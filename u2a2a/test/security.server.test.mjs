// 公開の土台 — 出所の検査（Origin / Host）と初回の安全な既定（合意メモ-公開準備.md の P0）
// Origin ヘッダは node:http の生クライアントで送る（fetch では送れない・上書きされる場合があるため）。
// 偽 CLI は呼び出しをファイルに記録するので、「手動の貼り付けで CLI が起動しない」ことを実測で確かめられる
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 呼ばれたら記録して終わる偽 CLI。grok の認証プローブ（-p）は記録しない（起動時に必ず走るため）
const FAKE_CLI = (kind) => `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const kind = ${JSON.stringify(kind)};
const argv = process.argv.slice(2);
const log = process.env.U2A2A_FAKE_LOG;
const done = (line) => process.stdout.write(line + "\\n", () => process.exit(0));
if (kind === "grok") {
  if (argv.includes("-p")) done(JSON.stringify({ text: "pong", stopReason: "end_turn", sessionId: "g-ping", usage: {}, total_cost_usd: 0 }));
  else { fs.writeFileSync(path.join(log, kind + "-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".json"), JSON.stringify({ kind, argv })); done(JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "g1", usage: {}, total_cost_usd: 0 })); }
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { prompt += d; });
  process.stdin.on("end", () => {
    fs.writeFileSync(path.join(log, kind + "-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".json"), JSON.stringify({ kind, argv, prompt }));
    if (kind === "codex") { const i = argv.indexOf("-o"); if (i >= 0) fs.writeFileSync(argv[i + 1], "了解"); }
    done(kind === "claude"
      ? JSON.stringify({ type: "result", result: "了解", session_id: "c1", usage: { input_tokens: 1, output_tokens: 1 } })
      : JSON.stringify({ type: "thread.started", thread_id: "t1" }));
  });
}
`;

let tmp, appDir, home, fakeBin, logDir, port, server;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origin = () => "http://127.0.0.1:" + port;
const cliCalls = () => fs.readdirSync(logDir);

// 生の HTTP 要求（Origin / Host を自由に指定する）
function raw(method, p, { headers = {}, body = null, hostHeader = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: p, method, headers: { ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}), ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (text += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // 本文が JSON でないことも受け入れる（静的配信など）
          }
          resolve({ status: res.statusCode, body: json, text });
        });
      }
    );
    if (hostHeader) req.setHeader("Host", hostHeader);
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
const api = (method, p, body) => raw(method, p, { body: body === undefined ? null : JSON.stringify(body) });
const getState = async () => (await api("GET", "/api/state")).body;
const messages = async () => (await getState()).messages;

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
    env: { ...process.env, HOME: home, U2A2A_PORT: String(port), PATH: fakeBin + ":" + process.env.PATH, U2A2A_FAKE_LOG: logDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  server.stderr.on("data", (d) => (err += d));
  server.stdout.on("data", () => {});
  await waitFor(async () => {
    try {
      return (await fetch(origin() + "/api/state")).ok;
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

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u2a2a-security-"));
  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "tray.mjs", "package.json", "public/flow-graph.js", "public/usage.js"]) fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html>u2a2a</html>");
  home = path.join(tmp, "home");
  fs.mkdirSync(home);
  fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  for (const k of ["claude", "codex", "grok"]) fs.writeFileSync(path.join(fakeBin, k), FAKE_CLI(k), { mode: 0o755 });
  logDir = path.join(tmp, "cli-calls");
  fs.mkdirSync(logDir);
  await startServer();
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("1. 新規環境の既定は自動応答 OFF（保存値のない state.json を作った直後）", async () => {
  const s = await getState();
  assert.deepEqual(
    Object.fromEntries(Object.keys(s.agents).map((a) => [a, s.agents[a].auto])),
    { claude: false, codex: false, grok: false }
  );
  for (const a of Object.keys(s.agents)) assert.equal(s.agentState.agents[a].global.phase, "off", a);
  // 保存は状態の変化をきっかけに遅延（100ms）で走る。トピックを 1 つ作って保存を促してから読む
  assert.equal((await api("POST", "/api/topics", { title: "保存のきっかけ" })).status, 201);
  const saved = await waitFor(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(appDir, "data", "state.json"), "utf8"));
    } catch {
      return null;
    }
  }, "state.json の保存", 5000);
  assert.equal(saved.agents.claude.auto, false, "保存されたファイルでも OFF");
});

