// 成果物検証の共通モジュール — 純関数と読取専用 I/O（仕様: SPEC-成果物検証.md／契約: 契約-成果物検証API.md 契約版 2）
// ハッシュの既知ベクトルは Python（hashlib + json.dumps）で独立に計算した値。実装の関数で期待値を作らない
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as V from "../verification.mjs";

const COMMIT = "fab20db32603ce0feed34a7131261118dae14ab4";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HEX = (ch) => ch.repeat(64);
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Python で計算した独立ベクトル
const VEC = {
  subjectEmptyPatch: "27c3ec60d7b7dd0276bd9556bca3119bdabdf03ed856b35c7aefbe8f4f15ab3a", // [["change.diff","patch",EMPTY]]
  subjectTwo: "93bc80ff364a76fbfd62740fd676bd2c0c1b69b29634325fc5911a4c0ff73566", // a.diff(patch,"2"x64) + z.txt(support,"1"x64)
  reqLib: "4957cff4693576f7d469d8d4750fdd6ca49d41b60605fa30d4c2856e3f1eee0b", // apply: [u2a2a/lib.mjs]
  reqTests: "7fb7ab190f89c8ce57656b79265f5dc3ad6f7e2bdf49275d4caa218f44db1fc9", // apply: [lib, test/a] + tests: [test/a]
  record: "cd47b56a66aac9795084cc8cce68445a38d75675acdc0a8b312774d252da15d6", // 下の notRunPayload を manifest/default で
};

const notRunPayload = () => ({
  id: "apply", subjectSha256: HEX("a"), policyVersion: 1, requirementsSha256: HEX("b"),
  actor: "claude", method: { type: "manual", description: "目視" },
  result: "not_run", executedAt: null, evidence: null, reason: "未実行",
});

const LIB_PATCH = ["diff --git a/u2a2a/lib.mjs b/u2a2a/lib.mjs", "--- a/u2a2a/lib.mjs", "+++ b/u2a2a/lib.mjs", "@@ -1 +1 @@", "-a", "+b", ""].join("\n");
const DELETE_TEST_PATCH = [
  "diff --git a/u2a2a/test/old.test.mjs b/u2a2a/test/old.test.mjs", "deleted file mode 100644",
  "--- a/u2a2a/test/old.test.mjs", "+++ /dev/null", "@@ -1 +0,0 @@", "-x", "",
].join("\n");

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "u2a2a-verification-"));

// impl フォルダを実ファイルで作る。SHA は node:crypto で直接計算する
function makeImpl({ patch = LIB_PATCH, declaredSha = null, checks = [], files = {} } = {}) {
  const dir = path.join(tmpRoot(), "impl");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "change.diff"), patch);
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  const manifest = { schemaVersion: 1, kind: "patch", baseCommit: COMMIT, artifacts: [{ path: "change.diff", role: "patch", sha256: declaredSha || sha(patch) }], checks };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return dir;
}
const subjectOf = (patch) => V.computeSubjectSha256({ baseCommit: COMMIT, artifacts: [{ path: "change.diff", role: "patch", sha256: sha(patch) }] });

let seqCounter = 0;
function checkRecord({ source = "manifest", id = "apply", result = "passed", subject, req, evidence = null, projectKey = "default", implDir = "topics/t/impl", executedAt, seq }) {
  const payload = V.normalizeCheck({
    id, subjectSha256: subject, policyVersion: 1, requirementsSha256: req, actor: source === "ui" ? "user" : "claude",
    method: { type: "manual", description: "確認" }, result,
    executedAt: result === "not_run" ? null : executedAt || "2026-09-11T00:00:00.000Z",
    evidence, reason: result === "not_run" ? "未実行" : null,
  });
  return V.buildLogRecord({ seq: seq ?? ++seqCounter, receivedAt: "2026-09-11T09:00:00.000Z", source, type: "check", projectKey, subjectSha256: subject, policyVersion: 1, implDir, itemId: "i1", payload });
}
function evaluate(dir, { records = [], log = null, base = "verified", evidenceStatus = {}, manifestEvidenceStatus = null } = {}) {
  return V.evaluateVerification({
    itemId: "i1", implDir: "topics/t/impl", projectKey: "default", folder: V.readImplFolder(dir),
    baseCommit: { value: COMMIT, status: base, detail: "" }, records,
    log: log || { ok: true, errors: [], lastSeq: records.reduce((m, r) => Math.max(m, r.seq), 0) },
    evidenceStatus, manifestEvidenceStatus,
  });
}
const codes = (ev) => ev.aggregate.reasons.map((r) => r.code);

// ---------- 定数 ----------
test("定数: 集約状態・表示名・reason code の区分", () => {
  assert.deepEqual(V.AGGREGATE_STATUSES, ["unsatisfied", "pending", "declared", "confirmed"]);
  assert.equal(V.AGGREGATE_LABELS.declared, "必須検証：申告で充足");
  assert.equal(V.AGGREGATE_LABELS.confirmed, "必須検証：確認済み（UI経路）");
  assert.equal(V.REASON_CODES["log-error"].category, "integrity");
  assert.equal(V.REASON_CODES["test-deleted"].category, "pending");
  assert.equal(V.REASON_CODES["check-stale"].category, "check");
  assert.equal(Object.keys(V.REASON_CODES).length, 27);
});

