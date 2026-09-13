// 成果物バージョン履歴 — サーバ統合テスト（仕様: SPEC-成果物バージョン履歴.md「検証」1〜11 ＋ レビュー指摘の異常系 12〜18）
// server.mjs を一時ディレクトリへ複製し、偽の claude / codex CLI（PATH 先頭）で修正・レビューを駆動する。
// 偽 CLI は制御ファイル（U2A2A_FAKE_CTL）を読み、ファイル書き換え・遅延・失敗・manifest 破壊を再現する。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 管理資格（契約-資格隔離API.md §4）。サーバへ同じ値を U2A2A_ADMIN_CREDENTIAL で渡し、
// ここでは全要求へ Authorization を足す（画面側の fetch 包みと同じ扱い）
const CRED = "c".repeat(64);
// 強制層は測らない（この機械に srt が入っていても結果が変わらないように、必ず不在にする）。
// 隔離の統合そのものは isolation.server.test.mjs で見る
const NO_SANDBOX = "u2a2a-sandbox-absent";
const rawFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || undefined);
  if (!headers.has("Authorization")) headers.set("Authorization", "Bearer " + CRED);
  return rawFetch(input, { ...init, headers });
};

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 偽 CLI（CommonJS・拡張子なし・shebang で起動）。stdin のプロンプトを読み切ってから制御ファイルどおりに振る舞う
// （ctl.promptFile があれば受け取ったプロンプトをそこへ保存し、テストが内容を検証できるようにする）
const FAKE_CLI = (kind) => `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const kind = ${JSON.stringify(kind)};
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(fs.readFileSync(__filename + ".env", "utf8").trim(), "utf8")); } catch (e) {}
const c = ctl[kind] || {};
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { prompt += d; });
process.stdin.on("end", () => {
  if (ctl.logFile) fs.appendFileSync(ctl.logFile, kind + "\\n");
  if (ctl.promptFile) fs.writeFileSync(ctl.promptFile, prompt);
  if (c.write) fs.writeFileSync(path.join(ctl.poolDir, c.write.file), c.write.content);
  if (c.breakManifest) {
    const m = path.join(ctl.poolDir, ".versions", ctl.itemId, "manifest.json");
    fs.renameSync(m, m + ".bak");
    fs.mkdirSync(m);
  }
  setTimeout(() => {
    if (c.fail) {
      process.stderr.write("fake failure");
      process.exit(1);
    }
    const text = c.text || "ok";
    const line = kind === "claude"
      ? JSON.stringify({ type: "result", result: text, session_id: "fake-session", usage: { input_tokens: 1, output_tokens: 1 } })
      : JSON.stringify({ type: "thread.started", thread_id: "fake-thread" });
    if (kind === "codex") {
      const i = process.argv.indexOf("-o");
      if (i > 0) fs.writeFileSync(process.argv[i + 1], text);
    }
    process.stdout.write(line + "\\n", () => process.exit(0)); // パイプへの書き込み完了を待ってから終了
  }, c.delayMs || 0);
});
`;

let tmp, appDir, poolDir, fakeBin, ctlFile, logFile, port, server;
let itemId, binItemId, bigItemId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeCtl = (obj) => fs.writeFileSync(ctlFile, JSON.stringify({ poolDir, logFile, itemId, ...obj }));
const cliLog = () => fs.readFileSync(logFile, "utf8");
const manifestPath = (id) => path.join(poolDir, ".versions", id, "manifest.json");
const readManifest = (id) => JSON.parse(fs.readFileSync(manifestPath(id), "utf8"));

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
const getItem = async (id) => (await getState()).pool.find((p) => p.id === id);

async function waitFor(fn, label, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout: " + label);
    await sleep(100);
  }
}
// 修正もレビューも走っていない状態まで待つ
const idle = (id) =>
  waitFor(async () => {
    const s = await getState();
    return !s.fixPending[id] && !(s.reviewPending[id] || []).length ? s : null;
  }, "idle " + id);

