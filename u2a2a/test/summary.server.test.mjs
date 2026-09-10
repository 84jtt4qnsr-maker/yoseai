// 要約の鮮度 — サーバ統合テスト（仕様: SPEC-要約鮮度.md「テスト」6〜13）
// server.mjs を一時ディレクトリへ複製し、偽 claude CLI（PATH 先頭）で要約を駆動する。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sortByTsId } from "../lib.mjs"; // 「どこまで要約したか」の末尾 ID は数える側と同じ並び順で決まる

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 偽 CLI。制御ファイルで遅延・失敗を切り替える
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
  if (ctl.logFile) fs.appendFileSync(ctl.logFile, kind + "\\n");
  setTimeout(() => {
    if (c.fail) { process.stderr.write("fake summary failure"); process.exit(1); }
    const text = c.text || "## 合意済み\\n- ここまでの合意\\n\\n## 未決\\nなし";
    const line = kind === "claude"
      ? JSON.stringify({ type: "result", result: text, session_id: "fake-session", usage: { input_tokens: 1, output_tokens: 1 } })
      : JSON.stringify({ type: "thread.started", thread_id: "fake-thread" });
    if (kind === "codex") {
      const i = process.argv.indexOf("-o");
      if (i > 0) fs.writeFileSync(process.argv[i + 1], text);
    }
    process.stdout.write(line + "\\n", () => process.exit(0));
  }, c.delayMs || 0);
});
`;

let tmp, appDir, poolDir, fakeBin, ctlFile, logFile, port, server, topicId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeCtl = (obj) => fs.writeFileSync(ctlFile, JSON.stringify({ poolDir, logFile, ...obj }));

async function api(method, p, body) {
  const r = await fetch("http://127.0.0.1:" + port + p, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    // 本文なし
  }
  return { status: r.status, body: json };
}
const getState = async () => (await api("GET", "/api/state")).body;
const getTopic = async (id = topicId) => (await getState()).topics.find((t) => t.id === id);
const status = async (id = topicId) => (await api("GET", "/api/topics/" + id + "/summary-status")).body;

async function waitFor(fn, label, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout: " + label);
    await sleep(80);
  }
}

async function startServer(extraEnv = {}) {
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: appDir,
    env: { ...process.env, U2A2A_PORT: String(port), PATH: fakeBin + ":" + process.env.PATH, U2A2A_FAKE_CTL: ctlFile, ...extraEnv },
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

// 自動応答を止めて、要約だけを観察できるようにする
async function quiet() {
  for (const a of ["claude", "codex", "grok"]) await api("PATCH", "/api/agents/" + a, { auto: false });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u2a2a-summary-"));
  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "package.json", "public/flow-graph.js"]) fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  poolDir = path.join(appDir, "pool");
  fs.mkdirSync(poolDir);
  fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  for (const k of ["claude", "codex"]) fs.writeFileSync(path.join(fakeBin, k), FAKE_CLI(k), { mode: 0o755 });
  ctlFile = path.join(tmp, "ctl.json");
  logFile = path.join(tmp, "cli.log");
  fs.writeFileSync(logFile, "");
  writeCtl({});
  await startServer();
  await quiet();
  topicId = (await getState()).topics[0].id;
  await api("POST", "/api/messages", { author: "user", thread: "claude", text: "最初の発言", topicId });
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 8. 成功
test("8. 手動更新: 走って phase が idle に戻り、summaryTs / summaryAt / summaryLastMsgId が進む", async () => {
  writeCtl({});
  const before = await getTopic();
  assert.equal(before.summaryState.phase, "idle"); // 既定値
  const r = await api("POST", "/api/topics/" + topicId + "/summarize");
  assert.equal(r.status, 202);
  assert.equal(r.body.started, true);
  assert.equal(r.body.state.phase, "running");
  assert.equal(r.body.state.trigger, "manual");
  const t = await waitFor(async () => {
    const x = await getTopic();
    return x.summaryState.phase === "idle" && x.summaryTs ? x : null;
  }, "summary done");
  assert.equal(t.summaryState.reason, null);
  assert.equal(t.summaryState.trigger, "manual");
  assert.ok(t.summaryText.includes("合意済み"));
  const msgs = (await getState()).messages.filter((m) => m.topicId === topicId);
  assert.equal(t.summaryAt, msgs.length);
  assert.equal(t.summaryLastMsgId, sortByTsId(msgs).pop().id);
  assert.equal((await status()).unreflected, 0, "要約直後は未反映 0");
});

// 13. summary-status
test("13. summary-status: 契約どおりの形。未知の topicId は 404", async () => {
  const s = await status();
  assert.deepEqual(Object.keys(s).sort(), ["due", "state", "summaryAt", "summaryLastMsgId", "summaryTs", "threshold", "topicId", "total", "unreflected"]);
  assert.equal(s.topicId, topicId);
  assert.equal(s.threshold, 12);
  assert.equal(s.unreflected, 0); // 直前に要約したので未反映なし
  assert.equal(s.due, false);
  await api("POST", "/api/messages", { author: "user", thread: "claude", text: "要約後の発言", topicId });
  const s2 = await status();
  assert.equal(s2.unreflected, 1);
  assert.equal(s2.total, s.total + 1);
  assert.equal((await api("GET", "/api/topics/nope/summary-status")).status, 404);
});

// 9. 二重起動
test("9. 走行中の再呼び出しは HTTP だけ started:false / already-running。トピックは running のまま。要約は 1 本だけ", async () => {
  writeCtl({ claude: { delayMs: 2000 } });
  fs.writeFileSync(logFile, "");
  const first = await api("POST", "/api/topics/" + topicId + "/summarize");
  assert.equal(first.body.started, true);
  assert.equal(first.body.state.phase, "running");
  const second = await api("POST", "/api/topics/" + topicId + "/summarize");
  assert.equal(second.body.started, false);
  assert.equal(second.body.state.phase, "skipped"); // 応答にだけ返る
  assert.equal(second.body.state.reason, "already-running");
  // 走行中の表示を潰さない。checkSummaries も 30 秒ごとに同じ経路へ入るので、ここで上書きすると「更新中」が消える
  const during = await getTopic();
  assert.equal(during.summaryState.phase, "running");
  assert.equal(during.summaryState.reason, null);
  assert.equal(during.summaryState.startedTs, first.body.state.startedTs, "startedTs も動かさない");
  assert.equal((await status()).state.phase, "running");
  await waitFor(async () => (await getTopic()).summaryState.phase === "idle", "first summary done");
  // already-running は永続しないので、state.json に残って再起動後まで「すでに更新中」が出ることはない
  assert.notEqual((await getTopic()).summaryState.reason, "already-running");
  assert.equal(fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).length, 1);
  writeCtl({});
});

// 10. 失敗
test("10. 失敗すると phase failed・detail に理由。summaryTs は進まない", async () => {
  writeCtl({ claude: { fail: true } });
  const before = await getTopic();
  const r = await api("POST", "/api/topics/" + topicId + "/summarize");
  assert.equal(r.body.started, true);
  const t = await waitFor(async () => {
    const x = await getTopic();
    return x.summaryState.phase === "failed" ? x : null;
  }, "summary failed");
  assert.equal(t.summaryState.reason, "error");
  assert.ok(t.summaryState.detail.length > 0, "detail が空でない");
  assert.equal(t.summaryTs, before.summaryTs); // 進んでいない
  writeCtl({});
});

// 6. 予算上限
test("6. 予算上限中は走らず、budget-cap が残る", async () => {
  // 実行回数の上限を 1 にして上限超過を作る
  await api("PATCH", "/api/budgets", { runCount: 1 });
  assert.equal((await getState()).budgets.runCount, 1, "予算が設定された");
  // 走行中件数ではなく当日の使用回数で判定させる（1 本走らせて確実に上限へ乗せる）
  await api("POST", "/api/topics/" + topicId + "/summarize");
  await waitFor(async () => (await getTopic()).summaryState.phase !== "running", "settle");
  const before = await getTopic();
  const capped = await api("POST", "/api/topics/" + topicId + "/summarize");
  assert.equal(capped.body.started, false);
  assert.equal(capped.body.state.phase, "skipped");
  assert.equal(capped.body.state.reason, "budget-cap");
  assert.ok(capped.body.state.detail.length > 0);
  const after = await getTopic();
  assert.equal(after.summaryState.reason, "budget-cap"); // 見送りはトピックにも残る（無言で消えない）
  assert.equal(after.summaryTs, before.summaryTs); // 要約は走っていない
  await api("PATCH", "/api/budgets", { runCount: 0 });
});

// 7. 予算停止（安全ラッチ）
test("7. budgetHalt 中は走らず、budget-halt と理由が残る", async () => {
  // halt を立てる API は無い（triggerBudgetHalt は上限到達時のみ）。state.json に書いて再起動する
  await stopServer();
  const file = path.join(appDir, "data", "state.json");
  const st = JSON.parse(fs.readFileSync(file, "utf8"));
  st.budgetHalt = { reason: "テスト用の上限到達", ts: Date.now() };
  fs.writeFileSync(file, JSON.stringify(st, null, 2));
  await startServer();
  await quiet();
  fs.writeFileSync(logFile, "");
  const before = await getTopic();
  const halted = await api("POST", "/api/topics/" + topicId + "/summarize");
  assert.equal(halted.body.started, false);
  assert.equal(halted.body.state.phase, "skipped");
  assert.equal(halted.body.state.reason, "budget-halt");
  assert.match(halted.body.state.detail, /テスト用の上限到達/);
  const after = await getTopic();
  assert.equal(after.summaryState.reason, "budget-halt");
  assert.equal(after.summaryTs, before.summaryTs);
  assert.equal(fs.readFileSync(logFile, "utf8").trim(), "", "CLI は呼ばれない");
  await api("POST", "/api/budgets/resume");
  assert.equal((await getState()).budgetHalt, null);
});

// 11. 分岐
test("11. 分岐先は summaryLastMsgId がコピー後の末尾 ID になり、未反映 0", async () => {
  writeCtl({});
  await api("PATCH", "/api/budgets", { runCount: 0 });
  await api("POST", "/api/topics/" + topicId + "/summarize");
  await waitFor(async () => (await getTopic()).summaryState.phase === "idle" && (await getTopic()).summaryTs, "summarized");
  const msgs = (await getState()).messages.filter((m) => m.topicId === topicId);
  const at = msgs[msgs.length - 1];
  const b = await api("POST", "/api/topics/" + topicId + "/branch", { messageId: at.id, participants: ["claude", "codex"] });
  assert.equal(b.status, 201);
  const child = b.body;
  const copies = (await getState()).messages.filter((m) => m.topicId === child.id);
  assert.equal(child.summaryAt, copies.length);
  assert.equal(child.summaryLastMsgId, sortByTsId(copies).pop().id);
  assert.notEqual(child.summaryLastMsgId, at.id); // 親の ID ではない（コピーは新 ID）
  const s = await status(child.id);
  assert.equal(s.unreflected, 0, "分岐直後は最新");
});

// 12. 移行
test("12. schemaVersion 7 の state を読むと summaryState が補われ、running は idle に戻る", async () => {
  await stopServer();
  const file = path.join(appDir, "data", "state.json");
  const st = JSON.parse(fs.readFileSync(file, "utf8"));
  st.schemaVersion = 7;
  delete st.topics[0].summaryState;
  if (st.topics[1]) st.topics[1].summaryState = { phase: "running", reason: null, detail: "", ts: 1, startedTs: 1, trigger: "auto" };
  fs.writeFileSync(file, JSON.stringify(st, null, 2));
  await startServer();
  await quiet();
  const topics = (await getState()).topics;
  for (const t of topics) {
    assert.deepEqual(Object.keys(t.summaryState).sort(), ["detail", "phase", "reason", "startedTs", "trigger", "ts"]);
    assert.notEqual(t.summaryState.phase, "running", "再起動で running のまま固まらない");
  }
  assert.equal(topics[0].summaryState.phase, "idle");
  // schemaVersion は保存時に刻まれる（persistState）。書き込みを起こしてからファイルで確かめる
  await api("POST", "/api/messages", { author: "user", thread: "claude", text: "移行後の発言", topicId });
  const saved = await waitFor(() => {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j.schemaVersion === 8 ? j : null;
  }, "schemaVersion 8 が保存される");
  assert.ok(saved.topics.every((t) => t.summaryState && t.summaryState.phase !== "running"));
});
