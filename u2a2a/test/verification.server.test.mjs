// 成果物の版と必須検証 — サーバ統合テスト（契約: 契約-成果物検証API.md §4・§5）
// server.mjs を一時ディレクトリへ複製して起動する。REPO_ROOT（appDir の親）を git リポジトリにして基点コミットを作り、
// 基点確認（git cat-file）を実際に通す。manifest の行の版・必須集合は verification.mjs で作る（モジュール自体は別テストで検証）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as V from "../verification.mjs";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOPIC_DIR = "topics/0123456789abcdef";
const IMPL = TOPIC_DIR + "/impl-t";
const IMPL_BAD_BASE = TOPIC_DIR + "/impl-base";
const MISSING_COMMIT = "0".repeat(40);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const HEX = (ch) => ch.repeat(64);

const LIB_PATCH = ["diff --git a/u2a2a/lib.mjs b/u2a2a/lib.mjs", "--- a/u2a2a/lib.mjs", "+++ b/u2a2a/lib.mjs", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
const DELETE_TEST_PATCH = [
  "diff --git a/u2a2a/test/old.test.mjs b/u2a2a/test/old.test.mjs", "deleted file mode 100644",
  "--- a/u2a2a/test/old.test.mjs", "+++ /dev/null", "@@ -1 +0,0 @@", "-x", "",
].join("\n");

let tmp, appDir, poolDir, home, port, server, baseCommit;
let oldSubject, oldReq;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = () => "http://127.0.0.1:" + port;
async function api(method, p, body, raw = null) {
  const r = await fetch(base() + p, { method, headers: { "content-type": "application/json" }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  let json = null;
  try {
    json = await r.json();
  } catch {
    // 本文なし
  }
  return { status: r.status, body: json };
}
async function waitFor(fn, label, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout: " + label);
    await sleep(80);
  }
}
const history = async (q = "") => (await api("GET", "/api/verification/history?projectKey=default" + q)).body;
const itemIdOf = (file) => waitFor(async () => ((await api("GET", "/api/state")).body.pool.find((p) => p.file === file) || {}).id, "item " + file);
const evaluate = async (file) => (await api("GET", `/api/pool/${await itemIdOf(file)}/verification`)).body;
const logFile = () => path.join(appDir, "data", "checks.jsonl");

// impl フォルダを書く。checks は (subject, req) を受け取って行を返す関数
function writeImpl(rel, { patch, commit, checks = () => [], files = {} }) {
  const dir = path.join(poolDir, ...rel.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "change.diff"), patch);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  const artifacts = [{ path: "change.diff", role: "patch", sha256: sha(patch) }];
  const subject = V.computeSubjectSha256({ baseCommit: commit, artifacts });
  const req = V.deriveRequirements({ files: V.parseUnifiedDiff(patch).files }).requirementsSha256;
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, kind: "patch", baseCommit: commit, artifacts, checks: checks(subject, req) }, null, 2));
  return { subject, req };
}