async function startServer() {
  port = 20000 + Math.floor(Math.random() * 20000);
  // spawnEnv の許可リスト化で U2A2A_FAKE_* は子へ渡らない。偽 CLI の隣へ控えを置く
  for (const f of fs.readdirSync(fakeBin)) if (!f.endsWith(".env")) fs.writeFileSync(path.join(fakeBin, f) + ".env", ctlFile);
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: appDir,
    env: { ...process.env, U2A2A_ADMIN_CREDENTIAL: CRED, U2A2A_SANDBOX_CMD: NO_SANDBOX, U2A2A_PORT: String(port), PATH: fakeBin + ":" + process.env.PATH },
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

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u2a2a-versions-"));
  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "tray.mjs", "credentials.mjs", "sandbox.mjs", "sandbox-profiles.json", "package.json", "public/flow-graph.js", "public/usage.js"]) fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  poolDir = path.join(appDir, "pool");
  fs.mkdirSync(poolDir);
  fs.writeFileSync(path.join(poolDir, "art.md"), "# v1\nhello\n");
  fs.writeFileSync(path.join(poolDir, "bin.dat"), Buffer.from([0x50, 0x4b, 0x00, 0x01]));
  fs.writeFileSync(path.join(poolDir, "big.txt"), "x".repeat(300 * 1024));
  fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  for (const k of ["claude", "codex"]) fs.writeFileSync(path.join(fakeBin, k), FAKE_CLI(k), { mode: 0o755 });
  ctlFile = path.join(tmp, "ctl.json");
  logFile = path.join(tmp, "cli.log");
  fs.writeFileSync(logFile, "");
  writeCtl({});
  await startServer();
  // 新規環境の既定は自動応答 OFF。このファイルは修正後の自動再レビューを見るので、ここで明示的に ON にする
  for (const a of ["claude", "codex"]) await api("PATCH", "/api/agents/" + a, { auto: true });
  const s = await getState();
  itemId = s.pool.find((p) => p.file === "art.md").id;
  binItemId = s.pool.find((p) => p.file === "bin.dat").id;
  bigItemId = s.pool.find((p) => p.file === "big.txt").id;
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("1. 正常修正: 修正前後の版が切られ、再レビューに versionId が付く", async () => {
  writeCtl({ claude: { write: { file: "art.md", content: "# v2\nhello world\n" }, text: "直しました" }, codex: { text: "OK\n【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
  let it = await waitFor(async () => {
    const i = await getItem(itemId);
    return (i.fixes || []).length === 1 ? i : null;
  }, "fix done");
  assert.equal(it.fixes[0].error, undefined, it.fixes[0].text);
  assert.equal(it.versions.length, 2);
  assert.deepEqual(it.versions.map((v) => v.reason), ["fix-before", "fix-after"]);
  assert.deepEqual(it.versions.map((v) => v.agent), ["claude", "claude"]);
  assert.equal(it.fixes[0].beforeVersionId, it.versions[0].id);
  assert.equal(it.fixes[0].afterVersionId, it.versions[1].id);
  assert.equal(it.versions[1].partial, false);
  // manifest（正本）と一致し、版ファイルの中身は当時の内容
  const m = readManifest(itemId);
  assert.deepEqual(m.versions, it.versions);
  assert.equal(fs.readFileSync(path.join(poolDir, ".versions", itemId, "v1.md"), "utf8"), "# v1\nhello\n");
  assert.equal(fs.readFileSync(path.join(poolDir, ".versions", itemId, "v2.md"), "utf8"), "# v2\nhello world\n");
  // 自動再レビュー（相手 = codex）は最新版 v2 を対象にし、同一内容なので版は増えない
  it = await waitFor(async () => {
    const s = await getState();
    const i = s.pool.find((p) => p.id === itemId);
    return i.reviews.length === 1 && !(s.reviewPending[itemId] || []).length ? i : null;
  }, "auto re-review");
  assert.equal(it.reviews[0].reviewer, "codex");
  assert.equal(it.reviews[0].verdict, "承認");
  assert.equal(it.reviews[0].versionId, it.versions[1].id);
  assert.equal(it.reviews[0].sha256, it.versions[1].sha256);
  assert.equal(it.reviews[0].stale, false);
  assert.equal(it.versions.length, 2);
  // API: 版一覧と差分
  const v = await api("GET", "/api/pool/" + itemId + "/versions");
  assert.equal(v.status, 200);
  assert.equal(v.body.versions.length, 2);
  assert.equal(v.body.unsupportedReason, null);
  const d = await api("GET", "/api/pool/" + itemId + "/diff?to=" + it.versions[1].id);
  assert.equal(d.status, 200);
  assert.equal(d.body.from.n, 1);
  assert.equal(d.body.to.n, 2);
  assert.equal(d.body.truncated, false);
  // unified diff は削除群→追加群でグループ化される（GNU diff と同様）
  assert.ok(d.body.diff.includes("-# v1") && d.body.diff.includes("+# v2"), d.body.diff);
  const d1 = await api("GET", "/api/pool/" + itemId + "/diff?to=" + it.versions[0].id);
  assert.equal(d1.status, 200);
  assert.equal(d1.body.from, null);
  assert.equal(d1.body.diff, "");
  assert.equal((await api("GET", "/api/pool/" + itemId + "/diff")).status, 400);
  assert.equal((await api("GET", "/api/pool/" + itemId + "/diff?to=nope")).status, 404);
});

test("2. 無変更修正: 版が増えず、before と after が同じ版", async () => {
  writeCtl({ claude: { text: "変更なし" }, codex: { text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
  const it = await waitFor(async () => {
    const i = await getItem(itemId);
    return (i.fixes || []).length === 2 ? i : null;
  }, "fix 2 done");
  assert.equal(it.versions.length, 2);
  assert.equal(it.fixes[1].beforeVersionId, it.versions[1].id);
  assert.equal(it.fixes[1].afterVersionId, it.versions[1].id);
  await idle(itemId);
  assert.equal((await getItem(itemId)).reviews.length, 2, "再レビューは行われる");
});

test("3. CLI 途中失敗で内容が変わった: partial の版が残り、再レビューしない", async () => {
  writeCtl({ claude: { fail: true, write: { file: "art.md", content: "# v3 partial\n" } } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
  const it = await waitFor(async () => {
    const i = await getItem(itemId);
    return (i.fixes || []).length === 3 ? i : null;
  }, "fix 3 done");
  assert.equal(it.fixes[2].error, true);
  assert.equal(it.versions.length, 3);
  assert.equal(it.versions[2].reason, "fix-after");
  assert.equal(it.versions[2].partial, true);
  assert.equal(it.fixes[2].afterVersionId, it.versions[2].id);
  await sleep(800);
  const s = await getState();
  assert.equal((s.reviewPending[itemId] || []).length, 0);
  assert.equal(s.pool.find((p) => p.id === itemId).reviews.length, 2, "失敗した修正は再レビューを起動しない");
});

test("4. 修正前の版を保存できない: 修正を実行せず historyError を記録", async () => {
  const mf = manifestPath(itemId);
  fs.renameSync(mf, mf + ".bak");
  fs.mkdirSync(mf); // manifest.json をディレクトリにして読み書きを失敗させる
  const logBefore = cliLog();
  writeCtl({ claude: { write: { file: "art.md", content: "# must not happen\n" } } });
  try {
    assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
    const it = await waitFor(async () => {
      const i = await getItem(itemId);
      return (i.fixes || []).length === 4 ? i : null;
    }, "fix 4 aborted");
    assert.equal(it.fixes[3].error, true);
    assert.match(it.fixes[3].historyError, /修正前/);
    assert.equal(cliLog(), logBefore, "CLI は呼ばれない");
    assert.equal(fs.readFileSync(path.join(poolDir, "art.md"), "utf8"), "# v3 partial\n");
    assert.equal(it.versions.length, 3);
  } finally {
    fs.rmdirSync(mf);
    fs.renameSync(mf + ".bak", mf);
  }
});

test("5. 修正後の版を保存できない: historyError を記録し、再レビューしない", async () => {
  writeCtl({ claude: { write: { file: "art.md", content: "# v4\n" }, breakManifest: true, text: "done" } });
  const mf = manifestPath(itemId);
  try {
    assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
    const it = await waitFor(async () => {
      const i = await getItem(itemId);
      return (i.fixes || []).length === 5 ? i : null;
    }, "fix 5 done");
    assert.equal(it.fixes[4].error, undefined, "CLI 自体は成功");
    assert.match(it.fixes[4].historyError, /修正後/);
    assert.equal(it.fixes[4].afterVersionId, undefined);
    await sleep(800);
    const s = await getState();
    assert.equal((s.reviewPending[itemId] || []).length, 0);
    assert.equal(s.pool.find((p) => p.id === itemId).reviews.length, 2, "履歴保存に失敗したら再レビューしない");
  } finally {
    fs.rmdirSync(mf);
    fs.renameSync(mf + ".bak", mf);
  }
});

test("6. 競合: 修正中のレビュー/修正/削除は 409、レビュー中の修正/削除は 409、別レビュアーは許容", async () => {
  writeCtl({ claude: { delayMs: 1500, text: "slow fix" }, codex: { delayMs: 1500, text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
  await sleep(300);
  assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "codex" })).status, 409);
  assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "codex" })).status, 409);
  assert.equal((await api("DELETE", "/api/pool/" + itemId)).status, 409);
  await idle(itemId); // 修正完了 → 自動再レビュー（codex）完了まで
  const reviewsBefore = (await getItem(itemId)).reviews.length;
  assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "codex" })).status, 202);
  await sleep(300);
  assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 409);
  assert.equal((await api("DELETE", "/api/pool/" + itemId)).status, 409);
  writeCtl({ claude: { text: "【判定】条件付き承認" }, codex: { delayMs: 1500, text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "claude" })).status, 202, "別レビュアーの同時レビューは許容");
  await idle(itemId);
  assert.equal((await getItem(itemId)).reviews.length, reviewsBefore + 2);
});

