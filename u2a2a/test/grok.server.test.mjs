// Grok 参戦（多者構成）— サーバ統合テスト（仕様: SPEC-Grok参戦.md「テスト」）
// server.mjs を一時ディレクトリへ複製し、偽の claude / codex / grok（PATH 先頭）で駆動する。
// HOME も一時ディレクトリに向け、~/.grok/auth.json の有無で認証状態を制御する。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 偽 claude / codex: stdin のプロンプトと引数を記録し、制御どおりに応答する
const FAKE_CLI = (kind) => `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const kind = ${JSON.stringify(kind)};
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(process.env.U2A2A_FAKE_CTL, "utf8")); } catch (e) {}
const c = ctl[kind] || {};
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { prompt += d; });
process.stdin.on("end", () => {
  const n = Date.now() + "-" + Math.random().toString(16).slice(2, 8);
  if (ctl.logDir) fs.writeFileSync(path.join(ctl.logDir, kind + "-" + n + ".json"), JSON.stringify({ kind, argv: process.argv.slice(2), cwd: process.cwd(), prompt, ts: Date.now() }));
  if (c.write) fs.writeFileSync(path.join(ctl.poolDir, c.write.file), c.write.content);
  setTimeout(() => {
    if (c.fail) { process.stderr.write("fake failure"); process.exit(1); }
    const text = c.text || "了解";
    const line = kind === "claude"
      ? JSON.stringify({ type: "result", result: text, session_id: "fake-" + n, usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.001, modelUsage: { "claude-fake": {} } })
      : JSON.stringify({ type: "thread.started", thread_id: "fake-thread" });
    if (kind === "codex") {
      const i = process.argv.indexOf("-o");
      if (i > 0) fs.writeFileSync(process.argv[i + 1], text);
    }
    process.stdout.write(line + "\\n", () => process.exit(0));
  }, c.delayMs || 0);
});
`;

