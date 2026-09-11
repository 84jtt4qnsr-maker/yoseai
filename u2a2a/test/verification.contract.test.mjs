// 契約-成果物検証API.md 契約版1 からの独立試験。
// 期待値は契約の式・表から立てる。verification.mjs の実装を写さない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as V from "../verification.mjs";

const COMMIT = "fab20db32603ce0feed34a7131261118dae14ab4";
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HEX = (ch) => ch.repeat(64);
const SUBJECT_EMPTY_PATCH = "27c3ec60d7b7dd0276bd9556bca3119bdabdf03ed856b35c7aefbe8f4f15ab3a";
const sha = (s) => createHash("sha256").update(s).digest("hex");

// 契約 §2.1 / §2.5 / §2.7 の式。実装の canonicalJson は使わない。
function oracleCanonical(value) {
  const walk = (v) => {
    if (v === null) return null;
    const t = typeof v;
    if (t === "string" || t === "boolean") return v;
    if (t === "number") {
      if (!Number.isFinite(v)) throw new TypeError("non-finite");
      return v;
    }
    if (t === "undefined" || t === "function" || t === "symbol" || t === "bigint") throw new TypeError("forbidden");
    if (Array.isArray(v)) return v.map(walk);
    if (t === "object") {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("not-plain");
      const out = {};
      for (const k of Object.keys(v).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = walk(v[k]);
      return out;
    }
    throw new TypeError("forbidden");
  };
  return JSON.stringify(walk(value));
}
function oracleSubject({ baseCommit, artifacts }) {
  const rows = [...artifacts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((a) => [a.path, a.role, a.sha256]);
  return sha(JSON.stringify([1, "patch", baseCommit, rows]));
}
function oracleRequirements(policyVersion, items) {
  const rows = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((i) => [i.id, i.methodClass, [...i.targets].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))]);
  return sha(JSON.stringify([1, policyVersion, rows]));
}
function oracleRecordSha({ type, source, projectKey, payload }) {
  return sha(oracleCanonical([1, type, source, projectKey, payload]));
}

function restoreLog(text) {
  const fn = V.parseChecksLog || V.restoreChecksLog || V.inspectChecksLog;
  if (typeof fn !== "function") {
    throw new Error("差し戻し: 契約§5のログ復元を verification.mjs から純関数として export してください（parseChecksLog 等）");
  }
  return fn(text);
}

const validManifest = (over = {}) => ({
  schemaVersion: 1,
  kind: "patch",
  baseCommit: COMMIT,
  artifacts: [{ path: "change.diff", role: "patch", sha256: EMPTY }],
  checks: [],
  ...over,
});

// ---------- §2.1 canonicalJson ----------
test("canonicalJson: 配列とプリミティブは JSON.stringify と同一", () => {
  for (const v of [null, true, false, 0, 1.5, "", "x", [], [1, "a", false, null], [[["n"]]]]) {
    assert.equal(V.canonicalJson(v), JSON.stringify(v));
  }
});

