// フロービューのグラフ導出（SPEC-フロービュー.md「テスト」1〜17 ＋ fixture スナップショット）。jsdom 不要
// fixture の更新: FLOW_FIXTURES_UPDATE=1 node --test test/flow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildFlowGraph, groupUserSends, collectRelays, artifactVerdicts, nodeStatus, childBranches, branchOrigin, foldPlan, membershipOf } from "../lib.mjs";

const T = "topicA";
const direct = (ingress = "ui", trigger = "manual") => ({ ingress, delivery: "direct", trigger, source: null });

// publicState() の形を手で組むヘルパ
function user(id, thread, ts, text = "お願いします", over = {}) {
  return { id, topicId: T, thread, author: "user", text, provenance: direct(), ts, ...over };
}
function reply(id, agent, ts, text = "応答 " + id, over = {}) {
  return { id, topicId: T, thread: agent, author: agent, text, provenance: direct("agent-loop", "auto"), ts, ...over };
}
function qaCopy(id, to, from, replyId, relayId, seq, turn, ts, text = "手番 " + seq) {
  return {
    id,
    topicId: T,
    thread: to,
    author: from,
    text,
    provenance: { ingress: "agent-loop", delivery: "qa-relay", trigger: "auto", source: { topicId: T, messageId: replyId, agent: from, relayId, seq, turn } },
    ts,
  };
}
function topic(over = {}) {
  return { id: T, title: "三者会談", participants: ["claude", "codex", "grok"], agents: {}, relay: { active: false, id: null, participants: [], turn: 0, seq: 0, stopReason: null, startMessageId: null }, ...over };
}
function input(over = {}) {
  return { topicId: T, messages: [], pool: [], tasks: [], topics: [topic()], running: {}, reviewPending: {}, fixPending: {}, ...over };
}
const byKey = (g, key) => g.nodes.find((n) => n.key === key);
const edgesOf = (g, kind) => g.edges.filter((e) => e.kind === kind);
function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// 1. 送信束
test("送信束: all 送信 3 件は 1 束（inferred）、200ms 離れた同文・同レーン連続は別束、分岐コピーも候補", () => {
  const msgs = [
    user("u1", "claude", 1000),
    user("u2", "codex", 1001),
    user("u3", "grok", 1003),
    user("u4", "claude", 1200), // 先頭から 200ms
    user("u5", "codex", 1201),
    user("u6", "codex", 1202), // 同レーン連続
    user("u7", "claude", 2000, "分岐前の発言", { copiedFromMessageId: "orig7" }),
  ];
  const b = groupUserSends(msgs);
  assert.deepEqual(b.map((x) => x.messageIds), [["u1", "u2", "u3"], ["u4", "u5"], ["u6"], ["u7"]]);
  assert.deepEqual(b.map((x) => x.inferred), [true, true, false, false]);
  assert.deepEqual(b[0].lanes, ["claude", "codex", "grok"]);
  const g = buildFlowGraph(input({ messages: msgs }));
  assert.equal(byKey(g, "msg:u1").kind, "send");
  assert.deepEqual(g.membership.u3, "msg:u1");
  assert.equal(g.episodes.length, 4);
});

// 2. 窓の連鎖をしない
test("送信束: 窓は束の先頭からの幅。0・40・80ms は 2 束（0+40 と 80）", () => {
  const msgs = [user("a", "claude", 0), user("b", "codex", 40), user("c", "grok", 80)];
  const b = groupUserSends(msgs, 50);
  assert.deepEqual(b.map((x) => x.messageIds), [["a", "b"], ["c"]]);
});

