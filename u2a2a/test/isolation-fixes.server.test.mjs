// 修正リスト-確定（2026-09-13）のサーバ統合テスト。
// A: 偽 srt で enforced にした本番構成 — /api/access（public）、検証取込の行単位被覆（P1-1）、
//    要約の隔離配線（P0-2）、codex の自前サンドボックス解除（P0-0 候補）、退避回収失敗の失敗扱い（P1-2）、
//    revoke の切符失効（P2-②）。
// B: srt なし＋U2A2A_CREDENTIALS=off — /api/access が off を返し画面が state を取れること（P0-3）、
//    unprotected では codex が自前サンドボックスを維持すること（P0-0 の fail 側）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRED = "d".repeat(64);

// 偽 srt: --version に応答し、-c LINE を sh -c で実行する。実行時に SRT_WRAP=1 を子へ渡すので、
// 偽 CLI は「包まれて起動した」ことを自分の応答に刻める。ctl.deleteOut なら終了後に
// リダイレクト先 (> '...') を消し、最終回収の missing（P1-2）を再現する
const FAKE_SRT = `#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
if (process.argv[2] === "--version") { process.stdout.write("fake-srt 9.9.9\\n"); process.exit(0); }
let ctl = {}; try { ctl = JSON.parse(fs.readFileSync(fs.readFileSync(__filename + ".env", "utf8").trim(), "utf8")); } catch (e) {}
const i = process.argv.indexOf("-c");
const line = i >= 0 ? process.argv[i + 1] : "true";
const r = spawnSync("sh", ["-c", line], { stdio: "inherit", env: { ...process.env, SRT_WRAP: "1" } });
if (ctl.deleteOut) { const m = /> '([^']+)'/.exec(line); if (m) { try { fs.unlinkSync(m[1]); } catch (e) {} } }
process.exit(r.status == null ? 1 : r.status);
`;

// 偽 claude: 包まれていれば "[wrapped]"、素起動なら "[bare]" を返信に刻む（要約の配線 P0-2 の観測点）
const FAKE_CLAUDE = `#!/usr/bin/env node
let p = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", d => p += d);
process.stdin.on("end", () => {
  const text = "done" + (process.env.SRT_WRAP ? "[wrapped]" : "[bare]");
  process.stdout.write(JSON.stringify({ type: "result", result: text, session_id: "fake", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n", () => process.exit(0));
});
`;

