// 成果物バージョン履歴 — lib.mjs の純関数テスト（仕様: SPEC-成果物バージョン履歴.md）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  historyEligibility,
  sha256Hex,
  versionFileName,
  appendVersion,
  resolveVersionPair,
  unifiedDiff,
  truncateUtf8,
  HISTORY_MAX_BYTES,
} from "../lib.mjs";

const BS = String.fromCharCode(92); // バックスラッシュ
const NOEOL = BS + " No newline at end of file";

test("historyEligibility: UTF-8 テキスト 256KiB 以下だけが対象", () => {
  assert.equal(historyEligibility(Buffer.from("# hello\n日本語\n")), null);
  assert.equal(historyEligibility(null), "no-file");
  assert.equal(historyEligibility(Buffer.alloc(HISTORY_MAX_BYTES, 0x61)), null); // ちょうど上限は対象
  assert.equal(historyEligibility(Buffer.alloc(HISTORY_MAX_BYTES + 1, 0x61)), "too-large");
  assert.equal(historyEligibility(Buffer.from([0x50, 0x4b, 0x00, 0x01])), "binary"); // NUL を含む
  assert.equal(historyEligibility(Buffer.from([0xff, 0xfe, 0x41])), "binary"); // 不正な UTF-8
});

test("sha256Hex / versionFileName", () => {
  assert.equal(sha256Hex(Buffer.from("")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(versionFileName(3, "topics/abc/foo.md"), "v3.md");
  assert.equal(versionFileName(1, "noext"), "v1.txt");
  assert.equal(versionFileName(2, "dir.v1/file.tar.gz"), "v2.gz");
});

test("appendVersion: 連番・id・版ファイル名、直前と同一 sha256 なら版を切らない", () => {
  const m0 = { itemId: "i1", file: "a.md", versions: [] };
  const r1 = appendVersion(m0, { sha256: "a".repeat(64), size: 10, ts: 1, reason: "fix-before", agent: "claude", runId: "r1" });
  assert.equal(r1.created, true);
  assert.equal(r1.version.n, 1);
  assert.equal(r1.version.id, "v1-" + "a".repeat(12));
  assert.equal(r1.version.file, "v1.md");
  assert.equal(r1.version.partial, false);
  assert.equal(m0.versions.length, 0, "入力の manifest は変更しない");
  const r2 = appendVersion(r1.manifest, { sha256: "a".repeat(64), size: 10, ts: 2, reason: "fix-after" });
  assert.equal(r2.created, false);
  assert.equal(r2.version, r1.version, "無変更なら同じ版オブジェクトを返す");
  assert.equal(r2.manifest.versions.length, 1);
  const r3 = appendVersion(r2.manifest, { sha256: "b".repeat(64), size: 12, ts: 3, reason: "fix-after", partial: true });
  assert.equal(r3.created, true);
  assert.equal(r3.version.n, 2);
  assert.equal(r3.version.partial, true);
  assert.deepEqual(r3.manifest.versions.map((v) => v.n), [1, 2]);
  // 過去の版と同じ内容に戻っても、直前の版と違えば新しい版になる（履歴は直線）
  const r4 = appendVersion(r3.manifest, { sha256: "a".repeat(64), size: 10, ts: 4, reason: "review" });
  assert.equal(r4.created, true);
  assert.equal(r4.version.n, 3);
});

test("resolveVersionPair: from 省略は直前の版、初版は from null、不明 id は null", () => {
  const m = { itemId: "i", file: "a.md", versions: [{ n: 1, id: "v1" }, { n: 2, id: "v2" }, { n: 3, id: "v3" }] };
  assert.deepEqual(resolveVersionPair(m, null, "v3"), { from: m.versions[1], to: m.versions[2] });
  assert.deepEqual(resolveVersionPair(m, null, "v1"), { from: null, to: m.versions[0] });
  assert.deepEqual(resolveVersionPair(m, "v1", "v3"), { from: m.versions[0], to: m.versions[2] });
  assert.equal(resolveVersionPair(m, null, "nope"), null);
  assert.equal(resolveVersionPair(m, "nope", "v3"), null);
  assert.equal(resolveVersionPair(null, null, "v1"), null);
});

test("unifiedDiff: 同一内容は空、1 行置換はハンク 1 つ", () => {
  const a = "a\nb\nc\nd\ne\nf\ng\nh\n";
  assert.equal(unifiedDiff(a, a), "");
  const d = unifiedDiff(a, "a\nb\nX\nd\ne\nf\ng\nh\n", { fromLabel: "v1", toLabel: "v2" });
  assert.equal(d, "--- v1\n+++ v2\n@@ -1,6 +1,6 @@\n a\n b\n-c\n+X\n d\n e\n f\n");
});

test("unifiedDiff: 空→内容、内容→空、末尾改行なしのマーカー", () => {
  assert.equal(unifiedDiff("", "x\n"), "--- a\n+++ b\n@@ -0,0 +1,1 @@\n+x\n");
  assert.equal(unifiedDiff("x\n", ""), "--- a\n+++ b\n@@ -1,1 +0,0 @@\n-x\n");
  const d = unifiedDiff("x", "x\n");
  assert.equal(d, "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-x\n" + NOEOL + "\n+x\n");
});

test("unifiedDiff: 離れた 2 か所の変更は 2 ハンク、近い変更は 1 ハンクに結合", () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => "L" + (i + 1)).join("\n") + "\n";
  const a = lines(30);
  const b = a.replace("L5\n", "L5x\n").replace("L25\n", "L25x\n");
  const d = unifiedDiff(a, b);
  const hunks = d.split("\n").filter((l) => l.startsWith("@@"));
  assert.deepEqual(hunks, ["@@ -2,7 +2,7 @@", "@@ -22,7 +22,7 @@"]);
  const c = a.replace("L5\n", "L5x\n").replace("L9\n", "L9x\n"); // 間隔 3 行 → 結合
  assert.deepEqual(unifiedDiff(a, c).split("\n").filter((l) => l.startsWith("@@")), ["@@ -2,11 +2,11 @@"]);
});