test("9. レビュー中の外部変更: stale が付く", async () => {
  writeCtl({ claude: { delayMs: 1500, text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "claude" })).status, 202);
  await sleep(400);
  fs.writeFileSync(path.join(poolDir, "art.md"), "# edited outside during review\n");
  await idle(itemId);
  const it = await getItem(itemId);
  const last = it.reviews[it.reviews.length - 1];
  assert.equal(last.reviewer, "claude");
  assert.equal(last.stale, true);
  const target = it.versions.find((v) => v.id === last.versionId);
  assert.ok(target, "レビュー対象版が版一覧にある");
  assert.equal(target.sha256, last.sha256);
  assert.equal(it.reviews[it.reviews.length - 2].stale, false, "直前の（外部変更のない）レビューは stale でない");
});

test("7. 再起動後: manifest から履歴が復元される", async () => {
  const before = readManifest(itemId).versions;
  await sleep(1000); // state.json の遅延保存（100ms）を待つ
  await stopServer();
  await startServer();
  const v = await api("GET", "/api/pool/" + itemId + "/versions");
  assert.equal(v.status, 200);
  assert.deepEqual(v.body.versions, before);
  assert.deepEqual((await getItem(itemId)).versions, before);
});

test("10. 対象外（バイナリ・256 KiB 超）: unsupportedReason を返し、修正は従来の .trash バックアップで動く", async () => {
  const { createHash } = await import("node:crypto");
  const binSha = createHash("sha256").update(fs.readFileSync(path.join(poolDir, "bin.dat"))).digest("hex");
  const vb = await api("GET", "/api/pool/" + binItemId + "/versions");
  assert.equal(vb.status, 200);
  // バイナリは版管理対象外でも実ファイルは読めるので currentSha は返す。サイズ超過は読まないので null
  assert.deepEqual(vb.body, { versions: [], unsupportedReason: "binary", currentSha: binSha });
  const vl = await api("GET", "/api/pool/" + bigItemId + "/versions");
  assert.deepEqual(vl.body, { versions: [], unsupportedReason: "too-large", currentSha: null });
  writeCtl({ codex: { text: "done" }, claude: { text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + binItemId + "/fix", { agent: "codex" })).status, 202);
  const it = await waitFor(async () => {
    const i = await getItem(binItemId);
    return (i.fixes || []).length === 1 ? i : null;
  }, "bin fix done");
  assert.equal(it.fixes[0].error, undefined, it.fixes[0].text);
  assert.equal(it.fixes[0].beforeVersionId, undefined);
  assert.equal(it.versionsUnsupported, "binary");
  assert.ok(!fs.existsSync(path.join(poolDir, ".versions", binItemId)), "対象外には版ディレクトリを作らない");
  assert.ok(fs.readdirSync(path.join(poolDir, ".trash")).some((f) => f.endsWith("-prefix-bin.dat")), "従来の .trash バックアップ");
  await idle(binItemId);
});

