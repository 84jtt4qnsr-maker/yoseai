// 要約の鮮度 — 純関数（仕様: SPEC-要約鮮度.md「テスト」1〜5）。jsdom 不要
import { test } from "node:test";
import assert from "node:assert/strict";
import { unreflectedMessages, unreflectedCount, summaryFreshness, sortByTsId } from "../lib.mjs";

const T = "topicA";
const direct = (ingress = "ui") => ({ ingress, delivery: "direct", trigger: "manual", source: null });
const msg = (id, ts, over = {}) => ({ id, topicId: T, thread: "claude", author: "claude", text: id, provenance: direct("agent-loop"), ts, ...over });
const user = (id, ts, thread = "claude") => ({ id, topicId: T, thread, author: "user", text: id, provenance: direct(), ts });
// 質疑の配送コピー（応答 1 件につき参加者-1 件つくられる）
const qaCopy = (id, to, from, replyId, relayId, seq, ts) => ({
  id, topicId: T, thread: to, author: from, text: "手番 " + seq, ts,
  provenance: { ingress: "agent-loop", delivery: "qa-relay", trigger: "auto", source: { topicId: T, messageId: replyId, agent: from, relayId, seq, turn: seq % 3 } },
});

// 1. 配送コピー除外
test("未反映: 3名リレー2手番（応答2＋コピー4）は 2 と数える。素の件数は 6", () => {
  const msgs = [
    msg("r1", 100),
    qaCopy("c1a", "codex", "claude", "r1", "R1", 1, 101),
    qaCopy("c1b", "grok", "claude", "r1", "R1", 1, 101),
    msg("r2", 200, { author: "codex", thread: "codex" }),
    qaCopy("c2a", "claude", "codex", "r2", "R1", 2, 201),
    qaCopy("c2b", "grok", "codex", "r2", "R1", 2, 201),
  ];
  assert.equal(msgs.length, 6);
  assert.equal(unreflectedCount(msgs, { summaryAt: 0 }), 2);
  assert.deepEqual(unreflectedMessages(msgs, { summaryAt: 0 }).map((m) => m.id), ["r1", "r2"]);
});

// 2. summaryLastMsgId 基準とフォールバック
test("未反映: summaryLastMsgId の次から数える。対象外の ID なら summaryAt にフォールバック", () => {
  const msgs = [user("u1", 100), msg("r1", 200), user("u2", 300), msg("r2", 400)];
  assert.equal(unreflectedCount(msgs, { summaryLastMsgId: "r1", summaryAt: 0 }), 2);
  assert.deepEqual(unreflectedMessages(msgs, { summaryLastMsgId: "r1" }).map((m) => m.id), ["u2", "r2"]);
  // 分岐前の親 ID など、このトピックに無い ID は無視して summaryAt を使う
  assert.equal(unreflectedCount(msgs, { summaryLastMsgId: "parent-msg", summaryAt: 3 }), 1);
  // 末尾を指していれば 0
  assert.equal(unreflectedCount(msgs, { summaryLastMsgId: "r2" }), 0);
});

// 3. 旧トピック（どちらも無い）
test("未反映: summaryLastMsgId も summaryAt も無ければ全件", () => {
  const msgs = [user("u1", 100), msg("r1", 200)];
  assert.equal(unreflectedCount(msgs, {}), 2);
  assert.equal(unreflectedCount(msgs), 2);
  assert.equal(unreflectedCount([], {}), 0);
  // summaryAt が件数を超えていても落ちない
  assert.equal(unreflectedCount(msgs, { summaryAt: 99 }), 0);
});

// 4. 数える発言・数えない発言
test("未反映: stale / blocked / cancelled は数え、転送・引き継ぎのコピーは数えない", () => {
  const msgs = [
    msg("s1", 100, { staleRelayId: "R0" }),
    msg("b1", 200, { blocked: true }),
    msg("x1", 300, { cancelled: true }),
    { ...msg("f1", 400), provenance: { ingress: "ui", delivery: "relay", trigger: "manual", source: { topicId: T, messageId: "s1", agent: "claude" } } },
    { ...msg("h1", 500), provenance: { ingress: "ui", delivery: "handoff", trigger: "manual", source: { topicId: T, messageId: "b1", agent: "claude" } } },
  ];
  assert.deepEqual(unreflectedMessages(msgs, { summaryAt: 0 }).map((m) => m.id), ["s1", "b1", "x1"]);
});