async function startServer() {
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, ["server.mjs"], { cwd: appDir, env: { ...process.env, HOME: home, U2A2A_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u2a2a-verification-"));
  execFileSync("git", ["init", "-q"], { cwd: tmp });
  fs.writeFileSync(path.join(tmp, "BASE.txt"), "base\n");
  execFileSync("git", ["add", "BASE.txt"], { cwd: tmp });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"], { cwd: tmp });
  baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "package.json", "public/flow-graph.js", "public/usage.js"]) fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  poolDir = path.join(appDir, "pool");
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });

  // 起動前に置く: 起動時の走査で manifest.json が新規登録され、自動取込が 1 回走る
  const t = writeImpl(IMPL, {
    patch: LIB_PATCH,
    commit: baseCommit,
    files: { "LOG.txt": "log" },
    checks: (subject, req) => [
      { id: "apply", subjectSha256: subject, policyVersion: 1, requirementsSha256: req, actor: "claude", method: { type: "command", argv: ["git", "apply", "--check", "change.diff"], cwd: "." }, result: "passed", executedAt: "2026-09-11T00:00:00Z", evidence: { path: "LOG.txt", sha256: sha("log") }, reason: null },
      { id: "lint", subjectSha256: subject, policyVersion: 1, requirementsSha256: req, actor: "claude", method: { type: "manual", description: "目視" }, result: "not_run", executedAt: null, evidence: null, reason: "この環境で実行できない" },
      { id: "old", subjectSha256: HEX("7"), policyVersion: 1, requirementsSha256: req, actor: "claude", method: { type: "manual", description: "前の版" }, result: "passed", executedAt: "2026-09-10T00:00:00Z", evidence: { path: "LOG.txt", sha256: sha("log") }, reason: null },
    ],
  });
  oldSubject = t.subject;
  oldReq = t.req;
  writeImpl(IMPL_BAD_BASE, { patch: LIB_PATCH, commit: MISSING_COMMIT });
  fs.writeFileSync(path.join(poolDir, "loose.md"), "impl ではない");
  await startServer();
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("1. 自動取込: 新規登録された manifest.json の現行版の行だけを source:manifest で追記する", async () => {
  const h = await waitFor(async () => {
    const x = await history();
    return x.records.length >= 2 ? x : null;
  }, "自動取込");
  assert.deepEqual(h.records.map((r) => [r.seq, r.source, r.type, r.payload.id]), [[1, "manifest", "check", "apply"], [2, "manifest", "check", "lint"]]);
  assert.equal(h.log.ok, true);
  assert.equal(h.records[0].implDir, IMPL);
  assert.equal(typeof h.records[0].itemId, "string");
  assert.ok(!h.records.some((r) => r.payload.id === "old"), "別の版の行は受理しない");
  const saved = fs.readFileSync(logFile(), "utf8");
  const parsed = V.parseChecksLog(saved);
  assert.deepEqual([parsed.ok, parsed.records.length], [true, 2], "ファイルに 2 行、検査を通る");
});

test("2. 評価取得: 申告で充足（complete は false）・プレビュー・対象外と未知の項目", async () => {
  const ev = await evaluate(IMPL + "/change.diff");
  assert.equal(ev.applicable, true);
  assert.deepEqual([ev.implDir, ev.projectKey, ev.baseCommit.status], [IMPL, "default", "verified"]);
  assert.equal(ev.subject.current, oldSubject);
  assert.deepEqual([ev.aggregate.status, ev.aggregate.label, ev.aggregate.complete], ["declared", "必須検証：申告で充足", false]);
  const apply = ev.checks.find((c) => c.id === "apply");
  assert.deepEqual([apply.required, apply.effective, apply.counted, apply.latest.source, apply.latest.evidenceStatus], [true, "passed", true, "manifest", "ok"]);
  assert.deepEqual(ev.preview.map((p) => [p.index, p.status, p.code]), [[0, "accepted", null], [1, "accepted", null], [2, "rejected", "subject-mismatch"]]);
  const viaManifest = await evaluate(IMPL + "/manifest.json");
  assert.equal(viaManifest.subject.current, ev.subject.current, "同じ impl のどの項目からでも同じ評価");
  assert.deepEqual(await evaluate("loose.md"), { applicable: false, itemId: await itemIdOf("loose.md"), implDir: null });
  const unknown = await api("GET", "/api/pool/nope/verification");
  assert.deepEqual([unknown.status, unknown.body.code], [404, "item-not-found"]);
  assert.equal((await history()).records.length, 2, "評価取得だけでは受理しない");
});

test("3. 取込の再実行は重複として数え、受理連番を進めない", async () => {
  const id = await itemIdOf(IMPL + "/change.diff");
  const r = await api("POST", `/api/pool/${id}/verification/import`);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.added, r.body.duplicates, r.body.records], [0, 2, []]);
  assert.deepEqual(r.body.rejected.map((x) => [x.index, x.code]), [[2, "subject-mismatch"]]);
  // 本文は読み捨てる（UI は {} を送る）。JSON として不正でも拒否しない
  for (const raw of ["{}", "{"]) {
    const withBody = await api("POST", `/api/pool/${id}/verification/import`, null, raw);
    assert.deepEqual([withBody.status, withBody.body.added, withBody.body.duplicates], [200, 0, 2], raw);
  }
  assert.equal((await history()).log.lastSeq, 2);
  const loose = await api("POST", `/api/pool/${await itemIdOf("loose.md")}/verification/import`);
  assert.deepEqual([loose.status, loose.body.code], [400, "not-applicable"]);
});