// ---------- §2.1〜§2.3 ----------
test("canonicalJson: キー整列（入れ子）・配列順は保持・空白なし", () => {
  assert.equal(V.canonicalJson({ b: [3, { d: 1, c: 2 }], a: null }), '{"a":null,"b":[3,{"c":2,"d":1}]}');
  assert.equal(V.canonicalJson(["z", "a"]), '["z","a"]');
  assert.equal(V.canonicalJson("あ"), JSON.stringify("あ"));
});

test("canonicalJson: undefined・非有限数・bigint・Date・疎配列の穴は TypeError", () => {
  for (const v of [undefined, NaN, -Infinity, 1n, new Date(0), [1, , 3], { a: undefined }, { f() {} }]) {
    assert.throws(() => V.canonicalJson(v), TypeError, String(v));
  }
  assert.doesNotThrow(() => V.canonicalJson(Object.create(null)), "プロトタイプ無しのオブジェクトは素のオブジェクト");
});

test("sha256Hex: 既知ベクトルと UTF-8", () => {
  assert.equal(V.sha256Hex(""), EMPTY);
  assert.equal(V.sha256Hex(Buffer.from("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(V.sha256Hex("日本語"), sha(Buffer.from("日本語", "utf8")));
  assert.throws(() => V.sha256Hex(123), TypeError);
});

test("checkRelPath: 表", () => {
  const cases = [
    ["a", null], ["a/b.c", null], ["..a", null], [null, "not-string"], ["", "empty"], ["/a", "absolute"],
    ["a\\b", "backslash"], ["a//b", "empty-segment"], ["a/", "empty-segment"], [".", "dot-segment"], ["a/./b", "dot-segment"], ["../a", "dot-segment"],
  ];
  for (const [p, want] of cases) assert.equal(V.checkRelPath(p), want, String(p));
});

// ---------- §2.4 validateManifest ----------
const line = (over = {}) => ({
  id: "apply", subjectSha256: HEX("a"), policyVersion: 1, requirementsSha256: HEX("b"), actor: "claude",
  method: { type: "command", argv: ["git", "apply", "--check", "change.diff"], cwd: "." },
  result: "passed", executedAt: "2026-09-11T00:00:00Z", evidence: { path: "LOG.txt", sha256: EMPTY }, reason: null, ...over,
});
const manifestOf = (over = {}) => ({ schemaVersion: 1, kind: "patch", baseCommit: COMMIT, artifacts: [{ path: "change.diff", role: "patch", sha256: EMPTY }], checks: [], ...over });
const errCodes = (r) => r.errors.map((e) => e.code);

test("validateManifest: 合法形は定義フィールドだけの新しいオブジェクト。欠けた reason / executedAt / evidence は null", () => {
  const raw = manifestOf({ checks: [{ ...notRunPayload(), executedAt: undefined, evidence: undefined }] });
  delete raw.checks[0].executedAt;
  delete raw.checks[0].evidence;
  const r = V.validateManifest(raw);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.notEqual(r.manifest, raw);
  assert.equal(r.manifest.checks[0].executedAt, null);
  assert.equal(r.manifest.checks[0].evidence, null);
  assert.equal(V.validateManifest(manifestOf({ baseCommit: "a".repeat(64) })).ok, true, "64 桁のコミットも可");
});

test("validateManifest: 形式違反を列挙する（schema・kind・baseCommit・sha・role・重複パス）", () => {
  const r = V.validateManifest({
    schemaVersion: 2, kind: "tree", baseCommit: "ABC",
    artifacts: [
      { path: "x.diff", role: "patch", sha256: "zz" },
      { path: "x.diff", role: "weird", sha256: EMPTY },
      { path: "../up", role: "support", sha256: EMPTY, extra: 1 },
    ],
    checks: [],
  });
  assert.equal(r.ok, false);
  const set = new Set(errCodes(r));
  for (const c of ["schema-unsupported", "kind-unsupported", "format", "enum", "duplicate-path", "path", "unknown-field"]) assert.ok(set.has(c), c);
  assert.ok(r.errors.every((e) => typeof e.pointer === "string" && e.pointer.startsWith("/")), "pointer は JSON Pointer");
});

test("validateManifest: artifacts は空不可、patch は 0 件も 2 件も patch-count", () => {
  assert.ok(errCodes(V.validateManifest(manifestOf({ artifacts: [] }))).includes("required"));
  assert.ok(errCodes(V.validateManifest(manifestOf({ artifacts: [{ path: "a", role: "support", sha256: EMPTY }] }))).includes("patch-count"));
});

test("validateManifest: 検証行 — server-field・unknown-field・id 形式・method の検査", () => {
  const r = V.validateManifest(manifestOf({
    checks: [
      line({ source: "ui", seq: 3, receivedAt: "2026-09-11T00:00:00Z", required: false }),
      line({ id: "Apply", method: { type: "command", argv: [], cwd: "/abs" } }),
      line({ method: { type: "manual", description: " " } }),
      line({ method: { type: "exec" } }),
    ],
  }));
  const at = (i) => r.errors.filter((e) => e.pointer.startsWith(`/checks/${i}`)).map((e) => e.code);
  assert.deepEqual(at(0).filter((c) => c === "server-field").length, 3);
  assert.ok(at(0).includes("unknown-field"), "required:false は未定義フィールド（免除には使えない）");
  assert.ok(at(1).includes("format") && at(1).includes("path"));
  assert.ok(at(2).includes("required"));
  assert.ok(at(3).includes("enum"));
});

test("validateManifest: not_run / passed の形と、実在しない日時", () => {
  assert.ok(errCodes(V.validateManifest(manifestOf({ checks: [line({ result: "not_run", executedAt: null, evidence: null, reason: "" })] }))).includes("reason-required"));
  assert.ok(errCodes(V.validateManifest(manifestOf({ checks: [line({ result: "not_run", reason: "x" })] }))).includes("not-run-shape"));
  assert.equal(V.validateManifest(manifestOf({ checks: [line({ result: "not_run", executedAt: null, reason: "x" })] })).ok, true, "not_run でも evidence は付けてよい");
  assert.ok(errCodes(V.validateManifest(manifestOf({ checks: [line({ result: "failed", evidence: null })] }))).includes("evidence-required"));
  assert.ok(errCodes(V.validateManifest(manifestOf({ checks: [line({ executedAt: null })] }))).includes("required"));
  assert.ok(errCodes(V.validateManifest(manifestOf({ checks: [line({ executedAt: "2026-02-30T00:00:00Z" })] }))).includes("format"));
});

test("validateManifest: manifest.json・APPLY.md・証跡パスを artifacts に入れると reserved-artifact", () => {
  for (const p of ["manifest.json", "APPLY.md", "LOG.txt"]) {
    const r = V.validateManifest(manifestOf({ artifacts: [{ path: "change.diff", role: "patch", sha256: EMPTY }, { path: p, role: "support", sha256: EMPTY }], checks: [line()] }));
    assert.ok(errCodes(r).includes("reserved-artifact"), p);
  }
  assert.equal(V.validateManifest(manifestOf({ artifacts: [{ path: "sub/APPLY.md", role: "patch", sha256: EMPTY }] })).ok, true, "予約はフォルダ直下の名前だけ");
});

// ---------- §2.5 / §2.7 ハッシュ ----------
test("computeSubjectSha256: 独立ベクトル・宣言順に依らない", () => {
  assert.equal(V.computeSubjectSha256({ baseCommit: COMMIT, artifacts: [{ path: "change.diff", role: "patch", sha256: EMPTY }] }), VEC.subjectEmptyPatch);
  const two = [{ path: "z.txt", role: "support", sha256: HEX("1") }, { path: "a.diff", role: "patch", sha256: HEX("2") }];
  assert.equal(V.computeSubjectSha256({ baseCommit: COMMIT, artifacts: two }), VEC.subjectTwo);
  assert.equal(V.computeSubjectSha256({ baseCommit: COMMIT, artifacts: [...two].reverse() }), VEC.subjectTwo);
  const roleChanged = two.map((a) => ({ ...a, role: "patch" }));
  assert.notEqual(V.computeSubjectSha256({ baseCommit: COMMIT, artifacts: roleChanged }), VEC.subjectTwo, "役割も版の一部");
});

test("computeRequirementsSha256: 独立ベクトル・items と targets の順に依らない", () => {
  assert.equal(V.computeRequirementsSha256(1, [{ id: "apply", methodClass: "git-apply-check", targets: ["u2a2a/lib.mjs"] }]), VEC.reqLib);
  const items = [
    { id: "tests", methodClass: "node-test", targets: ["u2a2a/test/a.test.mjs"] },
    { id: "apply", methodClass: "git-apply-check", targets: ["u2a2a/test/a.test.mjs", "u2a2a/lib.mjs"] },
  ];
  assert.equal(V.computeRequirementsSha256(1, items), VEC.reqTests);
  assert.deepEqual(items[1].targets, ["u2a2a/test/a.test.mjs", "u2a2a/lib.mjs"], "入力の配列を並べ替えない");
});

// ---------- §2.6 parseUnifiedDiff ----------
test("parseUnifiedDiff: 複数ファイル・既定行数 1・No newline 行・changedLines", () => {
  const text = [
    "diff --git a/u2a2a/a.txt b/u2a2a/a.txt", "index 1234567..89abcde 100644", "--- a/u2a2a/a.txt", "+++ b/u2a2a/a.txt",
    "@@ -1,2 +1,2 @@", " keep", "-old", "\\ No newline at end of file", "+new", "\\ No newline at end of file",
    "diff --git a/u2a2a/b.txt b/u2a2a/b.txt", "--- a/u2a2a/b.txt", "+++ b/u2a2a/b.txt", "@@ -3 +3 @@", "-x", "+y", "",
  ].join("\n");
  const r = V.parseUnifiedDiff(text);
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.deepEqual(r.files.map((f) => [f.oldPath, f.status, f.changedLines]), [["u2a2a/a.txt", "modified", ["old", "new"]], ["u2a2a/b.txt", "modified", ["x", "y"]]]);
});

test("parseUnifiedDiff: モード変更だけ（---/+++ 無し）は diff --git 見出しからパスを取る", () => {
  const r = V.parseUnifiedDiff(["diff --git a/u2a2a/run.sh b/u2a2a/run.sh", "old mode 100644", "new mode 100755", ""].join("\n"));
  assert.equal(r.ok, true);
  assert.deepEqual([r.files[0].oldPath, r.files[0].newPath, r.files[0].status], ["u2a2a/run.sh", "u2a2a/run.sh", "modified"]);
});

test("parseUnifiedDiff: copy・GIT binary patch", () => {
  const copy = V.parseUnifiedDiff(["diff --git a/u2a2a/a.mjs b/u2a2a/b.mjs", "similarity index 90%", "copy from u2a2a/a.mjs", "copy to u2a2a/b.mjs", ""].join("\n"));
  assert.equal(copy.ok, true);
  assert.deepEqual([copy.files[0].status, copy.files[0].oldPath, copy.files[0].newPath], ["copied", "u2a2a/a.mjs", "u2a2a/b.mjs"]);
  const bin = V.parseUnifiedDiff(["diff --git a/u2a2a/i.png b/u2a2a/i.png", "new file mode 100644", "index 0000000..1111111", "GIT binary patch", "literal 3", "HcmV?d00001", "", "diff --git a/u2a2a/c.txt b/u2a2a/c.txt", "--- a/u2a2a/c.txt", "+++ b/u2a2a/c.txt", "@@ -1 +1 @@", "-p", "+q", ""].join("\n"));
  assert.equal(bin.ok, true, JSON.stringify(bin.error));
  assert.deepEqual(bin.files.map((f) => [f.newPath, f.status, f.binary]), [["u2a2a/i.png", "added", true], ["u2a2a/c.txt", "modified", false]]);
});

test("parseUnifiedDiff: 解析不能 — 前置きの文・空・壊れた引用・ハンク超過・パスの .. ", () => {
  const bad = [
    "Subject: patch\n\ndiff --git a/x b/x\n",
    "",
    'diff --git "a/u2a2a/\\9.md" "b/u2a2a/\\9.md"\n--- "a/u2a2a/\\9.md"\n+++ "b/u2a2a/\\9.md"\n@@ -1 +1 @@\n-a\n+b\n',
    "diff --git a/u2a2a/a b/u2a2a/a\n--- a/u2a2a/a\n+++ b/u2a2a/a\n@@ -1 +1 @@\n-a\n+b\n+c\n",
    "diff --git a/../etc b/../etc\n--- a/../etc\n+++ b/../etc\n@@ -1 +1 @@\n-a\n+b\n",
  ];
  for (const text of bad) {
    const r = V.parseUnifiedDiff(text);
    assert.equal(r.ok, false, text.slice(0, 40));
    assert.equal(r.error.code, "diff-unparsable");
  }
});

// ---------- §2.7 deriveRequirements ----------
const file = (status, oldPath, newPath, extra = {}) => ({ status, oldPath, newPath, binary: false, changedLines: ["x"], ...extra });

test("deriveRequirements: apply の targets はリネームの両側を含み昇順", () => {
  const r = V.deriveRequirements({ files: [file("renamed", "u2a2a/z.mjs", "u2a2a/a.mjs"), file("modified", "u2a2a/m.mjs", "u2a2a/m.mjs")] });
  assert.deepEqual(r.items, [{ id: "apply", methodClass: "git-apply-check", targets: ["u2a2a/a.mjs", "u2a2a/m.mjs", "u2a2a/z.mjs"] }]);
  assert.equal(r.policyVersion, 1);
  assert.deepEqual([r.pending, r.resolved], [[], []]);
});

test("deriveRequirements: 独立ベクトル（lib 変更＋対象テスト追加）", () => {
  const r = V.deriveRequirements({ files: [file("modified", "u2a2a/lib.mjs", "u2a2a/lib.mjs"), file("added", null, "u2a2a/test/a.test.mjs")] });
  assert.equal(r.requirementsSha256, VEC.reqTests);
});

test("deriveRequirements: 対象テスト同士のリネームは保留にしない（新パスが target）", () => {
  const r = V.deriveRequirements({ files: [file("renamed", "u2a2a/test/a.test.mjs", "u2a2a/test/b.test.mjs")] });
  assert.equal(r.pending.length, 0);
  assert.deepEqual(r.items.find((i) => i.id === "tests").targets, ["u2a2a/test/b.test.mjs"]);
});

test("deriveRequirements: 削除側の対象外パスは deletion-accepted だけ、残存側は test / not-test", () => {
  const r = V.deriveRequirements({ files: [file("deleted", "u2a2a/test/helpers/x.mjs", null), file("added", null, "u2a2a/test/nested/y.test.mjs")] });
  assert.deepEqual(r.pending.map((p) => [p.path, p.code, p.allowedDecisions]), [
    ["u2a2a/test/helpers/x.mjs", "test-path-unrecognized", ["deletion-accepted"]],
    ["u2a2a/test/nested/y.test.mjs", "test-path-unrecognized", ["test", "not-test"]],
  ]);
});

test("deriveRequirements: test 分類で対象に加わり、最新 seq の分類が勝つ", () => {
  const files = [file("added", null, "u2a2a/test/nested/y.test.mjs")];
  const r = V.deriveRequirements({
    files,
    classifications: [
      { path: "u2a2a/test/nested/y.test.mjs", decision: "not-test", method: null, seq: 5 },
      { path: "u2a2a/test/nested/y.test.mjs", decision: "test", method: { type: "manual", description: "node --test で個別に" }, seq: 9 },
    ],
  });
  assert.equal(r.pending.length, 0);
  assert.deepEqual(r.resolved, [{ path: "u2a2a/test/nested/y.test.mjs", code: "test-path-unrecognized", decision: "test", seq: 9 }]);
  assert.deepEqual(r.items.find((i) => i.id === "tests").targets, ["u2a2a/test/nested/y.test.mjs"]);
});

test("deriveRequirements: package.json は test 系スクリプト行の変更だけを検出する", () => {
  const other = V.deriveRequirements({ files: [file("modified", "u2a2a/package.json", "u2a2a/package.json", { changedLines: ['  "start": "node server.mjs"'] })] });
  assert.equal(other.pending.length, 0);
  const pre = V.deriveRequirements({ files: [file("modified", "u2a2a/package.json", "u2a2a/package.json", { changedLines: ['  "pretest" : "true"'] })] });
  assert.deepEqual(pre.pending.map((p) => p.code), ["test-config-changed"]);
});

test("deriveRequirements: テスト候補の判定は basename と __tests__ 成分", () => {
  const r = V.deriveRequirements({ files: [file("added", null, "u2a2a/tools/spec.md"), file("added", null, "u2a2a/tools/unit.spec.ts"), file("added", null, "u2a2a/public/__tests__/a.js")] });
  assert.deepEqual(r.pending.map((p) => p.path), ["u2a2a/public/__tests__/a.js", "u2a2a/tools/unit.spec.ts"]);
});

test("latestClassifications: 版・ポリシー・プロジェクトが一致するものだけ、パスごとに最新", () => {
  const cls = (seq, pathName, decision, over = {}) => V.buildLogRecord({
    seq, receivedAt: "2026-09-11T09:00:00.000Z", source: "ui", type: "classification", projectKey: over.projectKey || "default",
    subjectSha256: over.subject || HEX("a"), policyVersion: over.policyVersion || 1, payload: V.normalizeClassification({ path: pathName, decision, reason: "理由", method: null }),
  });
  const records = [cls(1, "p", "not-test"), cls(2, "p", "test"), cls(3, "q", "not-test", { subject: HEX("b") }), cls(4, "r", "test", { projectKey: "project:x" }), cls(5, "s", "test", { policyVersion: 2 })];
  assert.deepEqual(V.latestClassifications(records, { projectKey: "default", subjectSha256: HEX("a") }), [{ path: "p", decision: "test", method: null, seq: 2 }]);
});

// ---------- §2.8 / §2.9 / §2.11 ----------
test("recordSha256: 独立ベクトル。キー順に依らず、seq 等を含めない", () => {
  const payload = V.normalizeCheck(notRunPayload());
  assert.equal(V.recordSha256({ type: "check", source: "manifest", projectKey: "default", payload }), VEC.record);
  const shuffled = Object.fromEntries(Object.entries(payload).reverse());
  assert.equal(V.recordSha256({ type: "check", source: "manifest", projectKey: "default", payload: shuffled }), VEC.record);
  assert.notEqual(V.recordSha256({ type: "check", source: "ui", projectKey: "default", payload }), VEC.record, "source は含む");
  assert.notEqual(V.recordSha256({ type: "check", source: "manifest", projectKey: "project:p1", payload }), VEC.record, "projectKey は含む");
});

test("normalizeCheck / normalizeClassification: 型違いは TypeError", () => {
  assert.throws(() => V.normalizeCheck({ ...notRunPayload(), id: 1 }), TypeError);
  assert.throws(() => V.normalizeCheck({ ...notRunPayload(), method: { type: "exec" } }), TypeError);
  assert.throws(() => V.normalizeClassification({ path: "a", decision: "test" }), TypeError);
  assert.deepEqual(V.normalizeClassification({ path: "a", decision: "test", reason: "r", method: { type: "manual", description: "d", x: 1 } }), { path: "a", decision: "test", reason: "r", method: { type: "manual", description: "d" } });
});

test("validateConfirmRequest: manual の成功は証跡・日時を省略可。日時は manifest と同じ判定、件数の上限は無い", () => {
  const body = (checks, over = {}) => ({ subjectSha256: HEX("a"), requirementsSha256: HEX("b"), policyVersion: 1, checks, ...over });
  const pick = (b) => V.validateConfirmRequest(b).map((e) => [e.pointer, e.code]);
  const manual = { id: "apply", result: "passed", method: { type: "manual", description: "目視" } };
  assert.deepEqual(pick(body([manual])), []);
  assert.deepEqual(pick(body(Array.from({ length: 60 }, (_, i) => ({ ...manual, id: "c" + i })))), [], "件数の上限は契約に無い");
  assert.deepEqual(pick(null), [["", "type"]]);
  assert.deepEqual(pick(body([], { extra: 1 })), [["/extra", "unknown-field"], ["/checks", "required"]]);
  assert.deepEqual(pick(body([manual, manual])), [["/checks/1/id", "duplicate-in-request"]]);
  assert.deepEqual(pick(body([{ ...manual, executedAt: "2026-02-30T00:00:00Z" }])), [["/checks/0/executedAt", "format"]], "暦に無い日");
  assert.deepEqual(pick(body([{ ...manual, seq: 1 }])), [["/checks/0/seq", "server-field"]]);
  assert.deepEqual(pick(body([{ id: "apply", result: "not_run", method: manual.method, executedAt: "2026-09-11T00:00:00Z" }])), [["/checks/0/executedAt", "not-run-shape"], ["/checks/0/reason", "reason-required"]]);
  const command = { id: "apply", result: "failed", method: { type: "command", argv: ["npm", "test"], cwd: "u2a2a" } };
  assert.deepEqual(pick(body([command])), [["/checks/0/evidence", "evidence-required"]]);
  assert.deepEqual(pick(body([{ ...command, evidence: { path: "../x", sha256: "A".repeat(64) } }])), [["/checks/0/evidence/path", "path"], ["/checks/0/evidence/sha256", "format"]]);
});

test("validateClassifyRequest: test には method が必要。reason は空白だけ不可", () => {
  const body = (over = {}) => ({ subjectSha256: HEX("a"), policyVersion: 1, path: "u2a2a/test/old.test.mjs", decision: "deletion-accepted", reason: "移した", method: null, ...over });
  const pick = (b) => V.validateClassifyRequest(b).map((e) => [e.pointer, e.code]);
  assert.deepEqual(pick(body()), []);
  assert.deepEqual(pick(body({ decision: "test" })), [["/method", "required"]]);
  assert.deepEqual(pick(body({ decision: "test", method: { type: "manual", description: "npm test" } })), []);
  assert.deepEqual(pick(body({ reason: "  ", path: "/abs", decision: "skip", source: "ui" })), [["/source", "unknown-field"], ["/path", "path"], ["/decision", "enum"], ["/reason", "required"]]);
  assert.deepEqual(pick(body({ method: { type: "exec" } })), [["/method/type", "enum"]]);
});

test("importRejection: 判定順と証跡", () => {
  const c = V.normalizeCheck(line({ subjectSha256: HEX("a"), requirementsSha256: HEX("b") }));
  const ctx = { currentSubjectSha256: HEX("a"), requirementsSha256: HEX("b") };
  assert.equal(V.importRejection(c, ctx), null);
  assert.equal(V.importRejection(c, { ...ctx, currentSubjectSha256: null }), "subject-unavailable");
  assert.equal(V.importRejection({ ...c, policyVersion: 2, subjectSha256: HEX("x") }, ctx), "subject-mismatch", "版が先");
  assert.equal(V.importRejection({ ...c, policyVersion: 2 }, ctx), "policy-unsupported");
  assert.equal(V.importRejection(c, { ...ctx, requirementsSha256: null }), "requirements-mismatch");
  assert.equal(V.importRejection(c, { ...ctx, evidenceStatus: "outside" }), "evidence-outside");
  assert.equal(V.importRejection(c, { ...ctx, evidenceStatus: "ok" }), null);
});

// ---------- §5.1 ログ ----------
test("buildLogRecord → formatChecksLogLine → parseChecksLog の往復。seq の欠番は許す", () => {
  const a = checkRecord({ subject: HEX("a"), req: HEX("b"), seq: 1 });
  const b = checkRecord({ subject: HEX("a"), req: HEX("b"), seq: 5, source: "ui" });
  const text = V.formatChecksLogLine(a) + V.formatChecksLogLine(b);
  assert.ok(!text.slice(0, -1).includes("\n\n") && text.endsWith("\n"));
  const r = V.parseChecksLog(text);
  assert.deepEqual([r.ok, r.lastSeq, r.errors], [true, 5, []]);
  assert.deepEqual(r.records, [a, b]);
  assert.throws(() => V.buildLogRecord({ ...a, seq: 0 }), TypeError);
});

test("parseChecksLog: 壊れた行があっても続きを読み、最初に当たった 1 件だけをその行のエラーにする", () => {
  const good1 = checkRecord({ subject: HEX("a"), req: HEX("b"), seq: 1 });
  const good3 = checkRecord({ subject: HEX("a"), req: HEX("b"), seq: 3 });
  const extraKey = { ...checkRecord({ subject: HEX("a"), req: HEX("b"), seq: 2 }), note: "x" };
  const mismatch = checkRecord({ subject: HEX("a"), req: HEX("b"), seq: 4 });
  mismatch.subjectSha256 = HEX("c"); // payload と食い違う
  const text = [V.formatChecksLogLine(good1), "\n", JSON.stringify(extraKey) + "\n", V.formatChecksLogLine(good3), JSON.stringify(mismatch) + "\n"].join("");
  const r = V.parseChecksLog(text);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors.map((e) => [e.line, e.code]), [[2, "line-json"], [3, "line-shape"], [5, "line-shape"]]);
  assert.deepEqual(r.records.map((x) => x.seq), [1, 3]);
  assert.equal(r.lastSeq, 3);
  assert.equal(V.parseChecksLog(null).errors[0].code, "log-unreadable");
});

// ---------- §2.10 / §6 evaluateVerification（実ファイルの impl フォルダで） ----------
test("評価: 記録が無ければ未充足（check-missing）。complete は false", () => {
  const dir = makeImpl();
  const ev = evaluate(dir);
  assert.equal(ev.applicable, true);
  assert.equal(ev.subject.current, subjectOf(LIB_PATCH));
  assert.equal(ev.requirements.sha256, VEC.reqLib);
  assert.deepEqual([ev.aggregate.status, ev.aggregate.label, ev.aggregate.complete], ["unsatisfied", "未充足", false]);
  assert.deepEqual(codes(ev), ["check-missing"]);
  assert.deepEqual(ev.checks.map((c) => [c.id, c.required, c.effective, c.counted]), [["apply", true, "missing", false]]);
});

test("評価: 申告で充足 → UI 確認で確認済み → 後着の申告失敗で未充足 → 申告成功で申告充足（古い UI 成功を選ばない）", () => {
  const dir = makeImpl();
  const subject = subjectOf(LIB_PATCH);
  const m1 = checkRecord({ subject, req: VEC.reqLib, seq: 1 });
  assert.equal(evaluate(dir, { records: [m1] }).aggregate.status, "declared");
  const u2 = checkRecord({ subject, req: VEC.reqLib, seq: 2, source: "ui" });
  const confirmed = evaluate(dir, { records: [m1, u2] });
  assert.deepEqual([confirmed.aggregate.status, confirmed.aggregate.complete], ["confirmed", true]);
  const m3 = checkRecord({ subject, req: VEC.reqLib, seq: 3, result: "failed" });
  assert.deepEqual(codes(evaluate(dir, { records: [m1, u2, m3] })), ["check-failed"]);
  const m4 = checkRecord({ subject, req: VEC.reqLib, seq: 4 });
  const back = evaluate(dir, { records: [m1, u2, m3, m4] });
  assert.deepEqual([back.aggregate.status, back.aggregate.complete], ["declared", false]);
});

test("評価: seq で選ぶ。未来の executedAt や配列の並びでは選ばない", () => {
  const dir = makeImpl();
  const subject = subjectOf(LIB_PATCH);
  const late = checkRecord({ subject, req: VEC.reqLib, seq: 20, result: "not_run" });
  const future = checkRecord({ subject, req: VEC.reqLib, seq: 10, source: "ui", executedAt: "2099-01-01T00:00:00.000Z" });
  assert.deepEqual(codes(evaluate(dir, { records: [late, future] })), ["check-not-run"]);
});

test("評価: 別プロジェクトの記録は数えない。同じ impl の別必須集合は check-stale", () => {
  const dir = makeImpl();
  const subject = subjectOf(LIB_PATCH);
  assert.deepEqual(codes(evaluate(dir, { records: [checkRecord({ subject, req: VEC.reqLib, projectKey: "project:p9", seq: 1 })] })), ["check-missing"]);
  assert.deepEqual(codes(evaluate(dir, { records: [checkRecord({ subject, req: VEC.reqTests, seq: 2 })] })), ["check-stale"]);
  const unrelated = checkRecord({ subject: HEX("e"), req: VEC.reqLib, implDir: "topics/t/other", seq: 3 });
  assert.deepEqual(codes(evaluate(dir, { records: [unrelated] })), ["check-missing"], "無関係な impl の同名 id で変更ありと出さない");
});

test("評価: 対象テストの削除は保留。現行版への deletion-accepted で保留が外れ、別版の分類は効かない", () => {
  const dir = makeImpl({ patch: DELETE_TEST_PATCH });
  const subject = subjectOf(DELETE_TEST_PATCH);
  const pending = evaluate(dir);
  assert.equal(pending.aggregate.status, "pending");
  assert.deepEqual(pending.requirements.pending.map((p) => [p.path, p.code]), [["u2a2a/test/old.test.mjs", "test-deleted"]]);
  const cls = (seq, subj) => V.buildLogRecord({ seq, receivedAt: "2026-09-11T09:00:00.000Z", source: "ui", type: "classification", projectKey: "default", subjectSha256: subj, policyVersion: 1, payload: V.normalizeClassification({ path: "u2a2a/test/old.test.mjs", decision: "deletion-accepted", reason: "統合", method: null }) });
  assert.equal(evaluate(dir, { records: [cls(1, HEX("9"))] }).aggregate.status, "pending");
  const lifted = evaluate(dir, { records: [cls(2, subject)] });
  assert.deepEqual([lifted.aggregate.status, lifted.requirements.resolved.length], ["unsatisfied", 1]);
  assert.deepEqual(codes(lifted), ["check-missing"]);
});

test("評価: 完全性の問題は保留より先。宣言 SHA の不一致でも現行版は実体から計算する", () => {
  const dir = makeImpl({ patch: DELETE_TEST_PATCH, declaredSha: EMPTY });
  const ev = evaluate(dir, { base: "unverifiable" });
  assert.equal(ev.aggregate.status, "unsatisfied");
  assert.ok(codes(ev).includes("artifact-sha-mismatch"));
  assert.ok(codes(ev).includes("base-commit-unverified") && codes(ev).includes("test-deleted"), "判定できた理由はすべて積む");
  assert.equal(ev.subject.current, subjectOf(DELETE_TEST_PATCH));
  assert.equal(ev.subject.artifacts[0].status, "mismatch");
});

test("評価: ログ不健全なら全件成功でも未充足（log-error）", () => {
  const dir = makeImpl();
  const u = checkRecord({ subject: subjectOf(LIB_PATCH), req: VEC.reqLib, seq: 1, source: "ui" });
  const ev = evaluate(dir, { records: [u], log: { ok: false, errors: [{ line: 2, code: "line-json", message: "x" }], lastSeq: 1 } });
  assert.deepEqual([ev.aggregate.status, ev.aggregate.complete], ["unsatisfied", false]);
  assert.ok(codes(ev).includes("log-error"));
});

test("評価: 証跡の状態が無い記録は evidence-unreadable で数えない。任意検証は集約に影響しない", () => {
  const dir = makeImpl();
  const subject = subjectOf(LIB_PATCH);
  const withEv = checkRecord({ subject, req: VEC.reqLib, seq: 1, source: "ui", evidence: { path: "LOG.txt", sha256: EMPTY } });
  const ev = evaluate(dir, { records: [withEv] });
  assert.deepEqual(codes(ev), ["evidence-unreadable"]);
  const ok = checkRecord({ subject, req: VEC.reqLib, seq: 2, source: "ui" });
  const optionalFail = checkRecord({ subject, req: VEC.reqLib, seq: 3, id: "lint", result: "failed" });
  const ev2 = evaluate(dir, { records: [ok, optionalFail] });
  assert.equal(ev2.aggregate.status, "confirmed");
  assert.deepEqual(ev2.checks.map((c) => [c.id, c.required, c.effective]), [["apply", true, "passed"], ["lint", false, "failed"]]);
});

test("評価: preview は受理済み・取込可・拒否を区別し、受理はしない", () => {
  const patch = LIB_PATCH;
  const subject = subjectOf(patch);
  const good = { ...notRunPayload(), subjectSha256: subject, requirementsSha256: VEC.reqLib };
  const withEv = { ...good, id: "lint", result: "passed", executedAt: "2026-09-11T00:00:00Z", evidence: { path: "LOG.txt", sha256: EMPTY }, reason: null };
  const wrong = { ...good, id: "old", subjectSha256: HEX("7") };
  const dir = makeImpl({ patch, checks: [good, withEv, wrong], files: { "LOG.txt": "log" } });
  const imported = V.buildLogRecord({ seq: 1, receivedAt: "2026-09-11T09:00:00.000Z", source: "manifest", type: "check", projectKey: "default", subjectSha256: subject, policyVersion: 1, payload: V.normalizeCheck(good) });
  const ev = evaluate(dir, { records: [imported], manifestEvidenceStatus: { 1: "mismatch" } });
  assert.deepEqual(ev.preview.map((p) => [p.index, p.status, p.code]), [[0, "accepted", null], [1, "rejected", "evidence-mismatch"], [2, "rejected", "subject-mismatch"]]);
  assert.deepEqual(evaluate(dir, { records: [imported] }).preview[1].status, "acceptable", "証跡状態を渡さなければ証跡は照合しない");
  assert.deepEqual(ev.subject.declared, [HEX("7"), subject].sort());
});

// ---------- §3 読取専用 I/O ----------
test("readImplFolder: manifest の欠落・JSON 不正・スキーマ不正", () => {
  assert.equal(V.readImplFolder(path.join(tmpRoot(), "nope")).manifest.errors[0].code, "manifest-missing");
  const dir = tmpRoot();
  fs.writeFileSync(path.join(dir, "manifest.json"), "{");
  assert.equal(V.readImplFolder(dir).manifest.errors[0].code, "manifest-json");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1 }));
  const r = V.readImplFolder(dir);
  assert.deepEqual([r.manifest.ok, r.artifacts, r.currentSubjectSha256, r.patchText], [false, [], null, null]);
});

