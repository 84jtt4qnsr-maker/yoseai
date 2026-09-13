// 隔離時の stdout ファイル退避 — サーバ統合テスト。
// 偽 srt（`--settings P -c LINE` を `sh -c LINE` として実行）で plan.mode を enforced にし、
// 子の stdout が一時ファイル経由でも取りこぼしなく届くことを見る（grok の EAGAIN 対策の回帰防止）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRED = "c".repeat(64);

// 偽 srt: `--version` に応答し、`-c LINE` を素の sh -c で実行する（隔離はしないが plan は enforced になる）
const FAKE_SRT = `#!/usr/bin/env node
const { spawnSync } = require("child_process");
if (process.argv[2] === "--version") { process.stdout.write("fake-srt 9.9.9\\n"); process.exit(0); }
const i = process.argv.indexOf("-c");
const line = i >= 0 ? process.argv[i + 1] : "true";
const r = spawnSync("sh", ["-c", line], { stdio: "inherit" });
process.exit(r.status == null ? 1 : r.status);
`;

// 偽 claude/codex: stdin を読み切ってから、大きめの JSONL を stdout へ吐く（ファイル退避経路の実況・全量回収を試す）
const FAKE_CLI = (kind) => `#!/usr/bin/env node
const fs = require("fs");
let ctl = {}; try { ctl = JSON.parse(fs.readFileSync(fs.readFileSync(__filename + ".env", "utf8").trim(), "utf8")); } catch (e) {}
const c = ctl[${JSON.stringify(kind)}] || {};
let p = ""; process.stdin.setEncoding("utf8");
process.stdin.on("data", d => p += d);
process.stdin.on("end", () => {
  const big = "x".repeat(2000);
  for (let n = 0; n < 200; n++) process.stdout.write(JSON.stringify({ type: "line", n, pad: big }) + "\\n");
  const text = c.text || "done";
  const result = ${JSON.stringify(kind)} === "claude"
    ? JSON.stringify({ type: "result", result: text, session_id: "fake", usage: { input_tokens: 1, output_tokens: 1 } })
    : JSON.stringify({ type: "thread.started", thread_id: "fake" });
  if (${JSON.stringify(kind)} === "codex") { const i = process.argv.indexOf("-o"); if (i > 0) fs.writeFileSync(process.argv[i + 1], text); }
  process.stdout.write(result + "\\n", () => process.exit(0));
});
`;

let tmp, appDir, poolDir, fakeBin, ctlFile, port, server, topicId;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "yoseai-iso-redirect-"));
  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "tray.mjs", "credentials.mjs", "sandbox.mjs", "sandbox-profiles.json", "package.json", "public/flow-graph.js", "public/usage.js"])
    fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  poolDir = path.join(appDir, "pool"); fs.mkdirSync(poolDir);
  fakeBin = path.join(tmp, "bin"); fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "srt"), FAKE_SRT, { mode: 0o755 });
  for (const k of ["claude", "codex"]) fs.writeFileSync(path.join(fakeBin, k), FAKE_CLI(k), { mode: 0o755 });
  ctlFile = path.join(tmp, "ctl.json");
  fs.writeFileSync(ctlFile, JSON.stringify({}));
  for (const f of fs.readdirSync(fakeBin)) if (!f.endsWith(".env")) fs.writeFileSync(path.join(fakeBin, f) + ".env", ctlFile);

  port = 20000 + Math.floor(Math.random() * 20000);
  // U2A2A_SANDBOX_CMD は既定 "srt"（PATH 先頭の偽 srt を拾う）。isolation が enforced になる
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: appDir,
    env: { ...process.env, U2A2A_ADMIN_CREDENTIAL: CRED, U2A2A_PORT: String(port), PATH: fakeBin + ":" + process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = ""; server.stderr.on("data", (d) => (err += d)); server.stdout.on("data", () => {});
  await waitFor(async () => { try { return (await fetch("http://127.0.0.1:" + port + "/api/state", { headers: { Authorization: "Bearer " + CRED } })).ok; } catch { return false; } }, "server start: " + err, 15000);
  for (const a of ["claude", "codex"]) await api("PATCH", "/api/agents/" + a, { auto: true });
  topicId = (await getState()).topics[0].id;
});

after(async () => {
  if (server) { server.kill("SIGTERM"); await sleep(500); }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("enforced 時は偽 srt 経由で起動し、大きな stdout もファイル退避で全量届く", async () => {
  const s = await getState();
  assert.equal(s.isolation.mode, "enforced", "偽 srt があるので enforced: " + JSON.stringify(s.isolation));

  const before = (await getState()).messages.length;
  assert.equal((await api("POST", "/api/messages", { author: "user", thread: "claude", text: "大きな出力の受け取り試験" })).status, 201);
  // 偽 claude の最終行 result.result（"done"）が claude スレッドの返信として届けば、
  // 200 行の大きな JSONL をファイル退避経由で取りこぼさず読み切れたことになる
  const reply = await waitFor(async () => {
    const msgs = (await getState()).messages;
    return msgs.length > before && msgs.find((m) => m.author === "claude" && m.text === "done") ? msgs : null;
  }, "claude reply via redirect");
  assert.ok(reply, "隔離下でも返信が届く");
});