test("4. 基点コミットが対象リポジトリに無ければ判定保留", async () => {
  const ev = await evaluate(IMPL_BAD_BASE + "/change.diff");
  assert.equal(ev.baseCommit.status, "not-found");
  assert.equal(ev.aggregate.status, "pending");
  assert.ok(ev.aggregate.reasons.some((x) => x.code === "base-commit-unverified"));
});

test("5. 確認記録: 400 / 409 / 422 の後、UI 経路の成功で確認済み。同じ内容の再確認も重複排除しない", async () => {
  const id = await itemIdOf(IMPL + "/change.diff");
  const url = `/api/pool/${id}/verification/confirm`;
  const bodyOf = (checks, over = {}) => ({ subjectSha256: oldSubject, requirementsSha256: oldReq, policyVersion: 1, checks, ...over });
  const manual = { id: "apply", result: "passed", method: { type: "manual", description: "npm test を実行して全件成功を確認" }, evidence: null };

  const invalidJson = await api("POST", url, null, "{");
  assert.deepEqual([invalidJson.status, invalidJson.body.code], [400, "invalid-json"]);
  const noReason = await api("POST", url, bodyOf([{ id: "apply", result: "not_run", method: manual.method }]));
  assert.deepEqual([noReason.status, noReason.body.code], [400, "invalid-request"]);
  assert.ok(noReason.body.errors.some((e) => e.code === "reason-required"));
  const serverField = await api("POST", url, bodyOf([{ ...manual, source: "ui" }]));
  assert.ok(serverField.body.errors.some((e) => e.code === "server-field"), "source はクライアントから指定できない");
  const stale = await api("POST", url, bodyOf([manual], { subjectSha256: HEX("7") }));
  assert.deepEqual([stale.status, stale.body.code, stale.body.current.subjectSha256], [409, "version-conflict", oldSubject]);
  const badEvidence = await api("POST", url, bodyOf([{ ...manual, evidence: { path: "LOG.txt", sha256: HEX("0") } }]));
  assert.deepEqual([badEvidence.status, badEvidence.body.code], [422, "evidence-mismatch"]);
  const command = { id: "apply", result: "passed", method: { type: "command", argv: ["git", "apply", "--check", "change.diff"], cwd: "." } };
  const noEvidence = await api("POST", url, bodyOf([command]));
  assert.deepEqual([noEvidence.status, noEvidence.body.errors.map((e) => [e.pointer, e.code])], [400, [["/checks/0/evidence", "evidence-required"]]]);
  const badDate = await api("POST", url, bodyOf([{ ...manual, executedAt: "2026-02-30T00:00:00Z" }]));
  assert.deepEqual([badDate.status, badDate.body.errors.map((e) => e.pointer)], [400, ["/checks/0/executedAt"]], "日時の判定は manifest と同じ");
  assert.equal((await history()).log.lastSeq, 2, "拒否した要求は何も追記しない");

  const ok = await api("POST", url, bodyOf([manual]));
  assert.equal(ok.status, 201);
  assert.deepEqual(ok.body.records.map((r) => [r.seq, r.source, r.payload.actor, r.payload.executedAt === r.receivedAt]), [[3, "ui", "user", true]]);
  assert.deepEqual([ok.body.evaluation.aggregate.status, ok.body.evaluation.aggregate.complete], ["confirmed", true]);
  const again = await api("POST", url, bodyOf([manual]));
  assert.deepEqual([again.status, again.body.records[0].seq], [201, 4], "UI 経路は同じ内容でも新しい連番で残す");

  const withEvidence = await api("POST", url, bodyOf([{ ...command, executedAt: "2026-09-11T01:02:03Z", evidence: { path: "LOG.txt", sha256: sha("log") } }], { actor: "reviewer" }));
  assert.equal(withEvidence.status, 201);
  assert.deepEqual([withEvidence.body.records[0].seq, withEvidence.body.records[0].payload.actor, withEvidence.body.records[0].payload.executedAt], [5, "reviewer", "2026-09-11T01:02:03Z"]);
  const latest = withEvidence.body.evaluation.checks.find((c) => c.id === "apply").latest;
  assert.deepEqual([latest.seq, latest.source, latest.method.type, latest.evidenceStatus], [5, "ui", "command", "ok"]);
});

