import { test } from "node:test";
import assert from "node:assert/strict";
import { validateStateShape, isRelay, extractDeclaredPaths, judgeBudget, inferAuthor, safeVersionFileName } from "../lib.mjs";

test("validateStateShape: 正常な形状は通す", () => {
  const st = { messages: [], tasks: [], pool: [], topics: [] };
  assert.equal(validateStateShape(st), st);
});

test("validateStateShape: 壊れた形状は理由付きで拒否（空上書き防止の入口）", () => {
  assert.throws(() => validateStateShape(null), /オブジェクト/);
  assert.throws(() => validateStateShape({ messages: "x", tasks: [], pool: [] }), /messages/);
  assert.throws(() => validateStateShape({ messages: [], tasks: [], pool: [], topics: {} }), /topics/);
});

test("isRelay: リレーのみ真、引き継ぎ・直接は偽", () => {
  assert.equal(isRelay({ delivery: "qa-relay" }), true);
  assert.equal(isRelay({ delivery: "relay" }), true);
  assert.equal(isRelay({ delivery: "handoff" }), false);
  assert.equal(isRelay({ delivery: "direct" }), false);
  assert.equal(isRelay(null), false);
});

test("extractDeclaredPaths: 本文のパス宣言を抽出、システム領域は除外", () => {
  const text =
    "保存しました: `u2a2a/pool/topics/abc123/art.png` と u2a2a/pool/media/clip.mp4。\n" +
    "参考: u2a2a/pool/threads/メイン-x.md、u2a2a/pool/U2A2A_RULES.md、u2a2a/pool/topics/abc123/.work/tmp.py";
  assert.deepEqual(extractDeclaredPaths(text), ["topics/abc123/art.png", "media/clip.mp4"]);
});

test("extractDeclaredPaths: 重複除去と末尾句読点の除去", () => {
  const t = "u2a2a/pool/a.md、u2a2a/pool/a.md。";
  assert.deepEqual(extractDeclaredPaths(t), ["a.md"]);
});

test("judgeBudget: 回数上限は走行中を含めて判定（合意事項B）", () => {
  const base = { budgets: { runCount: 2 }, usageDay: { date: "2026-09-08", runs: 1, ms: 0 }, today: "2026-09-08" };
  assert.equal(judgeBudget({ ...base, inflightCount: 0 }), null);
  assert.match(judgeBudget({ ...base, inflightCount: 1 }) || "", /実行回数上限/);
});

test("judgeBudget: 日付が変わればカウンタはリセット扱い", () => {
  const r = judgeBudget({
    budgets: { runCount: 1 },
    usageDay: { date: "2026-09-07", runs: 5, ms: 0 },
    today: "2026-09-08",
    inflightCount: 0,
  });
  assert.equal(r, null);
});

test("judgeBudget: 時間上限は走行中の経過を含める", () => {
  const r = judgeBudget({
    budgets: { runMinutes: 10 },
    usageDay: { date: "2026-09-08", runs: 0, ms: 9 * 60000 },
    today: "2026-09-08",
    inflightMs: 2 * 60000,
  });
  assert.match(r || "", /実行時間上限/);
});

test("judgeBudget: トピックUSD上限", () => {
  assert.match(judgeBudget({ budgets: {}, today: "d", topicUsd: 5.5, topicCap: 5 }) || "", /コスト上限/);
  assert.equal(judgeBudget({ budgets: {}, today: "d", topicUsd: 4.9, topicCap: 5 }), null);
});

test("inferAuthor: 候補がちょうど1件のときだけ推定（合意事項C）", () => {
  const runs1 = [{ kind: "thread", agent: "codex", topicId: "t1" }];
  assert.deepEqual(inferAuthor("topics/t1/a.png", "t1", runs1), { origin: "codex", via: "inferred", candidates: 1 });
  const runs2 = [
    { kind: "thread", agent: "codex", topicId: "t1" },
    { kind: "thread", agent: "claude", topicId: "t1" },
  ];
  assert.deepEqual(inferAuthor("topics/t1/a.png", "t1", runs2), { origin: null, via: "unknown", candidates: 2 });
  assert.deepEqual(inferAuthor("misc/a.png", null, runs1), { origin: null, via: "unknown", candidates: 0 });
});

test("inferAuthor: トピック不明のファイルは無関係な thread run に帰属しない", () => {
  const runs = [{ kind: "thread", agent: "claude", topicId: "t9" }];
  assert.deepEqual(inferAuthor("stray.md", null, runs), { origin: null, via: "unknown", candidates: 0 });
});

test("safeVersionFileName: 正当な版名のみ許可し、トラバーサルを拒否（監査4巡目）", () => {
  assert.equal(safeVersionFileName("v1.md"), true);
  assert.equal(safeVersionFileName("v12.tar.gz"), true);
  assert.equal(safeVersionFileName("../../../../src/App.tsx"), false);
  assert.equal(safeVersionFileName("v1/../x.md"), false);
  assert.equal(safeVersionFileName("v1.md/"), false);
  assert.equal(safeVersionFileName("x1.md"), false);
  assert.equal(safeVersionFileName(""), false);
  assert.equal(safeVersionFileName(null), false);
});