test("2. 手動の貼り付けでは CLI が起動しない。ON にすると起動する", async () => {
  const topicId = (await getState()).topics[0].id;
  // 先に ON で 1 往復し、「この機械で自動応答が CLI を起こすまでの実測時間」を取る。
  // OFF 側は起動しないことの確認なので待つしかないが、固定の秒数ではなく実測の 5 倍（最低 2 秒）待つ。
  // こうすると、機械が遅くて起動が間に合わないだけの偽合格にならない
  assert.equal((await api("PATCH", "/api/agents/claude", { auto: true })).status, 200);
  const t0 = Date.now();
  await api("POST", "/api/messages", { author: "user", thread: "claude", text: "自動で応答する", topicId });
  await waitFor(async () => cliCalls().length > 0, "ON なら CLI が起動する");
  const onLatency = Date.now() - t0;
  assert.equal((await api("PATCH", "/api/agents/claude", { auto: false })).status, 200);
  await waitFor(async () => !Object.values((await getState()).running || {}).some(Boolean), "走っている CLI の終了");

  const baseline = cliCalls().length;
  const posted = await api("POST", "/api/messages", { author: "user", thread: "claude", text: "手動で書いた発言", topicId });
  assert.equal(posted.status, 201);
  await sleep(Math.max(2000, onLatency * 5)); // 自動応答が走るなら、実測時間の 5 倍あれば記録が残っている
  assert.equal(cliCalls().length, baseline, "自動応答 OFF のあいだは CLI を一度も起動しない");
  assert.equal((await messages()).filter((m) => m.text === "手動で書いた発言").length, 1, "発言自体は保存される");
});

test("3. 別 Origin からの POST は本文を読む前に 403。副作用も無い", async () => {
  const topicId = (await getState()).topics[0].id;
  const before = (await messages()).length;
  const body = JSON.stringify({ author: "user", thread: "claude", text: "外部サイトから", topicId });
  const evil = await raw("POST", "/api/messages", { headers: { origin: "https://evil.example" }, body });
  assert.equal(evil.status, 403);
  assert.deepEqual([evil.body.code, evil.body.reason], ["forbidden-origin", "origin"]);

  // enctype="text/plain" のフォーム相当: プリフライト無しで本文を妥当な JSON にできる
  const plain = await raw("POST", "/api/messages", { headers: { origin: "https://evil.example", "content-type": "text/plain" }, body });
  assert.equal(plain.status, 403, "Content-Type や JSON.parse を防御の根拠にしない");

  const nullOrigin = await raw("POST", "/api/messages", { headers: { origin: "null" }, body });
  assert.equal(nullOrigin.status, 403, "file:// や sandbox の iframe");
  assert.equal((await messages()).length, before, "拒否した要求はメッセージを増やさない");
});

test("4. 正規の Origin と、Origin 欠席（curl・テスト）は通る", async () => {
  const topicId = (await getState()).topics[0].id;
  const ok = await raw("POST", "/api/messages", { headers: { origin: origin() }, body: JSON.stringify({ author: "user", thread: "claude", text: "画面から", topicId }) });
  assert.equal(ok.status, 201);
  const noOrigin = await api("POST", "/api/messages", { author: "user", thread: "claude", text: "Origin なし", topicId });
  assert.equal(noOrigin.status, 201);
  const localhost = await raw("POST", "/api/messages", { headers: { origin: "http://localhost:" + port }, body: JSON.stringify({ author: "user", thread: "claude", text: "localhost から", topicId }) });
  assert.equal(localhost.status, 201, "localhost も許可（埋め込みペインが使う場合がある）");
});

