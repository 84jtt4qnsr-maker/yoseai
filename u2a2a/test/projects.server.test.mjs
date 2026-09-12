// ローカルプロジェクト登録とトピック紐付け — サーバ統合テスト（仕様: SPEC-プロジェクト紐付け.md「テスト」1〜11）
// server.mjs を一時ディレクトリへ複製し、偽の claude / codex / git（PATH 先頭）で駆動する。
// 偽 CLI は制御ファイルを読み、受け取ったプロンプトと引数を記録する（プロンプト注入・--add-dir の検証用）。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 偽 claude / codex（CommonJS・拡張子なし・shebang 起動）。stdin のプロンプトを記録してから制御どおりに振る舞う
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
  if (ctl.logDir) {
    const n = Date.now() + "-" + Math.random().toString(16).slice(2, 8);
    fs.writeFileSync(path.join(ctl.logDir, kind + "-" + n + ".json"), JSON.stringify({ kind, argv: process.argv.slice(2), cwd: process.cwd(), prompt, ts: Date.now() }));
  }
  if (c.write) fs.writeFileSync(path.join(ctl.poolDir, c.write.file), c.write.content);
  setTimeout(() => {
    if (c.fail) {
      process.stderr.write("fake failure");
      process.exit(1);
    }
    const text = c.text || "ok";
    const line = kind === "claude"
      ? JSON.stringify({ type: "result", result: text, session_id: "fake-" + n(), usage: { input_tokens: 1, output_tokens: 1 } })
      : JSON.stringify({ type: "thread.started", thread_id: "fake-thread" });
    if (kind === "codex") {
      const i = process.argv.indexOf("-o");
      if (i > 0) fs.writeFileSync(process.argv[i + 1], text);
    }
    process.stdout.write(line + "\\n", () => process.exit(0));
  }, c.delayMs || 0);
});
function n() { return Math.random().toString(16).slice(2, 10); }
`;

// 偽 git: 制御ファイルの git.mode が "fail" なら非ゼロ終了、"sleep" なら 5 秒待つ、それ以外は PATH 上の本物の git へ委譲
const FAKE_GIT = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(process.env.U2A2A_FAKE_CTL, "utf8")); } catch (e) {}
const mode = (ctl.git && ctl.git.mode) || "real";
if (mode === "fail") { process.stderr.write("fatal: fake git failure"); process.exit(128); }
if (mode === "sleep") { setTimeout(() => process.exit(0), 5000); }
else {
  const here = path.dirname(fs.realpathSync(process.argv[1]));
  // macOS では /var/folders → /private/var/folders の symlink があるため realpath 同士で比較する
  const dirs = (process.env.PATH || "").split(":").filter((d) => { try { return d && fs.realpathSync(d) !== here; } catch (e) { return false; } });
  const real = dirs.map((d) => path.join(d, "git")).find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch (e) { return false; } });
  if (!real) { process.stderr.write("git not found"); process.exit(127); }
  const r = spawnSync(real, process.argv.slice(2), { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}
`;

let tmp, appDir, poolDir, fakeBin, ctlFile, logDir, port, server;
let projDir, plainDir, topicA, topicB, topicOld, topicFresh;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const gitIn = (dir, args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", env: GIT_ENV });
const todayStr = () => new Date().toLocaleDateString("sv-SE");
const writeCtl = (obj) => fs.writeFileSync(ctlFile, JSON.stringify({ poolDir, logDir, ...obj }));
// 偽 CLI の呼び出し記録（新しい順）
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
const getTopic = async (id) => (await getState()).topics.find((t) => t.id === id);

async function waitFor(fn, label, ms = 45000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout: " + label);
    await sleep(100);
  }
}
// 応答・レビュー・修正が走っていない状態まで待つ
const idle = () => waitFor(async () => {
  const s = await getState();
  const busy = Object.values(s.running || {}).some(Boolean) || Object.keys(s.fixPending || {}).length || Object.keys(s.reviewPending || {}).length;
  return busy ? null : s;
}, "idle");
// ユーザー発言を送り、担当エージェントの応答（または停止通知）が付くまで待つ
async function say(topicId, to, text) {
  const before = (await getState()).messages.filter((m) => m.topicId === topicId).length;
  const r = await api("POST", "/api/messages", { topicId, thread: to, text, author: "user" });
  assert.ok(r.status < 300, "POST /api/messages: " + r.status + " " + JSON.stringify(r.body));
  await waitFor(async () => (await getState()).messages.filter((m) => m.topicId === topicId).length >= before + 2, "reply in " + topicId);
  await idle();
  return (await getState()).messages.filter((m) => m.topicId === topicId);
}

