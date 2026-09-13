// 停止ラッチの再起動・リレー・stale プローブ回帰（契約-停止ラッチ §1〜§3、codex 差分レビューの要求）。
// サーバの再起動を挟むため availability.server.test.mjs とは分離。srt 無し（隔離非接触の契約）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRED = "f".repeat(64);
const G402 = 'Internal error: {"message": "API error (status 402 Payment Required): Grok Build usage balance exhausted", "http_status": 402}';

// 偽 grok: ping は pingLog に1行残す（起動時プローブ抑止の観測点）。fail402 / pingDelayMs / delayMs は ctl で制御
const FAKE_GROK = `#!/usr/bin/env node
const fs = require("fs");
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(fs.readFileSync(__filename + ".env", "utf8").trim(), "utf8")); } catch (e) {}
const c = ctl.grok || {};
const argv = process.argv.slice(2);
if (argv.includes("-p")) {
  if (ctl.pingLog) { try { fs.appendFileSync(ctl.pingLog, Date.now() + "\\n"); } catch (e) {} }
  const done = () => {
    if (c.fail402) { process.stderr.write(${JSON.stringify(G402)} + "\\n", () => process.exit(1)); return; }
    process.stdout.write(JSON.stringify({ text: "pong", stopReason: "end_turn", sessionId: "g-ping", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.0001, modelUsage: { "grok-4.6-build": {} } }) + "\\n", () => process.exit(0));
  };
  setTimeout(done, c.pingDelayMs || 0);
} else if (c.fail402) {
  process.stderr.write(${JSON.stringify(G402)} + "\\n", () => process.exit(1));
} else {
  const lines = [
    JSON.stringify({ type: "text", data: "了解（Grok）" }),
    JSON.stringify({ type: "end", stopReason: "end_turn", sessionId: "g-1", usage: { input_tokens: 10, output_tokens: 5 }, num_turns: 1, total_cost_usd: 0.002, modelUsage: { "grok-4.6-build": { costUSD: 0.002 } } }),
  ];
  setTimeout(() => process.stdout.write(lines.join("\\n") + "\\n", () => process.exit(0)), c.delayMs || 0);
}
`;

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require("fs");
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(fs.readFileSync(__filename + ".env", "utf8").trim(), "utf8")); } catch (e) {}
const c = ctl.claude || {};
let p = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", d => p += d);
process.stdin.on("end", () => {
  setTimeout(() => {
    process.stdout.write(JSON.stringify({ type: "result", result: "done", session_id: "fake", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n", () => process.exit(0));
  }, c.delayMs || 0);
});
`;

let tmp, appDir, fakeBin, ctlFile, pingLog, home, port, server, topic1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeCtl = (obj) => fs.writeFileSync(ctlFile, JSON.stringify({ pingLog, ...obj }));
const pingCount = () => { try { return fs.readFileSync(pingLog, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };

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

function spawnServer() {
  const s = spawn(process.execPath, ["server.mjs"], {
    cwd: appDir,
    env: { ...process.env, HOME: home, U2A2A_ADMIN_CREDENTIAL: CRED, U2A2A_PORT: String(port), U2A2A_SANDBOX_CMD: "yoseai-test-no-srt", PATH: fakeBin + ":" + process.env.PATH },
    stdio: ["ignore", "ignore", "pipe"],
  });
  s.stderr.on("data", () => {});
  return s;
}
async function stopServer() {
  if (!server) return;
  server.kill("SIGTERM");
  await sleep(600);
  server = null;
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yoseai-latch-"));
  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "tray.mjs", "credentials.mjs", "sandbox.mjs", "sandbox-profiles.json", "package.json", "public/flow-graph.js", "public/usage.js"])
    fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  fs.mkdirSync(path.join(appDir, "pool"));
  home = path.join(tmp, "home");
  fs.mkdirSync(path.join(home, ".grok"), { recursive: true });
  fs.writeFileSync(path.join(home, ".grok", "auth.json"), "{}");
  fakeBin = path.join(tmp, "bin"); fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "grok"), FAKE_GROK, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "claude"), FAKE_CLAUDE, { mode: 0o755 });
  ctlFile = path.join(tmp, "ctl.json");
  pingLog = path.join(tmp, "ping.log");
  writeCtl({});
  for (const f of ["grok", "claude"]) fs.writeFileSync(path.join(fakeBin, f) + ".env", ctlFile);
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawnServer();
  await waitFor(async () => { try { return (await api("GET", "/api/state")).status === 200; } catch { return false; } }, "server start", 15000);
  await waitFor(async () => (await getState()).agents.grok.authed === true, "grok auth probe");
  for (const a of ["claude", "grok"]) await api("PATCH", "/api/agents/" + a, { auto: true });
  topic1 = (await api("POST", "/api/topics", { title: "L1", participants: ["claude", "grok"] })).body.id;
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("進行中の質疑は、手番の席が停止していたら次の CLI 起動前に止まる（§1 リレー）", async () => {
  // claude を遅くして、その手番の間に grok を 402 の再確認で落とす
  writeCtl({ claude: { delayMs: 3000 }, grok: { fail402: true } });
  const q = await api("POST", "/api/qa/start", { first: "claude", topicId: topic1, text: "リレー停止試験", hops: 4 });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  await sleep(400); // claude の手番が始まってから
  assert.equal((await api("POST", "/api/agents/grok/check-auth")).status, 200);
  assert.equal((await getState()).agents.grok.availability, "unavailable");
  const s = await waitFor(async () => {
    const st = await getState();
    const rl = (st.topics.find((t) => t.id === topic1) || {}).relay || {};
    return rl.active === false && rl.stopReason ? st : null;
  }, "relay stopped");
  const rl = s.topics.find((t) => t.id === topic1).relay;
  assert.equal(rl.stopReason, "unavailable", JSON.stringify(rl));
  assert.ok(!s.messages.some((m) => m.topicId === topic1 && m.author === "grok" && m.text === "了解（Grok）"), "grok の CLI は起動していない");
});

test("停止観測より前に開始した再確認プローブは、成功でもラッチを外さない（§2・codex レビュー2）", async () => {
  // 前提: grok は unavailable（前のテストの 402）
  assert.equal((await getState()).agents.grok.availability, "unavailable");
  const since0 = (await getState()).agents.grok.availabilitySince;
  // 遅い成功 ping を開始し、走行中に新しい 402 観測でラッチを立て直す
  writeCtl({ grok: { pingDelayMs: 4000 } });
  const slow = api("POST", "/api/agents/grok/check-auth"); // await しない（走行中に次を仕込む）
  await sleep(800);
  writeCtl({ grok: { fail402: true } });
  assert.equal((await api("POST", "/api/agents/grok/check-auth")).status, 200); // 新しい観測（since 更新）
  const since1 = (await getState()).agents.grok.availabilitySince;
  assert.ok(since1 > since0, "新しい観測で since が進む");
  await slow; // 遅い成功が戻る
  const g = (await getState()).agents.grok;
  assert.equal(g.availability, "unavailable", "stale な成功プローブでは外れない");
  assert.equal(g.availabilitySince, since1, "観測時刻も stale 側で上書きされない");
});

test("再起動でラッチが理由コードから復元され、起動時 ping は飛ばない（§3）", async () => {
  assert.equal((await getState()).agents.grok.availability, "unavailable");
  const pings = pingCount();
  await stopServer();
  server = spawnServer();
  await waitFor(async () => { try { return (await api("GET", "/api/state")).status === 200; } catch { return false; } }, "server restart", 15000);
  const g = (await getState()).agents.grok;
  assert.equal(g.availability, "unavailable", "ラッチが復元される");
  assert.equal(g.availabilityReason, "grok-402");
  assert.ok(g.lastError.includes("残高"), "表示は理由コードから再生成: " + g.lastError);
  assert.equal(g.authed, null, "authed は確認中のまま");
  await sleep(1500);
  assert.equal(pingCount(), pings, "unavailable 復元席では起動時 ping が飛ばない");
  // 復帰導線: 解除 → 再確認（authed 未確認なので必須——契約 §4）
  assert.equal((await api("PATCH", "/api/agents/grok", { resetAvailability: true })).status, 200);
  writeCtl({});
  assert.equal((await api("POST", "/api/agents/grok/check-auth")).status, 200);
  const g2 = (await getState()).agents.grok;
  assert.equal(g2.availability, "available");
  assert.equal(g2.authed, true);
  assert.ok(pingCount() > pings, "再確認の ping は飛ぶ");
});
