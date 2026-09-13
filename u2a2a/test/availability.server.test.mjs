// エージェント不在の可視化（契約: 契約-不在可視化.md 契約版 1）のテスト。
// 単体: classifyBackendError（フィクスチャ-grok402.md の正例・負例）。
// 統合: 失敗が黙らない（⚠ 行・ta.lastError・可用性・別トピック非汚染・回復・再確認経路）。
// 隔離は触らない契約なので srt 無し（unprotected）で立てる。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyBackendError } from "../lib.mjs";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRED = "e".repeat(64);

// ---- 単体: フィクスチャ-grok402.md を正とする ----

const G402_MAIN = 'Internal error: {"message": "API error (status 402 Payment Required): Grok Build usage balance exhausted", "http_status": 402}';

test("classifyBackendError: grok 402 実文面（正例3種）は unavailable", () => {
  for (const msg of [
    G402_MAIN, // G402-1
    "API error (status 402 Payment Required): Grok Build usage balance exhausted", // G402-2
    "grok: " + G402_MAIN, // G402-3（将来 parsed.error 経路に乗った場合の接頭辞）
  ]) {
    assert.equal(classifyBackendError("grok", new Error(msg)).availability, "unavailable", msg);
  }
});

test("classifyBackendError: 併用条件を欠く 402 系・残高文言単体は unknown（負例）", () => {
  for (const msg of [
    'Internal error: {"message": "API error (status 402 Payment Required)", "http_status": 402}', // Gneg-1
    "Payment Required", // Gneg-2
    "usage balance exhausted", // Gneg-3
  ]) {
    assert.equal(classifyBackendError("grok", new Error(msg)).availability, "unknown", msg);
  }
});

test("classifyBackendError: claude の OAuth 期限切れ（2026-09-13 実測）は unavailable、他 CLI は対象外", () => {
  const msg = "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.";
  const r = classifyBackendError("claude", new Error(msg));
  assert.equal(r.availability, "unavailable");
  assert.ok(r.detail.includes("再認証"));
  assert.equal(classifyBackendError("codex", new Error(msg)).availability, "unknown");
});

test("classifyBackendError: grok 以外の CLI は 402 実文面でも unknown（初版の判定範囲）", () => {
  assert.equal(classifyBackendError("claude", new Error(G402_MAIN)).availability, "unknown");
  assert.equal(classifyBackendError("codex", new Error(G402_MAIN)).availability, "unknown");
});

test("classifyBackendError: unknown の detail は定型短文——生文をどう伏せても漏れうるため転記しない（契約 §2・codex 再レビュー2）", () => {
  for (const msg of [
    "Authorization: Bearer FAKE_UNIT_TOKEN",
    "Authorization: Basic RkFLRTpGQUtF",
    "access_token=FAKE refresh_token=FAKE2",
    "at stack.only (x.js:1)\nat deeper (y.js:2)",
    "x".repeat(500),
  ]) {
    const r = classifyBackendError("claude", new Error(msg));
    assert.equal(r.availability, "unknown");
    assert.equal(r.detail, "実行に失敗しました（分類外のエラー。詳細は起動端末のログに出力）");
  }
  // unavailable 側も定型（生文は含まれない）
  const u = classifyBackendError("grok", new Error(G402_MAIN));
  assert.ok(!u.detail.includes("http_status"), u.detail);
  // アプリ自前の失敗フラグは専用の定型（「分類外」に丸めて原因を消さない）
  const ol = classifyBackendError("claude", Object.assign(new Error("raw with Bearer FAKE"), { outputLost: true }));
  assert.ok(ol.detail.includes("退避") && !ol.detail.includes("FAKE"), ol.detail);
  const ib = classifyBackendError("grok", Object.assign(new Error("x"), { isolationBlocked: true }));
  assert.ok(ib.detail.includes("隔離"), ib.detail);
});

// ---- 統合 ----