// 3. 質疑開始
test("質疑開始: relay.startMessageId と一致する発言は単独束（kind relay）で relay-start が solid", () => {
  const msgs = [
    user("u1", "claude", 100, "今回決めること"),
    reply("r1", "claude", 200),
    qaCopy("c1", "codex", "claude", "r1", "R1", 1, 0, 201),
    qaCopy("c2", "grok", "claude", "r1", "R1", 1, 0, 201),
  ];
  const g = buildFlowGraph(input({ messages: msgs, topics: [topic({ relay: { active: true, id: "R1", participants: ["claude", "codex", "grok"], turn: 1, seq: 1, stopReason: null, startMessageId: "u1" } })] }));
  assert.equal(g.episodes[0].kind, "relay");
  const rs = edgesOf(g, "relay-start");
  assert.equal(rs.length, 1);
  assert.deepEqual([rs[0].from.nodeKey, rs[0].to.nodeKey, rs[0].style], ["msg:u1", "relay:R1", "solid"]);
  assert.equal(byKey(g, "relay:R1").status, "run");
  assert.equal(byKey(g, "relay:R1").startMessageId, "u1");
});

// 4. 応答の所属（復元は約束しない）
test("応答の所属: レーン別の直前束へ dashed。束より前は orphan。実行中に届いた次の束の後に保存された応答は次の束に付く（復元を約束しない）", () => {
  const msgs = [
    reply("r0", "claude", 50), // どの束より前
    user("a1", "claude", 100, "A"),
    user("a2", "codex", 101, "A"),
    reply("r1", "claude", 200),
    user("b1", "claude", 300, "B"),
    reply("r2", "codex", 350), // B は codex 宛てでないので A に付く
    reply("r3", "claude", 400), // 実際は A の入力への応答でも B に付く
  ];
  const g = buildFlowGraph(input({ messages: msgs }));
  const ans = Object.fromEntries(edgesOf(g, "answer").map((e) => [e.to.nodeKey, e.from.nodeKey]));
  assert.deepEqual(ans, { "msg:r1": "msg:a1", "msg:r2": "msg:a1", "msg:r3": "msg:b1" });
  assert.ok(edgesOf(g, "answer").every((e) => e.style === "dashed"));
  const orphan = g.episodes.find((e) => e.kind === "orphan");
  assert.deepEqual(orphan.nodeKeys, ["msg:r0"]);
  assert.equal(g.episodes[0].key, orphan.key); // 時刻順にスパインへ混ざる
});

// 5. 配送コピー
test("配送コピー: qa-relay / relay のコピーはノードにならず、relayId+seq で 1 手 1 件。membership にコピー ID は載らない", () => {
  const msgs = [
    user("u1", "claude", 100),
    reply("r1", "claude", 200),
    qaCopy("c1", "codex", "claude", "r1", "R1", 1, 0, 201),
    qaCopy("c2", "grok", "claude", "r1", "R1", 1, 0, 201),
    { ...reply("f1", "codex", 300, "応答 r1"), author: "claude", provenance: { ingress: "ui", delivery: "relay", trigger: "manual", source: { topicId: T, messageId: "r1", agent: "claude" } } },
  ];
  const g = buildFlowGraph(input({ messages: msgs }));
  assert.deepEqual(g.nodes.map((n) => n.key), ["msg:u1", "relay:R1"]);
  assert.equal(byKey(g, "relay:R1").hops.length, 1);
  assert.deepEqual(Object.keys(g.membership).sort(), ["r1", "u1"]);
  const fw = edgesOf(g, "forward");
  assert.equal(fw.length, 1);
  assert.deepEqual([fw[0].from.nodeKey, fw[0].to.mark, fw[0].viaMessageIds], ["relay:R1", "forward", ["f1"]]);
});

