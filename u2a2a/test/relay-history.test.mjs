// 質疑リレーの履歴 — 純関数とフロー導出（仕様: SPEC-relayHistory.md）。jsdom 不要
import { test } from "node:test";
import assert from "node:assert/strict";
import { relayRecord, reconstructRelays, findRelayRecord, RELAY_STOP_REASONS } from "../lib.mjs";
import { buildFlowGraph } from "../public/flow-graph.js";

const T = "topicA";
const PARTS = ["grok", "claude", "codex"];
const reply = (id, agent, ts) => ({ id, topicId: T, thread: agent, author: agent, text: "応答 " + id, ts, provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null } });
const qaCopy = (id, to, from, replyId, relayId, seq, turn, ts) => ({
  id, topicId: T, thread: to, author: from, text: "手番 " + seq, ts,
  provenance: { ingress: "agent-loop", delivery: "qa-relay", trigger: "auto", source: { topicId: T, messageId: replyId, agent: from, relayId, seq, turn } },
});
// 3 名リレー: 手番ごとに「応答 1 ＋ 配送コピー 2」
function relayMsgs(relayId, hops, t0 = 1000) {
  const out = [];
  for (let seq = 1; seq <= hops; seq++) {
    const turn = (seq - 1) % 3;
    const agent = PARTS[turn];
    const rid = relayId + "_r" + seq;
    out.push(reply(rid, agent, t0 + seq * 10));
    for (const to of PARTS.filter((p) => p !== agent)) out.push(qaCopy(relayId + "_c" + seq + to, to, agent, rid, relayId, seq, turn, t0 + seq * 10 + 1));
  }
  return out;
}

test("relayRecord: 不明な項目は null のまま。既定値で埋めない", () => {
  const rec = relayRecord({ id: "R1", participants: PARTS, spoken: { grok: 2 }, seq: 4, stopReason: "agreed", agenda: "決めること", startMessageId: "u1", startedTs: 100 }, { endedTs: 900 });
  assert.deepEqual(rec, {
    id: "R1", participants: PARTS, spoken: { grok: 2 }, hops: 4, stopReason: "agreed",
    agenda: "決めること", startMessageId: "u1", startedTs: 100, endedTs: 900, reconstructed: false,
  });
  // 何も分からないリレー
  const bare = relayRecord({ id: "R2" });
  assert.equal(bare.stopReason, null);
  assert.equal(bare.agenda, null);
  assert.equal(bare.startMessageId, null);
  assert.equal(bare.startedTs, null);
  assert.deepEqual(bare.participants, []);
  assert.equal(bare.hops, 0);
  // 入力を持ち回さない（spoken / participants はコピー）
  const src = { id: "R3", participants: ["a"], spoken: { a: 1 } };
  const r3 = relayRecord(src);
  r3.participants.push("b");
  r3.spoken.a = 99;
  assert.deepEqual(src.participants, ["a"]);
  assert.deepEqual(src.spoken, { a: 1 });
});

test("reconstructRelays: 参加者の並び・手番数・時刻を復元し、停止理由は不明のまま", () => {
  const msgs = [...relayMsgs("R1", 5, 1000), ...relayMsgs("R2", 2, 5000)];
  const recs = reconstructRelays(msgs);
  assert.equal(recs.length, 2);
  const [a, b] = recs;
  assert.equal(a.id, "R1");
  assert.deepEqual(a.participants, PARTS, "source.turn の添字から並びが戻る");
  assert.equal(a.hops, 5, "配送コピー 10 件ではなく手番 5");
  assert.deepEqual(a.spoken, { grok: 2, claude: 2, codex: 1 });
  assert.equal(a.startedTs, 1011);
  assert.equal(a.endedTs, 1051);
  assert.equal(a.reconstructed, true);
  // 偽の確実さを作らない
  assert.equal(a.stopReason, null);
  assert.equal(a.agenda, null);
  assert.equal(a.startMessageId, null);
  assert.equal(b.id, "R2");
  assert.equal(b.hops, 2);
  assert.deepEqual(b.participants, ["grok", "claude"]);
  // 開始時刻順
  assert.ok(a.startedTs < b.startedTs);
});

test("reconstructRelays: 配送コピーが無ければ何も作らない。壊れた provenance は読み飛ばす", () => {
  assert.deepEqual(reconstructRelays([]), []);
  assert.deepEqual(reconstructRelays(null), []);
  assert.deepEqual(reconstructRelays([reply("r1", "claude", 100)]), []);
  const broken = [
    { id: "x1", topicId: T, ts: 100 }, // provenance なし
    { id: "x2", topicId: T, ts: 101, provenance: { delivery: "qa-relay", source: null } },
    { id: "x3", topicId: T, ts: 102, provenance: { delivery: "qa-relay", source: { relayId: null, seq: 1 } } },
  ];
  assert.deepEqual(reconstructRelays(broken), []);
  // seq が無いコピーは元メッセージ ID で 1 手番として数える
  const noSeq = [
    { id: "y1", topicId: T, ts: 200, author: "claude", provenance: { delivery: "qa-relay", source: { relayId: "R9", messageId: "m1", agent: "claude" } } },
    { id: "y2", topicId: T, ts: 200, author: "claude", provenance: { delivery: "qa-relay", source: { relayId: "R9", messageId: "m1", agent: "claude" } } },
  ];
  const r = reconstructRelays(noSeq);
  assert.equal(r.length, 1);
  assert.equal(r[0].hops, 1);
  assert.deepEqual(r[0].participants, [], "turn が無ければ並びは復元しない");
});