async function startServer() {
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: appDir,
    env: { ...process.env, U2A2A_PORT: String(port), PATH: fakeBin + ":" + process.env.PATH, U2A2A_FAKE_CTL: ctlFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  const dbg = process.env.U2A2A_TEST_DEBUG_LOG;
  server.stderr.on("data", (d) => { err += d; if (dbg) fs.appendFileSync(dbg, d); });
  server.stdout.on("data", (d) => { if (dbg) fs.appendFileSync(dbg, d); });
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

// schemaVersion 5 の state.json（移行テスト用）: 実行済みトピックと未実行トピック
function legacyState() {
  const agents = () => ({ claude: { sessionId: null, lastSeenTs: 1, transcriptOffset: null }, codex: { sessionId: null, lastSeenTs: 1, transcriptOffset: null } });
  const old = { id: "0000000000000001", title: "旧・実行済み", ts: 1, relay: { active: false, remaining: 0, hopsDone: 0 }, agents: agents() };
  const fresh = { id: "0000000000000002", title: "旧・未実行", ts: 2, relay: { active: false, remaining: 0, hopsDone: 0 }, agents: agents() };
  return {
    schemaVersion: 5,
    messages: [
      { id: "m1", topicId: old.id, thread: "claude", author: "user", text: "hi", ts: 1, provenance: { ingress: "ui", delivery: "direct", trigger: "manual", source: null } },
      { id: "m2", topicId: old.id, thread: "claude", author: "claude", text: "hello", ts: 2, provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null } },
      { id: "m3", topicId: fresh.id, thread: "claude", author: "user", text: "draft", ts: 3, provenance: { ingress: "ui", delivery: "direct", trigger: "manual", source: null } },
    ],
    tasks: [],
    pool: [],
    topics: [old, fresh],
    agents: { claude: { auto: true }, codex: { auto: true } },
  };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u2a2a-projects-"));
  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "tray.mjs", "package.json", "public/flow-graph.js", "public/usage.js"]) fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  poolDir = path.join(appDir, "pool");
  fs.mkdirSync(poolDir);
  fs.mkdirSync(path.join(appDir, "data"));
  fs.writeFileSync(path.join(appDir, "data", "state.json"), JSON.stringify(legacyState(), null, 2));
  // 外部プロジェクト（Git）と通常フォルダ
  projDir = path.join(tmp, "ext-project");
  fs.mkdirSync(path.join(projDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(projDir, "README.md"), "# Ext Project\nこれは外部プロジェクトです。\n");
  fs.writeFileSync(path.join(projDir, "src", "main.mjs"), "export const x = 1;\n");
  const git = (args) => gitIn(projDir, args);
  git(["init", "-q", "-b", "main"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  plainDir = path.join(tmp, "plain-folder");
  fs.mkdirSync(plainDir);
  fs.writeFileSync(path.join(plainDir, "notes.txt"), "plain\n");
  // 偽 CLI
  fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  for (const k of ["claude", "codex"]) fs.writeFileSync(path.join(fakeBin, k), FAKE_CLI(k), { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, "git"), FAKE_GIT, { mode: 0o755 });
  ctlFile = path.join(tmp, "ctl.json");
  logDir = path.join(tmp, "calls");
  fs.mkdirSync(logDir);
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" } });
  await startServer();
  const s = await getState();
  topicOld = s.topics.find((t) => t.title === "旧・実行済み").id;
  topicFresh = s.topics.find((t) => t.title === "旧・未実行").id;
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let pid, plainPid;

test("8. 移行: schemaVersion 5 の state から projects / projectId / projectLocked が補完される", async () => {
  const s = await getState();
  assert.deepEqual(s.projects, []);
  const old = s.topics.find((t) => t.id === topicOld);
  const fresh = s.topics.find((t) => t.id === topicFresh);
  assert.equal(old.projectId, null);
  assert.equal(old.projectLocked, true, "エージェント発言があるトピックは実行済み");
  assert.equal(fresh.projectId, null);
  assert.equal(fresh.projectLocked, false, "ユーザー発言だけのトピックは未実行");
});

test("1. 登録: 相対・不在・ファイル・プール内（symlink 含む）は拒否、重複は既存 id", async () => {
  assert.equal((await api("POST", "/api/projects", { path: "ext-project" })).status, 400);
  assert.equal((await api("POST", "/api/projects", { path: path.join(tmp, "nope") })).status, 404);
  assert.equal((await api("POST", "/api/projects", { path: path.join(projDir, "README.md") })).status, 400);
  assert.equal((await api("POST", "/api/projects", {})).status, 400);
  const inPool = await api("POST", "/api/projects", { path: poolDir });
  assert.equal(inPool.status, 400);
  assert.match(inPool.body.error, /プール/);
  const link = path.join(tmp, "link-to-pool");
  fs.symlinkSync(poolDir, link);
  assert.equal((await api("POST", "/api/projects", { path: link })).status, 400, "symlink 経由のプール内も拒否");
  const r = await api("POST", "/api/projects", { path: projDir });
  assert.equal(r.status, 201);
  assert.equal(r.body.project.kind, "git");
  assert.equal(r.body.project.name, "ext-project");
  assert.equal(r.body.project.path, fs.realpathSync(projDir));
  pid = r.body.project.id;
  const dup = await api("POST", "/api/projects", { path: projDir + "/", name: "別名" });
  assert.equal(dup.status, 200);
  assert.equal(dup.body.existing, true);
  assert.equal(dup.body.project.id, pid);
  const r2 = await api("POST", "/api/projects", { path: plainDir, name: "メモ置き場" });
  assert.equal(r2.status, 201);
  assert.equal(r2.body.project.kind, "dir");
  assert.equal(r2.body.project.name, "メモ置き場");
  plainPid = r2.body.project.id;
  assert.equal((await api("PATCH", "/api/projects/" + plainPid, { name: "plain" })).body.project.name, "plain");
  const list = await api("GET", "/api/projects");
  assert.deepEqual(list.body.projects.map((p) => p.id), [pid, plainPid]);
  assert.equal((await api("GET", "/api/projects/nope/probe")).status, 404);
});

test("2. probe: Git 情報が取れる／通常フォルダは not-git／git 失敗・タイムアウトは unavailable で止まらない", async () => {
  let p = (await api("GET", "/api/projects/" + pid + "/probe")).body;
  assert.equal(p.status, "ok");
  assert.equal(p.branch, "main");
  assert.match(p.head, /^[0-9a-f]{7,}$/);
  assert.equal(p.dirty, 0);
  fs.writeFileSync(path.join(projDir, "untracked.txt"), "x\n");
  p = (await api("GET", "/api/projects/" + pid + "/probe")).body;
  assert.equal(p.dirty, 1);
  assert.deepEqual(p.dirtyPaths, ["untracked.txt"]);
  fs.unlinkSync(path.join(projDir, "untracked.txt"));
  assert.equal((await api("GET", "/api/projects/" + plainPid + "/probe")).body.status, "not-git");
  writeCtl({ git: { mode: "fail" } });
  p = (await api("GET", "/api/projects/" + pid + "/probe")).body;
  assert.equal(p.status, "unavailable");
  assert.match(p.note, /^確認不可/);
  writeCtl({ git: { mode: "sleep" } });
  const t0 = Date.now();
  p = (await api("GET", "/api/projects/" + pid + "/probe")).body;
  assert.equal(p.status, "unavailable");
  assert.match(p.note, /タイムアウト/);
  assert.ok(Date.now() - t0 < 4500, "3 秒で打ち切る");
  writeCtl({});
});

test("3. 紐付け: 新規作成時の指定、未実行トピックは変更可、実行済みは 409、未登録 id は 400", async () => {
  const t = await api("POST", "/api/topics", { title: "外部A", projectId: pid });
  assert.equal(t.status, 201);
  assert.equal(t.body.projectId, pid);
  assert.equal(t.body.projectLocked, false);
  topicA = t.body.id;
  assert.equal((await api("POST", "/api/topics", { title: "x", projectId: "nope" })).status, 400);
  assert.equal((await api("PATCH", "/api/topics/" + topicFresh, { projectId: pid })).status, 200);
  assert.equal((await getTopic(topicFresh)).projectId, pid);
  const locked = await api("PATCH", "/api/topics/" + topicOld, { projectId: pid });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.reason, "locked");
  assert.equal((await api("PATCH", "/api/topics/" + topicFresh, { projectId: null })).status, 200);
  assert.equal((await getTopic(topicFresh)).projectId, null);
  assert.equal((await api("PATCH", "/api/topics/" + topicFresh, { projectId: "nope" })).status, 400);
});

test("4. プロンプト: 紐付けありの初回は対象・Git・概要が入り、--add-dir と Edit 規則だけを渡す。2 回目は概要なしだが最新の Git 情報は毎回入る。未紐付けは従来文言", async () => {
  clearCalls();
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" } });
  await say(topicA, "claude", "このプロジェクトの概要を教えて");
  let call = cliCalls("claude")[0];
  assert.ok(call, "claude が呼ばれる");
  assert.ok(call.prompt.includes("対象プロジェクトは「ext-project」（" + fs.realpathSync(projDir) + "、閲覧のみ・変更不可）。Git: main@"), call.prompt.slice(0, 600));
  assert.ok(call.prompt.includes("--- 対象プロジェクトの概要（初回のみ） ---"));
  assert.ok(call.prompt.includes("README.md, src/"));
  assert.ok(call.prompt.includes("# Ext Project"));
  assert.ok(!call.prompt.includes("作業ディレクトリはアプリのリポジトリ（"));
  const i = call.argv.indexOf("--add-dir");
  assert.ok(i >= 0 && call.argv[i + 1] === fs.realpathSync(projDir), "--add-dir <path>: " + JSON.stringify(call.argv));
  assert.ok(call.argv.includes("Edit(u2a2a/pool/**)"));
  // 現行 CLI では新規ファイル作成に Write 規則が必要（Edit 規則では許可されない実測）。pool 限定で渡す
  assert.ok(call.argv.includes("Write(u2a2a/pool/**)"));
  assert.ok(call.argv.filter((a) => a.startsWith("Write(")).every((a) => a.includes("/pool/")), "Write 規則は pool 限定");
  assert.ok(!call.argv.includes("acceptEdits"));
  assert.equal((await getTopic(topicA)).projectLocked, true, "実行で固定される");
  assert.equal((await api("PATCH", "/api/topics/" + topicA, { projectId: plainPid })).status, 409);
  // 2 回目（セッション継続）: 概要は付かないが、対象と最新の Git 情報（ブランチを変えたことがクリーンな状態でも伝わる）は毎回入る
  gitIn(projDir, ["checkout", "-q", "-b", "feature"]);
  clearCalls();
  try {
    await say(topicA, "claude", "続きです");
  } finally {
    gitIn(projDir, ["checkout", "-q", "main"]);
  }
  call = cliCalls("claude")[0];
  assert.ok(!call.prompt.includes("対象プロジェクトの概要"));
  assert.ok(!call.prompt.includes("担当エージェントです"), "継続では前文なし");
  assert.ok(call.prompt.includes("対象プロジェクトは「ext-project」（" + fs.realpathSync(projDir) + "、閲覧のみ・変更不可）。Git: feature@"), call.prompt.slice(0, 400));
  assert.ok(call.argv.includes("--add-dir"));
  // 未紐付けトピック: 従来文言・--add-dir なし
  const plain = await api("POST", "/api/topics", { title: "従来" });
  clearCalls();
  await say(plain.body.id, "claude", "hi");
  call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("作業ディレクトリはアプリのリポジトリ（") && call.prompt.includes("、閲覧のみ、変更は不可）"), call.prompt.slice(0, 400));
  assert.ok(!call.argv.includes("--add-dir"));
  // Codex 側: 対象パスを絶対パスで参照する文言
  clearCalls();
  const tb = await api("POST", "/api/topics", { title: "外部B", projectId: pid });
  topicB = tb.body.id;
  await say(topicB, "codex", "概要を");
  call = cliCalls("codex")[0];
  assert.ok(call.prompt.includes("対象プロジェクトは " + fs.realpathSync(projDir) + " を絶対パスで参照（閲覧のみ）"));
  assert.ok(call.prompt.includes("対象プロジェクトの概要（初回のみ）"));
});

test("5. 停止: 紐付け先が消えると応答せず理由を残す。戻すと再開。git が使えないだけなら「確認不可」で続行", async () => {
  const moved = projDir + "-moved";
  fs.renameSync(projDir, moved);
  clearCalls();
  try {
    const msgs = await say(topicA, "claude", "まだいますか");
    const last = msgs[msgs.length - 1];
    assert.equal(last.author, "claude");
    assert.equal(last.blocked, true);
    assert.match(last.text, /対象プロジェクトを確認できません/);
    assert.match(last.text, /missing/);
    assert.equal(cliCalls("claude").length, 0, "CLI は呼ばれない");
    assert.match((await getState()).agents.claude.lastError, /確認できません/);
  } finally {
    fs.renameSync(moved, projDir);
  }
  clearCalls();
  const msgs = await say(topicA, "claude", "戻しました");
  assert.equal(msgs[msgs.length - 1].blocked, undefined);
  assert.equal(cliCalls("claude").length, 1, "登録先を戻せば再開する");
  // unavailable: 新しいトピックの初回プロンプトに「確認不可」が入り、実行は止まらない
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" }, git: { mode: "fail" } });
  const tc = await api("POST", "/api/topics", { title: "外部C", projectId: pid });
  clearCalls();
  const m2 = await say(tc.body.id, "claude", "git なしでも動く？");
  assert.equal(m2[m2.length - 1].blocked, undefined);
  const call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("Git 情報は確認不可"), call.prompt.slice(0, 500));
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" } });
});