// 6. リレー複合
test("リレー複合: 3 名 5 手が 1 ノード、hops は seq 順、agreed → ok、hops → wait、relay-hop は 4 本", () => {
  const parts = ["grok", "claude", "codex"];
  const msgs = [user("u1", "grok", 100)];
  for (let seq = 1; seq <= 5; seq++) {
    const agent = parts[(seq - 1) % 3];
    msgs.push(reply("r" + seq, agent, 100 + seq * 10));
    for (const to of parts.filter((p) => p !== agent)) msgs.push(qaCopy("c" + seq + to, to, agent, "r" + seq, "R1", seq, (seq - 1) % 3, 101 + seq * 10));
  }
  // 順不同で渡しても seq 順
  const shuffled = msgs.slice().reverse();
  const done = (stopReason) => topic({ relay: { active: false, id: "R1", participants: parts, turn: 2, seq: 5, stopReason, startMessageId: "u1" } });
  const g = buildFlowGraph(input({ messages: shuffled, topics: [done("agreed")] }));
  const r = byKey(g, "relay:R1");
  assert.deepEqual(r.hops.map((h) => h.seq), [1, 2, 3, 4, 5]);
  assert.deepEqual(r.hops.map((h) => h.messageId), ["r1", "r2", "r3", "r4", "r5"]);
  assert.deepEqual(r.participants, parts);
  assert.equal(r.status, "ok");
  assert.equal(g.nodes.filter((n) => n.kind === "reply").length, 0);
  assert.equal(edgesOf(g, "relay-hop").length, 4);
  assert.deepEqual(edgesOf(g, "relay-hop")[0].viaMessageIds, ["r1", "r2"]);
  const g2 = buildFlowGraph(input({ messages: shuffled, topics: [done("hops")] }));
  assert.equal(byKey(g2, "relay:R1").status, "wait");
  assert.equal(nodeStatus({ kind: "relay", active: false, stopReason: "budget" }), "err");
});

// 7. 未中継
test("未中継: staleRelayId 付きは unrelayed ノード。配送先への線は無く、gray の終端マークだけ", () => {
  const msgs = [user("u1", "claude", 100), reply("r1", "claude", 200, "遅れて届いた応答", { staleRelayId: "R0" })];
  const g = buildFlowGraph(input({ messages: msgs }));
  const n = byKey(g, "msg:r1");
  assert.equal(n.kind, "unrelayed");
  assert.equal(n.text, "遅れて届いた応答");
  assert.equal(edgesOf(g, "answer").length, 0);
  const u = edgesOf(g, "unrelayed");
  assert.equal(u.length, 1);
  assert.deepEqual([u[0].from.nodeKey, u[0].to.mark, u[0].style], ["msg:r1", "unrelayed", "gray"]);
  assert.equal(g.episodes[0].count.replies, 1);
});

// 8. 同著者の複数応答
test("同著者の複数応答: 同一束に 2 件 → replies。membership は grp: を指し、成果物の線もグループカードへ", () => {
  const msgs = [user("u1", "claude", 100), reply("r1", "claude", 200), reply("r2", "claude", 300), reply("r3", "codex", 250)];
  const pool = [{ id: "p1", title: "案.md", file: "topics/topicA/案.md", origin: "claude", topicId: T, reviewers: ["codex", "grok"], status: "submitted", reviews: [], fromMessageId: "r2", ts: 310 }];
  const g = buildFlowGraph(input({ messages: msgs, pool }));
  const grp = byKey(g, "grp:r1");
  assert.equal(grp.kind, "replies");
  assert.equal(grp.count, 2);
  assert.deepEqual(grp.messageIds, ["r1", "r2"]);
  assert.equal(byKey(g, "msg:r1"), undefined);
  assert.equal(byKey(g, "msg:r3").kind, "reply"); // 1 件なら reply のまま
  assert.deepEqual([g.membership.r1, g.membership.r2], ["grp:r1", "grp:r1"]);
  const a = edgesOf(g, "artifact");
  assert.equal(a.length, 1);
  assert.deepEqual([a[0].from.nodeKey, a[0].to.nodeKey, a[0].style], ["grp:r1", "art:p1", "solid"]);
});

