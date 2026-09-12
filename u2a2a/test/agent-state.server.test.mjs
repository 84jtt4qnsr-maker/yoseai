// エージェント状態とアバター配信 — サーバ統合テスト（仕様: SPEC-アバター状態.md §11）
// server.mjs を一時ディレクトリへ複製し、偽の claude / codex / grok（PATH 先頭）で駆動する。
// HOME も一時ディレクトリに向け、~/.grok/auth.json の有無で Grok の認証状態を制御する。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_IDS = ["claude", "codex", "grok"];

const FAKE_CLI = (kind) => `#!/usr/bin/env node
const fs = require("fs");
const kind = ${JSON.stringify(kind)};
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(process.env.U2A2A_FAKE_CTL, "utf8")); } catch (e) {}
const c = ctl[kind] || {};
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { prompt += d; });
process.stdin.on("end", () => {
  setTimeout(() => {
    if (c.fail) { process.stderr.write("fake failure"); process.exit(1); }
    const text = c.text || "了解";
    const line = kind === "claude"
      ? JSON.stringify({ type: "result", result: text, session_id: "fake-" + Date.now(), usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.001, modelUsage: { "claude-fake": {} } })
      : JSON.stringify({ type: "thread.started", thread_id: "fake-thread" });
    if (kind === "codex") {
      const i = process.argv.indexOf("-o");
      if (i > 0) fs.writeFileSync(process.argv[i + 1], text);
    }
    process.stdout.write(line + "\\n", () => process.exit(0));
  }, c.delayMs || 0);
});
`;