test("6. 成果物: 登録時に projectId が写り、レビュー・修正はそれを使う（--add-dir、acceptEdits なし、cwd=リポジトリルート）", async () => {
  const rel = "topics/" + topicA + "/out.md";
  fs.mkdirSync(path.join(poolDir, "topics", topicA), { recursive: true });
  writeCtl({ claude: { text: "保存しました: u2a2a/pool/" + rel, write: { file: rel, content: "# out\n" } }, codex: { text: "OK\n【判定】承認" } });
  await say(topicA, "claude", "成果物を保存して");
  const item = (await getState()).pool.find((p) => p.file === rel);
  assert.ok(item, "宣言パスで登録される");
  assert.equal(item.projectId, pid);
  // レビュー（claude）
  clearCalls();
  writeCtl({ claude: { text: "見ました\n【判定】承認" }, codex: { text: "OK\n【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + item.id + "/review", { reviewer: "claude" })).status, 202);
  await idle();
  let call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("対象プロジェクト「ext-project」（" + fs.realpathSync(projDir) + "、閲覧のみ可）の実態と照らして"), call.prompt.slice(0, 400));
  assert.ok(call.prompt.includes("対象プロジェクトは「ext-project」（" + fs.realpathSync(projDir) + "、閲覧のみ・変更不可）。Git: main@"), "Git 情報は別行で添える");
  assert.ok(call.argv.includes("--add-dir"));
  assert.ok(!call.argv.includes("--allowedTools"), "レビューは読み取りのみ");
  // 修正（claude）: acceptEdits を使わず、通常応答と同じ規則＋ --add-dir、cwd はリポジトリルート
  clearCalls();
  writeCtl({ claude: { text: "直しました", write: { file: rel, content: "# out v2\n" } }, codex: { text: "OK\n【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + item.id + "/fix", { agent: "claude" })).status, 202);
  await waitFor(async () => ((await getState()).pool.find((p) => p.id === item.id).fixes || []).length === 1, "fix done");
  await idle();
  call = cliCalls("claude").find((c) => c.prompt.includes("修正する担当"));
  assert.ok(call, "修正の呼び出し");
  assert.ok(!call.argv.includes("acceptEdits"));
  assert.ok(call.argv.includes("Edit(u2a2a/pool/**)"));
  assert.ok(call.argv.includes("--add-dir"));
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(tmp), "cwd はリポジトリルート（appDir の親）");
  assert.ok(call.prompt.includes("u2a2a/pool/" + rel + "（リポジトリルートからの相対パス）"));
  assert.ok(call.prompt.includes("照合先は対象プロジェクト「ext-project」（" + fs.realpathSync(projDir) + "、閲覧のみ可）。\n対象プロジェクトは「ext-project」（"), call.prompt.slice(0, 500));
  const fixed = (await getState()).pool.find((p) => p.id === item.id);
  assert.equal(fixed.fixes[0].error, undefined);
  // 未紐付けトピックの成果物: projectId は null、レビューは従来文言
  const plainTopic = (await getState()).topics.find((t) => t.title === "従来");
  const pi = await api("POST", "/api/pool", { origin: "user", title: "memo", body: "hello", topicId: plainTopic.id, autoReview: false });
  assert.equal(pi.status, 201);
  assert.equal(pi.body.projectId, null);
  clearCalls();
  assert.equal((await api("POST", "/api/pool/" + pi.body.id + "/review", { reviewer: "claude" })).status, 202);
  await idle();
  call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("アプリのリポジトリ（閲覧のみ可）の実態と照らして"));
  assert.ok(!call.argv.includes("--add-dir"));
  // 紐付け先が消えたときのレビュー・修正は中止して理由を残す
  const moved = projDir + "-moved";
  fs.renameSync(projDir, moved);
  clearCalls();
  try {
    assert.equal((await api("POST", "/api/pool/" + item.id + "/review", { reviewer: "codex" })).status, 202);
    await idle();
    const it = (await getState()).pool.find((p) => p.id === item.id);
    const rv = it.reviews[it.reviews.length - 1];
    assert.equal(rv.error, true);
    assert.match(rv.projectError, /確認できません/);
    assert.equal((await api("POST", "/api/pool/" + item.id + "/fix", { agent: "codex" })).status, 202);
    await waitFor(async () => ((await getState()).pool.find((p) => p.id === item.id).fixes || []).length === 2, "fix blocked");
    const fx = (await getState()).pool.find((p) => p.id === item.id).fixes[1];
    assert.equal(fx.error, true);
    assert.match(fx.projectError, /確認できません/);
    assert.equal(cliCalls().length, 0, "CLI は呼ばれない");
  } finally {
    fs.renameSync(moved, projDir);
  }
});

test("9. 分岐: projectId は継承／上書きでき、分岐先は未実行（変更可）", async () => {
  const first = (await getState()).messages.find((m) => m.topicId === topicA);
  const b1 = await api("POST", "/api/topics/" + topicA + "/branch", { messageId: first.id });
  assert.equal(b1.status, 201);
  assert.equal(b1.body.projectId, pid);
  assert.equal(b1.body.projectLocked, false);
  const b2 = await api("POST", "/api/topics/" + topicA + "/branch", { messageId: first.id, projectId: plainPid });
  assert.equal(b2.body.projectId, plainPid);
  assert.equal((await api("POST", "/api/topics/" + topicA + "/branch", { messageId: first.id, projectId: "nope" })).status, 400);
  assert.equal((await api("PATCH", "/api/topics/" + b1.body.id, { projectId: null })).status, 200, "分岐先は変更できる");
  // 質疑の開始でも固定される
  const qa = await api("POST", "/api/qa/start", { first: "claude", text: "テスト質疑", hops: 1, topicId: b1.body.id });
  assert.ok(qa.status < 300, JSON.stringify(qa.body));
  assert.equal((await getTopic(b1.body.id)).projectLocked, true);
  await sleep(500);
  await idle();
});

test("10. 削除: 参照ありは 409 と参照元一覧、参照なしは 200", async () => {
  const d = await api("DELETE", "/api/projects/" + pid);
  assert.equal(d.status, 409);
  assert.ok(d.body.topics.includes(topicA));
  assert.ok(d.body.items.length >= 1);
  const d2 = await api("DELETE", "/api/projects/" + plainPid);
  assert.equal(d2.status, 409, "分岐先トピックから参照されている");
  const third = path.join(tmp, "third");
  fs.mkdirSync(third);
  const r = await api("POST", "/api/projects", { path: third });
  assert.equal((await api("DELETE", "/api/projects/" + r.body.project.id)).status, 200);
  assert.equal((await api("GET", "/api/projects/" + r.body.project.id + "/probe")).status, 404);
});

test("7. 再起動後: projects と紐付け・ロックが保持され、旧トピックの推定は再計算されない", async () => {
  await sleep(1000);
  await stopServer();
  // 11 の要約出所テスト用: topicA に「ext-project 時点の要約」を書き込んでから再起動する（要約の生成を待たずに済むよう state.json を直接編集。生成経路は 17 で見る）。
  // topicB には出所なしの要約（旧 state 相当）を入れ、移行で「現在の対象で作られた要約」と補完されることを見る
  const stFile = path.join(appDir, "data", "state.json");
  const st = JSON.parse(fs.readFileSync(stFile, "utf8"));
  Object.assign(st.topics.find((t) => t.id === topicA), { summaryText: "## 合意済み\n- 要約テスト\n## 未決\n- なし", summaryProjectId: pid, summaryTs: Date.now() });
  Object.assign(st.topics.find((t) => t.id === topicB), { summaryText: "## 合意済み\n- B\n## 未決\n- なし", summaryTs: Date.now() });
  fs.writeFileSync(stFile, JSON.stringify(st, null, 2));
  await startServer();
  const s = await getState();
  assert.deepEqual(s.projects.map((p) => p.id), [pid, plainPid]);
  assert.equal(s.topics.find((t) => t.id === topicA).projectId, pid);
  assert.equal(s.topics.find((t) => t.id === topicA).projectLocked, true);
  assert.equal(s.topics.find((t) => t.id === topicFresh).projectLocked, false);
  assert.equal(s.topics.find((t) => t.id === topicA).summaryProjectId, pid);
  assert.equal(s.topics.find((t) => t.id === topicB).summaryProjectId, pid, "出所未記録の要約は現在の対象で補完");
  assert.equal(s.topics.find((t) => t.id === topicOld).summaryProjectId, null);
});

test("11. 要約の出所: 分岐後に対象を変えると初回プロンプトに注記、同じ対象なら注記なし。出所は要約と一緒に引き継ぐ", async () => {
  const first = (await getState()).messages.find((m) => m.topicId === topicA);
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" } });
  // A → A（同じ対象）: 要約は入るが注記なし
  const same = (await api("POST", "/api/topics/" + topicA + "/branch", { messageId: first.id })).body;
  assert.equal(same.summaryProjectId, pid, "要約の出所を要約と一緒に引き継ぐ");
  clearCalls();
  await say(same.id, "claude", "続き");
  let call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("--- これまでのスレッドの要約"), call.prompt.slice(0, 600));
  assert.ok(call.prompt.includes("- 要約テスト"));
  assert.ok(!call.prompt.includes("注意: 以下の要約は"), "同じ対象なら注記なし");
  // A → A で分岐し、初回実行前に PATCH で plain へ変更（レビュー指摘の再現）: 旧対象の要約であることを注記
  const moved = (await api("POST", "/api/topics/" + topicA + "/branch", { messageId: first.id })).body;
  assert.equal((await api("PATCH", "/api/topics/" + moved.id, { projectId: plainPid })).status, 200);
  assert.equal((await getTopic(moved.id)).summaryProjectId, pid, "PATCH は要約の出所を変えない");
  clearCalls();
  await say(moved.id, "claude", "続き");
  call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("（注意: 以下の要約は対象「ext-project」の時点のものです。現在の対象は「plain」です）\n## 合意済み"), call.prompt.slice(0, 900));
  // 分岐 API で未紐付け（null）を指定: 現在の対象は「アプリのリポジトリ（既定）」
  const toNull = (await api("POST", "/api/topics/" + topicA + "/branch", { messageId: first.id, projectId: null })).body;
  assert.equal(toNull.projectId, null);
  assert.equal(toNull.summaryProjectId, pid);
  clearCalls();
  await say(toNull.id, "claude", "続き");
  call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("現在の対象は「アプリのリポジトリ（既定）」です"), call.prompt.slice(0, 900));
  // 要約のない分岐元からの分岐: 出所も null
  const fromPlain = (await getState()).topics.find((t) => t.title === "従来");
  const pm = (await getState()).messages.find((m) => m.topicId === fromPlain.id);
  const noSum = (await api("POST", "/api/topics/" + fromPlain.id + "/branch", { messageId: pm.id, projectId: pid })).body;
  assert.equal(noSum.summaryText, "");
  assert.equal(noSum.summaryProjectId, null);
});