// 偽 grok: --prompt-file を読んで記録し、streaming-json（工程 0 の実測形式）で応答する。-p ping は認証プローブ
const FAKE_GROK = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(process.env.U2A2A_FAKE_CTL, "utf8")); } catch (e) {}
const c = ctl.grok || {};
const argv = process.argv.slice(2);
const n = Date.now() + "-" + Math.random().toString(16).slice(2, 8);
const home = process.env.HOME || "";
const authed = fs.existsSync(path.join(home, ".grok", "auth.json"));
if (!authed || c.unauthed) {
  process.stdout.write(JSON.stringify({ type: "error", message: "Not signed in. Run grok login." }) + "\\n", () => process.exit(1));
} else if (argv.includes("-p")) {
  process.stdout.write(JSON.stringify({ text: "pong", stopReason: "end_turn", sessionId: "g-ping", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.0001, modelUsage: { "grok-4.6-build": {} } }) + "\\n", () => process.exit(0));
} else {
  const i = argv.indexOf("--prompt-file");
  const prompt = i >= 0 ? fs.readFileSync(argv[i + 1], "utf8") : "";
  if (ctl.logDir) fs.writeFileSync(path.join(ctl.logDir, "grok-" + n + ".json"), JSON.stringify({ kind: "grok", argv, cwd: process.cwd(), prompt, ts: Date.now() }));
  if (c.write) fs.writeFileSync(path.join(ctl.poolDir, c.write.file), c.write.content);
  const r = argv.indexOf("--resume");
  const sid = r >= 0 ? argv[r + 1] : "g-" + n;
  setTimeout(() => {
    const text = c.text || "了解（Grok）";
    const lines = [
      JSON.stringify({ type: "thought", delta: "…" }),
      JSON.stringify({ type: "text", data: text.slice(0, 3) }),
      JSON.stringify({ type: "text", data: text.slice(3) }),
      JSON.stringify({ type: "end", stopReason: c.stopReason || "end_turn", sessionId: sid, usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 }, num_turns: 1, total_cost_usd: 0.002, modelUsage: { "grok-4.6-build": { costUSD: 0.002 } } }),
    ];
    process.stdout.write(lines.join("\\n") + "\\n", () => process.exit(0));
  }, c.delayMs || 0);
}
`;

let tmp, appDir, poolDir, fakeBin, ctlFile, logDir, home, port, server;
let topicOld, topic3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeCtl = (obj) => fs.writeFileSync(ctlFile, JSON.stringify({ poolDir, logDir, ...obj }));
const authFile = () => path.join(home, ".grok", "auth.json");
const setAuth = (on) => {
  fs.mkdirSync(path.dirname(authFile()), { recursive: true });
  if (on) fs.writeFileSync(authFile(), "{}");
  else fs.rmSync(authFile(), { force: true });
};
function cliCalls(kind) {
  return fs
    .readdirSync(logDir)
    .filter((f) => !kind || f.startsWith(kind + "-"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(logDir, f), "utf8")))
    .sort((a, b) => b.ts - a.ts);
}
const clearCalls = () => {
  for (const f of fs.readdirSync(logDir)) fs.unlinkSync(path.join(logDir, f));
};

async function api(method, p, body) {
  const r = await fetch("http://127.0.0.1:" + port + p, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await r.json();
  } catch {
    // 本文なし
  }
  return { status: r.status, body: json };
}
const getState = async () => (await api("GET", "/api/state")).body;
const getTopic = async (id) => (await getState()).topics.find((t) => t.id === id);
const msgsOf = async (id) => (await getState()).messages.filter((m) => m.topicId === id);

async function waitFor(fn, label, ms = 45000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout: " + label);
    await sleep(100);
  }
}
const busy = (s) => Object.values(s.running || {}).some(Boolean) || Object.keys(s.fixPending || {}).length || Object.keys(s.reviewPending || {}).length || Object.keys(s.runs || {}).length;
const idle = () => waitFor(async () => {
  const s = await getState();
  return busy(s) ? null : s;
}, "idle");
async function say(topicId, thread, text) {
  const before = (await msgsOf(topicId)).length;
  const r = await api("POST", "/api/messages", { topicId, thread, text, author: "user" });
  assert.ok(r.status < 300, "POST /api/messages: " + r.status + " " + JSON.stringify(r.body));
  await waitFor(async () => (await msgsOf(topicId)).length >= before + 2, "reply in " + topicId);
  await idle();
  return msgsOf(topicId);
}

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
      return (await fetch("http://127.0.0.1:" + port + "/api/state")).ok;
    } catch {
      return false;
    }
  }, "server start: " + err, 15000);
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

// schemaVersion 6 の state.json（participants 無し）
function legacyState() {
  const agents = () => ({ claude: { sessionId: null, lastSeenTs: 1, transcriptOffset: null }, codex: { sessionId: null, lastSeenTs: 1, transcriptOffset: null } });
  return {
    schemaVersion: 6,
    messages: [{ id: "m1", topicId: "0000000000000001", thread: "claude", author: "user", text: "hi", ts: 1, provenance: { ingress: "ui", delivery: "direct", trigger: "manual", source: null } }],
    tasks: [],
    pool: [],
    projects: [],
    topics: [{ id: "0000000000000001", title: "旧トピック", ts: 1, relay: { active: false, remaining: 0, hopsDone: 0 }, agents: agents(), projectId: null, projectLocked: false }],
    agents: { claude: { auto: true }, codex: { auto: true } },
  };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u2a2a-grok-"));
  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "package.json", "public/flow-graph.js", "public/usage.js"]) fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  poolDir = path.join(appDir, "pool");
  fs.mkdirSync(poolDir);
  fs.mkdirSync(path.join(appDir, "data"));
  fs.writeFileSync(path.join(appDir, "data", "state.json"), JSON.stringify(legacyState(), null, 2));
  home = path.join(tmp, "home");
  fs.mkdirSync(home);
  setAuth(true);
  fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  for (const k of ["claude", "codex"]) fs.writeFileSync(path.join(fakeBin, k), FAKE_CLI(k), { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "grok"), FAKE_GROK, { mode: 0o755 });
  ctlFile = path.join(tmp, "ctl.json");
  logDir = path.join(tmp, "calls");
  fs.mkdirSync(logDir);
  writeCtl({});
  await startServer();
  topicOld = (await getState()).topics[0].id;
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("移行と起動: 旧トピックは 2 名、grok の定義と認証判定、agentDefs", async () => {
  const s = await waitFor(async () => {
    const st = await getState();
    return st.agents.grok && st.agents.grok.authCheckedTs ? st : null;
  }, "grok auth check");
  assert.deepEqual(s.topics[0].participants, ["claude", "codex"]);
  assert.equal(s.topics[0].agents.grok, undefined, "旧トピックに grok のセッションは作らない");
  assert.equal(s.agents.grok.authed, true);
  assert.deepEqual(Object.keys(s.agentDefs), ["claude", "codex", "grok"]);
  assert.equal(s.agentDefs.grok.name, "Grok");
  assert.equal(s.schemaVersion, 10); // schemaVersion 10: agentOutcomes（仕様: SPEC-アバター状態.md） // schemaVersion 9: topic.relayHistory（仕様: SPEC-relayHistory.md） // schemaVersion 8: topic.summaryState（仕様: SPEC-要約鮮度.md）
  const models = (await api("GET", "/api/models")).body;
  assert.ok(models.grok.includes("grok-4.6-build"));
});

test("未認証: 参加・宛先・依頼を送信前に拒否し、再確認で解除される", async () => {
  setAuth(false);
  const c1 = await api("POST", "/api/agents/grok/check-auth");
  assert.equal(c1.body.authed, false);
  assert.match(c1.body.message, /未認証/);
  const t = await api("POST", "/api/topics", { title: "x", participants: ["claude", "grok"] });
  assert.equal(t.status, 400);
  assert.equal(t.body.reason, "unauthed");
  // 既定参加者は認証済みの全員 → grok を含まない
  const t2 = await api("POST", "/api/topics", { title: "既定" });
  assert.deepEqual(t2.body.participants, ["claude", "codex"]);
  setAuth(true);
  assert.equal((await api("POST", "/api/agents/grok/check-auth")).body.authed, true);
  const t3 = await api("POST", "/api/topics", { title: "既定2" });
  assert.deepEqual(t3.body.participants, ["claude", "codex", "grok"]);
});

test("3 名トピック: 作成・参加者外の宛先は 400・旧トピックへ grok 宛ては 400", async () => {
  const t = await api("POST", "/api/topics", { title: "三者", participants: ["claude", "grok", "codex"] });
  assert.equal(t.status, 201);
  assert.deepEqual(t.body.participants, ["claude", "grok", "codex"]);
  assert.ok(t.body.agents.grok, "参加者分のセッション枠");
  topic3 = t.body.id;
  const bad = await api("POST", "/api/messages", { topicId: topicOld, thread: "grok", text: "hi", author: "user" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /参加者/);
  assert.equal((await api("POST", "/api/topics", { title: "x", participants: ["nobody"] })).status, 400);
  assert.equal((await api("POST", "/api/topics", { title: "x", participants: [] })).status, 400);
});

test("Grok 応答: prompt-file・allow 規則・spawn_subagent 除外・参加者の列挙・meta。resume でも権限を毎回渡す", async () => {
  clearCalls();
  writeCtl({ grok: { text: "はじめまして、Grok です" } });
  let msgs = await say(topic3, "grok", "自己紹介して");
  let reply = msgs[msgs.length - 1];
  assert.equal(reply.author, "grok");
  assert.equal(reply.text, "はじめまして、Grok です");
  assert.equal(reply.meta.model, "grok-4.6-build");
  assert.deepEqual(reply.meta.billing, { mode: "metered", usd: 0.002 });
  assert.deepEqual(reply.meta.usage, { inTok: 10, outTok: 5, cacheTok: 2 });
  let call = cliCalls("grok")[0];
  assert.ok(call.argv.includes("--prompt-file"));
  assert.ok(call.argv.includes("streaming-json"));
  assert.ok(call.argv.includes("Edit(u2a2a/pool/**)"));
  // 方針変更（2026-09-10 実測）: 1 行の python3 / ffmpeg と内蔵生成スイートを許可し、プロンプト注意で誘導する
  assert.ok(call.argv.includes("Bash(python3:*)") && call.argv.includes("Bash(ffmpeg:*)"), "1 行シェルの allow");
  assert.ok(call.argv.includes("image_gen") && call.argv.includes("image_to_video"), "生成スイートの allow");
  const di = call.argv.indexOf("--disallowed-tools");
  assert.ok(di >= 0 && call.argv[di + 1] === "spawn_subagent", "サブエージェントのみ除外");
  assert.ok(!call.argv.includes("--resume"));
  assert.ok(call.prompt.includes("参加者はユーザー・Claude Code・Grok（あなた）・Codex です"), call.prompt.slice(0, 400));
  assert.ok(call.prompt.includes("書き込みは u2a2a/pool/ 配下のみ"));
  assert.ok(!fs.existsSync(call.argv[call.argv.indexOf("--prompt-file") + 1]), "一時ファイルは削除される");
  assert.equal((await getState()).agents.grok.lastError, "");
  // 2 回目: --resume 付きでも allow 規則を渡す
  clearCalls();
  msgs = await say(topic3, "grok", "続き");
  call = cliCalls("grok")[0];
  const ri = call.argv.indexOf("--resume");
  assert.ok(ri >= 0 && call.argv[ri + 1] === reply.meta ? true : ri >= 0, "--resume 付き");
  assert.ok(call.argv.includes("Edit(u2a2a/pool/**)"), "resume でも権限を毎回渡す");
  // 停止（cancelled）: 本文と費用を保持し、ヘッダに停止理由
  clearCalls();
  writeCtl({ grok: { text: "途中まで", stopReason: "cancelled" } });
  msgs = await say(topic3, "grok", "外に書いて");
  reply = msgs[msgs.length - 1];
  assert.equal(reply.text, "途中まで");
  assert.equal(reply.meta.status, "stopped");
  assert.equal(reply.meta.billing.usd, 0.002);
  assert.match((await getState()).agents.grok.lastError, /権限要求または中断で停止/);
  writeCtl({});
  // Codex 宛て（3 名トピック）の従来どおりの応答
  msgs = await say(topic3, "codex", "Codex さんも");
  assert.equal(msgs[msgs.length - 1].author, "codex");
  assert.match((await getState()).agents.grok.lastError, /権限要求または中断で停止/, "他の応答成功で消えない — grok のエラーは grok の応答でのみ更新");
});

test("リレー 3 名: 手番順・全員配送・seq・手数到達の停止・最終手の配送・手番外の起動抑止・終了後の経緯", async () => {
  clearCalls();
  writeCtl({ claude: { text: "Claude の見解" }, grok: { text: "Grok の見解", delayMs: 1200 }, codex: { text: "Codex の見解" } });
  const before = (await msgsOf(topic3)).length;
  const qa = await api("POST", "/api/qa/start", { first: "claude", text: "リレー試験", hops: 4, topicId: topic3 });
  assert.equal(qa.status, 201, JSON.stringify(qa.body));
  assert.deepEqual(qa.body.relay.participants, ["claude", "grok", "codex"]);
  assert.ok(qa.body.relay.id.startsWith("r_"));
  // grok の手番（遅延中）に codex へユーザー発言 → 手番まで codex は応答しない
  await waitFor(async () => (await getTopic(topic3)).relay.turn === 1, "grok の手番");
  await api("POST", "/api/messages", { topicId: topic3, thread: "codex", text: "割り込み", author: "user" });
  await sleep(700);
  const mid = await getState();
  assert.equal(mid.topics.find((t) => t.id === topic3).relay.turn, 1, "まだ grok の手番");
  assert.ok(!mid.messages.some((m) => m.topicId === topic3 && m.author === "codex" && m.ts > mid.topics.find((t) => t.id === topic3).relay.startTs), "codex は手番外で応答しない");
  await waitFor(async () => !(await getTopic(topic3)).relay.active, "relay end");
  await idle();
  const t = await getTopic(topic3);
  assert.equal(t.relay.stopReason, "hops");
  const all = (await msgsOf(topic3)).slice(before);
  const replies = all.filter((m) => m.author !== "user" && m.provenance.delivery === "direct");
  assert.deepEqual(replies.map((m) => m.author), ["claude", "grok", "codex", "claude", "grok"], "手番順に 5 応答（hops 4）");
  const copies = all.filter((m) => m.provenance.delivery === "qa-relay");
  assert.equal(copies.length, 10, "各応答が他の 2 名へ配送される（最終手も配送）");
  assert.ok(copies.every((m) => m.provenance.source.relayId === t.relay.id && Number.isInteger(m.provenance.source.seq)));
  assert.deepEqual([...new Set(copies.map((m) => m.provenance.source.seq))].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  assert.deepEqual(t.relay.spoken, { claude: 2, grok: 2, codex: 1 });
  // codex の 3 手目のプロンプトには claude・grok 両方の発言が入る（共通履歴）
  const codexCall = cliCalls("codex").find((c) => c.prompt.includes("リレー試験") || c.prompt.includes("Claude の見解"));
  assert.ok(codexCall && codexCall.prompt.includes("Claude の見解") && codexCall.prompt.includes("Grok の見解"), "全員の発言が見える");
  assert.ok(codexCall.prompt.includes("手番順: Claude Code → Grok → Codex"));
  // 終了後: 残った配送コピー（grok の最終応答）は次の通常応答で「返信不要」の経緯として渡る
  clearCalls();
  await say(topic3, "codex", "リレーの後で");
  const after = cliCalls("codex")[0];
  assert.ok(after.prompt.includes("【終了した質疑の経緯・返信不要】"), after.prompt.slice(-800));
});

test("リレー 3 名: 全員発言後の【質疑終了】だけが有効（agreed）", async () => {
  writeCtl({ claude: { text: "論点です" }, grok: { text: "賛成です【質疑終了】" }, codex: { text: "補足します" } });
  const before = (await msgsOf(topic3)).length;
  const qa = await api("POST", "/api/qa/start", { first: "claude", text: "合意試験", hops: 8, topicId: topic3 });
  assert.equal(qa.status, 201);
  await waitFor(async () => !(await getTopic(topic3)).relay.active, "relay end");
  await idle();
  const t = await getTopic(topic3);
  assert.equal(t.relay.stopReason, "agreed");
  const replies = (await msgsOf(topic3)).slice(before).filter((m) => m.author !== "user" && m.provenance.delivery === "direct");
  // grok の初回の終了宣言（codex 未発言）は無効 → 一巡して grok の 2 回目で成立
  assert.deepEqual(replies.map((m) => m.author), ["claude", "grok", "codex", "claude", "grok"]);
  assert.ok(t.relay.remaining > 0, "手数を残して合意で止まる");
  writeCtl({});
});

test("リレー 2 名（旧トピック）: 従来どおり動き、質疑を停止すると manual", async () => {
  writeCtl({ claude: { text: "A" }, codex: { text: "B【質疑終了】" } });
  const before = (await msgsOf(topicOld)).length;
  const qa = await api("POST", "/api/qa/start", { first: "claude", text: "2名", hops: 6, topicId: topicOld });
  assert.equal(qa.status, 201);
  assert.deepEqual(qa.body.relay.participants, ["claude", "codex"]);
  await waitFor(async () => !(await getTopic(topicOld)).relay.active, "relay end");
  await idle();
  const t = await getTopic(topicOld);
  assert.equal(t.relay.stopReason, "agreed");
  const replies = (await msgsOf(topicOld)).slice(before).filter((m) => m.author !== "user" && m.provenance.delivery === "direct");
  assert.deepEqual(replies.map((m) => m.author), ["claude", "codex"]);
  // 手動停止
  writeCtl({ claude: { text: "A", delayMs: 1500 }, codex: { text: "B" } });
  await api("POST", "/api/qa/start", { first: "claude", text: "停止試験", hops: 6, topicId: topicOld });
  await sleep(300);
  await api("POST", "/api/qa/stop", { topicId: topicOld });
  assert.equal((await getTopic(topicOld)).relay.stopReason, "manual");
  await idle();
  writeCtl({});
});

test("未読の切り詰め: 11 件以上の未読は末尾 10 件＋参照注記", async () => {
  clearCalls();
  writeCtl({ codex: { text: "OK", delayMs: 1200 } });
  await api("POST", "/api/messages", { topicId: topicOld, thread: "codex", text: "先頭", author: "user" });
  await sleep(200);
  for (let i = 0; i < 12; i++) await api("POST", "/api/messages", { topicId: topicOld, thread: "codex", text: "追加 " + i, author: "user" });
  await waitFor(async () => cliCalls("codex").length >= 2, "second codex run");
  await idle();
  const second = cliCalls("codex").sort((a, b) => a.ts - b.ts)[1];
  assert.ok(second.prompt.includes("これ以前の未読 2 件は"), second.prompt.slice(0, 600));
  assert.ok(second.prompt.includes("追加 11") && !second.prompt.includes("追加 0\\n"), "末尾 10 件だけ本文に入る");
  writeCtl({});
});

test("レビュー依頼先: 既定・指定・作者本人は 400・未認証は skipped・手動は 400・grok のレビューは read-only・修正は allow・offline", async () => {
  // 既定: 作者以外の参加者
  const a = await api("POST", "/api/pool", { origin: "codex", title: "案A", body: "本文", topicId: topic3, autoReview: false });
  assert.equal(a.status, 201);
  assert.deepEqual(a.body.reviewers, ["claude", "grok"]);
  const u = await api("POST", "/api/pool", { origin: "user", title: "案U", body: "本文", topicId: topic3, autoReview: false });
  assert.deepEqual(u.body.reviewers, ["claude", "grok", "codex"]);
  const old = await api("POST", "/api/pool", { origin: "codex", title: "旧", body: "本文", topicId: topicOld, autoReview: false });
  assert.deepEqual(old.body.reviewers, ["claude"], "旧トピックは従来どおり相手 1 名");
  assert.equal((await api("POST", "/api/pool", { origin: "codex", title: "x", body: "b", topicId: topic3, autoReview: false, reviewers: ["codex"] })).status, 400, "作者本人");
  assert.equal((await api("POST", "/api/pool", { origin: "codex", title: "x", body: "b", topicId: topicOld, autoReview: false, reviewers: ["grok"] })).status, 400, "参加者外");
  const g = await api("POST", "/api/pool", { origin: "claude", title: "案G", body: "本文", topicId: topic3, autoReview: false, reviewers: ["grok"] });
  assert.deepEqual(g.body.reviewers, ["grok"]);
  // 自動レビューで grok 未認証 → skipped、claude は実施
  setAuth(false);
  await api("POST", "/api/agents/grok/check-auth");
  writeCtl({ claude: { text: "見ました\\n【判定】承認" } });
  const s = await api("POST", "/api/pool", { origin: "codex", title: "案S", body: "本文", topicId: topic3 });
  await idle();
  const si = (await getState()).pool.find((p) => p.id === s.body.id);
  const skipped = si.reviews.find((r) => r.reviewer === "grok");
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, "未認証");
  assert.equal(si.reviews.find((r) => r.reviewer === "claude").verdict, "承認");
  assert.equal((await api("POST", "/api/pool/" + si.id + "/review", { reviewer: "grok" })).status, 400, "手動依頼は 400");
  setAuth(true);
  await api("POST", "/api/agents/grok/check-auth");
  // grok のレビュー（read-only）と offline
  clearCalls();
  writeCtl({ grok: { text: "問題なし\\n【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + si.id + "/review", { reviewer: "grok", offline: true })).status, 202);
  await idle();
  let call = cliCalls("grok")[0];
  const sb = call.argv.indexOf("--sandbox");
  assert.ok(sb >= 0 && call.argv[sb + 1] === "read-only");
  assert.ok(!call.argv.includes("Edit(u2a2a/pool/**)"));
  assert.ok(call.argv.includes("--disable-web-search"));
  assert.ok(call.prompt.includes("オフライン指定"));
  const gi = (await getState()).pool.find((p) => p.id === si.id);
  assert.equal(gi.reviews.filter((r) => r.reviewer === "grok" && !r.skipped)[0].verdict, "承認");
  // grok の修正（allow 規則・cwd=リポジトリルート）。再レビューは実際にレビューした人（claude）へ
  clearCalls();
  writeCtl({ grok: { text: "直しました", write: { file: si.file, content: "本文 v2\\n" } }, claude: { text: "再確認\\n【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + si.id + "/fix", { agent: "grok" })).status, 202);
  await waitFor(async () => ((await getState()).pool.find((p) => p.id === si.id).fixes || []).length === 1, "fix");
  await idle();
  call = cliCalls("grok").find((c) => c.prompt.includes("修正する担当"));
  assert.ok(call.argv.includes("Edit(u2a2a/pool/**)") && !call.argv.includes("--sandbox"));
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(tmp));
  assert.ok(call.prompt.includes("u2a2a/pool/" + si.file + "（リポジトリルートからの相対パス）"));
  const fi = (await getState()).pool.find((p) => p.id === si.id);
  assert.equal(fi.fixes[0].error, undefined);
  const reReviewers = fi.reviews.slice(-1).map((r) => r.reviewer);
  assert.deepEqual(reReviewers, ["claude"], "修正後は実施済みレビュアー（修正者以外）へ");
  assert.equal((await api("POST", "/api/pool/" + si.id + "/fix", { agent: "codex" })).status, 202, "codex は参加者");
  await idle();
  assert.equal((await api("POST", "/api/pool/" + old.body.id + "/fix", { agent: "grok" })).status, 400, "旧トピックの成果物に grok は依頼できない");
  writeCtl({});
});

test("転送・引き継ぎ: 3 名では toAgent 必須、2 名では省略可", async () => {
  const m3 = (await msgsOf(topic3)).find((m) => m.author === "claude" && m.provenance.delivery === "direct");
  const noTo = await api("POST", "/api/relay", { messageId: m3.id });
  assert.equal(noTo.status, 400);
  assert.match(noTo.body.error, /toAgent/);
  writeCtl({ grok: { text: "受け取りました" } });
  const to = await api("POST", "/api/relay", { messageId: m3.id, toAgent: "grok" });
  assert.equal(to.status, 201);
  assert.equal(to.body.thread, "grok");
  assert.equal(to.body.provenance.source.agent, "claude");
  assert.equal((await api("POST", "/api/handoff", { messageId: m3.id, toAgent: "claude" })).status, 400, "自分宛ては候補外");
  await idle();
  const m2 = (await msgsOf(topicOld)).find((m) => m.author === "claude" && m.provenance.delivery === "direct");
  const two = await api("POST", "/api/handoff", { messageId: m2.id });
  assert.equal(two.status, 201);
  assert.equal(two.body.thread, "codex");
  await idle();
  writeCtl({});
});

test("分岐と all 宛て: 参加者の継承／指定、全員宛ての配送前検証", async () => {
  const first = (await msgsOf(topic3))[0];
  const b1 = await api("POST", "/api/topics/" + topic3 + "/branch", { messageId: first.id });
  assert.deepEqual(b1.body.participants, ["claude", "grok", "codex"]);
  const b2 = await api("POST", "/api/topics/" + topic3 + "/branch", { messageId: first.id, participants: ["claude", "codex"] });
  assert.deepEqual(b2.body.participants, ["claude", "codex"]);
  assert.equal(b2.body.agents.grok, undefined);
  // all: 3 名へ配送
  const before = (await msgsOf(topic3)).length;
  const all = await api("POST", "/api/messages", { topicId: topic3, thread: "all", text: "全員へ", author: "user" });
  assert.equal(all.status, 201);
  assert.deepEqual(all.body.map((m) => m.thread), ["claude", "grok", "codex"]);
  await waitFor(async () => (await msgsOf(topic3)).length >= before + 6, "3 replies");
  await idle();
  // grok 未認証なら all は一部配送せず 400
  setAuth(false);
  await api("POST", "/api/agents/grok/check-auth");
  const cnt = (await msgsOf(topic3)).length;
  const rej = await api("POST", "/api/messages", { topicId: topic3, thread: "all", text: "全員へ2", author: "user" });
  assert.equal(rej.status, 400);
  assert.equal(rej.body.reason, "unauthed");
  assert.equal((await msgsOf(topic3)).length, cnt, "一部だけ届く状態を作らない");
  // both は claude+codex が参加者なら可（3 名トピックでも）
  const both = await api("POST", "/api/messages", { topicId: topic3, thread: "both", text: "両者へ", author: "user" });
  assert.equal(both.status, 201);
  assert.deepEqual(both.body.map((m) => m.thread), ["claude", "codex"]);
  await idle();
  setAuth(true);
  await api("POST", "/api/agents/grok/check-auth");
});

test("再起動: 参加者・依頼先が保持され、grok の認証は再判定される", async () => {
  await sleep(1000);
  await stopServer();
  await startServer();
  const s = await waitFor(async () => {
    const st = await getState();
    return st.agents.grok.authCheckedTs ? st : null;
  }, "re-probe");
  assert.deepEqual(s.topics.find((t) => t.id === topic3).participants, ["claude", "grok", "codex"]);
  assert.deepEqual(s.topics.find((t) => t.id === topicOld).participants, ["claude", "codex"]);
  assert.equal(s.agents.grok.authed, true);
  assert.ok(s.pool.every((p) => Array.isArray(p.reviewers)));
  assert.equal(s.topics.find((t) => t.id === topic3).relay.active, false);
});


test("Grok CLI取消: 発言に未計測metaを保存する", async () => {
  clearCalls();
  writeCtl({ grok: { delayMs: 5000 } });
  const result = await api("POST", "/api/messages", { author: "user", thread: "grok", topicId: topic3, text: "取消対象" });
  assert.equal(result.status, 201);
  await waitFor(() => cliCalls("grok").length, "grok CLI started");
  const run = (await getState()).runs.find(r => r.agent === "grok" && r.kind === "thread");
  assert.ok(run);
  assert.equal((await api("POST", "/api/runs/" + run.runId + "/cancel", {})).status, 202);
  await idle();
  const record = (await msgsOf(topic3)).filter(m => m.author === "grok").at(-1);
  assert.equal(record.meta.status, "cancelled");
  assert.equal(record.meta.billing.mode, "unknown");
  assert.deepEqual(record.meta.usage, { inTok: null, outTok: null, cacheTok: null });
  writeCtl({});
});