test("6. 差し替えと分類: 行を消しても履歴は残り、旧版の成功は check-stale。保留は現行版への分類で外れる", async () => {
  const id = await itemIdOf(IMPL + "/change.diff");
  const { subject } = writeImpl(IMPL, { patch: DELETE_TEST_PATCH, commit: baseCommit, files: { "LOG.txt": "log" } }); // checks を空にする
  const ev = await evaluate(IMPL + "/change.diff");
  assert.equal(ev.subject.current, subject);
  assert.equal(ev.aggregate.status, "pending");
  assert.deepEqual(ev.requirements.pending.map((p) => [p.path, p.code, p.allowedDecisions]), [["u2a2a/test/old.test.mjs", "test-deleted", ["deletion-accepted"]]]);
  assert.ok(ev.aggregate.reasons.some((x) => x.code === "check-stale"), "旧版への成功を現行版に引き継がない");
  assert.equal((await history()).records.length, 5, "manifest から行を消しても受理済み履歴は残る");

  const oldConfirm = await api("POST", `/api/pool/${id}/verification/confirm`, { subjectSha256: oldSubject, requirementsSha256: oldReq, policyVersion: 1, checks: [{ id: "apply", result: "passed", method: { type: "manual", description: "x" } }] });
  assert.deepEqual([oldConfirm.status, oldConfirm.body.current.subjectSha256], [409, subject], "画面表示後の差し替えは競合");

  const url = `/api/pool/${id}/verification/classify`;
  const cls = (over) => api("POST", url, { subjectSha256: subject, policyVersion: 1, path: "u2a2a/test/old.test.mjs", decision: "deletion-accepted", reason: "統合テストへ移した", method: null, ...over });
  assert.deepEqual([(await cls({ subjectSha256: oldSubject })).body.code], ["version-conflict"]);
  const notPending = await cls({ path: "u2a2a/lib.mjs" });
  assert.deepEqual([notPending.status, notPending.body.code], [409, "not-classifiable"]);
  const notAllowed = await cls({ decision: "test", method: { type: "manual", description: "x" } });
  assert.deepEqual([notAllowed.status, notAllowed.body.code, notAllowed.body.allowedDecisions], [422, "decision-not-allowed", ["deletion-accepted"]]);
  assert.equal((await cls({ reason: "  " })).status, 400);
  assert.equal((await cls({ decision: "test", method: null })).body.errors.some((e) => e.pointer === "/method"), true, "test 分類には確認方法が必要");

  const done = await cls({});
  assert.equal(done.status, 201);
  assert.deepEqual([done.body.record.type, done.body.record.source, done.body.record.payload.decision], ["classification", "ui", "deletion-accepted"]);
  assert.deepEqual([done.body.requirements.pending, done.body.requirements.resolved.length], [[], 1]);
  assert.equal(done.body.evaluation.aggregate.status, "unsatisfied", "分類だけでは検証の成功にならない");

  // 解決済みのパスも再分類できる（seq が最大のものが有効）
  const redo = await cls({ reason: "理由を書き直した" });
  assert.deepEqual([redo.status, done.body.record.seq, redo.body.record.seq, redo.body.record.payload.reason], [201, 6, 7, "理由を書き直した"]);
  assert.deepEqual([redo.body.requirements.pending, redo.body.requirements.resolved.length], [[], 1]);
});