test("12. 上限: 同時送信でも、確認待ちを経た起動が走行中件数に数えられ、実行回数上限を超えない", async () => {
  await idle();
  const s0 = await getState();
  const runsToday = s0.usageDay && s0.usageDay.date === todayStr() ? s0.usageDay.runs : 0;
  assert.equal((await api("PATCH", "/api/budgets", { runCount: runsToday + 1 })).status, 200, "残り 1 回");
  // probe（git）が 3 秒かかる状態で、両エージェントへ同時に送る → 両方が確認待ちで重なる
  writeCtl({ claude: { text: "了解", delayMs: 800 }, codex: { text: "了解", delayMs: 800 }, git: { mode: "sleep" } });
  clearCalls();
  const before = (await getState()).messages.length;
  const t0 = Date.now();
  const posted = await Promise.all([
    api("POST", "/api/messages", { topicId: topicA, thread: "claude", text: "同時1", author: "user" }),
    api("POST", "/api/messages", { topicId: topicB, thread: "codex", text: "同時2", author: "user" }),
  ]);
  assert.ok(posted.every((r) => r.status < 300));
  try {
    // 片方の返答（1）＋もう片方の上限停止通知（1）。30 秒周期の自動要約が偶然重なった場合は停止通知だけになる
    await waitFor(async () => (await getState()).messages.length >= before + 3, "reply + halt", 30000);
    await idle();
    const threadCalls = cliCalls().filter((c) => c.prompt.includes("--- 新着メッセージ ---"));
    // 修正前の退行（確認待ち中の起動が数えられず 2 回起動）は必ず検出する
    assert.ok(threadCalls.length <= 1, "上限 1 で CLI が " + threadCalls.length + " 回起動した");
    const s = await getState();
    assert.ok(s.budgetHalt, "上限停止ラッチが立つ");
    assert.ok(s.messages.some((m) => m.budget && m.ts >= t0), "上限停止の通知が残る");
  } finally {
    writeCtl({ claude: { text: "了解" }, codex: { text: "了解" } });
    assert.equal((await api("PATCH", "/api/budgets", { runCount: null })).status, 200);
    assert.equal((await api("POST", "/api/budgets/resume")).status, 200);
  }
});