// ---- 以下はレビュー指摘（Codex）で追加した異常系。仕様「検証」には無いが、保存失敗時の保護に関わる ----

const artPath = () => path.join(poolDir, "art.md");
const versionFile = (v) => path.join(poolDir, ".versions", itemId, v.file);
const lastOf = (arr) => arr[arr.length - 1];
const trashPrefixCount = () => fs.readdirSync(path.join(poolDir, ".trash")).filter((f) => f.endsWith("-prefix-art.md")).length;

test("12. 修正前の実ファイルが読み取り障害（EACCES）: 対象外扱いで続行せず、修正を中止する", { skip: process.getuid && process.getuid() === 0 ? "root では EACCES を再現できない" : false }, async () => {
  await idle(itemId);
  const it0 = await getItem(itemId);
  const before = fs.readFileSync(artPath(), "utf8");
  const logBefore = cliLog();
  const trashBefore = trashPrefixCount();
  fs.chmodSync(artPath(), 0o000);
  writeCtl({ claude: { write: { file: "art.md", content: "# must not happen\n" } } });
  try {
    assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
    const it = await waitFor(async () => {
      const i = await getItem(itemId);
      return i.fixes.length === it0.fixes.length + 1 ? i : null;
    }, "fix aborted (EACCES)");
    const f = lastOf(it.fixes);
    assert.equal(f.error, true);
    assert.match(f.historyError, /修正前/);
    assert.equal(f.beforeVersionId, undefined);
    assert.equal(cliLog(), logBefore, "CLI は呼ばれない");
    assert.equal(it.versions.length, it0.versions.length, "版は増えない");
    assert.notEqual(it.versionsUnsupported, "no-file", "読み取り障害を『ファイル実体なし』にしない");
    assert.equal(trashPrefixCount(), trashBefore, "対象外扱いの .trash バックアップにも流れない");
  } finally {
    fs.chmodSync(artPath(), 0o644);
  }
  assert.equal(fs.readFileSync(artPath(), "utf8"), before, "実ファイルは触られていない");
  // 読めるようになれば対象外ではない（versions API の理由も null）
  assert.equal((await api("GET", "/api/pool/" + itemId + "/versions")).body.unsupportedReason, null);
});

