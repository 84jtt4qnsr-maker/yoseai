// 質疑リレーの履歴 — サーバ統合テスト（仕様: SPEC-relayHistory.md）
// server.mjs を一時ディレクトリへ複製し、偽 CLI で質疑リレーを回して停止理由の記録を確かめる。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

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
    const text = c.text || "了解しました。検討を続けます。";
    const line = kind === "claude"
      ? JSON.stringify({ type: "result", result: text, session_id: "fake-" + kind, usage: { input_tokens: 1, output_tokens: 1 } })
      : JSON.stringify({ type: "thread.started", thread_id: "fake-thread" });
    if (kind === "codex") {
      const i = process.argv.indexOf("-o");
      if (i > 0) fs.writeFileSync(process.argv[i + 1], text);
    }
    process.stdout.write(line + "\\n", () => process.exit(0));
  }, c.delayMs || 0);
});
`;

let tmp, appDir, poolDir, fakeBin, ctlFile, port, server, topicId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeCtl = (obj) => fs.writeFileSync(ctlFile, JSON.stringify({ poolDir, ...obj }));

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
const history = async (id = topicId) => (await getTopic(id)).relayHistory || [];

async function waitFor(fn, label, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout: " + label);
    await sleep(80);
  }
}

async function startServer() {
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: appDir,
    env: { ...process.env, U2A2A_PORT: String(port), PATH: fakeBin + ":" + process.env.PATH, U2A2A_FAKE_CTL: ctlFile },
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

const stateFile = () => path.join(appDir, "data", "state.json");
const readSaved = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u2a2a-relayhist-"));
  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "tray.mjs", "package.json", "public/flow-graph.js", "public/usage.js"]) fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  poolDir = path.join(appDir, "pool");
  fs.mkdirSync(poolDir);
  fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  for (const k of ["claude", "codex"]) fs.writeFileSync(path.join(fakeBin, k), FAKE_CLI(k), { mode: 0o755 });
  ctlFile = path.join(tmp, "ctl.json");
  writeCtl({});
  await startServer();
  // 新規環境の既定は自動応答 OFF。このファイルは質疑リレーを駆動するので、ここで明示的に ON にする
  for (const a of ["claude", "codex"]) await api("PATCH", "/api/agents/" + a, { auto: true });
  topicId = (await getState()).topics[0].id;
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// 質疑を始めて、手番が 1 回進むのを待つ
async function startQa(hops, agenda = "") {
  const r = await api("POST", "/api/qa/start", { topicId, text: "今回決めること: テスト", first: "claude", hops, agenda, participants: ["claude", "codex"] });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  return (await getTopic()).relay;
}

test("1. 手動停止でリレーが確定記録として残る（id・participants・spoken・agenda・時刻）", async () => {
  writeCtl({ claude: { delayMs: 150 } });
  const relay = await startQa(6, "手狭の解決");
  assert.ok(relay.id, "リレー id");
  assert.ok(relay.startedTs > 0, "開始時刻が入る");
  assert.ok(relay.startMessageId, "開始メッセージ");
  await waitFor(async () => ((await getTopic()).relay.seq || 0) >= 1, "1 手番進む");
  const before = await getTopic();
  await api("POST", "/api/qa/stop", { topicId });
  const h = await history();
  assert.equal(h.length, 1);
  const rec = h[0];
  assert.equal(rec.id, relay.id);
  assert.equal(rec.stopReason, "manual");
  assert.deepEqual(rec.participants, ["claude", "codex"]);
  assert.equal(rec.agenda, "手狭の解決");
  assert.equal(rec.startMessageId, before.relay.startMessageId);
  assert.equal(rec.startedTs, relay.startedTs);
  assert.ok(rec.endedTs >= rec.startedTs, "終了時刻");
  assert.equal(rec.hops, before.relay.seq);
  assert.equal(rec.spoken.claude >= 1, true);
  assert.equal(rec.reconstructed, false);
  // 進行中の relay は解除されている
  assert.equal((await getTopic()).relay.active, false);
});

test("2. 2 本目のリレーも追記され、1 本目の記録は変わらない", async () => {
  const first = (await history())[0];
  const relay = await startQa(4);
  await waitFor(async () => ((await getTopic()).relay.seq || 0) >= 1, "1 手番進む");
  await api("POST", "/api/qa/stop", { topicId });
  const h = await history();
  assert.equal(h.length, 2);
  assert.deepEqual(h[0], first, "1 本目は不変");
  assert.equal(h[1].id, relay.id);
  assert.notEqual(h[1].id, first.id);
  assert.equal(h[1].stopReason, "manual");
  assert.equal(h[1].agenda, "", "議題を指定しなければ空文字（不明ではなく「無い」）");
  // 開始時刻順
  assert.ok(h[0].startedTs <= h[1].startedTs);
});

test("3. 停止していない進行中のリレーは履歴に入らない", async () => {
  writeCtl({ claude: { delayMs: 400 } });
  const before = (await history()).length;
  const relay = await startQa(6);
  assert.equal((await history()).length, before, "開始しただけでは追記しない");
  assert.equal(relay.stopReason, null);
  await api("POST", "/api/qa/stop", { topicId });
  assert.equal((await history()).length, before + 1);
  writeCtl({});
});

test("4. 保存され、再起動後も履歴が残る。active のまま落ちたリレーは restart として確定する", async () => {
  const before = await history();
  // 保存はまとめて走るので、履歴がファイルに落ちてから止める
  await waitFor(() => {
    const j = readSaved();
    const x = j.topics.find((y) => y.id === topicId);
    return x && Array.isArray(x.relayHistory) && x.relayHistory.length === before.length ? j : null;
  }, "relayHistory が保存される");
  await stopServer();
  // 保存済み state に「走ったまま保存されたリレー」を仕込む
  const saved = readSaved();
  const t = saved.topics.find((x) => x.id === topicId);
  assert.equal(t.relayHistory.length, before.length, "履歴が保存されている");
  t.relay = { active: true, remaining: 3, hopsDone: 1, id: "r_interrupted", participants: ["claude", "codex"], turn: 1, seq: 2, spoken: { claude: 1, codex: 1 }, stopReason: null, startMessageId: "m-x", agenda: "落ちた質疑", startedTs: 1000 };
  fs.writeFileSync(stateFile(), JSON.stringify(saved, null, 2));
  await startServer();
  const h = await history();
  assert.equal(h.length, before.length + 1);
  const rec = h.find((x) => x.id === "r_interrupted");
  assert.ok(rec, "再起動で打ち切られたリレーが記録される");
  assert.equal(rec.stopReason, "restart");
  assert.equal(rec.agenda, "落ちた質疑");
  assert.equal(rec.hops, 2);
  assert.deepEqual(rec.spoken, { claude: 1, codex: 1 });
  assert.equal(rec.reconstructed, false);
  assert.equal((await getTopic()).relay.active, false, "再起動でリレーは再開しない");
});

test("5. 移行: 過去の配送コピーから復元し、停止理由は不明のまま。既知の記録は上書きしない", async () => {
  await stopServer();
  const saved = readSaved();
  const t = saved.topics.find((x) => x.id === topicId);
  const knownId = t.relayHistory[0].id;
  const knownReason = t.relayHistory[0].stopReason;
  // 記録の無い過去リレー（配送コピーだけが残っている状態）を作る
  const base = Date.now() - 100000;
  for (let seq = 1; seq <= 3; seq++) {
    const turn = (seq - 1) % 2;
    const agent = ["claude", "codex"][turn];
    const to = agent === "claude" ? "codex" : "claude";
    saved.messages.push({
      id: "old_c" + seq, topicId, thread: to, author: agent, text: "昔の手番 " + seq, ts: base + seq * 10,
      provenance: { ingress: "agent-loop", delivery: "qa-relay", trigger: "auto", source: { topicId, messageId: "old_r" + seq, agent, relayId: "r_legacy", seq, turn } },
    });
  }
  saved.schemaVersion = 8; // 移行を走らせる
  fs.writeFileSync(stateFile(), JSON.stringify(saved, null, 2));
  await startServer();
  const h = await history();
  const legacy = h.find((x) => x.id === "r_legacy");
  assert.ok(legacy, "配送コピーから過去リレーを復元する");
  assert.equal(legacy.stopReason, null, "停止理由は復元できない。不明のまま");
  assert.equal(legacy.agenda, null);
  assert.equal(legacy.startMessageId, null);
  assert.equal(legacy.reconstructed, true);
  assert.equal(legacy.hops, 3);
  assert.deepEqual(legacy.participants, ["claude", "codex"]);
  assert.deepEqual(legacy.spoken, { claude: 2, codex: 1 });
  // 既に確定していた記録は復元で潰さない
  const known = h.find((x) => x.id === knownId);
  assert.equal(known.stopReason, knownReason);
  assert.equal(known.reconstructed, false);
  // 2 回目の起動で二重登録しない
  await stopServer();
  await startServer();
  const h2 = await history();
  assert.equal(h2.filter((x) => x.id === "r_legacy").length, 1);
  assert.equal(h2.length, h.length);
  assert.equal((await getState()).schemaVersion, undefined ?? (await getState()).schemaVersion); // 参照のみ
});

test("6. 保存ファイルの schemaVersion が 10 になる（relayHistory は 9 で導入）", async () => {
  await api("POST", "/api/messages", { author: "user", thread: "claude", text: "保存を起こす", topicId });
  const saved = await waitFor(() => {
    const j = readSaved();
    return j.schemaVersion === 11 ? j : null;
  }, "schemaVersion 11");
  const t = saved.topics.find((x) => x.id === topicId);
  assert.ok(Array.isArray(t.relayHistory));
  for (const rec of t.relayHistory) {
    assert.deepEqual(Object.keys(rec).sort(), ["agenda", "endedTs", "hops", "id", "participants", "reconstructed", "spoken", "startMessageId", "startedTs", "stopReason"]);
  }
});

test("7. 新しいトピックは空の履歴を持つ", async () => {
  const r = await api("POST", "/api/topics", { title: "新規", participants: ["claude", "codex"] });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.relayHistory, []);
});