// 9. 成果物
test("成果物: fromMessageId あり → solid、空／他トピック → 独立ノードでエッジなし。verdicts は reviewer ごとの最新。reviewPending で run", () => {
  const msgs = [user("u1", "claude", 100), reply("r1", "claude", 200)];
  const item = (id, over) => ({ id, title: id, file: "topics/topicA/" + id, origin: "claude", topicId: T, reviewers: ["codex", "grok"], status: "submitted", reviews: [], fromMessageId: null, ts: 500, ...over });
  const pool = [
    item("p1", {
      fromMessageId: "r1",
      reviews: [
        { id: "v1", reviewer: "codex", text: "【判定】承認", verdict: "承認", ts: 510 },
        { id: "v2", reviewer: "codex", text: "【判定】差し戻し", verdict: "差し戻し", ts: 520 },
        { id: "v3", reviewer: "grok", text: "（未実施: スキップ）", verdict: "", skipped: true, reason: "未認証", ts: 511 },
      ],
    }),
    item("p2", { fromMessageId: "" }),
    item("p3", { fromMessageId: "other-topic-msg", ts: 600 }),
    item("p4", { topicId: "topicB" }),
  ];
  const g = buildFlowGraph(input({ messages: msgs, pool, reviewPending: { p2: ["codex"] } }));
  assert.deepEqual(edgesOf(g, "artifact").map((e) => [e.from.nodeKey, e.to.nodeKey, e.style]), [["msg:r1", "art:p1", "solid"]]);
  assert.deepEqual(byKey(g, "art:p1").verdicts, [
    { reviewer: "codex", label: "差し戻し", ts: 520 },
    { reviewer: "grok", label: "スキップ", ts: 511 },
  ]);
  assert.deepEqual(artifactVerdicts({ reviewers: ["claude"], reviews: [] }), [{ reviewer: "claude", label: "未実施", ts: null }]);
  assert.deepEqual(artifactVerdicts({ reviewers: [], reviews: [{ reviewer: "grok", verdict: "", error: true, ts: 1 }, { reviewer: "grok", verdict: "", stopped: true, ts: 2 }] }), [{ reviewer: "grok", label: "中断", ts: 2 }]);
  assert.ok(byKey(g, "art:p2") && byKey(g, "art:p3"));
  assert.equal(byKey(g, "art:p4"), undefined);
  assert.equal(byKey(g, "art:p2").status, "run");
  assert.equal(byKey(g, "art:p2").pending, true);
  assert.equal(byKey(g, "art:p3").status, "ok");
  // 独立ノードは起点なしの束に時刻順で混ざる
  const orphan = g.episodes.find((e) => e.kind === "orphan");
  assert.deepEqual(orphan.nodeKeys, ["art:p2", "art:p3"]);
  assert.equal(g.episodes[0].count.artifacts, 1);
});

// 10. タスク
test("タスク: fromMessageId → task エッジ、taskId 付き発言 → task-return。queued → wait、working → run", () => {
  const msgs = [user("u1", "claude", 100), reply("r1", "claude", 200), reply("r2", "codex", 900, "結果です", { taskId: "t1" })];
  const tasks = [
    { id: "t1", agent: "codex", topicId: T, title: "実装", detail: "", status: "returned", fromMessageId: "r1", result: "結果です", ts: 300 },
    { id: "t2", agent: "grok", topicId: T, title: "整理", detail: "", status: "queued", fromMessageId: null, result: "", ts: 400 },
    { id: "t3", agent: "grok", topicId: T, title: "調査", detail: "", status: "working", fromMessageId: "r1", result: "", ts: 450 },
  ];
  const g = buildFlowGraph(input({ messages: msgs, tasks }));
  assert.deepEqual(edgesOf(g, "task").map((e) => [e.from.nodeKey, e.to.nodeKey]), [["msg:r1", "task:t1"], ["msg:r1", "task:t3"]]);
  assert.deepEqual(edgesOf(g, "task-return").map((e) => [e.from.nodeKey, e.to.nodeKey, e.viaMessageIds]), [["task:t1", "msg:r2", ["r2"]]]);
  assert.equal(byKey(g, "task:t1").status, "ok");
  assert.equal(byKey(g, "task:t2").status, "wait");
  assert.equal(byKey(g, "task:t3").status, "run");
  assert.equal(g.episodes.find((e) => e.kind === "orphan").nodeKeys.includes("task:t2"), true);
});