test("13. manifest はあるが版ファイルが欠落: 版を再利用する前に実体を検証し、現在の内容から復旧する", async () => {
  await idle(itemId);
  // 前提を作る: 現在の内容をレビューで版にする（最新版 = 実ファイル）
  writeCtl({ codex: { text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "codex" })).status, 202);
  await idle(itemId);
  const it0 = await getItem(itemId);
  const last = lastOf(it0.versions);
  const content = fs.readFileSync(artPath(), "utf8");
  assert.equal(fs.readFileSync(versionFile(last), "utf8"), content, "前提: 最新版の内容 = 実ファイル");
  fs.unlinkSync(versionFile(last));
  // 内容が同じなので前版保存は既存版を再利用する。その前に欠落を検知して復旧し、そのうえで CLI が書き換える
  writeCtl({ claude: { write: { file: "art.md", content: "# after restore\n" }, text: "ok" }, codex: { text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
  const it = await waitFor(async () => {
    const i = await getItem(itemId);
    return i.fixes.length === it0.fixes.length + 1 ? i : null;
  }, "fix after restore");
  const f = lastOf(it.fixes);
  assert.equal(f.error, undefined);
  assert.equal(f.historyError, undefined);
  assert.equal(f.beforeVersionId, last.id, "前版は既存の版を再利用");
  assert.equal(fs.readFileSync(versionFile(last), "utf8"), content, "欠落していた版ファイルが修正前の内容で復旧している");
  assert.equal(it.versions.length, it0.versions.length + 1);
  assert.equal(fs.readFileSync(versionFile(lastOf(it.versions)), "utf8"), "# after restore\n");
  await idle(itemId);
  // 内容が不整合（manifest の sha256 と違う）でも同様に復旧する
  const it1 = await getItem(itemId);
  const cur = lastOf(it1.versions);
  fs.writeFileSync(versionFile(cur), "corrupted\n");
  writeCtl({ codex: { text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "codex" })).status, 202);
  await idle(itemId);
  assert.equal(fs.readFileSync(versionFile(cur), "utf8"), "# after restore\n", "不整合な版ファイルも復旧");
  assert.equal(lastOf((await getItem(itemId)).reviews).versionId, cur.id);
});

test("14. レビュープロンプトの本文・全文参照先は保存版に固定され、前版との差分取得失敗は明示される", async () => {
  await idle(itemId);
  const promptFile = path.join(tmp, "prompt.txt");
  // 8000 文字超にして「全文は … を参照」が付く状態にする
  const big = "# big\n" + "line\n".repeat(3000);
  fs.writeFileSync(artPath(), big);
  writeCtl({ promptFile, codex: { text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "codex" })).status, 202);
  await idle(itemId);
  const it = await getItem(itemId);
  const rev = lastOf(it.reviews);
  const v = it.versions.find((x) => x.id === rev.versionId);
  assert.ok(v, "レビュー対象版が版一覧にある");
  const snapRel = "u2a2a/pool/.versions/" + itemId + "/" + v.file;
  const prompt = fs.readFileSync(promptFile, "utf8");
  assert.ok(prompt.includes("レビュー対象: v" + v.n + " のスナップショット " + snapRel), "対象版のスナップショットが明示される");
  assert.ok(prompt.includes("全文は " + snapRel + " を参照"), "全文参照先はスナップショット");
  assert.ok(!prompt.includes("全文は u2a2a/pool/art.md"), "変更され得る実ファイルを参照させない");
  assert.ok(prompt.includes(big.slice(0, 8000)), "本文は保存版の内容");
  assert.equal(fs.readFileSync(versionFile(v), "utf8"), big);
  // 前版ファイルを欠落させて内容を変えレビュー → 差分取得失敗が明示され、「前版と同一内容」にはならず、レビュー自体は行われる
  fs.renameSync(versionFile(v), versionFile(v) + ".bak");
  fs.writeFileSync(artPath(), "# small again\n");
  try {
    assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "codex" })).status, 202);
    await idle(itemId);
    const it2 = await getItem(itemId);
    const rev2 = lastOf(it2.reviews);
    assert.equal(rev2.error, undefined);
    assert.equal(it2.versions.length, it.versions.length + 1);
    assert.equal(rev2.versionId, lastOf(it2.versions).id);
    const p2 = fs.readFileSync(promptFile, "utf8");
    assert.ok(p2.includes("前版 v" + v.n + " からの差分"), p2.slice(-600));
    assert.ok(p2.includes("前版との差分を取得できませんでした"), "差分取得失敗を明示");
    assert.ok(!p2.includes("前版と同一内容"), "取得失敗を『同一内容』と誤表示しない");
    assert.ok(p2.includes("# small again"), "本文は新しい保存版");
  } finally {
    fs.renameSync(versionFile(v) + ".bak", versionFile(v));
  }
});