test("canonicalJson: オブジェクトのキーは JS 文字列 < で整列し空白なし", () => {
  assert.equal(V.canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(V.canonicalJson({ z: { b: 1, a: 2 }, a: 0 }), '{"a":0,"z":{"a":2,"b":1}}');
});

test("canonicalJson: 禁止値は TypeError（入れ子も含む）", () => {
  for (const v of [undefined, NaN, Infinity, -Infinity, () => {}, Symbol("s")]) {
    assert.throws(() => V.canonicalJson(v), TypeError);
  }
  assert.throws(() => V.canonicalJson({ a: undefined }), TypeError);
  assert.throws(() => V.canonicalJson([NaN]), TypeError);
  assert.throws(() => V.canonicalJson(1n), TypeError);
});

// ---------- §2.2 sha256Hex ----------
test("sha256Hex: 空文字と abc の既知ベクトル（FIPS 180-4）", () => {
  assert.equal(V.sha256Hex(""), EMPTY);
  assert.equal(V.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(V.sha256Hex(new Uint8Array()), EMPTY);
});

test("sha256Hex: 文字列は UTF-8 バイト列", () => {
  assert.equal(V.sha256Hex("あ"), sha("あ"));
});

// ---------- §2.3 checkRelPath ----------
test("checkRelPath: POSIX 相対のみ。. 単独も dot-segment", () => {
  assert.equal(V.checkRelPath("change.diff"), null);
  assert.equal(V.checkRelPath("a/b.txt"), null);
  assert.equal(V.checkRelPath(""), "empty");
  assert.equal(V.checkRelPath("/abs"), "absolute");
  assert.equal(V.checkRelPath("a\\b"), "backslash");
  assert.equal(V.checkRelPath("a//b"), "empty-segment");
  assert.equal(V.checkRelPath("."), "dot-segment");
  assert.equal(V.checkRelPath("./x"), "dot-segment");
  assert.equal(V.checkRelPath("a/../b"), "dot-segment");
});

test("checkRelPath: 非文字列は not-string", () => {
  assert.equal(V.checkRelPath(null), "not-string");
  assert.equal(V.checkRelPath(undefined), "not-string");
});

// ---------- §2.4 validateManifest ----------
test("validateManifest: 最小の合法形", () => {
  const r = V.validateManifest(validManifest());
  assert.equal(r.ok, true);
  assert.equal(r.manifest.schemaVersion, 1);
  assert.equal(r.manifest.artifacts.length, 1);
  assert.deepEqual(r.manifest.checks, []);
});

test("validateManifest: source/seq/receivedAt は server-field（unknown-field より優先）", () => {
  const r = V.validateManifest(validManifest({
    checks: [{
      id: "apply", subjectSha256: HEX("a"), policyVersion: 1, requirementsSha256: HEX("b"),
      actor: "grok", method: { type: "manual", description: "x" },
      result: "not_run", executedAt: null, evidence: null, reason: "未実行",
      source: "manifest", seq: 1, receivedAt: "2026-09-11T00:00:00Z",
    }],
  }));
  assert.equal(r.ok, false);
  const codes = r.errors.filter((e) => e.pointer.includes("/checks/0")).map((e) => e.code);
  assert.ok(codes.includes("server-field"));
  assert.equal(codes.includes("unknown-field") && !codes.includes("server-field"), false);
});

test("validateManifest: エラーは最初の1件で止めず列挙する", () => {
  const r = V.validateManifest({
    schemaVersion: 1, kind: "patch", baseCommit: COMMIT,
    artifacts: [
      { path: "manifest.json", role: "patch", sha256: EMPTY },
      { path: "change.diff", role: "patch", sha256: EMPTY },
    ],
    checks: [], extra: true,
  });
  assert.equal(r.ok, false);
  const set = new Set(r.errors.map((e) => e.code));
  assert.ok(set.has("unknown-field"));
  assert.ok(set.has("reserved-artifact") || set.has("patch-count"));
});

test("validateManifest: reserved-artifact と patch-count", () => {
  const reserved = V.validateManifest(validManifest({
    artifacts: [{ path: "APPLY.md", role: "patch", sha256: EMPTY }],
  }));
  assert.equal(reserved.ok, false);
  assert.ok(reserved.errors.some((e) => e.code === "reserved-artifact"));

  const twoPatch = V.validateManifest(validManifest({
    artifacts: [
      { path: "a.diff", role: "patch", sha256: EMPTY },
      { path: "b.diff", role: "patch", sha256: EMPTY },
    ],
  }));
  assert.equal(twoPatch.ok, false);
  assert.ok(twoPatch.errors.some((e) => e.code === "patch-count"));
});

test("validateManifest: not_run は executedAt null・reason 必須、passed は evidence 必須", () => {
  const base = {
    id: "apply", subjectSha256: HEX("a"), policyVersion: 1, requirementsSha256: HEX("b"),
    actor: "grok", method: { type: "manual", description: "目視" },
  };
  const badRun = V.validateManifest(validManifest({
    checks: [{ ...base, result: "not_run", executedAt: "2026-09-11T00:00:00Z", evidence: null, reason: "x" }],
  }));
  assert.ok(badRun.errors.some((e) => e.code === "not-run-shape"));
  const noReason = V.validateManifest(validManifest({
    checks: [{ ...base, result: "not_run", executedAt: null, evidence: null, reason: null }],
  }));
  assert.ok(noReason.errors.some((e) => e.code === "reason-required"));
  const noEv = V.validateManifest(validManifest({
    checks: [{ ...base, result: "passed", executedAt: "2026-09-11T00:00:00Z", evidence: null, reason: null }],
  }));
  assert.ok(noEv.errors.some((e) => e.code === "evidence-required"));
});

test("validateManifest: evidence.path と同じ artifacts.path は reserved-artifact", () => {
  const r = V.validateManifest(validManifest({
    artifacts: [
      { path: "change.diff", role: "patch", sha256: EMPTY },
      { path: "TEST-RESULT.txt", role: "support", sha256: EMPTY },
    ],
    checks: [{
      id: "apply", subjectSha256: HEX("a"), policyVersion: 1, requirementsSha256: HEX("b"),
      actor: "grok", method: { type: "command", argv: ["git", "apply", "--check", "change.diff"], cwd: "." },
      result: "passed", executedAt: "2026-09-11T00:00:00.000Z",
      evidence: { path: "TEST-RESULT.txt", sha256: EMPTY }, reason: null,
    }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === "reserved-artifact"));
});

// ---------- §2.5 computeSubjectSha256 ----------
test("computeSubjectSha256: 契約の JSON 配列式。整列は path の <、宣言順ではない", () => {
  const arts = [
    { path: "z.diff", role: "support", sha256: HEX("1") },
    { path: "a.diff", role: "patch", sha256: HEX("2") },
  ];
  const expected = oracleSubject({ baseCommit: COMMIT, artifacts: arts });
  assert.equal(V.computeSubjectSha256({ baseCommit: COMMIT, artifacts: arts }), expected);
  assert.equal(V.computeSubjectSha256({ baseCommit: COMMIT, artifacts: [...arts].reverse() }), expected);
});

test("computeSubjectSha256: 独立ベクトル（空ファイル SHA + 既知コミット）", () => {
  assert.equal(
    V.computeSubjectSha256({
      baseCommit: COMMIT,
      artifacts: [{ path: "change.diff", role: "patch", sha256: EMPTY }],
    }),
    "27c3ec60d7b7dd0276bd9556bca3119bdabdf03ed856b35c7aefbe8f4f15ab3a",
  );
});

test("computeSubjectSha256: 基点が違えば別版。渡す sha256 が実体側であることは呼び出し契約", () => {
  const arts = [{ path: "change.diff", role: "patch", sha256: EMPTY }];
  const a = V.computeSubjectSha256({ baseCommit: COMMIT, artifacts: arts });
  const b = V.computeSubjectSha256({ baseCommit: "0".repeat(40), artifacts: arts });
  assert.notEqual(a, b);
});

// ---------- §2.6 parseUnifiedDiff ----------
test("parseUnifiedDiff: 変更ファイル。changedLines は +/- 本文のみ、見出し ---/+++ を含まない", () => {
  const text = [
    "diff --git a/u2a2a/lib.mjs b/u2a2a/lib.mjs",
    "--- a/u2a2a/lib.mjs",
    "+++ b/u2a2a/lib.mjs",
    "@@ -1,3 +1,3 @@",
    " a",
    "-b",
    "+c",
    " d",
    "",
  ].join("\n");
  const r = V.parseUnifiedDiff(text);
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 1);
  assert.equal(r.files[0].oldPath, "u2a2a/lib.mjs");
  assert.equal(r.files[0].newPath, "u2a2a/lib.mjs");
  assert.equal(r.files[0].status, "modified");
  assert.equal(r.files[0].binary, false);
  assert.deepEqual(r.files[0].changedLines, ["b", "c"]);
});

test("parseUnifiedDiff: 追加は oldPath null、削除は newPath null", () => {
  const add = V.parseUnifiedDiff([
    "diff --git a/u2a2a/test/foo.test.mjs b/u2a2a/test/foo.test.mjs",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/u2a2a/test/foo.test.mjs",
    "@@ -0,0 +1,1 @@",
    "+ok",
    "",
  ].join("\n"));
  assert.equal(add.ok, true);
  assert.equal(add.files[0].status, "added");
  assert.equal(add.files[0].oldPath, null);
  assert.equal(add.files[0].newPath, "u2a2a/test/foo.test.mjs");

  const del = V.parseUnifiedDiff([
    "diff --git a/u2a2a/test/foo.test.mjs b/u2a2a/test/foo.test.mjs",
    "deleted file mode 100644",
    "--- a/u2a2a/test/foo.test.mjs",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-ok",
    "",
  ].join("\n"));
  assert.equal(del.ok, true);
  assert.equal(del.files[0].status, "deleted");
  assert.equal(del.files[0].newPath, null);
  assert.equal(del.files[0].oldPath, "u2a2a/test/foo.test.mjs");
});

test("parseUnifiedDiff: rename from/to を正とし、対象テストから対象外へは後段で test-deleted", () => {
  const r = V.parseUnifiedDiff([
    "diff --git a/u2a2a/test/old.test.mjs b/u2a2a/lib.mjs",
    "rename from u2a2a/test/old.test.mjs",
    "rename to u2a2a/lib.mjs",
    "similarity index 100%",
    "",
  ].join("\n"));
  assert.equal(r.ok, true);
  assert.equal(r.files[0].status, "renamed");
  assert.equal(r.files[0].oldPath, "u2a2a/test/old.test.mjs");
  assert.equal(r.files[0].newPath, "u2a2a/lib.mjs");
});

test("parseUnifiedDiff: Binary files / GIT binary patch は binary:true", () => {
  const r = V.parseUnifiedDiff([
    "diff --git a/u2a2a/x.bin b/u2a2a/x.bin",
    "--- a/u2a2a/x.bin",
    "+++ b/u2a2a/x.bin",
    "Binary files a/u2a2a/x.bin and b/u2a2a/x.bin differ",
    "",
  ].join("\n"));
  assert.equal(r.ok, true);
  assert.equal(r.files[0].binary, true);
});

test("parseUnifiedDiff: C 形式引用パスの 8 進エスケープを UTF-8 復号", () => {
  const r = V.parseUnifiedDiff([
    'diff --git "a/u2a2a/\\343\\201\\202.md" "b/u2a2a/\\343\\201\\202.md"',
    '--- "a/u2a2a/\\343\\201\\202.md"',
    '+++ "b/u2a2a/\\343\\201\\202.md"',
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "",
  ].join("\n"));
  assert.equal(r.ok, true);
  assert.equal(r.files[0].newPath, "u2a2a/あ.md");
});

test("parseUnifiedDiff: 見出し無し・ハンク行数不一致・未知拡張ヘッダは ok:false", () => {
  const none = V.parseUnifiedDiff("just text\n");
  assert.equal(none.ok, false);
  assert.equal(none.error.code, "diff-unparsable");

  const hunk = V.parseUnifiedDiff([
    "diff --git a/u2a2a/a.txt b/u2a2a/a.txt",
    "--- a/u2a2a/a.txt",
    "+++ b/u2a2a/a.txt",
    "@@ -1,3 +1,3 @@",
    "-only",
    "",
  ].join("\n"));
  assert.equal(hunk.ok, false);
  assert.equal(hunk.error.code, "diff-unparsable");

  const hdr = V.parseUnifiedDiff([
    "diff --git a/u2a2a/a.txt b/u2a2a/a.txt",
    "weird-header yes",
    "--- a/u2a2a/a.txt",
    "+++ b/u2a2a/a.txt",
    "@@ -1,1 +1,1 @@",
    "-a",
    "+b",
    "",
  ].join("\n"));
  assert.equal(hdr.ok, false);
  assert.equal(hdr.error.code, "diff-unparsable");
});

// ---------- §2.7 deriveRequirements ----------
const emptyClass = [];

test("deriveRequirements: 常に apply。対象テストの追加は tests 必須", () => {
  const files = [{
    oldPath: null, newPath: "u2a2a/test/foo.test.mjs", status: "added", binary: false, changedLines: ["x"],
  }];
  const r = V.deriveRequirements({ files, classifications: emptyClass, policyVersion: 1 });
  assert.deepEqual(r.items.map((i) => i.id), ["apply", "tests"]);
  assert.deepEqual(r.items[0].targets, ["u2a2a/test/foo.test.mjs"]);
  assert.deepEqual(r.items[1].targets, ["u2a2a/test/foo.test.mjs"]);
  assert.equal(r.items[0].methodClass, "git-apply-check");
  assert.equal(r.items[1].methodClass, "node-test");
  assert.equal(r.pending.length, 0);
  assert.equal(r.requirementsSha256, oracleRequirements(1, r.items));
  assert.equal(
    r.requirementsSha256,
    oracleRequirements(1, [
      { id: "apply", methodClass: "git-apply-check", targets: ["u2a2a/test/foo.test.mjs"] },
      { id: "tests", methodClass: "node-test", targets: ["u2a2a/test/foo.test.mjs"] },
    ]),
  );
});

test("deriveRequirements: 対象テストの削除は test-deleted、allowedDecisions は deletion-accepted のみ", () => {
  const r = V.deriveRequirements({
    files: [{ oldPath: "u2a2a/test/foo.test.mjs", newPath: null, status: "deleted", binary: false, changedLines: ["x"] }],
    classifications: emptyClass,
  });
  assert.deepEqual(r.items.map((i) => i.id), ["apply"]);
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].code, "test-deleted");
  assert.deepEqual(r.pending[0].allowedDecisions, ["deletion-accepted"]);
});

test("deriveRequirements: 対象テストから対象外へのリネームは test-deleted（§9-7）", () => {
  const r = V.deriveRequirements({
    files: [{
      oldPath: "u2a2a/test/old.test.mjs", newPath: "u2a2a/lib.mjs", status: "renamed", binary: false, changedLines: [],
    }],
    classifications: emptyClass,
  });
  assert.ok(r.pending.some((p) => p.code === "test-deleted" && p.path === "u2a2a/test/old.test.mjs"));
  assert.equal(r.items.some((i) => i.id === "tests"), false);
});

test("deriveRequirements: リネームで新パスが対象テストなら tests の target は新パス", () => {
  const r = V.deriveRequirements({
    files: [{
      oldPath: "u2a2a/lib.mjs", newPath: "u2a2a/test/new.test.mjs", status: "renamed", binary: false, changedLines: [],
    }],
    classifications: emptyClass,
  });
  const tests = r.items.find((i) => i.id === "tests");
  assert.deepEqual(tests.targets, ["u2a2a/test/new.test.mjs"]);
});

test("deriveRequirements: fixtures のみは test-fixtures-only。同じ diff に tests target があれば保留にしない（§9-6）", () => {
  const only = V.deriveRequirements({
    files: [{
      oldPath: "u2a2a/test/fixtures/a.json", newPath: "u2a2a/test/fixtures/a.json",
      status: "modified", binary: false, changedLines: ["x"],
    }],
    classifications: emptyClass,
  });
  assert.ok(only.pending.some((p) => p.code === "test-fixtures-only"));
  assert.equal(only.items.some((i) => i.id === "tests"), false);

  const both = V.deriveRequirements({
    files: [
      { oldPath: "u2a2a/test/fixtures/a.json", newPath: "u2a2a/test/fixtures/a.json", status: "modified", binary: false, changedLines: ["x"] },
      { oldPath: null, newPath: "u2a2a/test/foo.test.mjs", status: "added", binary: false, changedLines: ["y"] },
    ],
    classifications: emptyClass,
  });
  assert.equal(both.pending.some((p) => p.code === "test-fixtures-only"), false);
  assert.ok(both.items.some((i) => i.id === "tests"));
});

test("deriveRequirements: テストルート配下の glob 外は test-path-unrecognized、ルート外候補は test-candidate-unknown", () => {
  const nested = V.deriveRequirements({
    files: [{
      oldPath: null, newPath: "u2a2a/test/nested/a.test.mjs", status: "added", binary: false, changedLines: ["x"],
    }],
    classifications: emptyClass,
  });
  assert.ok(nested.pending.some((p) => p.code === "test-path-unrecognized"));

  const cand = V.deriveRequirements({
    files: [{
      oldPath: null, newPath: "u2a2a/tools/foo.spec.js", status: "added", binary: false, changedLines: ["x"],
    }],
    classifications: emptyClass,
  });
  assert.ok(cand.pending.some((p) => p.code === "test-candidate-unknown"));

  const dunder = V.deriveRequirements({
    files: [{
      oldPath: null, newPath: "u2a2a/lib/__tests__/x.js", status: "added", binary: false, changedLines: ["x"],
    }],
    classifications: emptyClass,
  });
  assert.ok(dunder.pending.some((p) => p.code === "test-candidate-unknown"));
});

test("deriveRequirements: package.json の test スクリプト変更は test-config-changed。test 分類で TEST_SUITE_TARGET を加える", () => {
  const r = V.deriveRequirements({
    files: [{
      oldPath: "u2a2a/package.json", newPath: "u2a2a/package.json", status: "modified", binary: false,
      changedLines: ['    "test": "node --test --test-concurrency=1 test/*.test.mjs"'],
    }],
    classifications: emptyClass,
  });
  assert.ok(r.pending.some((p) => p.code === "test-config-changed"));
  assert.deepEqual(r.pending.find((p) => p.code === "test-config-changed").allowedDecisions, ["test", "not-test"]);

  const classified = V.deriveRequirements({
    files: [{
      oldPath: "u2a2a/package.json", newPath: "u2a2a/package.json", status: "modified", binary: false,
      changedLines: ['    "test": "node --test test/*.test.mjs"'],
    }],
    classifications: [{ path: "u2a2a/package.json", decision: "test", method: null, seq: 1 }],
  });
  assert.equal(classified.pending.length, 0);
  const tests = classified.items.find((i) => i.id === "tests");
  assert.ok(tests.targets.includes("u2a2a/test/*.test.mjs"));
});

test("deriveRequirements: binary は diff-binary、allowedDecisions 空。分類では解除できない", () => {
  const r = V.deriveRequirements({
    files: [{ oldPath: "u2a2a/x.bin", newPath: "u2a2a/x.bin", status: "modified", binary: true, changedLines: [] }],
    classifications: [{ path: "u2a2a/x.bin", decision: "not-test", method: null, seq: 1 }],
  });
  assert.ok(r.pending.some((p) => p.code === "diff-binary" && p.allowedDecisions.length === 0));
});

test("deriveRequirements: not-test / deletion-accepted は保留から外すだけ。許可外の分類は無視", () => {
  const files = [{ oldPath: "u2a2a/test/foo.test.mjs", newPath: null, status: "deleted", binary: false, changedLines: ["x"] }];
  const ok = V.deriveRequirements({
    files,
    classifications: [{ path: "u2a2a/test/foo.test.mjs", decision: "deletion-accepted", method: null, seq: 3 }],
  });
  assert.equal(ok.pending.length, 0);
  assert.ok(ok.resolved.some((x) => x.decision === "deletion-accepted" && x.seq === 3));

  const ignored = V.deriveRequirements({
    files,
    classifications: [{ path: "u2a2a/test/foo.test.mjs", decision: "not-test", method: null, seq: 1 }],
  });
  assert.ok(ignored.pending.some((p) => p.code === "test-deleted"));
});

test("deriveRequirements: pending パス昇順、items は id 昇順。pending があっても requirementsSha256 を計算する", () => {
  const r = V.deriveRequirements({
    files: [
      { oldPath: "u2a2a/test/z.test.mjs", newPath: null, status: "deleted", binary: false, changedLines: ["z"] },
      { oldPath: "u2a2a/test/a.test.mjs", newPath: null, status: "deleted", binary: false, changedLines: ["a"] },
    ],
    classifications: emptyClass,
  });
  assert.deepEqual(r.pending.map((p) => p.path), ["u2a2a/test/a.test.mjs", "u2a2a/test/z.test.mjs"]);
  assert.match(r.requirementsSha256, /^[0-9a-f]{64}$/);
});

// ---------- §2.8 / §2.9 ----------
test("normalizeCheck: 欠けた reason/evidence/executedAt は null。method は定義キーだけ", () => {
  const n = V.normalizeCheck({
    id: "apply", subjectSha256: HEX("a"), policyVersion: 1, requirementsSha256: HEX("b"),
    actor: "grok", method: { type: "command", argv: ["git"], cwd: ".", extra: 1 },
    result: "not_run",
  });
  assert.equal(n.reason, null);
  assert.equal(n.evidence, null);
  assert.equal(n.executedAt, null);
  assert.deepEqual(Object.keys(n.method).sort(), ["argv", "cwd", "type"]);
});

test("recordSha256: seq/receivedAt/implDir/itemId を含めない。同じ payload なら同じハッシュ", () => {
  const payload = V.normalizeCheck({
    id: "apply", subjectSha256: HEX("a"), policyVersion: 1, requirementsSha256: HEX("b"),
    actor: "grok", method: { type: "manual", description: "x" },
    result: "not_run", executedAt: null, evidence: null, reason: "未実行",
  });
  const h = V.recordSha256({ type: "check", source: "manifest", projectKey: "default", payload });
  assert.equal(h, oracleRecordSha({ type: "check", source: "manifest", projectKey: "default", payload }));
  assert.equal(h, V.recordSha256({ type: "check", source: "manifest", projectKey: "default", payload }));
});

// ---------- §5 ログ復元 ----------
function checkPayload() {
  return {
    id: "apply", subjectSha256: HEX("a"), policyVersion: 1, requirementsSha256: HEX("b"),
    actor: "grok", method: { type: "manual", description: "x" },
    result: "not_run", executedAt: null, evidence: null, reason: "未実行",
  };
}
function logLine(over = {}) {
  const payload = over.payload || checkPayload();
  const source = over.source || "manifest";
  const type = over.type || "check";
  const projectKey = over.projectKey || "default";
  const rec = {
    v: 1,
    seq: over.seq ?? 1,
    receivedAt: over.receivedAt || "2026-09-11T09:00:00.000Z",
    source,
    type,
    projectKey,
    subjectSha256: over.subjectSha256 || payload.subjectSha256,
    policyVersion: over.policyVersion ?? 1,
    implDir: over.implDir || "topics/x/impl",
    itemId: over.itemId || "item1",
    payload,
  };
  rec.recordSha256 = over.recordSha256 || oracleRecordSha({ type, source, projectKey, payload });
  return rec;
}

test("parseChecksLog: 空は ok。ファイル無し相当", () => {
  const r = restoreLog("");
  assert.equal(r.ok, true);
  assert.equal(r.lastSeq, 0);
  assert.deepEqual(r.errors, []);
});

test("parseChecksLog: line-json / line-truncated / line-shape / seq-order / record-hash", () => {
  const good = logLine({ seq: 1 });
  const json = restoreLog("{not json}\n");
  assert.equal(json.ok, false);
  assert.ok(json.errors.some((e) => e.code === "line-json"));

  const trunc = restoreLog(JSON.stringify(good)); // 末尾改行なし
  assert.equal(trunc.ok, false);
  assert.ok(trunc.errors.some((e) => e.code === "line-truncated"));

  const shape = restoreLog('{"v":99,"seq":1}\n');
  assert.equal(shape.ok, false);
  assert.ok(shape.errors.some((e) => e.code === "line-shape"));

  const a = logLine({ seq: 2 });
  const b = logLine({ seq: 2, receivedAt: "2026-09-11T09:00:01.000Z" });
  const order = restoreLog(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`);
  assert.equal(order.ok, false);
  assert.ok(order.errors.some((e) => e.code === "seq-order"));

  const badHash = logLine({ seq: 1, recordSha256: HEX("f") });
  const hashed = restoreLog(`${JSON.stringify(badHash)}\n`);
  assert.equal(hashed.ok, false);
  assert.ok(hashed.errors.some((e) => e.code === "record-hash"));
});

test("parseChecksLog: 合法行は lastSeq を進め、record-hash 再計算と一致する", () => {
  const rec = logLine({ seq: 1 });
  const r = restoreLog(`${JSON.stringify(rec)}\n`);
  assert.equal(r.ok, true);
  assert.equal(r.lastSeq, 1);
});

// ---------- §6 evaluateVerification ----------
function folderOk({ subject = SUBJECT_EMPTY_PATCH, patchText = null, artifacts = null } = {}) {
  return {
    manifest: { ok: true, manifest: validManifest() },
    artifacts: artifacts || [{
      path: "change.diff", role: "patch", declaredSha256: EMPTY, actualSha256: EMPTY, status: "ok",
    }],
    currentSubjectSha256: subject,
    patchText,
    declaredSubjects: [subject],
  };
}
function record({ seq, source, result, id = "apply", subject = SUBJECT_EMPTY_PATCH, req = HEX("b"), evidence = null }) {
  const payload = {
    id, subjectSha256: subject, policyVersion: 1, requirementsSha256: req,
    actor: source === "ui" ? "user" : "grok",
    method: { type: "manual", description: "x" },
    result, executedAt: result === "not_run" ? null : "2026-09-11T00:00:00.000Z",
    evidence, reason: result === "not_run" ? "未実行" : null,
  };
  return {
    v: 1, seq, receivedAt: `2026-09-11T09:00:0${seq}.000Z`, source, type: "check",
    recordSha256: oracleRecordSha({ type: "check", source, projectKey: "default", payload }),
    projectKey: "default", subjectSha256: subject, policyVersion: 1,
    implDir: "topics/x/impl", itemId: "i1", payload,
  };
}

const libPatch = [
  "diff --git a/u2a2a/lib.mjs b/u2a2a/lib.mjs",
  "--- a/u2a2a/lib.mjs",
  "+++ b/u2a2a/lib.mjs",
  "@@ -1,1 +1,1 @@",
  "-a",
  "+b",
  "",
].join("\n");

test("evaluateVerification: log.ok false は必ず unsatisfied / log-error。complete は false", () => {
  const ev = V.evaluateVerification({
    itemId: "i1", implDir: "topics/x/impl", projectKey: "default",
    folder: folderOk({ patchText: libPatch }),
    baseCommit: { value: COMMIT, status: "verified", detail: "" },
    records: [],
    log: { ok: false, errors: [{ line: 1, code: "line-json", message: "x" }], lastSeq: 0 },
    evidenceStatus: {},
  });
  assert.equal(ev.aggregate.status, "unsatisfied");
  assert.equal(ev.aggregate.complete, false);
  assert.ok(ev.aggregate.reasons.some((r) => r.code === "log-error"));
});

test("evaluateVerification: 完全性（manifest-missing）は保留より先に unsatisfied", () => {
  const ev = V.evaluateVerification({
    itemId: "i1", implDir: "topics/x/impl", projectKey: "default",
    folder: {
      manifest: { ok: false, errors: [{ pointer: "", code: "manifest-missing", message: "無い" }] },
      artifacts: [], currentSubjectSha256: null, patchText: null, declaredSubjects: [],
    },
    baseCommit: { value: null, status: "not-found", detail: "" },
    records: [],
    log: { ok: true, errors: [], lastSeq: 0 },
    evidenceStatus: {},
  });
  assert.equal(ev.aggregate.status, "unsatisfied");
  assert.ok(ev.aggregate.reasons.some((r) => r.code === "manifest-missing"));
});

test("evaluateVerification: 基点未確認は pending（base-commit-unverified）。log が健全なとき", () => {
  const ev = V.evaluateVerification({
    itemId: "i1", implDir: "topics/x/impl", projectKey: "default",
    folder: folderOk({ patchText: libPatch, subject: oracleSubject({
      baseCommit: COMMIT, artifacts: [{ path: "change.diff", role: "patch", sha256: EMPTY }],
    }) }),
    baseCommit: { value: COMMIT, status: "not-found", detail: "missing" },
    records: [],
    log: { ok: true, errors: [], lastSeq: 0 },
    evidenceStatus: {},
  });
  assert.equal(ev.aggregate.status, "pending");
  assert.ok(ev.aggregate.reasons.some((r) => r.code === "base-commit-unverified"));
  assert.equal(ev.aggregate.complete, false);
});

test("evaluateVerification: 後着の failed が最新。未来の executedAt では失敗を隠せない", () => {
  const files = [{ oldPath: "u2a2a/lib.mjs", newPath: "u2a2a/lib.mjs", status: "modified", binary: false, changedLines: ["a", "b"] }];
  const req = V.deriveRequirements({ files, classifications: [] });
  const subject = SUBJECT_EMPTY_PATCH;
  const passed = record({
    seq: 1, source: "ui", result: "passed", subject, req: req.requirementsSha256,
  });
  passed.payload.executedAt = "2099-01-01T00:00:00.000Z";
  const failed = record({
    seq: 2, source: "manifest", result: "failed", subject, req: req.requirementsSha256,
  });
  const ev = V.evaluateVerification({
    itemId: "i1", implDir: "topics/x/impl", projectKey: "default",
    folder: folderOk({ subject, patchText: libPatch }),
    baseCommit: { value: COMMIT, status: "verified", detail: "" },
    records: [passed, failed],
    log: { ok: true, errors: [], lastSeq: 2 },
    evidenceStatus: { 1: "none", 2: "none" },
  });
  assert.equal(ev.aggregate.status, "unsatisfied");
  assert.ok(ev.aggregate.reasons.some((r) => r.code === "check-failed"));
});

test("evaluateVerification: 現行版に記録が無く別版にあるときは check-stale（check-missing ではない）", () => {
  const files = [{ oldPath: "u2a2a/lib.mjs", newPath: "u2a2a/lib.mjs", status: "modified", binary: false, changedLines: ["a"] }];
  const req = V.deriveRequirements({ files, classifications: [] });
  const current = HEX("c");
  const old = record({ seq: 1, source: "ui", result: "passed", subject: HEX("d"), req: req.requirementsSha256 });
  const ev = V.evaluateVerification({
    itemId: "i1", implDir: "topics/x/impl", projectKey: "default",
    folder: folderOk({ subject: current, patchText: libPatch }),
    baseCommit: { value: COMMIT, status: "verified", detail: "" },
    records: [old],
    log: { ok: true, errors: [], lastSeq: 1 },
    evidenceStatus: { 1: "ok" },
  });
  assert.equal(ev.aggregate.status, "unsatisfied");
  assert.ok(ev.aggregate.reasons.some((r) => r.code === "check-stale"));
  assert.equal(ev.aggregate.reasons.some((r) => r.code === "check-missing"), false);
});

test("evaluateVerification: passed でも evidence mismatch は成功に数えない", () => {
  const files = [{ oldPath: "u2a2a/lib.mjs", newPath: "u2a2a/lib.mjs", status: "modified", binary: false, changedLines: ["a"] }];
  const req = V.deriveRequirements({ files, classifications: [] });
  const subject = SUBJECT_EMPTY_PATCH;
  const rec = record({
    seq: 1, source: "ui", result: "passed", subject, req: req.requirementsSha256,
    evidence: { path: "TEST-RESULT.txt", sha256: EMPTY },
  });
  const ev = V.evaluateVerification({
    itemId: "i1", implDir: "topics/x/impl", projectKey: "default",
    folder: folderOk({ subject, patchText: libPatch }),
    baseCommit: { value: COMMIT, status: "verified", detail: "" },
    records: [rec],
    log: { ok: true, errors: [], lastSeq: 1 },
    evidenceStatus: { 1: "mismatch" },
  });
  assert.equal(ev.aggregate.status, "unsatisfied");
  assert.ok(ev.aggregate.reasons.some((r) => r.code === "evidence-mismatch"));
  const row = ev.checks.find((c) => c.id === "apply");
  assert.equal(row.counted, false);
});

test("evaluateVerification: evidence none（manual）の passed は数えてよい。全件 ui だけ confirmed", () => {
  const files = [{ oldPath: "u2a2a/lib.mjs", newPath: "u2a2a/lib.mjs", status: "modified", binary: false, changedLines: ["a"] }];
  const req = V.deriveRequirements({ files, classifications: [] });
  const subject = SUBJECT_EMPTY_PATCH;
  const rec = record({ seq: 1, source: "ui", result: "passed", subject, req: req.requirementsSha256 });
  const ev = V.evaluateVerification({
    itemId: "i1", implDir: "topics/x/impl", projectKey: "default",
    folder: folderOk({ subject, patchText: libPatch }),
    baseCommit: { value: COMMIT, status: "verified", detail: "" },
    records: [rec],
    log: { ok: true, errors: [], lastSeq: 1 },
    evidenceStatus: { 1: "none" },
  });
  assert.equal(ev.aggregate.status, "confirmed");
  assert.equal(ev.aggregate.complete, true);
  assert.equal(ev.aggregate.label, "必須検証：確認済み（UI経路）");
});

test("evaluateVerification: 必須の最新が1件でも manifest なら declared。complete は false", () => {
  const files = [{ oldPath: "u2a2a/lib.mjs", newPath: "u2a2a/lib.mjs", status: "modified", binary: false, changedLines: ["a"] }];
  const req = V.deriveRequirements({ files, classifications: [] });
  const subject = SUBJECT_EMPTY_PATCH;
  const rec = record({ seq: 1, source: "manifest", result: "passed", subject, req: req.requirementsSha256 });
  const ev = V.evaluateVerification({
    itemId: "i1", implDir: "topics/x/impl", projectKey: "default",
    folder: folderOk({ subject, patchText: libPatch }),
    baseCommit: { value: COMMIT, status: "verified", detail: "" },
    records: [rec],
    log: { ok: true, errors: [], lastSeq: 1 },
    evidenceStatus: { 1: "none" },
  });
  assert.equal(ev.aggregate.status, "declared");
  assert.equal(ev.aggregate.complete, false);
  assert.equal(ev.aggregate.label, "必須検証：申告で充足");
});