// 11. 分岐
test("分岐: 親は子 2 つの branches と anchorKey、子は copiedFromMessageId 一致のコピー ID を origin.anchorKey に持つ", () => {
  const topics = [
    topic(),
    { ...topic({ id: "child1", title: "三者会談＃分岐" }), branchedFrom: { topicId: T, messageId: "u1" } },
    { ...topic({ id: "child2", title: "三者会談＃分岐2" }), branchedFrom: { topicId: T, messageId: "r1" } },
  ];
  const parentMsgs = [user("u1", "claude", 100), reply("r1", "claude", 200)];
  const childMsgs = [
    { ...user("k1", "claude", 100), topicId: "child1", copiedFromMessageId: "u1" },
    { ...reply("k2", "claude", 200), topicId: "child1", copiedFromMessageId: "r1" },
    { ...user("k3", "claude", 900, "分岐後"), topicId: "child1" },
  ];
  const messages = [...parentMsgs, ...childMsgs];
  const gp = buildFlowGraph(input({ messages, topics }));
  assert.deepEqual(gp.branches, [
    { childTopicId: "child1", title: "三者会談＃分岐", atMessageId: "u1", anchorKey: "msg:u1" },
    { childTopicId: "child2", title: "三者会談＃分岐2", atMessageId: "r1", anchorKey: "msg:r1" },
  ]);
  assert.deepEqual(edgesOf(gp, "branch").map((e) => [e.from.nodeKey, e.to.mark, e.to.childTopicId]), [["msg:u1", "branch", "child1"], ["msg:r1", "branch", "child2"]]);
  assert.equal(gp.origin, null);
  assert.deepEqual(childBranches(topics, "child1"), []);
  const gc = buildFlowGraph(input({ topicId: "child1", messages, topics }));
  assert.deepEqual(gc.origin, { parentTopicId: T, parentMessageId: "u1", anchorKey: "msg:k1" });
  assert.equal(byKey(gc, "msg:k1").branchPoint, true);
  assert.equal(byKey(gc, "msg:u1"), undefined); // 親側の ID は子に無い（ID 同一の前提を置かない）
  assert.deepEqual(branchOrigin(topics, messages, "child1"), { parentTopicId: T, parentMessageId: "u1", copyMessageId: "k1" });
});

// 12. システム発言
test("システム発言: blocked / cancelled は system・err", () => {
  const msgs = [user("u1", "claude", 100), reply("r1", "claude", 200, "⛔ 登録先を確認できません", { blocked: true }), reply("r2", "codex", 300, "⏹ 応答をキャンセルしました", { cancelled: true })];
  const g = buildFlowGraph(input({ messages: msgs }));
  assert.deepEqual([byKey(g, "msg:r1").kind, byKey(g, "msg:r1").status, byKey(g, "msg:r1").reason], ["system", "err", "blocked"]);
  assert.deepEqual([byKey(g, "msg:r2").kind, byKey(g, "msg:r2").status, byKey(g, "msg:r2").reason], ["system", "err", "cancelled"]);
  assert.equal(edgesOf(g, "answer").length, 1); // codex 宛てが無いので r2 は orphan
});

// 13. 外部同期
test("外部同期: cli-sync は sync ノードになり、送信束の候補にならず、本文は保持される", () => {
  const msgs = [
    user("u1", "claude", 100),
    { ...reply("s1", "claude", 150, "ターミナルで続けた分"), provenance: direct("cli-sync", "manual") },
    { ...user("u2", "claude", 160, "外部で送った発言"), provenance: direct("cli-sync", "manual") },
    { ...user("u3", "codex", 161, "外部で送った発言"), provenance: direct("ui") },
  ];
  const g = buildFlowGraph(input({ messages: msgs }));
  const s = byKey(g, "msg:s1");
  assert.deepEqual([s.kind, s.status, s.text], ["sync", "ok", "ターミナルで続けた分"]);
  assert.equal(edgesOf(g, "answer").some((e) => e.to.nodeKey === "msg:s1"), true);
  // 外部同期のユーザー発言も sync ノード（SPEC ノード表: cli-sync はすべて sync。送信束の候補にしない）
  assert.deepEqual(g.nodes.filter((n) => n.kind === "send").map((n) => n.messageIds), [["u1"], ["u3"]]);
  const u2 = byKey(g, "msg:u2");
  assert.equal(u2 && u2.kind, "sync", "cli-sync のユーザー発言は sync ノード");
  assert.equal(u2.text, "外部で送った発言", "本文は保持される");
});