test("13. 確認待ち中に自動応答を OFF にすると起動しない（起動直前に再判定する）", async () => {
  await idle();
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" }, git: { mode: "sleep" } });
  clearCalls();
  const before = (await getState()).messages.filter((m) => m.topicId === topicA).length;
  assert.ok((await api("POST", "/api/messages", { topicId: topicA, thread: "claude", text: "待って", author: "user" })).status < 300);
  await sleep(300); // agentLoop が対象確認（3 秒）の await に入るのを待つ
  assert.equal((await api("PATCH", "/api/agents/claude", { auto: false })).status, 200);
  await sleep(4000);
  await idle();
  assert.equal(cliCalls("claude").filter((c) => c.prompt.includes("--- 新着メッセージ ---")).length, 0, "OFF 後は起動しない");
  assert.equal((await getState()).messages.filter((m) => m.topicId === topicA).length, before + 1, "返答も停止通知も付かない");
  assert.equal((await api("PATCH", "/api/agents/claude", { auto: true })).status, 200); // ON で既読位置が進むので、上の発言は拾われない
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" } });
});

test("14. 概要: README が通常ファイルでなければ読まずに開始でき、巨大 README は冒頭だけ読んで 4,000 文字で打ち切る", async () => {
  const fifoDir = path.join(tmp, "fifo-project");
  fs.mkdirSync(fifoDir);
  execFileSync("mkfifo", [path.join(fifoDir, "README")]); // 修正前は readFileSync が永久に待ち、サーバー全体が止まる
  const bigDir = path.join(tmp, "big-project");
  fs.mkdirSync(bigDir);
  fs.writeFileSync(path.join(bigDir, "README.md"), "# Big\n" + "あ".repeat(200000)); // 約 600 KB
  const pf = (await api("POST", "/api/projects", { path: fifoDir })).body.project;
  const pb = (await api("POST", "/api/projects", { path: bigDir })).body.project;
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" } });
  const tf = (await api("POST", "/api/topics", { title: "fifo", projectId: pf.id })).body;
  clearCalls();
  await say(tf.id, "claude", "概要は？");
  let call = cliCalls("claude")[0];
  assert.ok(call, "FIFO の README で固まらない");
  assert.ok(call.prompt.includes("（README は見つかりませんでした）"), "通常ファイル以外は候補にしない");
  const tb = (await api("POST", "/api/topics", { title: "big", projectId: pb.id })).body;
  clearCalls();
  await say(tb.id, "claude", "概要は？");
  call = cliCalls("claude")[0];
  const digest = call.prompt.split("--- 対象プロジェクトの概要（初回のみ） ---\n")[1].split("\n[ユーザー]")[0];
  assert.ok(digest.includes("# Big"));
  assert.match(digest, /打ち切り/);
  assert.ok(digest.length <= 4100, "4,000 文字で打ち切る: " + digest.length);
});