// 偽 grok: c.fail402 なら 402 実文面を stderr に出して exit 1（!parsed.end && code!==0 → 生文 throw の経路）。
// それ以外は grok.server.test.mjs と同じ streaming-json の成功形
const FAKE_GROK = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(fs.readFileSync(__filename + ".env", "utf8").trim(), "utf8")); } catch (e) {}
const c = ctl.grok || {};
const argv = process.argv.slice(2);
if (c.fail402) {
  process.stderr.write(${JSON.stringify(G402_MAIN)} + "\\n", () => process.exit(1));
} else if (argv.includes("-p")) {
  if (c.pingFail) { process.stderr.write("weird failure Authorization: Bearer FAKE_REVIEW_TOKEN\\n", () => process.exit(1)); return; }
  process.stdout.write(JSON.stringify({ text: "pong", stopReason: "end_turn", sessionId: "g-ping", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.0001, modelUsage: { "grok-4.6-build": {} } }) + "\\n", () => process.exit(0));
} else {
  const r = argv.indexOf("--resume");
  const sid = r >= 0 ? argv[r + 1] : "g-1";
  const lines = [
    JSON.stringify({ type: "text", data: "了解（Grok）" }),
    JSON.stringify({ type: "end", stopReason: c.stopReason || "end_turn", sessionId: sid, usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, total_cost_usd: 0.002, modelUsage: { "grok-4.6-build": { costUSD: 0.002 } } }),
  ];
  setTimeout(() => process.stdout.write(lines.join("\\n") + "\\n", () => process.exit(0)), c.delayMs || 0);
}
`;

// 偽 claude: c.fail なら分類表にない一般失敗（unknown の経路）。それ以外は成功
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(fs.readFileSync(__filename + ".env", "utf8").trim(), "utf8")); } catch (e) {}
const c = ctl.claude || {};
let p = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", d => p += d);
process.stdin.on("end", () => {
  if (c.fail) { process.stderr.write("boom: unexpected crash\\n", () => process.exit(1)); return; }
  process.stdout.write(JSON.stringify({ type: "result", result: "done", session_id: "fake", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n", () => process.exit(0));
});
`;

let tmp, appDir, fakeBin, ctlFile, home, port, server, topic1, topic2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeCtl = (obj) => fs.writeFileSync(ctlFile, JSON.stringify(obj));

async function api(method, p, body) {
  const r = await fetch("http://127.0.0.1:" + port + p, {
    method,
    headers: { "content-type": "application/json", Authorization: "Bearer " + CRED },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, body: json };
}
const getState = async () => (await api("GET", "/api/state")).body;
async function waitFor(fn, label, ms = 20000) {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timeout: " + label); await sleep(100); }
}
const topicOf = (s, id) => s.topics.find((t) => t.id === id);

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yoseai-avail-"));
  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "tray.mjs", "credentials.mjs", "sandbox.mjs", "sandbox-profiles.json", "package.json", "public/flow-graph.js", "public/usage.js"])
    fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  fs.mkdirSync(path.join(appDir, "pool"));
  home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
  fs.writeFileSync(path.join(home, ".grok", "auth.json"), "{}"); // 認証済みの体
  fakeBin = path.join(tmp, "bin"); fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "grok"), FAKE_GROK, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  ctlFile = path.join(tmp, "ctl.json");
  writeCtl({});
  for (const f of ["grok", "claude"]) fs.writeFileSync(path.join(fakeBin, f) + ".env", ctlFile);
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: appDir,
    env: { ...process.env, HOME: home, U2A2A_ADMIN_CREDENTIAL: CRED, U2A2A_PORT: String(port), U2A2A_SANDBOX_CMD: "yoseai-test-no-srt", PATH: fakeBin + ":" + process.env.PATH },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = ""; server.stderr.on("data", (d) => (err += d));
  await waitFor(async () => { try { return (await api("GET", "/api/state")).status === 200; } catch { return false; } }, "server start: " + err, 15000);
  await waitFor(async () => (await getState()).agents.grok.authed === true, "grok auth probe");
  for (const a of ["claude", "codex", "grok"]) await api("PATCH", "/api/agents/" + a, { auto: true });
  topic1 = (await api("POST", "/api/topics", { title: "T1", participants: ["claude", "grok"] })).body.id;
  topic2 = (await api("POST", "/api/topics", { title: "T2", participants: ["claude", "grok"] })).body.id;
});