// 14. 折りたたみ
test("折りたたみ: 束 6 つで先頭と末尾 2 つが開き、中 3 つが folded。run を含む中間と分岐点を含む束は開く", () => {
  const msgs = [];
  for (let i = 1; i <= 6; i++) {
    msgs.push(user("u" + i, "claude", i * 100, "発言 " + i));
    msgs.push(reply("r" + i, "claude", i * 100 + 10));
  }
  const g = buildFlowGraph(input({ messages: msgs }));
  assert.deepEqual(g.episodes.map((e) => e.folded), [false, true, true, true, false, false]);
  const tasks = [{ id: "t1", agent: "grok", topicId: T, title: "調査", detail: "", status: "working", fromMessageId: "r3", result: "", ts: 315 }];
  const g2 = buildFlowGraph(input({ messages: msgs, tasks }));
  assert.deepEqual(g2.episodes.map((e) => e.folded), [false, true, false, true, false, false]);
  // 分岐先: 3 番目の束に分岐点
  const topics = [topic(), { ...topic({ id: "child" }), branchedFrom: { topicId: T, messageId: "orig" } }];
  const childMsgs = msgs.map((m) => ({ ...m, id: "k" + m.id, topicId: "child", ...(m.id === "u3" ? { copiedFromMessageId: "orig" } : {}) }));
  const g3 = buildFlowGraph(input({ topicId: "child", messages: childMsgs, topics }));
  assert.deepEqual(g3.episodes.map((e) => e.folded), [false, true, false, true, false, false]);
  assert.equal(byKey(g3, "msg:ku3").branchPoint, true);
  assert.deepEqual(foldPlan([{ key: "a" }, { key: "b" }, { key: "c" }], 1).map((e) => e.folded), [false, true, false]);
  // 実行中は末尾の束に置かれ、その束は開く
  const g4 = buildFlowGraph(input({ messages: msgs, running: { [T + ":codex"]: true, "other:claude": true } }));
  assert.deepEqual(g4.episodes[5].nodeKeys, ["msg:u6", "msg:r6", "run:codex"]);
  assert.equal(byKey(g4, "run:codex").status, "run");
  assert.equal(byKey(g4, "run:claude"), undefined);
});

// 15. 決定性・不変
test("決定性・不変: 同じ入力で JSON が一致し、Object.freeze した入力でも例外なし・入力は変わらない", () => {
  const msgs = [user("u1", "claude", 100), user("u2", "codex", 101), reply("r1", "claude", 200), reply("r2", "claude", 210), qaCopy("c1", "codex", "claude", "r2", "R1", 1, 0, 211)];
  const pool = [{ id: "p1", title: "a", file: "topics/topicA/a", origin: "claude", topicId: T, reviewers: ["codex"], status: "submitted", reviews: [], fromMessageId: "r1", ts: 300 }];
  const inp = deepFreeze(input({ messages: msgs.slice().reverse(), pool, running: { [T + ":grok"]: true } }));
  const snapshot = JSON.stringify(inp);
  const a = buildFlowGraph(inp), b = buildFlowGraph(inp);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(inp), snapshot);
  assert.deepEqual(a.nodes.map((n) => n.key), ["msg:u1", "msg:r1", "relay:R1", "art:p1", "run:grok"]);
  assert.deepEqual(membershipOf(a.nodes), { u1: "msg:u1", u2: "msg:u1", r1: "msg:r1", r2: "relay:R1" });
});