test("15. PATCH: 409／400 で返すときはタイトルも変わらない（全入力を検証してから状態を変える）", async () => {
  const lockedBefore = await getTopic(topicA);
  assert.equal(lockedBefore.projectLocked, true);
  const r1 = await api("PATCH", "/api/topics/" + topicA, { title: "変更後", projectId: plainPid });
  assert.equal(r1.status, 409);
  assert.equal((await getTopic(topicA)).title, lockedBefore.title, "409 でタイトルが変わらない");
  const fresh = (await api("POST", "/api/topics", { title: "未実行", projectId: pid })).body;
  const r2 = await api("PATCH", "/api/topics/" + fresh.id, { title: "変更後", projectId: "nope" });
  assert.equal(r2.status, 400);
  const after = await getTopic(fresh.id);
  assert.equal(after.title, "未実行", "400 でタイトルが変わらない");
  assert.equal(after.projectId, pid, "400 で対象も変わらない");
  // 正常系: タイトルと対象が同時に変わる
  const r3 = await api("PATCH", "/api/topics/" + fresh.id, { title: "変更後", projectId: plainPid });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.title, "変更後");
  assert.equal(r3.body.projectId, plainPid);
});

test("16. 名前に「。」を含むプロジェクトでも、レビュー・修正プロンプトの Git 情報が崩れない", async () => {
  const dotDir = path.join(tmp, "dot-project");
  fs.mkdirSync(dotDir);
  fs.writeFileSync(path.join(dotDir, "a.txt"), "x\n");
  const pr = await api("POST", "/api/projects", { path: dotDir, name: "検証。A" });
  assert.equal(pr.status, 201);
  const dotPath = pr.body.project.path;
  const t = (await api("POST", "/api/topics", { title: "句点", projectId: pr.body.project.id })).body;
  const pi = await api("POST", "/api/pool", { origin: "user", title: "dot-memo", body: "hello", topicId: t.id, autoReview: false });
  assert.equal(pi.status, 201);
  assert.equal(pi.body.projectId, pr.body.project.id);
  writeCtl({ claude: { text: "見ました\n【判定】承認" }, codex: { text: "OK\n【判定】承認" } });
  clearCalls();
  assert.equal((await api("POST", "/api/pool/" + pi.body.id + "/review", { reviewer: "claude" })).status, 202);
  await idle();
  let call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("対象プロジェクト「検証。A」（" + dotPath + "、閲覧のみ可）の実態と照らして"), call.prompt.slice(0, 500));
  assert.ok(call.prompt.includes("対象プロジェクトは「検証。A」（" + dotPath + "、閲覧のみ・変更不可）。Git 管理外のフォルダ。"), call.prompt.slice(0, 500));
  assert.ok(!call.prompt.includes("閲覧のみ可。A」"), "名前の断片が Git 情報の位置に入らない");
  clearCalls();
  assert.equal((await api("POST", "/api/pool/" + pi.body.id + "/fix", { agent: "codex" })).status, 202);
  await waitFor(async () => ((await getState()).pool.find((p) => p.id === pi.body.id).fixes || []).length === 1, "fix done");
  await idle();
  call = cliCalls("codex")[0];
  assert.ok(call.prompt.includes("照合先は対象プロジェクト「検証。A」（" + dotPath + "、閲覧のみ可）。\n対象プロジェクトは「検証。A」（" + dotPath + "、閲覧のみ・変更不可）。Git 管理外のフォルダ。"), call.prompt.slice(0, 600));
});