test("unifiedDiff: 大きなファイルでも先頭/末尾の共通部分を除いて高速、D 上限超は全置換にフォールバック", () => {
  const big1 = Array.from({ length: 5000 }, (_, i) => "line " + i).join("\n") + "\n";
  const big2 = big1.replace("line 10\n", "line ten\n").replace("line 4990\n", "line 4990x\nextra\n");
  const t0 = Date.now();
  const d = unifiedDiff(big1, big2);
  assert.ok(Date.now() - t0 < 2000, "5000 行の差分が 2 秒以内");
  assert.equal(d.split("\n").filter((l) => l.startsWith("@@")).length, 2);
  assert.ok(d.includes("-line 10\n+line ten\n"));
  assert.ok(d.includes("+extra\n"));
  // 全行が異なる 300 行 × 2、D 上限 10 → 全置換ハンク 1 つ
  const c1 = Array.from({ length: 300 }, (_, i) => "a" + i).join("\n") + "\n";
  const c2 = Array.from({ length: 300 }, (_, i) => "b" + i).join("\n") + "\n";
  const f = unifiedDiff(c1, c2, { maxD: 10 });
  assert.equal(f.split("\n").filter((l) => l.startsWith("@@")).length, 1);
  assert.ok(f.startsWith("--- a\n+++ b\n@@ -1,300 +1,300 @@\n"));
  assert.equal(f.split("\n").filter((l) => l.startsWith("-")).length - 1, 300); // "--- a" を除く
  assert.equal(f.split("\n").filter((l) => l.startsWith("+")).length - 1, 300);
});

test("unifiedDiff: 出力を素朴に適用すると新版に戻る（往復検証）", () => {
  const apply = (src, diff) => {
    const out = [];
    const a = src.split("\n");
    if (a[a.length - 1] === "") a.pop();
    let ai = 0;
    for (const line of diff.split("\n").slice(2)) {
      if (line === "") continue;
      if (line.startsWith("@@")) {
        const start = Number(/-(\d+)/.exec(line)[1]);
        const count = Number(/-\d+,(\d+)/.exec(line)[1]);
        const from = count === 0 ? start : start - 1;
        while (ai < from) out.push(a[ai++]);
      } else if (line.startsWith(BS)) continue;
      else if (line.startsWith("+")) out.push(line.slice(1));
      else if (line.startsWith("-")) ai++;
      else out.push(a[ai++]);
    }
    while (ai < a.length) out.push(a[ai++]);
    return out.join("\n") + "\n";
  };
  const a = Array.from({ length: 40 }, (_, i) => "row " + i).join("\n") + "\n";
  const b = a.replace("row 3\n", "row three\n").replace("row 20\n", "").replace("row 35\n", "row 35\nrow 35.5\n");
  const d = unifiedDiff(a, b);
  assert.notEqual(d, "");
  assert.equal(apply(a, d), b);
});

test("truncateUtf8: 上限以内はそのまま、超えたら行境界で切って truncated", () => {
  assert.deepEqual(truncateUtf8("abc\n", 10), { text: "abc\n", truncated: false });
  const r = truncateUtf8("line1\nline2\nline3\n", 13);
  assert.equal(r.truncated, true);
  assert.equal(r.text, "line1\nline2\n");
  const j = truncateUtf8("日本語\n日本語\n", 12); // 2 行目の途中（マルチバイト境界）で切っても壊れない
  assert.equal(j.truncated, true);
  assert.equal(j.text, "日本語\n");
});