test("findRelayRecord: 履歴から引く。無ければ null", () => {
  const topic = { relayHistory: [{ id: "R1", stopReason: "agreed" }, { id: "R2", stopReason: null }] };
  assert.equal(findRelayRecord(topic, "R1").stopReason, "agreed");
  assert.equal(findRelayRecord(topic, "R2").stopReason, null);
  assert.equal(findRelayRecord(topic, "R9"), null);
  assert.equal(findRelayRecord({}, "R1"), null);
  assert.equal(findRelayRecord(null, "R1"), null);
  assert.equal(findRelayRecord(topic, null), null);
});

test("RELAY_STOP_REASONS に restart が入っている（再起動での打ち切り）", () => {
  assert.ok(RELAY_STOP_REASONS.includes("restart"));
  assert.ok(RELAY_STOP_REASONS.includes("agreed"));
});

// ---- フロー導出との接続 ----

const topic = (over = {}) => ({
  id: T, title: "三者会談", participants: PARTS,
  relay: { active: false, id: null, participants: [], turn: 0, seq: 0, stopReason: null, startMessageId: null },
  relayHistory: [], ...over,
});
const input = (over = {}) => ({ topicId: T, messages: [], pool: [], tasks: [], topics: [topic()], running: {}, reviewPending: {}, fixPending: {}, ...over });
const relayNode = (g) => g.nodes.find((n) => n.kind === "relay");

test("フロー: 過去リレーの stopReason を relayHistory から引いて色が付く", () => {
  const msgs = relayMsgs("R1", 3, 1000);
  const hist = [{ id: "R1", participants: PARTS, spoken: {}, hops: 3, stopReason: "agreed", agenda: "手狭の解決", startMessageId: "u1", startedTs: 1000, endedTs: 2000, reconstructed: false }];
  const g = buildFlowGraph(input({ messages: msgs, topics: [topic({ relayHistory: hist })] }));
  const n = relayNode(g);
  assert.equal(n.stopReason, "agreed");
  assert.equal(n.status, "ok", "合意で終わったリレーは青");
  assert.equal(n.agenda, "手狭の解決");
  assert.equal(n.startMessageId, "u1");
  assert.equal(n.endedTs, 2000);
  assert.equal(n.reconstructed, false);
  assert.equal(n.active, false);
});

test("フロー: 打ち切りは黄、エラーは赤、restart も理由として出る", () => {
  const msgs = relayMsgs("R1", 3, 1000);
  const mk = (reason) => buildFlowGraph(input({ messages: msgs, topics: [topic({ relayHistory: [{ id: "R1", stopReason: reason, reconstructed: false }] })] }));
  assert.equal(relayNode(mk("hops")).status, "wait");
  assert.equal(relayNode(mk("manual")).status, "wait");
  assert.equal(relayNode(mk("error")).status, "err");
  assert.equal(relayNode(mk("budget")).status, "err");
  const restart = relayNode(mk("restart"));
  assert.equal(restart.stopReason, "restart");
  assert.equal(restart.status, "wait", "再起動での打ち切りは黄。合意で閉じていないので青にしない");
  assert.equal(relayNode(mk("agreed")).status, "ok");
});

test("フロー: 復元由来（stopReason 不明）は中立のまま。reconstructed が立つ", () => {
  const msgs = relayMsgs("R1", 3, 1000);
  const hist = reconstructRelays(msgs);
  const g = buildFlowGraph(input({ messages: msgs, topics: [topic({ relayHistory: hist })] }));
  const n = relayNode(g);
  assert.equal(n.stopReason, null);
  assert.equal(n.status, "", "終了理由不明は中立表示（青にしない）");
  assert.equal(n.reconstructed, true);
  assert.deepEqual(n.participants, PARTS, "復元した並びを使う");
});

test("フロー: 履歴が無い過去リレーは従来どおり中立。現在のリレーは topic.relay が優先", () => {
  const msgs = relayMsgs("R1", 3, 1000);
  const none = relayNode(buildFlowGraph(input({ messages: msgs })));
  assert.equal(none.stopReason, null);
  assert.equal(none.status, "");
  assert.equal(none.reconstructed, false);
  // 進行中のリレーは履歴に古い記録があっても active が勝つ
  const live = topic({
    relay: { active: true, id: "R1", participants: PARTS, turn: 1, seq: 3, stopReason: null, startMessageId: "u1", agenda: "いま決めること" },
    relayHistory: [{ id: "R1", stopReason: "restart", agenda: "古い議題", reconstructed: false }],
  });
  const n = relayNode(buildFlowGraph(input({ messages: msgs, topics: [live] })));
  assert.equal(n.active, true);
  assert.equal(n.status, "run");
  assert.equal(n.stopReason, null, "進行中は topic.relay を見る");
  assert.equal(n.agenda, "いま決めること");
});

test("フロー: 複数の過去リレーがそれぞれの結末を持つ", () => {
  const msgs = [...relayMsgs("R1", 3, 1000), ...relayMsgs("R2", 2, 5000), ...relayMsgs("R3", 4, 9000)];
  const hist = [
    { id: "R1", stopReason: "agreed", reconstructed: false },
    { id: "R2", stopReason: "hops", reconstructed: false },
    ...reconstructRelays(msgs).filter((r) => r.id === "R3"),
  ];
  const g = buildFlowGraph(input({ messages: msgs, topics: [topic({ relayHistory: hist })] }));
  const nodes = g.nodes.filter((n) => n.kind === "relay");
  assert.equal(nodes.length, 3);
  assert.deepEqual(nodes.map((n) => [n.relayId, n.stopReason, n.status]), [
    ["R1", "agreed", "ok"],
    ["R2", "hops", "wait"],
    ["R3", null, ""],
  ]);
  assert.equal(g.warnings.length, 0);
});