// 16. 壊れた入力
test("壊れた入力: provenance 欠落・無い topicId・無い source.messageId は例外にせず warnings に残す", () => {
  const msgs = [
    { id: "u1", topicId: T, thread: "claude", author: "user", text: "古い形", ts: 100 },
    { id: "r1", topicId: T, thread: "claude", author: "claude", text: "古い応答", ts: 200 },
    qaCopy("c1", "codex", "claude", "gone", "R1", 1, 0, 300),
    { ...reply("f1", "codex", 400), author: "claude", provenance: { ingress: "ui", delivery: "relay", trigger: "manual", source: { topicId: T, messageId: "gone2", agent: "claude" } } },
    { topicId: T, thread: "claude", author: "claude", text: "id なし", ts: 500 },
    null,
  ];
  assert.doesNotThrow(() => buildFlowGraph(input({ messages: msgs, topics: [] })));
  const g = buildFlowGraph(input({ messages: msgs, topics: [] }));
  assert.equal(byKey(g, "msg:u1").kind, "send");
  assert.equal(byKey(g, "msg:r1").kind, "reply");
  assert.equal(byKey(g, "relay:R1").hops[0].messageId, "gone");
  assert.ok(g.warnings.some((w) => w.includes("topics に")));
  assert.ok(g.warnings.some((w) => w.includes("provenance")));
  assert.ok(g.warnings.some((w) => w.includes("gone ")));
  assert.ok(g.warnings.some((w) => w.includes("gone2")));
  assert.ok(g.warnings.some((w) => w.includes("id の無い")));
  assert.deepEqual(buildFlowGraph(null).nodes, []);
  assert.deepEqual(buildFlowGraph({ messages: "x" }).warnings, ["topicId がありません"]);
});

// 17. 170 件
test("170 件: メッセージ 170・リレー 3・成果物 20 の導出が 50ms 未満（超過は diagnostic）", (t) => {
  const parts = ["claude", "codex", "grok"];
  const msgs = [];
  let ts = 1000, n = 0;
  const pool = [];
  for (let ep = 0; ep < 20; ep++) {
    for (const p of parts) msgs.push(user("u" + n++, p, ts++, "発言 " + ep));
    for (const p of parts) {
      const id = "r" + n++;
      msgs.push(reply(id, p, (ts += 5)));
      if (pool.length < 20) pool.push({ id: "p" + pool.length, title: id + ".md", file: "topics/topicA/" + id + ".md", origin: p, topicId: T, reviewers: parts.filter((x) => x !== p), status: "submitted", reviews: [{ id: "v", reviewer: "codex", verdict: "承認", ts: ts + 1 }], fromMessageId: id, ts: ts + 1 });
    }
  }
  for (let r = 0; r < 3; r++) {
    msgs.push(user("q" + r, "grok", (ts += 5), "質疑 " + r));
    for (let seq = 1; seq <= 5; seq++) {
      const agent = parts[(seq - 1) % 3];
      const id = "h" + r + "_" + seq;
      msgs.push(reply(id, agent, (ts += 5)));
      for (const to of parts.filter((x) => x !== agent)) msgs.push(qaCopy(id + to, to, agent, id, "R" + r, seq, (seq - 1) % 3, ts + 1));
    }
  }
  while (msgs.filter((m) => !m.provenance.source).length < 170) msgs.push(reply("x" + n++, "claude", (ts += 5)));
  const inp = input({ messages: msgs, pool });
  buildFlowGraph(inp); // ウォームアップ
  const t0 = performance.now();
  const g = buildFlowGraph(inp);
  const ms = performance.now() - t0;
  t.diagnostic(`buildFlowGraph: ${ms.toFixed(1)}ms, nodes=${g.nodes.length}, edges=${g.edges.length}, episodes=${g.episodes.length}`);
  if (ms >= 50) t.diagnostic("50ms を超えました（fail にはしない）");
  assert.equal(g.nodes.filter((n) => n.kind === "relay").length, 3);
  assert.equal(g.nodes.filter((n) => n.kind === "artifact").length, 20);
  assert.equal(g.warnings.length, 0);
});