const FAKE_GROK = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(process.env.U2A2A_FAKE_CTL, "utf8")); } catch (e) {}
const c = ctl.grok || {};
const argv = process.argv.slice(2);
const authed = fs.existsSync(path.join(process.env.HOME || "", ".grok", "auth.json"));
if (!authed) {
  process.stdout.write(JSON.stringify({ type: "error", message: "Not signed in. Run grok login." }) + "\\n", () => process.exit(1));
} else if (argv.includes("-p")) {
  process.stdout.write(JSON.stringify({ text: "pong", stopReason: "end_turn", sessionId: "g-ping", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.0001, modelUsage: { "grok-fake": {} } }) + "\\n", () => process.exit(0));
} else {
  setTimeout(() => {
    const text = c.text || "了解（Grok）";
    const lines = [
      JSON.stringify({ type: "text", data: text }),
      JSON.stringify({ type: "end", stopReason: c.stopReason || "end_turn", sessionId: "g-" + Date.now(), usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1, total_cost_usd: 0.002, modelUsage: { "grok-fake": {} } }),
    ];
    process.stdout.write(lines.join("\\n") + "\\n", () => process.exit(0));
  }, c.delayMs || 0);
}
`;

const FORMAT = {
  spriteVersionNumber: 2,
  atlas: { width: 1536, height: 2288, columns: 8, rows: 11, cellWidth: 192, cellHeight: 208 },
  animations: [{ row: 0, name: "idle", frames: 6, durationsMs: [280, 110, 110, 140, 140, 320] }],
  look: { rows: [9, 10], framesPerRow: 8, stepDeg: 22.5, zeroDeg: "up", clockwise: true },
  neutral: { row: 0, col: 6 },
};

let tmp, appDir, poolDir, fakeBin, ctlFile, home, port, server;
let T1, T2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const base = () => "http://127.0.0.1:" + port;
const writeCtl = (obj) => fs.writeFileSync(ctlFile, JSON.stringify({ poolDir, ...obj }));
const setAuth = (on) => {
  const f = path.join(home, ".grok", "auth.json");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (on) fs.writeFileSync(f, "{}");
  else fs.rmSync(f, { force: true });
};

async function api(method, p, body) {
  const r = await fetch(base() + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await r.json();
  } catch {
    // 本文なし
  }
  return { status: r.status, body: json };
}
const getState = async () => (await api("GET", "/api/state")).body;
const agentState = async () => (await api("GET", "/api/agent-state")).body;
const view = async (agent, topicId) => (await agentState()).agents[agent].byTopic[topicId];
const post = (topicId, thread, text) => api("POST", "/api/messages", { topicId, thread, text, author: "user" });

async function waitFor(fn, label, ms = 30000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout: " + label);
    await sleep(80);
  }
}
const idle = () => waitFor(async () => ((await getState()).runs || []).length ? null : true, "idle");

const stateFile = () => path.join(appDir, "data", "state.json");
const readSaved = () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  } catch {
    return null;
  }
};

async function startServer() {
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: appDir,
    env: { ...process.env, HOME: home, U2A2A_PORT: String(port), PATH: fakeBin + ":" + process.env.PATH, U2A2A_FAKE_CTL: ctlFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  server.stderr.on("data", (d) => (err += d));
  server.stdout.on("data", () => {});
  await waitFor(async () => {
    try {
      return (await fetch(base() + "/api/state")).ok;
    } catch {
      return false;
    }
  }, "server start: " + err, 15000);
  await waitFor(async () => ((await getState()).agents.grok.authed === true ? true : null), "grok 認証確認");
}

async function stopServer() {
  if (!server) return;
  const p = server;
  server = null;
  await new Promise((resolve) => {
    p.on("exit", resolve);
    p.kill("SIGTERM");
    setTimeout(resolve, 3000);
  });
}

async function newTopic(title) {
  const r = await api("POST", "/api/topics", { title, participants: AGENT_IDS });
  assert.ok(r.status < 300, "POST /api/topics: " + r.status + " " + JSON.stringify(r.body));
  return r.body.id || (r.body.topic && r.body.topic.id);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u2a2a-agentstate-"));
  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "package.json", "public/flow-graph.js", "public/usage.js"]) fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  poolDir = path.join(appDir, "pool");
  fs.mkdirSync(poolDir);
  home = path.join(tmp, "home");
  fs.mkdirSync(home);
  setAuth(true);
  fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  for (const k of ["claude", "codex"]) fs.writeFileSync(path.join(fakeBin, k), FAKE_CLI(k), { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "grok"), FAKE_GROK, { mode: 0o755 });
  ctlFile = path.join(tmp, "ctl.json");
  writeCtl({});
  await startServer();
  // 新規環境の既定は自動応答 OFF。このファイルは自動応答の状態を見るので、ここで明示的に ON にする
  for (const a of AGENT_IDS) await api("PATCH", "/api/agents/" + a, { auto: true });
  T1 = await newTopic("状態 A");
  T2 = await newTopic("状態 B");
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("1. SSE の state と GET が同じ agentState を返す。初期は全員 idle", async () => {
  const g = await agentState();
  assert.equal(g.version, 1);
  assert.deepEqual(Object.keys(g.agents), AGENT_IDS);
  for (const a of AGENT_IDS) {
    assert.deepEqual(g.agents[a].global, { phase: "idle", reason: null, since: null });
    assert.deepEqual(g.agents[a].byTopic, {});
  }
  assert.deepEqual((await getState()).agentState, g);
});

test("2. 実行中はそのトピックだけ working/run。別トピックには出ない。完了で消える", async () => {
  writeCtl({ claude: { delayMs: 1500 } });
  await post(T1, "claude", "考えて");
  const v = await waitFor(() => view("claude", T1), "run が見える");
  assert.deepEqual({ ...v, since: 0, runId: "" }, { phase: "working", kind: "thread", reason: null, since: 0, source: "run", runId: "", runCount: 1, outcomeId: null });
  const g = await agentState();
  assert.equal(g.agents.claude.byTopic[T2], undefined, "別トピックへ混ざらない");
  assert.equal(g.agents.claude.runs[0].topicId, T1);
  assert.equal(g.agents.codex.runs.length, 0);
  assert.equal(g.agents.claude.global.phase, "idle");
  writeCtl({});
  await waitFor(async () => ((await view("claude", T1)) === undefined ? true : null), "完了で消える");
  await idle();
});

test("3. 失敗は failed/error としてそのトピックに残り、global と別トピックは変わらない", async () => {
  writeCtl({ claude: { fail: true } });
  await post(T1, "claude", "失敗して");
  const v = await waitFor(async () => {
    const x = await view("claude", T1);
    return x && x.source === "outcome" ? x : null;
  }, "outcome");
  assert.equal(v.phase, "failed");
  assert.equal(v.reason, "error");
  assert.equal(v.kind, "thread");
  assert.ok(v.outcomeId);
  const g = await agentState();
  assert.equal(g.agents.claude.global.phase, "idle", "outcome は global を変えない");
  assert.equal(g.agents.claude.byTopic[T2], undefined, "別トピックへ波及しない");
  assert.equal(g.agents.claude.outcomes.length, 1);
  assert.equal(g.agents.claude.outcomes[0].topicId, T1);
  assert.match(g.agents.claude.outcomes[0].detail, /fake failure/);
  await idle();
  writeCtl({});
});

test("4. キャンセルは記録せず、既存の終了状態も消さない", async () => {
  writeCtl({ claude: { delayMs: 8000 } });
  await post(T1, "claude", "長く考えて");
  const r = await waitFor(async () => (await agentState()).agents.claude.runs.find((x) => x.kind === "thread"), "run");
  const during = await view("claude", T1);
  assert.equal(during.source, "run");
  assert.ok(during.outcomeId, "run の下に前回の失敗が隠れている");
  const c = await api("POST", `/api/runs/${r.runId}/cancel`);
  assert.equal(c.status, 202);
  await idle();
  const afterCancel = await view("claude", T1);
  assert.equal(afterCancel.source, "outcome");
  assert.equal(afterCancel.phase, "failed");
  assert.equal(afterCancel.outcomeId, during.outcomeId, "キャンセルで置き換わらない");
  writeCtl({});
});

test("5. auto OFF は global off として outcome を隠し、ON で戻る", async () => {
  await api("PATCH", "/api/agents/claude", { auto: false });
  let v = await view("claude", T1);
  assert.equal(v.source, "global");
  assert.equal(v.phase, "off");
  assert.equal(v.reason, "auto-off");
  assert.ok(v.outcomeId, "隠れた outcome の id は残る");
  assert.deepEqual((await agentState()).agents.claude.global, { phase: "off", reason: "auto-off", since: null });
  await api("PATCH", "/api/agents/claude", { auto: true });
  v = await view("claude", T1);
  assert.equal(v.source, "outcome");
  assert.equal(v.phase, "failed");
});

test("6. 同じトピックでの正常完了で終了状態が消える", async () => {
  writeCtl({});
  await post(T1, "claude", "今度は成功");
  await waitFor(async () => {
    const g = await agentState();
    return !g.agents.claude.runs.length && g.agents.claude.byTopic[T1] === undefined ? g : null;
  }, "解除");
  assert.equal((await agentState()).agents.claude.outcomes.length, 0);
});

test("7. Grok の停止は halted/stopped-unknown で、停止応答の messageId を持つ", async () => {
  writeCtl({ grok: { text: "途中まで", stopReason: "cancelled" } });
  await post(T1, "grok", "外に書いて");
  const v = await waitFor(async () => {
    const x = await view("grok", T1);
    return x && x.source === "outcome" ? x : null;
  }, "grok outcome");
  assert.equal(v.phase, "halted");
  assert.equal(v.reason, "stopped-unknown");
  await idle();
  const o = (await agentState()).agents.grok.outcomes[0];
  const msgs = (await getState()).messages.filter((m) => m.topicId === T1 && m.author === "grok");
  assert.equal(o.messageId, msgs[msgs.length - 1].id);
  assert.equal(msgs[msgs.length - 1].meta.status, "stopped");
  writeCtl({});
});

test("8. 未認証は global waiting/unauthed で outcome を隠し、再認証で idle に戻る。他エージェントへ波及しない", async () => {
  setAuth(false);
  await api("POST", "/api/agents/grok/check-auth");
  let g = await agentState();
  assert.equal(g.agents.grok.global.phase, "waiting");
  assert.equal(g.agents.grok.global.reason, "unauthed");
  assert.ok(g.agents.grok.global.since > 0);
  assert.equal(g.agents.grok.byTopic[T1].source, "global");
  assert.ok(g.agents.grok.byTopic[T1].outcomeId);
  assert.equal(g.agents.claude.global.phase, "idle");
  setAuth(true);
  await api("POST", "/api/agents/grok/check-auth");
  g = await agentState();
  assert.equal(g.agents.grok.global.phase, "idle");
  assert.equal(g.agents.grok.byTopic[T1].source, "outcome");
});

test("9. 終了状態は保存され再起動後も残る。schemaVersion 10。不正な保存値は捨て、過去データから復元しない", async () => {
  await waitFor(() => {
    const j = readSaved();
    const t = j && j.topics.find((x) => x.id === T1);
    return j && j.schemaVersion === 10 && t && t.agentOutcomes && t.agentOutcomes.grok ? j : null;
  }, "outcome が保存される");
  await stopServer();
  const saved = readSaved();
  saved.schemaVersion = 9;
  saved.unattributedOutcomes = {
    claude: { phase: "working" },
    evil: { phase: "failed" },
    codex: { id: "u1", kind: "review", phase: "failed", reason: "error", ts: 5, runId: null, itemId: "x", messageId: null, detail: "" },
  };
  delete saved.topics.find((x) => x.id === T2).agentOutcomes;
  // 旧データの停止応答（outcome を持たない）。移行で outcome に起こさないこと
  saved.messages.push({ id: "old-stop", topicId: T2, thread: "grok", author: "grok", text: "昔の停止", stopped: true, meta: { status: "stopped" }, ts: 1, provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null } });
  fs.writeFileSync(stateFile(), JSON.stringify(saved, null, 2));
  await startServer();
  const s = await getState();
  assert.deepEqual(Object.keys(s.unattributedOutcomes), ["codex"], "不正な値・対応外エージェントを捨てる");
  assert.deepEqual(s.topics.find((x) => x.id === T2).agentOutcomes, {});
  const g = await agentState();
  assert.equal(g.agents.grok.byTopic[T1].reason, "stopped-unknown", "再起動後も残る");
  assert.equal(g.agents.grok.byTopic[T2], undefined, "過去の停止応答から復元しない");
  assert.deepEqual(g.agents.codex.outcomes.map((o) => [o.id, o.topicId]), [["u1", null]]);
  assert.deepEqual(g.agents.codex.byTopic, {}, "帰属なしはどのトピックにも出ない");
});

test("10. ack: 消したら cleared true、2 回目は false。入力の検証", async () => {
  assert.equal((await api("POST", "/api/agent-state/ack", { agent: "evil", topicId: T1 })).status, 400);
  assert.equal((await api("POST", "/api/agent-state/ack", { agent: "grok" })).status, 400, "topicId 省略は不可（帰属なしは null を明示）");
  assert.equal((await api("POST", "/api/agent-state/ack", { agent: "grok", topicId: "ffffffffffffffff" })).status, 404);
  let r = await api("POST", "/api/agent-state/ack", { agent: "grok", topicId: T1 });
  assert.deepEqual(r, { status: 200, body: { ok: true, cleared: true } });
  assert.equal(await view("grok", T1), undefined);
  r = await api("POST", "/api/agent-state/ack", { agent: "grok", topicId: T1 });
  assert.deepEqual(r.body, { ok: true, cleared: false });
  r = await api("POST", "/api/agent-state/ack", { agent: "codex", topicId: null });
  assert.deepEqual(r.body, { ok: true, cleared: true });
  assert.equal((await agentState()).agents.codex.outcomes.length, 0);
});

test("11. レビューはプール項目のトピックへ帰属して reviewing。正常完了は何も残さない", async () => {
  writeCtl({ codex: { delayMs: 2000, text: "判定: 承認" } });
  const r = await api("POST", "/api/pool", { origin: "claude", title: "レビュー対象", body: "# 本文", topicId: T1, reviewers: ["codex"] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const v = await waitFor(() => view("codex", T1), "reviewing");
  assert.equal(v.phase, "reviewing");
  assert.equal(v.kind, "review");
  assert.equal(v.source, "run");
  const g = await agentState();
  const rv = g.agents.codex.runs.find((x) => x.kind === "review");
  assert.equal(rv.itemId, r.body.id);
  assert.equal(rv.topicId, T1);
  assert.equal(g.agents.codex.byTopic[T2], undefined);
  writeCtl({});
  await waitFor(async () => (!(await agentState()).agents.codex.runs.length ? true : null), "レビュー完了");
  assert.equal(await view("codex", T1), undefined);
});

test("12. アバター manifest は no-cache＋ETag／304。画像は hash URL で immutable、更新で旧 URL は 404 stale", async () => {
  const av = path.join(poolDir, "avatars");
  fs.mkdirSync(path.join(av, "claude"), { recursive: true });
  fs.mkdirSync(path.join(av, "codex"), { recursive: true });
  fs.writeFileSync(path.join(av, "claude", "pet.json"), JSON.stringify({ id: "claude", displayName: "Claude", description: "d", spriteVersionNumber: 2, spritesheetPath: "spritesheet.webp" }));
  fs.writeFileSync(path.join(av, "claude", "spritesheet.webp"), "SPRITE-1");
  fs.writeFileSync(path.join(av, "claude", "still-r0c0.webp"), "STILL");
  fs.writeFileSync(path.join(av, "codex", "pet.json"), JSON.stringify({ id: "codex", spriteVersionNumber: 2, spritesheetPath: "../escape.webp" }));
  fs.writeFileSync(path.join(av, "v2-format.json"), JSON.stringify(FORMAT));

  const res = await fetch(base() + "/api/avatars");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-cache");
  const etag = res.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  const m = await res.json();
  assert.equal(m.version, 1);
  assert.deepEqual(m.format, FORMAT);
  assert.equal(m.formatError, null);
  assert.equal(m.agents.grok, null, "pet.json が無ければ null");
  assert.equal(m.agents.codex.sprite, null);
  assert.match(m.agents.codex.error, /spritesheetPath/, "フォルダ外を指す spritesheetPath は拒否");
  const h1 = sha("SPRITE-1");
  assert.deepEqual(m.agents.claude.sprite, { url: `/api/avatars/claude/sprite.${h1.slice(0, 16)}.webp`, sha256: h1, bytes: 8 });
  assert.equal(m.agents.claude.still.bytes, 5);
  assert.equal(m.agents.claude.displayName, "Claude");
  assert.equal((await fetch(base() + "/api/avatars", { headers: { "If-None-Match": etag } })).status, 304);

  const img = await fetch(base() + m.agents.claude.sprite.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/webp");
  assert.equal(img.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await img.text(), "SPRITE-1");
  assert.equal((await fetch(base() + m.agents.claude.sprite.url, { headers: { "If-None-Match": img.headers.get("etag") } })).status, 304);

  // 画像を更新すると旧 URL は同じ内容を返せないので 404 stale、manifest が新 URL を知らせる
  fs.writeFileSync(path.join(av, "claude", "spritesheet.webp"), "SPRITE-2-longer");
  const stale = await fetch(base() + m.agents.claude.sprite.url);
  assert.equal(stale.status, 404);
  assert.equal(stale.headers.get("cache-control"), "no-store");
  const staleBody = await stale.json();
  assert.equal(staleBody.error, "stale");
  const m2Res = await fetch(base() + "/api/avatars", { headers: { "If-None-Match": etag } });
  assert.equal(m2Res.status, 200, "内容が変われば 304 にならない");
  const m2 = await m2Res.json();
  assert.equal(m2.agents.claude.sprite.url, staleBody.current);
  assert.equal(m2.agents.claude.sprite.sha256, sha("SPRITE-2-longer"));

  assert.equal((await fetch(base() + "/api/avatars/evil/sprite.0000000000000000.webp")).status, 404);
  assert.equal((await fetch(base() + "/api/avatars/claude/sprite.xyz.webp")).status, 404);

  fs.writeFileSync(path.join(av, "v2-format.json"), JSON.stringify({ spriteVersionNumber: 1 }));
  const m3 = await (await fetch(base() + "/api/avatars")).json();
  assert.equal(m3.format, null);
  assert.match(m3.formatError, /spriteVersionNumber/);
});