// 偽 grok: 自分の argv をスレッド返信の本文として返す（契約-grok許可拡張: enforced で Bash(*) が付くかの観測）
const FAKE_GROK = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes("-p")) {
  process.stdout.write(JSON.stringify({ text: "pong", stopReason: "end_turn", sessionId: "g-ping", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.0001, modelUsage: { "grok-4.6-build": {} } }) + "\\n", () => process.exit(0));
} else {
  const lines = [
    JSON.stringify({ type: "text", data: "argv:" + argv.join(" ") }),
    JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "g-1", usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1, total_cost_usd: 0.001, modelUsage: { "grok-4.6-build": {} } }),
  ];
  process.stdout.write(lines.join("\\n") + "\\n", () => process.exit(0));
}
`;

// 偽 codex: 自分の argv を -o ファイルへ書く（P0-0: -s の値をスレッド返信として観測する）
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require("fs");
let p = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", d => p += d);
process.stdin.on("end", () => {
  const i = process.argv.indexOf("-o");
  if (i > 0) fs.writeFileSync(process.argv[i + 1], "argv:" + process.argv.slice(2).join(" "));
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "fake" }) + "\\n", () => process.exit(0));
});
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApp(tmp) {
  const appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "tray.mjs", "credentials.mjs", "sandbox.mjs", "sandbox-profiles.json", "package.json", "public/flow-graph.js", "public/usage.js"])
    fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  fs.mkdirSync(path.join(appDir, "pool"));
  return appDir;
}

function apiFor(port, cred) {
  return async (method, p, body, noAuth = false) => {
    const headers = { "content-type": "application/json" };
    if (!noAuth && cred) headers.Authorization = "Bearer " + cred;
    const r = await fetch("http://127.0.0.1:" + port + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    let json = null; try { json = await r.json(); } catch {}
    return { status: r.status, body: json };
  };
}

async function waitFor(fn, label, ms = 20000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout: " + label); await sleep(100); }
}

// ---- A: enforced（偽 srt）＋資格あり ----
let tmpA, serverA, portA, apiA, ctlA, topicA;

// ---- B: srt なし＋資格検査 off ----
let tmpB, serverB, portB, apiB, topicB;

before(async () => {
  // A
  tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "yoseai-fixes-a-"));
  const appA = makeApp(tmpA);
  const binA = path.join(tmpA, "bin"); fs.mkdirSync(binA);
  fs.writeFileSync(path.join(binA, "srt"), FAKE_SRT, { mode: 0o755 });
  fs.writeFileSync(path.join(binA, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(binA, "codex"), FAKE_CODEX, { mode: 0o755 });
  fs.writeFileSync(path.join(binA, "grok"), FAKE_GROK, { mode: 0o755 });
  ctlA = path.join(tmpA, "ctl.json");
  fs.writeFileSync(ctlA, JSON.stringify({}));
  fs.writeFileSync(path.join(binA, "srt") + ".env", ctlA);
  portA = 20000 + Math.floor(Math.random() * 20000);
  serverA = spawn(process.execPath, ["server.mjs"], {
    cwd: appA,
    env: { ...process.env, U2A2A_ADMIN_CREDENTIAL: CRED, U2A2A_PORT: String(portA), PATH: binA + ":" + process.env.PATH },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errA = ""; serverA.stderr.on("data", (d) => (errA += d));
  apiA = apiFor(portA, CRED);
  await waitFor(async () => { try { return (await apiA("GET", "/api/state")).status === 200; } catch { return false; } }, "server A start: " + errA, 15000);
  await waitFor(async () => (await apiA("GET", "/api/state")).body.agents.grok.authed === true, "grok auth probe (A)");
  for (const a of ["claude", "codex", "grok"]) await apiA("PATCH", "/api/agents/" + a, { auto: true });
  topicA = (await apiA("POST", "/api/topics", { title: "GA", participants: ["claude", "codex", "grok"] })).body.id;

  // B
  tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "yoseai-fixes-b-"));
  const appB = makeApp(tmpB);
  const binB = path.join(tmpB, "bin"); fs.mkdirSync(binB);
  fs.writeFileSync(path.join(binB, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(binB, "codex"), FAKE_CODEX, { mode: 0o755 });
  fs.writeFileSync(path.join(binB, "grok"), FAKE_GROK, { mode: 0o755 });
  portB = 20000 + Math.floor(Math.random() * 20000);
  serverB = spawn(process.execPath, ["server.mjs"], {
    cwd: appB,
    // 実機にはグローバルの srt が入っているので、存在しないコマンド名で「ラッパー不在」を再現する
    env: { ...process.env, U2A2A_CREDENTIALS: "off", U2A2A_SANDBOX_CMD: "yoseai-test-no-srt", U2A2A_PORT: String(portB), PATH: binB + ":" + process.env.PATH },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errB = ""; serverB.stderr.on("data", (d) => (errB += d));
  apiB = apiFor(portB, null);
  await waitFor(async () => { try { return (await apiB("GET", "/api/state", null, true)).status === 200; } catch { return false; } }, "server B start: " + errB, 15000);
  await waitFor(async () => (await apiB("GET", "/api/state", null, true)).body.agents.grok.authed === true, "grok auth probe (B)");
  for (const a of ["claude", "codex", "grok"]) await apiB("PATCH", "/api/agents/" + a, { auto: true });
  // トピック作成と投稿が同ミリ秒だと lastSeenTs の厳密比較で未読ゼロになる競合があるため、ここで作っておく
  topicB = (await apiB("POST", "/api/topics", { title: "GB", participants: ["claude", "grok"] }, true)).body.id;
});

after(async () => {
  for (const s of [serverA, serverB]) if (s) s.kill("SIGTERM");
  await sleep(500);
  for (const t of [tmpA, tmpB]) if (t) fs.rmSync(t, { recursive: true, force: true });
});

// ---- P0-3: /api/access ----

test("GET /api/access は資格なしで通り、検査の有無だけを返す", async () => {
  const on = await apiA("GET", "/api/access", null, true);
  assert.equal(on.status, 200);
  assert.deepEqual(on.body, { credentials: true });
  const off = await apiB("GET", "/api/access", null, true);
  assert.equal(off.status, 200);
  assert.deepEqual(off.body, { credentials: false });
});

test("U2A2A_CREDENTIALS=off では無資格の GET /api/state が通る（画面が空にならない）", async () => {
  const r = await apiB("GET", "/api/state", null, true);
  assert.equal(r.status, 200);
  assert.ok(r.body.isolation);
  assert.equal(r.body.isolation.credentials, false, "isolation.credentials が off を示す");
});

// ---- P1-1: 検証取込の行単位被覆と runtime 版 ----

const GENERIC = {
  "fs-child": "denied", "fs-tool": "denied", "fs-self": "denied", "net-loopback": "denied",
  "net-vendor": "allowed", "exec-tests": "allowed", "init-fail": "not_run",
  "cred-none": "denied", "cred-env": "denied", "cred-file": "denied",
};
function probesOldStyle() {
  return Object.entries(GENERIC).map(([k, v]) => ({ probeId: "probe-isolation-" + k, observation: v }));
}
function probesNewStyle() {
  const rows = [
    ["claude", "any"], ["claude", "review"], ["claude", "fix"], ["claude", "summary"],
    ["codex", "any"], ["codex", "fix"], ["codex", "review"],
    ["grok", "any"], ["grok", "fix"], ["grok", "review"],
  ];
  return [
    ...probesOldStyle(),
    ...rows.map(([a, p]) => ({ probeId: `probe-isolation-boundary-${a}-${p}`, observation: "denied" })),
    ...["claude", "codex", "grok"].map((a) => ({ probeId: `probe-isolation-wrap-${a}`, observation: "denied" })),
  ];
}

test("旧スイート形式（汎用接尾辞のみ）の取込は行単位被覆の不足で弾かれる", async () => {
  const iso = (await apiA("GET", "/api/state")).body.isolation;
  assert.equal(iso.mode, "enforced");
  const r = await apiA("POST", "/api/isolation/verification", {
    profilesSha256: iso.profilesSha256, runtime: iso.runtime, version: iso.version,
    probes: probesOldStyle(), verifiedReady: true,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "probes-incomplete");
  assert.ok(r.body.missing.includes("-boundary-claude-summary"), "行単位の境界 probe が missing に載る: " + JSON.stringify(r.body.missing));
  assert.ok(r.body.missing.includes("-wrap-codex"), "エージェント単位の wrap probe が missing に載る");
});

test("runtime の版が現行と違う取込は弾かれる", async () => {
  const iso = (await apiA("GET", "/api/state")).body.isolation;
  const r = await apiA("POST", "/api/isolation/verification", {
    profilesSha256: iso.profilesSha256, runtime: iso.runtime, version: "0.0.1",
    probes: probesNewStyle(), verifiedReady: true,
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "runtime-version-mismatch");
});

test("行単位被覆＋wrap が揃った取込で点灯し、被覆がラベルに載る", async () => {
  const iso = (await apiA("GET", "/api/state")).body.isolation;
  const r = await apiA("POST", "/api/isolation/verification", {
    profilesSha256: iso.profilesSha256, runtime: iso.runtime, version: iso.version,
    probes: probesNewStyle(), verifiedReady: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const after = (await apiA("GET", "/api/state")).body.isolation;
  assert.equal(after.verified, true);
  assert.deepEqual(after.coverage.agents, ["claude", "codex", "grok"]);
  assert.equal(after.coverage.rows, 10);
  assert.ok(after.label.includes("被覆"), "ラベルに被覆が載る: " + after.label);
});

// ---- P0-2 / P0-0: 実行経路 ----

test("enforced では codex の自前サンドボックスを外し danger-full-access で起動する（P0-0 候補）", async () => {
  const before = (await apiA("GET", "/api/state")).body.messages.length;
  assert.equal((await apiA("POST", "/api/messages", { author: "user", thread: "codex", topicId: topicA, text: "argv を見せて" })).status, 201);
  const reply = await waitFor(async () => {
    const msgs = (await apiA("GET", "/api/state")).body.messages;
    return msgs.length > before ? msgs.find((m) => m.author === "codex" && m.text.startsWith("argv:")) : null;
  }, "codex argv reply");
  assert.ok(reply.text.includes("-s danger-full-access"), "enforced では danger-full-access: " + reply.text);
  assert.ok(!reply.text.includes("workspace-write"), "自前サンドボックス指定が残っていない");
});

test("要約が隔離に包まれて起動する（P0-2 配線）", async () => {
  const r = await apiA("POST", "/api/topics/" + topicA + "/summarize");
  assert.equal(r.status, 202);
  const topic = await waitFor(async () => {
    const t = (await apiA("GET", "/api/state")).body.topics.find((t) => t.id === topicA);
    return t.summaryText ? t : null;
  }, "summary text");
  assert.ok(topic.summaryText.includes("[wrapped]"), "要約の claude が srt 経由で起動している: " + topic.summaryText);
});

test("退避ファイルの最終回収に失敗した実行は成功にならない（P1-2）", async () => {
  fs.writeFileSync(ctlA, JSON.stringify({ deleteOut: true }));
  try {
    assert.equal((await apiA("POST", "/api/messages", { author: "user", thread: "claude", topicId: topicA, text: "退避を壊す試験" })).status, 201);
    await waitFor(async () => {
      const a = (await apiA("GET", "/api/state")).body.agents.claude;
      return a.lastError && a.lastError.includes("退避") ? a : null;
    }, "outputLost surfaces as run failure");
  } finally {
    fs.writeFileSync(ctlA, JSON.stringify({}));
  }
});

test("enforced では grok に Bash(*) が付き、unprotected では従来規則のまま（契約-grok許可拡張）", async () => {
  // A: enforced
  const beforeA = (await apiA("GET", "/api/state")).body.messages.length;
  assert.equal((await apiA("POST", "/api/messages", { author: "user", thread: "grok", topicId: topicA, text: "argv" })).status, 201);
  const rA = await waitFor(async () => {
    const msgs = (await apiA("GET", "/api/state")).body.messages;
    return msgs.length > beforeA ? msgs.find((m) => m.author === "grok" && m.text.startsWith("argv:")) : null;
  }, "grok argv reply (enforced)");
  assert.ok(rA.text.includes("--always-approve"), "enforced は always-approve（Bash(*) 系は実測で無効だった）: " + rA.text);
  assert.ok(rA.text.includes("--tools"), "正のホワイトリスト方式（--disallowed-tools は always-approve 併用時に効かない実測）");
  assert.ok(!/--tools [^ ]*spawn_subagent/.test(rA.text), "spawn_subagent はホワイトリストに入れない");
  // B: unprotected
  const beforeB = (await apiB("GET", "/api/state", null, true)).body.messages.length;
  assert.equal((await apiB("POST", "/api/messages", { author: "user", thread: "grok", topicId: topicB, text: "argv" }, true)).status, 201);
  const rB = await waitFor(async () => {
    const msgs = (await apiB("GET", "/api/state", null, true)).body.messages;
    return msgs.length > beforeB ? msgs.find((m) => m.author === "grok" && m.text.startsWith("argv:")) : null;
  }, "grok argv reply (unprotected)");
  assert.ok(!rB.text.includes("--always-approve"), "unprotected は always-approve を付けない: " + rB.text);
  assert.ok(rB.text.includes("Bash(python3:*)"), "従来規則は残る");
});

test("grok セッションの許可構成の印: 同一構成なら resume、印が無い/違うセッションは新規（改版1c §2b）", async () => {
  // 1回目（前テストで grok は新規セッション・印が記録された）。2回目は同一構成なので --resume が付く。
  // 前テストの返信を拾わないよう、投稿時刻より後の最後の返信だけを見る
  const t0 = Date.now();
  assert.equal((await apiA("POST", "/api/messages", { author: "user", thread: "grok", topicId: topicA, text: "argv2" })).status, 201);
  const r2 = await waitFor(async () => {
    const msgs = (await apiA("GET", "/api/state")).body.messages;
    return msgs.findLast((m) => m.author === "grok" && m.text.startsWith("argv:") && m.ts >= t0) || null;
  }, "grok resume reply");
  assert.ok(r2.text.includes("--resume"), "印が一致するので resume される: " + r2.text.slice(0, 120));
  // 印を意図的に不一致にする（既存セッションに後付けの適合印を与えない規律の裏返し）→ 次のランは新規セッション
  const st = (await apiA("GET", "/api/state")).body;
  const sid = st.topics.find((t) => t.id === topicA).agents.grok.sessionId;
  assert.ok(sid, "セッションが記録されている");
  // grokArgsTag を state 上で書き換える公開 API は無いので、resetAgent（印ごとセッションを捨てる既存操作）で代用し、
  // リセット後の初回が --resume 無しで立つことを確認する
  assert.equal((await apiA("PATCH", "/api/topics/" + topicA, { resetAgent: "grok" })).status, 200);
  const t1 = Date.now();
  assert.equal((await apiA("POST", "/api/messages", { author: "user", thread: "grok", topicId: topicA, text: "argv3" })).status, 201);
  const r3 = await waitFor(async () => {
    const msgs = (await apiA("GET", "/api/state")).body.messages;
    return msgs.findLast((m) => m.author === "grok" && m.text.startsWith("argv:") && m.ts >= t1) || null;
  }, "grok fresh reply after reset");
  assert.ok(!r3.text.includes("--resume"), "リセット後は新規セッション: " + r3.text.slice(0, 120));
});

// ---- 回帰: ディレクトリへの /api/pool/file はプロセスを落とさず 404 ----
// 2026-09-13 の実走で、ディレクトリの createReadStream が未処理 'error'（EISDIR）で
// サーバごと落ちた。ファイル以外は 404、サーバは生き続けること

test("GET /api/pool/file/<ディレクトリ> は 404 で、サーバは落ちない", async () => {
  const dir = path.join(tmpA, "u2a2a", "pool", "probe-dir"); fs.mkdirSync(dir, { recursive: true });
  const r = await apiA("GET", "/api/pool/file/probe-dir");
  assert.equal(r.status, 404);
  assert.equal((await apiA("GET", "/api/state")).status, 200, "サーバが生きている");
});

// ---- P2-②: revoke は切符も失効させる（資格が回るので最後に置く）----

test("revoke 後は発行済みの SSE 切符が使えない", async () => {
  const t = await apiA("POST", "/api/events/ticket");
  assert.equal(t.status, 201);
  assert.equal((await apiA("POST", "/api/credentials/revoke")).status, 200);
  const r = await fetch(`http://127.0.0.1:${portA}/api/events?ticket=${encodeURIComponent(t.body.ticket)}`);
  assert.equal(r.status, 401, "旧資格で取った切符は失効している");
  try { await r.body?.cancel(); } catch {}
});

// ---- P0-0 の fail 側: unprotected では自前サンドボックスを維持 ----

test("unprotected では codex は従来どおり自前サンドボックス（read-only）で起動する", async () => {
  const state = (await apiB("GET", "/api/state", null, true)).body;
  assert.equal(state.isolation.mode, "unprotected");
  const topicB = state.topics[0].id;
  const before = state.messages.length;
  assert.equal((await apiB("POST", "/api/messages", { author: "user", thread: "codex", topicId: topicB, text: "argv を見せて" }, true)).status, 201);
  const reply = await waitFor(async () => {
    const msgs = (await apiB("GET", "/api/state", null, true)).body.messages;
    return msgs.length > before ? msgs.find((m) => m.author === "codex" && m.text.startsWith("argv:")) : null;
  }, "codex argv reply (unprotected)");
  assert.ok(reply.text.includes("-s read-only") || reply.text.includes("-s workspace-write"), "自前サンドボックスが維持される: " + reply.text);
  assert.ok(!reply.text.includes("danger-full-access"), "unprotected で danger-full-access にしない");
});