test("15. manifest だけ欠落（版ファイルや索引の写しは残存）: 初版として書き直さず、修正を中止する", async () => {
  await idle(itemId);
  const it0 = await getItem(itemId);
  assert.ok(it0.versions.length >= 2, "前提: 版が複数ある");
  const mf = manifestPath(itemId);
  const v1 = it0.versions[0];
  const v1Content = fs.readFileSync(versionFile(v1), "utf8");
  const artBefore = fs.readFileSync(artPath(), "utf8");
  const logBefore = cliLog();
  fs.renameSync(mf, mf + ".bak");
  writeCtl({ claude: { write: { file: "art.md", content: "# must not overwrite v1\n" } }, codex: { text: "【判定】承認" } });
  try {
    // 修正: 前版保存が「索引欠損」で失敗し、CLI を呼ばずに中止する
    assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
    const it = await waitFor(async () => {
      const i = await getItem(itemId);
      return i.fixes.length === it0.fixes.length + 1 ? i : null;
    }, "fix aborted (manifest missing)");
    const f = lastOf(it.fixes);
    assert.equal(f.error, true);
    assert.match(f.historyError, /修正前/);
    assert.match(f.historyError, /manifest\.json が無いのに履歴が残っています/);
    assert.equal(cliLog(), logBefore, "CLI は呼ばれない");
    assert.equal(fs.readFileSync(versionFile(v1), "utf8"), v1Content, "既存の v1 は上書きされない");
    assert.equal(fs.readFileSync(artPath(), "utf8"), artBefore, "実ファイルは触られていない");
    assert.deepEqual(it.versions, it0.versions, "版一覧が 1 件に縮まない");
    assert.ok(!fs.existsSync(mf), "manifest を勝手に作り直さない");
    // レビュー: 版が切れないので CLI を呼ばずに中止し、error 付きの記録に historyError を残す。版ファイルにも触らない
    const logBefore1 = cliLog();
    assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "codex" })).status, 202);
    await idle(itemId);
    const it2 = await getItem(itemId);
    const rev = lastOf(it2.reviews);
    assert.equal(rev.error, true);
    assert.match(rev.historyError, /manifest\.json が無いのに履歴が残っています/);
    assert.equal(rev.versionId, null);
    assert.equal(cliLog(), logBefore1, "CLI は呼ばれない");
    assert.equal(fs.readFileSync(versionFile(v1), "utf8"), v1Content);
    assert.deepEqual(it2.versions, it0.versions);
    assert.ok(!fs.existsSync(mf));
  } finally {
    fs.renameSync(mf + ".bak", mf);
  }
  // 版ディレクトリごと消えていても、item.versions（索引の写し）が残っている限り初版から切り直さない
  const dir = path.join(poolDir, ".versions", itemId);
  fs.cpSync(dir, dir + ".bak", { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
  const logBefore2 = cliLog();
  try {
    assert.equal((await api("POST", "/api/pool/" + itemId + "/fix", { agent: "claude" })).status, 202);
    const it = await waitFor(async () => {
      const i = await getItem(itemId);
      return i.fixes.length === it0.fixes.length + 2 ? i : null;
    }, "fix aborted (versions dir missing)");
    assert.equal(lastOf(it.fixes).error, true);
    assert.match(lastOf(it.fixes).historyError, /索引の写し [1-9]/);
    assert.equal(cliLog(), logBefore2, "CLI は呼ばれない");
    assert.ok(!fs.existsSync(dir), "版ディレクトリを作り直さない");
    assert.deepEqual(it.versions, it0.versions);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.cpSync(dir + ".bak", dir, { recursive: true });
    fs.rmSync(dir + ".bak", { recursive: true, force: true });
  }
  assert.equal(fs.readFileSync(artPath(), "utf8"), artBefore);
  assert.deepEqual(readManifest(itemId).versions, it0.versions, "manifest は元どおり");
});