test("17. 再要約: 要約入力に対象と旧要約の出所を明示し、出所は開始時点の対象で固定する（再要約中の対象変更を含む）", async () => {
  await idle();
  const first = (await getState()).messages.find((m) => m.topicId === topicA);
  // A（要約の出所 = ext-project）から plain へ分岐し、手動で再要約 → 旧対象の要約であることが入力・保存の両方に残る
  const b = (await api("POST", "/api/topics/" + topicA + "/branch", { messageId: first.id, projectId: plainPid })).body;
  assert.equal(b.summaryProjectId, pid);
  writeCtl({ claude: { text: "## 合意済み\n- 更新後\n## 未決\n- なし" }, codex: { text: "了解" } });
  clearCalls();
  assert.equal((await api("POST", "/api/topics/" + b.id + "/summarize")).status, 202);
  await waitFor(async () => (await getTopic(b.id)).summaryProjectId === plainPid, "summary of branch");
  let call = cliCalls("claude")[0];
  assert.ok(call, "要約の呼び出し");
  assert.ok(call.prompt.includes("対象プロジェクトは「plain」です"), call.prompt.slice(0, 400));
  assert.ok(call.prompt.includes("--- 前回までの要約（対象「ext-project」の時点のもの） ---"), call.prompt.slice(0, 600));
  assert.ok(call.prompt.includes("（旧対象「ext-project」での合意）"), "旧対象の合意を区別する指示");
  let tb = await getTopic(b.id);
  assert.ok(tb.summaryText.startsWith("（この要約は対象「ext-project」の時点の内容を引き継ぎ、対象「plain」で更新したものです）\n## 合意済み"), tb.summaryText);
  assert.equal(tb.projectLocked, false, "要約は実行に数えない");
  // 出所が現在の対象と一致したので、初回プロンプトの注記は付かない
  clearCalls();
  await say(b.id, "claude", "続き");
  call = cliCalls("claude").find((c) => c.prompt.includes("--- 新着メッセージ ---"));
  assert.ok(!call.prompt.includes("注意: 以下の要約は"), "再要約後は注記なし");
  assert.ok(call.prompt.includes("（この要約は対象「ext-project」の時点の内容を引き継ぎ"), "引き継ぎの注記は要約本文に残る");
  assert.ok(call.prompt.includes("引き継いだ会話には対象「ext-project」の時点の内容が含まれます"), "会話の出所注記（恒久マーク）");
  // 2 回目の再要約でも、引き継いだ旧対象の注意は消えない（carriedProjectId は再要約で上書きされない）
  writeCtl({ claude: { text: "## 合意済み\n- 二度目\n## 未決\n- なし" }, codex: { text: "了解" } });
  clearCalls();
  assert.equal((await api("POST", "/api/topics/" + b.id + "/summarize")).status, 202);
  await waitFor(async () => (await getTopic(b.id)).summaryText.includes("二度目"), "second resummary");
  call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("（旧対象「ext-project」での合意）"), "2 回目の再要約でも旧対象の区別指示が入る");
  assert.ok(call.prompt.includes("分岐で引き継いだ対象「ext-project」の時点の内容が含まれます"));
  tb = await getTopic(b.id);
  assert.ok(tb.summaryText.startsWith("（この要約は対象「ext-project」の時点の内容を引き継ぎ、対象「plain」で更新したものです）"), tb.summaryText);
  // 再要約中に対象を変えても、出所は開始時点の対象（plain）で保存され、次の初回プロンプトで注記される
  const c = (await api("POST", "/api/topics/" + topicA + "/branch", { messageId: first.id, projectId: plainPid })).body;
  writeCtl({ claude: { text: "## 合意済み\n- 途中変更\n## 未決\n- なし", delayMs: 1500 }, codex: { text: "了解" } });
  clearCalls();
  assert.equal((await api("POST", "/api/topics/" + c.id + "/summarize")).status, 202);
  await sleep(400); // 要約の await に入ってから対象を変える
  assert.equal((await api("PATCH", "/api/topics/" + c.id, { projectId: pid })).status, 200);
  await waitFor(async () => (await getTopic(c.id)).summaryText.includes("途中変更"), "summary during patch");
  const tc = await getTopic(c.id);
  assert.equal(tc.projectId, pid);
  assert.equal(tc.summaryProjectId, plainPid, "出所は開始時点の対象で固定");
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" } });
  clearCalls();
  await say(c.id, "claude", "続き");
  call = cliCalls("claude").find((c2) => c2.prompt.includes("--- 新着メッセージ ---"));
  assert.ok(call.prompt.includes("（注意: 以下の要約は対象「plain」の時点のものです。現在の対象は「ext-project」です）"), call.prompt.slice(0, 900));
});