// 5. due の境界
test("鮮度: due は unreflected >= threshold。11 は false、12 は true", () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => msg("m" + i, 100 + i));
  const topic = { summaryAt: 0, summaryLastMsgId: null };
  assert.deepEqual(summaryFreshness(topic, mk(11), 12), { total: 11, unreflected: 11, threshold: 12, due: false });
  assert.deepEqual(summaryFreshness(topic, mk(12), 12), { total: 12, unreflected: 12, threshold: 12, due: true });
  // 配送コピーは due の判定にも効かない: 応答 4 ＋ コピー 8 の 12 件でも未反映は 4
  const relay = [];
  for (let seq = 1; seq <= 4; seq++) {
    relay.push(msg("r" + seq, 100 + seq * 10));
    relay.push(qaCopy("c" + seq + "a", "codex", "claude", "r" + seq, "R1", seq, 101 + seq * 10));
    relay.push(qaCopy("c" + seq + "b", "grok", "claude", "r" + seq, "R1", seq, 101 + seq * 10));
  }
  assert.equal(relay.length, 12);
  assert.deepEqual(summaryFreshness(topic, relay, 12), { total: 12, unreflected: 4, threshold: 12, due: false });
  // threshold 0 は due を立てない
  assert.equal(summaryFreshness(topic, mk(3), 0).due, false);
});

// 「どこまで要約したか」を書く側（server: 要約成功時・分岐時）と数える側で並び順が食い違うと、
// 同 ts の配送コピーが並んだときに直後の未反映が 0 にならない。sortByTsId を共有することで揃える
test("並び順: 同 ts は id 昇順。末尾 ID を挿入順で取ると未反映が残る", () => {
  const sameTs = [msg("b", 100), msg("a", 100), msg("c", 100)];
  assert.deepEqual(sortByTsId(sameTs).map((m) => m.id), ["a", "b", "c"]);
  assert.equal(unreflectedCount(sameTs, { summaryLastMsgId: sortByTsId(sameTs).pop().id }), 0);
  const inserted = [msg("c", 100), msg("a", 100), msg("b", 100)];
  assert.equal(unreflectedCount(inserted, { summaryLastMsgId: inserted[inserted.length - 1].id }), 1); // 挿入順の末尾は "b"
  assert.deepEqual(sortByTsId([]), []);
  assert.deepEqual(sortByTsId(null), []);
});

test("未反映: 入力を破壊しない・順不同でも同じ結果", () => {
  const msgs = [user("u1", 100), msg("r1", 200), user("u2", 300)];
  const frozen = msgs.slice().reverse().map((m) => Object.freeze({ ...m }));
  Object.freeze(frozen);
  assert.equal(unreflectedCount(frozen, { summaryLastMsgId: "r1" }), 1);
  assert.deepEqual(msgs.map((m) => m.id), ["u1", "r1", "u2"]);
});

test("unreflectedMessages: 分岐先の孤児コピー（親IDしか指さないqa-relay）は relayId+seq で1件に畳まれる", async () => {
  // 分岐先: 応答コピー1 + 配送コピー2（sourceは親トピックのIDのまま＝この一覧に存在しない孤児）
  const msgs = [
    { id: "k1", thread: "claude", author: "grok", text: "本文", ts: 100,
      provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null } },
    { id: "k2", thread: "claude", author: "grok", text: "本文", ts: 101,
      provenance: { ingress: "agent-loop", delivery: "qa-relay", trigger: "auto", source: { messageId: "parent-1", relayId: "r1", seq: 3 } } },
    { id: "k3", thread: "codex", author: "grok", text: "本文", ts: 101,
      provenance: { ingress: "agent-loop", delivery: "qa-relay", trigger: "auto", source: { messageId: "parent-1", relayId: "r1", seq: 3 } } },
  ];
  const kept = unreflectedMessages(msgs, {});
  // 応答1 + 孤児コピー畳み1 = 2件（3件に膨らまない・0件に消えない）
  assert.equal(kept.length, 2, kept.map((m) => m.id).join(","));
  assert.equal(kept[0].id, "k1");
});