test("16. 前版ファイルは存在するが内容が manifest と不一致: 差分取得失敗として扱い、正常な差分に見せない", async () => {
  await idle(itemId);
  const it0 = await getItem(itemId);
  const prev = lastOf(it0.versions);
  const prevContent = fs.readFileSync(versionFile(prev), "utf8");
  const next = "# corrupted-prev test\n";
  assert.notEqual(prevContent, next);
  // 前版の保存ファイルを「新しい本文と同じ内容」に破損させる（無検証なら差分が空になり「前版と同一内容」と誤表示される）
  fs.writeFileSync(versionFile(prev), next);
  fs.writeFileSync(artPath(), next);
  const promptFile = path.join(tmp, "prompt16.txt");
  writeCtl({ promptFile, codex: { text: "【判定】承認" } });
  try {
    assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "codex" })).status, 202);
    await idle(itemId);
    const it = await getItem(itemId);
    const rev = lastOf(it.reviews);
    assert.equal(rev.error, undefined, "レビュー自体は行われる");
    assert.equal(it.versions.length, it0.versions.length + 1, "新しい版は切られる");
    const cur = lastOf(it.versions);
    assert.equal(rev.versionId, cur.id);
    const p = fs.readFileSync(promptFile, "utf8");
    assert.ok(p.includes("前版 v" + prev.n + " からの差分"), p.slice(-600));
    assert.ok(p.includes("前版との差分を取得できませんでした"), "差分取得失敗を明示");
    assert.ok(p.includes("sha256 と一致しません"), "理由（内容不一致）を明示");
    assert.ok(!p.includes("前版と同一内容"), "破損した前版を『同一内容』と誤表示しない");
    // diff API も同じ検証を通る: 破損した版を含む差分は 500、破損版を含まない差分は従来どおり
    const d = await api("GET", "/api/pool/" + itemId + "/diff?to=" + cur.id);
    assert.equal(d.status, 500);
    assert.match(d.body.error, /sha256 と一致しません/);
    assert.equal((await api("GET", "/api/pool/" + itemId + "/diff?to=" + prev.id)).status, 500, "破損版そのものを to にしても失敗");
    assert.equal((await api("GET", "/api/pool/" + itemId + "/diff?from=" + it0.versions[0].id + "&to=" + cur.id)).status, 200, "健全な版どうしは取得できる");
    // 破損した前版ファイルは当時の内容に戻せば復活する（manifest の sha256 は正しいまま）
    fs.writeFileSync(versionFile(prev), prevContent);
    const d2 = await api("GET", "/api/pool/" + itemId + "/diff?to=" + cur.id);
    assert.equal(d2.status, 200);
    assert.ok(d2.body.diff.includes("+# corrupted-prev test\n"), d2.body.diff);
  } finally {
    fs.writeFileSync(versionFile(prev), prevContent);
  }
});

test("17. 修正／レビュー中の移動: 対象ファイルも親フォルダも 409。完了後は移動でき、修正内容は移動先に残る", async () => {
  await idle(itemId);
  // 前提: フォルダ内のテキストアイテムを作る（mkdir → copy で登録される）
  assert.equal((await api("POST", "/api/pool/mkdir", { dir: "", name: "d17" })).status, 201);
  const cp = await api("POST", "/api/pool/copy", { src: "art.md", destDir: "d17" });
  assert.equal(cp.status, 200);
  assert.equal(cp.body.dest, "d17/art.md");
  const mvId = (await getState()).pool.find((p) => p.file === "d17/art.md").id;
  // 修正中: 対象ファイルの移動も親フォルダの移動も 409。関係ないファイルの移動は通る
  writeCtl({ claude: { delayMs: 1500, write: { file: "d17/art.md", content: "# fixed in d17\n" }, text: "slow fix" }, codex: { text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + mvId + "/fix", { agent: "claude" })).status, 202);
  await sleep(300);
  const m1 = await api("POST", "/api/pool/move", { src: "d17/art.md", destDir: "" });
  assert.equal(m1.status, 409);
  assert.match(m1.body.error, /実行中/);
  assert.equal((await api("POST", "/api/pool/move", { src: "d17", destDir: "" })).status, 409, "親フォルダの移動も拒否（同じ場所への移動でも例外にしない）");
  assert.equal((await api("POST", "/api/pool/mkdir", { dir: "", name: "elsewhere" })).status, 201);
  assert.equal((await api("POST", "/api/pool/move", { src: "d17", destDir: "elsewhere" })).status, 409);
  assert.equal((await api("POST", "/api/pool/move", { src: "big.txt", destDir: "elsewhere" })).status, 200, "実行中でないアイテムは移動できる");
  assert.equal((await api("POST", "/api/pool/move", { src: "elsewhere/big.txt", destDir: "" })).status, 200);
  assert.ok(fs.existsSync(path.join(poolDir, "d17", "art.md")), "移動されていない");
  await idle(mvId); // 修正完了 → 自動再レビュー完了まで
  let it = await getItem(mvId);
  assert.equal(it.file, "d17/art.md");
  assert.equal(fs.readFileSync(path.join(poolDir, "d17", "art.md"), "utf8"), "# fixed in d17\n", "修正内容は対象ファイルに書かれている");
  assert.equal(it.versions.length, 2);
  assert.notEqual(it.fixes[0].beforeVersionId, it.fixes[0].afterVersionId);
  // レビュー中も同様に 409（レビュー記録の file と対象版の対応を崩さない）
  writeCtl({ codex: { delayMs: 1500, text: "【判定】承認" } });
  assert.equal((await api("POST", "/api/pool/" + mvId + "/review", { reviewer: "codex" })).status, 202);
  await sleep(300);
  assert.equal((await api("POST", "/api/pool/move", { src: "d17/art.md", destDir: "" })).status, 409);
  await idle(mvId);
  // 完了後は移動でき、履歴（itemId で引く）は移動に追従する
  const mv = await api("POST", "/api/pool/move", { src: "d17/art.md", destDir: "elsewhere" });
  assert.equal(mv.status, 200);
  it = await getItem(mvId);
  assert.equal(it.file, "elsewhere/art.md");
  const v = await api("GET", "/api/pool/" + mvId + "/versions");
  assert.equal(v.body.versions.length, 2);
  assert.equal(v.body.unsupportedReason, null);
});