test("18. 要約なしの分岐: 引き継いだ会話の出所（carriedProjectId）が初回プロンプトと要約の入力・保存に明示される", async () => {
  await idle();
  // 要約のない分岐元を新しく作る（既存トピックは自動要約が走っている可能性がある）
  const srcT = (await api("POST", "/api/topics", { title: "外部D", projectId: pid })).body;
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" } });
  await say(srcT.id, "claude", "外部Dの初回");
  const src = await getTopic(srcT.id);
  assert.ok(!src.summaryText, "前提: 分岐元に要約がない");
  const first = (await getState()).messages.find((m) => m.topicId === srcT.id);
  const d = (await api("POST", "/api/topics/" + srcT.id + "/branch", { messageId: first.id, projectId: plainPid })).body;
  assert.equal(d.summaryProjectId, null, "要約は引き継がれない");
  writeCtl({ claude: { text: "了解" }, codex: { text: "了解" } });
  clearCalls();
  await say(d.id, "claude", "引き継ぎです");
  let call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("引き継いだ会話には対象「ext-project」の時点の内容が含まれます"), call.prompt.slice(0, 700));
  writeCtl({ claude: { text: "## 合意済み\n- 引継ぎ\n## 未決\n- なし" }, codex: { text: "了解" } });
  clearCalls();
  assert.equal((await api("POST", "/api/topics/" + d.id + "/summarize")).status, 202);
  await waitFor(async () => (await getTopic(d.id)).summaryText.includes("引継ぎ"), "summary of no-summary branch");
  call = cliCalls("claude")[0];
  assert.ok(call.prompt.includes("分岐で引き継いだ対象「ext-project」の時点の内容が含まれます"), "要約入力に会話の出所");
  assert.ok(call.prompt.includes("（旧対象「ext-project」での合意）"), "旧対象の区別指示");
  assert.ok((await getTopic(d.id)).summaryText.startsWith("（この要約は対象「ext-project」の時点の内容を引き継ぎ、対象「plain」で更新したものです）"));
});