test("7. 履歴取得: 版で絞る・ページ送り・入力の検証", async () => {
  const all = await history();
  assert.deepEqual(all.records.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7]);
  const page1 = await history("&limit=2");
  assert.deepEqual([page1.records.map((r) => r.seq), page1.nextAfterSeq], [[1, 2], 2]);
  const page2 = await history("&limit=2&afterSeq=5");
  assert.deepEqual([page2.records.map((r) => r.seq), page2.nextAfterSeq], [[6, 7], null]);
  const old = await history("&subjectSha256=" + oldSubject);
  assert.deepEqual(old.records.map((r) => r.seq), [1, 2, 3, 4, 5], "過去版も引ける");
  for (const q of ["/api/verification/history", "/api/verification/history?projectKey=evil", "/api/verification/history?projectKey=default&limit=0", "/api/verification/history?projectKey=default&subjectSha256=abc"]) {
    assert.equal((await api("GET", q)).status, 400, q);
  }
});

test("8. 再起動後も履歴と評価が復元される", async () => {
  const before = await history();
  const evBefore = await evaluate(IMPL + "/change.diff");
  await stopServer();
  await startServer();
  const after = await history();
  assert.deepEqual(after.records, before.records);
  assert.equal(after.log.lastSeq, 7);
  const evAfter = await evaluate(IMPL + "/change.diff");
  assert.deepEqual([evAfter.aggregate.status, evAfter.requirements.resolved.length], [evBefore.aggregate.status, 1]);
});

test("9. 追記を開けなければ 500（log-write-failed）。連番も履歴も進めず、受付は止めない", { skip: process.getuid?.() === 0 ? "root は読取専用のファイルにも書ける" : false }, async () => {
  const id = await itemIdOf(IMPL + "/change.diff");
  const ev = await evaluate(IMPL + "/change.diff");
  fs.chmodSync(logFile(), 0o444);
  try {
    const r = await api("POST", `/api/pool/${id}/verification/confirm`, { subjectSha256: ev.subject.current, requirementsSha256: ev.requirements.sha256, policyVersion: 1, checks: [{ id: "apply", result: "passed", method: { type: "manual", description: "x" } }] });
    assert.deepEqual([r.status, r.body.code], [500, "log-write-failed"]);
  } finally {
    fs.chmodSync(logFile(), 0o644);
  }
  const h = await history();
  assert.deepEqual([h.log.ok, h.log.lastSeq, h.records.length], [true, 7, 7], "開く前の失敗なので途中の行は無く、受付も止めない");
});

test("10. ログ破損: 評価は必ず未充足、書込系は 503、履歴は読めた行を返す", async () => {
  await stopServer();
  fs.appendFileSync(logFile(), "{broken\n");
  await startServer();
  const id = await itemIdOf(IMPL + "/change.diff");
  const ev = await evaluate(IMPL + "/change.diff");
  assert.deepEqual([ev.aggregate.status, ev.aggregate.complete, ev.log.ok], ["unsatisfied", false, false]);
  assert.ok(ev.aggregate.reasons.some((x) => x.code === "log-error"));
  assert.deepEqual(ev.log.errors.map((e) => [e.line, e.code]), [[8, "line-json"]]);
  const imp = await api("POST", `/api/pool/${id}/verification/import`);
  assert.deepEqual([imp.status, imp.body.code], [503, "log-unavailable"]);
  const conf = await api("POST", `/api/pool/${id}/verification/confirm`, { subjectSha256: ev.subject.current, requirementsSha256: ev.requirements.sha256, policyVersion: 1, checks: [{ id: "apply", result: "passed", method: { type: "manual", description: "x" } }] });
  assert.deepEqual([conf.status, conf.body.code], [503, "log-unavailable"]);
  const h = await history();
  assert.deepEqual([h.log.ok, h.records.length], [false, 7]);
  assert.equal(fs.readFileSync(logFile(), "utf8").split("\n").filter(Boolean).length, 8, "破損後に追記していない");
});