// fixture（Codex の描画側が先行実装に使う入力→出力の組）
const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
function fixtureInputs() {
  const parts = ["claude", "codex", "grok"];
  const three = input({
    messages: [
      user("u1", "claude", 1000, "三者で相談したい"),
      user("u2", "codex", 1001, "三者で相談したい"),
      user("u3", "grok", 1002, "三者で相談したい"),
      reply("r1", "claude", 1100, "構造から見ると…"),
      reply("r2", "codex", 1150, "実装面では…"),
      reply("r3", "claude", 1200, "補足です"),
      user("q1", "grok", 2000, "今回決めること: 手狭の解決法"),
      reply("h1", "grok", 2100, "横断整理"),
      qaCopy("h1claude", "claude", "grok", "h1", "R1", 1, 0, 2101),
      qaCopy("h1codex", "codex", "grok", "h1", "R1", 1, 0, 2101),
      reply("h2", "claude", 2200, "根拠付きレビュー"),
      qaCopy("h2codex", "codex", "claude", "h2", "R1", 2, 1, 2201),
      qaCopy("h2grok", "grok", "claude", "h2", "R1", 2, 1, 2201),
      reply("h3", "codex", 2300, "実装案 【質疑終了】"),
      qaCopy("h3claude", "claude", "codex", "h3", "R1", 3, 2, 2301),
      qaCopy("h3grok", "grok", "codex", "h3", "R1", 3, 2, 2301),
      reply("late", "grok", 2400, "旧リレー宛ての応答", { staleRelayId: "R0" }),
      { ...reply("s1", "codex", 2500, "ターミナルで続けた分"), provenance: direct("cli-sync", "manual") },
      user("u4", "codex", 3000, "タスクにします"),
      reply("r4", "codex", 3100, "結果を戻します", { taskId: "t1" }),
      { ...reply("fw", "grok", 3150, "実装面では…"), author: "codex", provenance: { ingress: "ui", delivery: "relay", trigger: "manual", source: { topicId: T, messageId: "r2", agent: "codex" } } },
    ],
    pool: [
      { id: "p1", title: "合意メモ.md", file: "topics/topicA/合意メモ.md", origin: "claude", topicId: T, reviewers: ["codex", "grok"], status: "submitted", reviews: [{ id: "v1", reviewer: "codex", text: "【判定】承認", verdict: "承認", ts: 1300 }], fromMessageId: "r3", ts: 1250 },
      { id: "p2", title: "hello.md", file: "topics/topicA/hello.md", origin: "grok", topicId: T, reviewers: ["claude", "codex"], status: "submitted", reviews: [], fromMessageId: null, ts: 2050 },
    ],
    tasks: [{ id: "t1", agent: "codex", topicId: T, title: "手動拡幅の実装", detail: "", status: "returned", fromMessageId: "r2", result: "結果を戻します", ts: 1160 }],
    topics: [
      topic({ relay: { active: false, id: "R1", participants: parts, turn: 0, seq: 3, stopReason: "agreed", startMessageId: "q1" } }),
      { ...topic({ id: "childA", title: "三者会談＃分岐" }), branchedFrom: { topicId: T, messageId: "r2" } },
    ],
    running: { [T + ":grok"]: true },
    reviewPending: { p2: ["claude"] },
  });
  const child = input({
    topicId: "childA",
    messages: [
      { ...user("k1", "claude", 1000, "三者で相談したい"), topicId: "childA", copiedFromMessageId: "u1" },
      { ...user("k2", "codex", 1001, "三者で相談したい"), topicId: "childA", copiedFromMessageId: "u2" },
      { ...reply("k3", "claude", 1100, "構造から見ると…"), topicId: "childA", copiedFromMessageId: "r1" },
      { ...reply("k4", "codex", 1150, "実装面では…"), topicId: "childA", copiedFromMessageId: "r2" },
      { ...user("k5", "codex", 5000, "分岐後の発言"), topicId: "childA" },
      { ...reply("k6", "codex", 5100, "分岐後の応答"), topicId: "childA" },
    ],
    topics: three.topics,
  });
  return { "flow-3agents": three, "flow-branch-child": child };
}

for (const [name, inp] of Object.entries(fixtureInputs())) {
  test("fixture: " + name + ".json の expected と一致", () => {
    const file = path.join(FIXTURE_DIR, name + ".json");
    const actual = buildFlowGraph(inp);
    if (process.env.FLOW_FIXTURES_UPDATE) {
      fs.mkdirSync(FIXTURE_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ name, input: inp, expected: actual }, null, 2) + "\n");
    }
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(saved.input, JSON.parse(JSON.stringify(inp)));
    assert.deepEqual(actual, saved.expected);
  });
}