test("18. レビュー対象版を保存できない: CLI を呼ばずに中止し、error 付きの記録に historyError を残す", async () => {
  await idle(itemId);
  const it0 = await getItem(itemId);
  const mf = manifestPath(itemId);
  fs.renameSync(mf, mf + ".bak");
  fs.mkdirSync(mf); // manifest.json をディレクトリにして読み書きを失敗させる
  const logBefore = cliLog();
  writeCtl({ codex: { text: "【判定】承認" } });
  try {
    assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "codex" })).status, 202);
    const it = await waitFor(async () => {
      const i = await getItem(itemId);
      return i.reviews.length === it0.reviews.length + 1 ? i : null;
    }, "review aborted");
    const rev = lastOf(it.reviews);
    assert.equal(rev.error, true);
    assert.equal(rev.verdict, "", "通常の判定として残らない");
    assert.match(rev.historyError, /レビュー対象版を保存できません/);
    assert.match(rev.text, /レビュー中止/);
    assert.equal(rev.versionId, null);
    assert.equal(cliLog(), logBefore, "CLI は呼ばれない");
    assert.deepEqual(it.versions, it0.versions, "版は増えない");
    await idle(itemId);
    // 対象外のアイテム（バイナリ）は履歴と無関係なので、これまでどおり versionId なしでレビューされる
    const logBefore2 = cliLog();
    assert.equal((await api("POST", "/api/pool/" + binItemId + "/review", { reviewer: "codex" })).status, 202);
    await idle(binItemId);
    const rb = lastOf((await getItem(binItemId)).reviews);
    assert.equal(rb.error, undefined);
    assert.equal(rb.versionId, null);
    assert.notEqual(cliLog(), logBefore2, "対象外は CLI が呼ばれる");
  } finally {
    fs.rmdirSync(mf);
    fs.renameSync(mf + ".bak", mf);
  }
  // 保存先が直れば通常どおりレビューされる
  assert.equal((await api("POST", "/api/pool/" + itemId + "/review", { reviewer: "codex" })).status, 202);
  await idle(itemId);
  const rev2 = lastOf((await getItem(itemId)).reviews);
  assert.equal(rev2.error, undefined);
  assert.equal(rev2.verdict, "承認");
  assert.equal(rev2.versionId, lastOf((await getItem(itemId)).versions).id);
});

test("8. 削除後: 版ディレクトリは残り、versions / diff API が引き続き使える", async () => {
  await idle(itemId);
  const before = readManifest(itemId).versions;
  assert.equal((await api("DELETE", "/api/pool/" + itemId)).status, 200);
  assert.equal(await getItem(itemId), undefined);
  assert.ok(fs.existsSync(manifestPath(itemId)));
  const v = await api("GET", "/api/pool/" + itemId + "/versions");
  assert.equal(v.status, 200);
  assert.deepEqual(v.body.versions, before);
  assert.equal(v.body.unsupportedReason, null);
  const last = before[before.length - 1];
  const d = await api("GET", "/api/pool/" + itemId + "/diff?to=" + last.id);
  assert.equal(d.status, 200);
  assert.equal(d.body.to.id, last.id);
  assert.equal((await api("GET", "/api/pool/nonexistent/versions")).status, 404);
});

test("19. versions API の currentSha: 実ファイルと一致し、変更で変わり、読めない対象と削除済みは null", async () => {
  const { createHash } = await import("node:crypto");
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  // 現在の実ファイルの sha を返す（レビュー記録の sha256 と描画時に比較する材料。合意メモ-成果物検証 §4）
  const v1 = await api("GET", "/api/pool/" + binItemId + "/versions");
  assert.equal(v1.status, 200);
  assert.equal(v1.body.currentSha, sha(fs.readFileSync(path.join(poolDir, "bin.dat"))));
  fs.writeFileSync(path.join(poolDir, "bin.dat"), "changed after review\n");
  const v2 = await api("GET", "/api/pool/" + binItemId + "/versions");
  assert.equal(v2.body.currentSha, sha(Buffer.from("changed after review\n")));
  assert.notEqual(v2.body.currentSha, v1.body.currentSha);
  // 読めない対象（サイズ超過）は null = 比較不能。一致として扱わない側に倒す
  const big = await api("GET", "/api/pool/" + bigItemId + "/versions");
  assert.equal(big.status, 200);
  assert.equal(big.body.currentSha, null);
  // テスト 8 で削除済みのアイテムも null（版一覧は引き続き返る）
  const gone = await api("GET", "/api/pool/" + itemId + "/versions");
  assert.equal(gone.status, 200);
  assert.equal(gone.body.currentSha, null);
});