test("readImplFolder: 欠落は subject null。フォルダ外へのシンボリックリンクは outside", () => {
  const dir = makeImpl();
  fs.rmSync(path.join(dir, "change.diff"));
  const missing = V.readImplFolder(dir);
  assert.deepEqual([missing.artifacts[0].status, missing.currentSubjectSha256, missing.patchText], ["missing", null, null]);
  const outsideFile = path.join(tmpRoot(), "secret.diff");
  fs.writeFileSync(outsideFile, LIB_PATCH);
  fs.symlinkSync(outsideFile, path.join(dir, "change.diff"));
  const out = V.readImplFolder(dir);
  assert.deepEqual([out.artifacts[0].status, out.artifacts[0].actualSha256], ["outside", null]);
});

test("readImplFolder: フォルダ全体の移動で版は変わらず、内容の変更で変わる", () => {
  const dir = makeImpl();
  const before = V.readImplFolder(dir);
  assert.equal(before.patchText, LIB_PATCH);
  const moved = path.join(path.dirname(dir), "renamed-impl");
  fs.renameSync(dir, moved);
  assert.equal(V.readImplFolder(moved).currentSubjectSha256, before.currentSubjectSha256);
  fs.appendFileSync(path.join(moved, "change.diff"), " ");
  const after = V.readImplFolder(moved);
  assert.notEqual(after.currentSubjectSha256, before.currentSubjectSha256);
  assert.equal(after.artifacts[0].status, "mismatch");
});