test("5. Host が違えば GET も静的配信も 403（DNS リバインディング対策）", async () => {
  const state = await raw("GET", "/api/state", { hostHeader: "evil.example" });
  assert.equal(state.status, 403);
  assert.deepEqual([state.body.code, state.body.reason], ["forbidden-origin", "host"]);
  const html = await raw("GET", "/", { hostHeader: "evil.example" });
  assert.equal(html.status, 403);
  assert.ok(!html.text.includes("u2a2a</html>"), "静的ファイルの中身を返さない");
  assert.equal((await raw("GET", "/", {})).status, 200, "正しい Host なら従来どおり");
  // 許可リストの 3 つを Host ヘッダとして 1 件ずつ通す（接続先は常に 127.0.0.1。到達性ではなく綴りの検査）
  for (const h of ["127.0.0.1:" + port, "localhost:" + port, "[::1]:" + port]) {
    assert.equal((await raw("GET", "/api/state", { hostHeader: h })).status, 200, "許可 Host: " + h);
  }
  assert.equal((await raw("GET", "/api/state", { hostHeader: "127.0.0.1:" + (port + 1) })).status, 403, "ポート違いは 403");
  assert.equal((await raw("GET", "/api/state", { hostHeader: "127.0.0.1" })).status, 403, "ポート無しも 403");
});

test("6. SSE（/api/events）は正規の Origin で継続する", async () => {
  const received = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/api/events", method: "GET", headers: { origin: origin(), accept: "text/event-stream" } }, (res) => {
      if (res.statusCode !== 200) return resolve({ status: res.statusCode, data: "" });
      res.setEncoding("utf8");
      res.once("data", (d) => {
        req.destroy();
        resolve({ status: 200, data: d });
      });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
    req.end();
  });
  assert.equal(received.status, 200);
  assert.ok(received.data.startsWith("data: "), "最初の状態がすぐ流れる");
});

// 保存済み state.json を置いて起動し直し、loadState の移行分岐 4 通りを固定する。
// ここが壊れると、既存ユーザーの ON/OFF が更新で黙って変わる（＝意図しない課金 / 意図しない沈黙）
function savedState(agents) {
  return {
    schemaVersion: 9,
    messages: [],
    tasks: [],
    pool: [],
    projects: [],
    topics: [{ id: "0000000000000001", title: "既存トピック", ts: 1, relay: { active: false, remaining: 0, hopsDone: 0 }, participants: ["claude", "codex"], agents: {}, projectId: null, projectLocked: false }],
    agents,
  };
}

async function restartWith(agents) {
  await stopServer();
  fs.mkdirSync(path.join(appDir, "data"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "data", "state.json"), JSON.stringify(savedState(agents), null, 2));
  await startServer();
  const s = await getState();
  return Object.fromEntries(Object.keys(s.agents).map((a) => [a, s.agents[a].auto]));
}

test("7. 既存 state.json の移行: キー無しだけ OFF、旧形式は ON、保存済み boolean はそのまま", async () => {
  // claude: auto: true → true / codex: キーはあるが auto 無し（旧形式）→ true / grok: キー無し → false
  assert.deepEqual(
    await restartWith({ claude: { auto: true, sessionId: null }, codex: { sessionId: null } }),
    { claude: true, codex: true, grok: false },
    "旧形式（auto 欠落）を OFF に倒さない。後から増えたエージェントだけ OFF"
  );
  // auto: false は false のまま（既定 OFF 化に巻き込まれて true に戻らない）
  assert.deepEqual(
    await restartWith({ claude: { auto: false }, codex: { auto: true }, grok: { auto: false } }),
    { claude: false, codex: true, grok: false },
    "保存済みの boolean をそのまま維持する"
  );
  // auto が boolean でない値（壊れた保存値）はキーありの旧形式と同じ扱い＝ ON
  assert.deepEqual(
    await restartWith({ claude: { auto: "yes" }, codex: { auto: null }, grok: { auto: 0 } }),
    { claude: true, codex: true, grok: true },
    "boolean でない auto は旧形式扱いで ON"
  );
});