after(async () => {
  if (server) { server.kill("SIGTERM"); await sleep(500); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("grok 402: ⚠ 行・ta.lastError・availability=unavailable、別トピックへ漏れない（受入①②③⑤）", async () => {
  writeCtl({ grok: { fail402: true } });
  assert.equal((await api("POST", "/api/messages", { author: "user", thread: "grok", topicId: topic1, text: "残高切れ試験" })).status, 201);
  const s = await waitFor(async () => {
    const st = await getState();
    return st.messages.some((m) => m.topicId === topic1 && m.thread === "grok" && m.failed && m.text.startsWith("⚠ 応答できませんでした")) ? st : null;
  }, "⚠ line in topic1");
  assert.ok(topicOf(s, topic1).agents.grok.lastError, "ta.lastError が立つ");
  assert.equal(s.agents.grok.availability, "unavailable");
  assert.ok(s.agents.grok.lastError.includes("残高"), "バッジ用 a.lastError: " + s.agents.grok.lastError);
  assert.ok(!topicOf(s, topic2).agents.grok.lastError, "別トピックへ漏れない");
  // 席全体の事情は topic2 にも複製される（次のテストで復帰時の一括クリアを見る）
  assert.equal((await api("POST", "/api/messages", { author: "user", thread: "grok", topicId: topic2, text: "残高切れ試験2" })).status, 201);
  await waitFor(async () => {
    const st = await getState();
    return topicOf(st, topic2).agents.grok.lastError ? st : null;
  }, "⚠ in topic2 too");
});

test("claude の一般失敗: availability=unknown に更新される（受入⑧、unavailable が残らない）", async () => {
  writeCtl({ claude: { fail: true } });
  assert.equal((await api("POST", "/api/messages", { author: "user", thread: "claude", topicId: topic1, text: "一般失敗試験" })).status, 201);
  const s = await waitFor(async () => {
    const st = await getState();
    return st.messages.some((m) => m.topicId === topic1 && m.thread === "claude" && m.failed) ? st : null;
  }, "⚠ line for claude");
  assert.equal(s.agents.claude.availability, "unknown");
  assert.ok(topicOf(s, topic1).agents.claude.lastError);
  // outcome の detail も定型のみ（生文 "boom" が agentOutcomes → API へ流れない——指摘#1）
  assert.ok(!JSON.stringify(s.agentState || {}).includes("boom"), "agentState に生文が出ない");
});

test("成功で availability=available・ta.lastError が空へ戻る。席全体の複製は全トピック消える（受入④・指摘#4）", async () => {
  writeCtl({});
  assert.equal((await api("POST", "/api/messages", { author: "user", thread: "grok", topicId: topic1, text: "回復試験" })).status, 201);
  const s = await waitFor(async () => {
    const st = await getState();
    return st.messages.some((m) => m.topicId === topic1 && m.author === "grok" && m.text === "了解（Grok）") ? st : null;
  }, "grok recovery reply");
  assert.equal(s.agents.grok.availability, "available");
  assert.equal(topicOf(s, topic1).agents.grok.lastError, "");
  assert.equal(topicOf(s, topic2).agents.grok.lastError, "", "残高切れ由来の複製は実行していないトピックからも消える（指摘#4）");
});

test("review 失敗も同じ可視化（3経路の網羅・codex レビュー）", async () => {
  const nf = await api("POST", "/api/pool/newfile", { name: "avail-review.md", dir: "topics/" + topic1 });
  assert.equal(nf.status, 201, JSON.stringify(nf.body));
  const itemId = nf.body.id;
  writeCtl({ grok: { fail402: true } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "grok" })).status, 202);
  const s = await waitFor(async () => {
    const st = await getState();
    const it = st.pool.find((p) => p.id === itemId);
    return it && (it.reviews || []).some((r) => r.error) ? st : null;
  }, "review failure recorded");
  assert.equal(s.agents.grok.availability, "unavailable");
  assert.ok(s.messages.some((m) => m.topicId === topic1 && m.thread === "grok" && m.failed), "⚠ 行が成果物のトピックに積まれる");
  assert.ok(topicOf(s, topic1).agents.grok.lastError);
});

test("fix 失敗も同じ可視化（3経路の網羅・codex レビュー）", async () => {
  const nf = await api("POST", "/api/pool/newfile", { name: "avail-fix.md", dir: "topics/" + topic1 });
  const itemId = nf.body.id;
  writeCtl({ claude: { fail: true } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
  const s = await waitFor(async () => {
    const st = await getState();
    const it = st.pool.find((p) => p.id === itemId);
    return it && (it.fixes || []).some((f) => f.error) ? st : null;
  }, "fix failure recorded");
  assert.equal(s.agents.claude.availability, "unknown");
  assert.ok(s.messages.some((m) => m.topicId === topic1 && m.thread === "claude" && m.failed && m.ts > Date.now() - 60000), "⚠ 行が積まれる");
});

test("stopped は成功でも失敗でもない: ⚠ 無し・available 維持・停止理由は ta に残る（受入⑦）", async () => {
  writeCtl({}); // まず成功で状態を戻す
  await api("POST", "/api/messages", { author: "user", thread: "grok", topicId: topic2, text: "回復" });
  await waitFor(async () => (await getState()).agents.grok.availability === "available", "grok available again");
  const failedBefore = (await getState()).messages.filter((m) => m.failed).length;
  writeCtl({ grok: { stopReason: "cancelled" } });
  assert.equal((await api("POST", "/api/messages", { author: "user", thread: "grok", topicId: topic2, text: "停止試験" })).status, 201);
  const s = await waitFor(async () => {
    const st = await getState();
    return st.messages.some((m) => m.topicId === topic2 && m.author === "grok" && m.stopped) ? st : null;
  }, "stopped reply");
  assert.equal(s.messages.filter((m) => m.failed).length, failedBefore, "⚠ 行は増えない");
  assert.equal(s.agents.grok.availability, "available", "stopped で可用性を動かさない");
  assert.ok(topicOf(s, topic2).agents.grok.lastError.includes("停止"), "停止理由がトピック側に残る（列の表示が消えない）");
});

test("キャンセルは対象外: ⏹ のみで ⚠ 無し・可用性不変（受入⑥）", async () => {
  writeCtl({ grok: { delayMs: 5000 } });
  const failedBefore = (await getState()).messages.filter((m) => m.failed).length;
  assert.equal((await api("POST", "/api/messages", { author: "user", thread: "grok", topicId: topic2, text: "キャンセル試験" })).status, 201);
  const run = await waitFor(async () => ((await getState()).runs || []).find((r) => r.agent === "grok" && r.kind === "thread"), "grok run visible");
  assert.equal((await api("POST", "/api/runs/" + run.runId + "/cancel")).status, 202);
  const s = await waitFor(async () => {
    const st = await getState();
    return st.messages.some((m) => m.topicId === topic2 && m.thread === "grok" && m.cancelled) ? st : null;
  }, "⏹ line");
  assert.equal(s.messages.filter((m) => m.failed).length, failedBefore, "⚠ 行は増えない");
  assert.equal(s.agents.grok.availability, "available", "キャンセルで可用性を動かさない");
});

test("手動リセット: unknown を未評価（null）へ戻せる。available へは上がらない（指摘#3）", async () => {
  writeCtl({ claude: { fail: true } });
  await api("POST", "/api/messages", { author: "user", thread: "claude", topicId: topic2, text: "unknown にする" });
  await waitFor(async () => (await getState()).agents.claude.availability === "unknown", "claude unknown");
  const r = await api("PATCH", "/api/agents/claude", { resetAvailability: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.availability, null, "未評価へ戻る（available と断定しない）");
  writeCtl({});
});

test("再確認プローブにも分類が適用される: 402→unavailable／成功→available（受入⑨）", async () => {
  writeCtl({ grok: { fail402: true } });
  const r1 = await api("POST", "/api/agents/grok/check-auth");
  assert.equal(r1.status, 200);
  let s = await getState();
  assert.equal(s.agents.grok.availability, "unavailable", JSON.stringify(r1.body));
  writeCtl({ grok: { pingFail: true } });
  const rU = await api("POST", "/api/agents/grok/check-auth");
  assert.equal(rU.status, 200);
  s = await getState();
  assert.equal(s.agents.grok.availability, "unknown", "判定不能は unknown");
  assert.ok(!s.agents.grok.lastError.includes("FAKE_REVIEW_TOKEN"), "架空秘密が lastError に残らない: " + s.agents.grok.lastError);
  assert.ok(!JSON.stringify(s.events || []).includes("FAKE_REVIEW_TOKEN"), "架空秘密が events にも残らない（SSE・運用画面に流れるため）");
  writeCtl({});
  const r2 = await api("POST", "/api/agents/grok/check-auth");
  assert.equal(r2.status, 200);
  s = await getState();
  assert.equal(s.agents.grok.availability, "available");
  assert.equal(s.agents.grok.authed, true);
  assert.equal(s.agents.grok.lastError, "", "available へ戻すとき旧エラーを残さない");
});