test("resolveImplDir: 最も近い manifest を持つ祖先。トピックフォルダとプールルートでは止まる", () => {
  const pool = tmpRoot();
  const topic = path.join(pool, "topics", "0123456789abcdef");
  fs.mkdirSync(path.join(topic, "impl-x", "u2a2a", "test"), { recursive: true });
  fs.writeFileSync(path.join(topic, "impl-x", "manifest.json"), "{}");
  fs.writeFileSync(path.join(topic, "manifest.json"), "{}");
  fs.writeFileSync(path.join(pool, "manifest.json"), "{}");
  assert.equal(V.resolveImplDir(pool, "topics/0123456789abcdef/impl-x/u2a2a/test/a.test.mjs"), "topics/0123456789abcdef/impl-x");
  assert.equal(V.resolveImplDir(pool, "topics/0123456789abcdef/impl-x/APPLY.md"), "topics/0123456789abcdef/impl-x");
  assert.equal(V.resolveImplDir(pool, "topics/0123456789abcdef/notes.md"), null, "トピックフォルダ自身の manifest は使わない");
  assert.equal(V.resolveImplDir(pool, "loose.md"), null, "プールルートの manifest は使わない");
  assert.equal(V.resolveImplDir(pool, "../x.md"), null);
});

test("evidenceStatusOf: none / ok / mismatch / missing / outside", () => {
  const dir = makeImpl({ files: { "LOG.txt": "log" } });
  assert.equal(V.evidenceStatusOf(dir, null), "none");
  assert.equal(V.evidenceStatusOf(dir, { path: "LOG.txt", sha256: sha("log") }), "ok");
  assert.equal(V.evidenceStatusOf(dir, { path: "LOG.txt", sha256: EMPTY }), "mismatch");
  assert.equal(V.evidenceStatusOf(dir, { path: "NONE.txt", sha256: EMPTY }), "missing");
  assert.equal(V.evidenceStatusOf(dir, { path: "../LOG.txt", sha256: EMPTY }), "outside");
  const outside = path.join(tmpRoot(), "o.txt");
  fs.writeFileSync(outside, "log");
  fs.symlinkSync(outside, path.join(dir, "LINK.txt"));
  assert.equal(V.evidenceStatusOf(dir, { path: "LINK.txt", sha256: sha("log") }), "outside");
});
