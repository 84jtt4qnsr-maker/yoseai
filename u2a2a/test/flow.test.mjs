import * as Usage from "../public/usage.js";
// フロービューのグラフ導出（SPEC-フロービュー.md「テスト」1〜17 ＋ fixture スナップショット）。jsdom 不要
// fixture の更新: FLOW_FIXTURES_UPDATE=1 node --test test/flow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
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

// 実寸法・CSS・ブラウザ描画は別途受け入れ確認が必要。SSE相当の再描画は実関数を実行する。
test("flow UI: filters, column jump and repeated redraw", () => {
  const source = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "flow-3agents.json"), "utf8")).input;
// 表示ロジック用の小さなDOM代替。CSSレイアウトやブラウザ描画の検証ではない。
class Element {
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.parentElement=null;this.attrs={};this.dataset={};this.listeners={};this._text='';this.hidden=false;this.disabled=false;this.value='';this._top=0;this.scrollHeight=2500;this.clientHeight=500;this.scrollWidth=1000;this.style={setProperty:(k,v)=>this.style[k]=v,getPropertyValue:k=>this.style[k]||''};this.classList={contains:c=>this.classes.includes(c),add:(...cs)=>this.setAttribute('class',[...new Set([...this.classes,...cs])].join(' ')),remove:(...cs)=>this.setAttribute('class',this.classes.filter(c=>!cs.includes(c)).join(' ')),toggle:(c,b)=>{const yes=b??!this.classes.includes(c);yes?this.classList.add(c):this.classList.remove(c);return yes;}};}
 get isConnected(){for(let n=this;n;n=n.parentElement)if(n===body)return true;return false;}
 get classes(){return (this.attrs.class||'').split(/\s+/).filter(Boolean);}
 get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
 set textContent(v){this.textWrites=(this.textWrites||0)+1;this.replaceChildren();this._text=String(v??'');}
 set innerHTML(v){this.textContent=v;}
 get innerHTML(){return this.textContent;}
 get scrollTop(){return this._top;}
 set scrollTop(v){this._top=Math.max(0,Math.min(v,Math.max(0,this.scrollHeight-this.clientHeight)));}
 setAttribute(k,v){this.attrs[k]=String(v);if(k==='hidden')this.hidden=true;if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v);}
 getAttribute(k){return k in this.attrs?this.attrs[k]:null;}
 removeAttribute(k){delete this.attrs[k];if(k==='hidden')this.hidden=false;}
 appendChild(c){c.remove();c.parentElement=this;this.children.push(c);return c;}
 insertBefore(c,ref){c.remove();c.parentElement=this;const i=this.children.indexOf(ref);this.children.splice(i<0?this.children.length:i,0,c);return c;}
 replaceChildren(...cs){for(const c of this.children)c.parentElement=null;this.children=[];this._top=0;this._text='';cs.forEach(c=>this.appendChild(c));}
 remove(){if(this.parentElement){const p=this.parentElement;p.children=p.children.filter(c=>c!==this);this.parentElement=null;}}
 addEventListener(type,fn){if(!this.listeners[type])this.listeners[type]=[];this.listeners[type].push(fn);}
 dispatch(type,event={}){const e={target:this,stopPropagation(){},preventDefault(){},...event};this['on'+type]?.(e);for(const fn of this.listeners[type]||[])fn(e);}
 click(){if(!this.disabled)this.dispatch('click');}
 focus(){this.focused=true;context.document.activeElement=this;}
 scrollIntoView(){this.scrolledIntoView=true;if(this.parentElement?.classes.includes("messages"))this.parentElement.scrollTop=700;}
 matches(selector){
  selector=selector.trim();const nots=[...selector.matchAll(/:not\(([^)]+)\)/g)];if(nots.some(m=>this.matches(m[1])))return false;selector=selector.replace(/:not\([^)]+\)/g,'');
  for(const m of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)){const v=m[1].startsWith('data-')?this.dataset[m[1].slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]:this.attrs[m[1]];if(m[2]!==undefined?v!==m[2]:v===undefined)return false;}
  selector=selector.replace(/\[[^\]]+\]/g,'');const id=selector.match(/#([\w-]+)/);if(id&&this.attrs.id!==id[1])return false;
  if([...selector.matchAll(/\.([\w-]+)/g)].some(m=>!this.classes.includes(m[1])))return false;
  const tag=selector.match(/^[a-zA-Z][\w-]*/);return !tag||this.tagName===tag[0].toUpperCase();
 }
 querySelectorAll(selector){
  const all=[];const visit=n=>{for(const c of n.children){all.push(c);visit(c);}};visit(this);
  const matches=(n,s)=>{s=s.trim();const direct=s.lastIndexOf(' > ');if(direct>=0)return n.matches(s.slice(direct+3))&&!!n.parentElement&&matches(n.parentElement,s.slice(0,direct));const space=s.lastIndexOf(' ');if(space>=0){if(!n.matches(s.slice(space+1)))return false;for(let p=n.parentElement;p;p=p.parentElement)if(matches(p,s.slice(0,space)))return true;return false;}return n.matches(s);};
  return all.filter(n=>selector.split(',').some(s=>matches(n,s)));
 }
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
 getClientRects(){for(let n=this;n;n=n.parentElement)if(n.hidden)return [];return [this.getBoundingClientRect()];}
 getBoundingClientRect(){return {top:20,bottom:420,left:20,right:320,width:300,height:400};}
}
const body=new Element('body');
const make=(tag,attrs={},children=[])=>{const n=new Element(tag);for(const[k,v]of Object.entries(attrs)){if(k==='text')n.textContent=v;else if(k.startsWith('on'))n.addEventListener(k.slice(2),v);else n.setAttribute(k,v);}children.forEach(c=>n.appendChild(c));return n;};
const main=make('main');body.appendChild(main);
const zone=make('section',{id:'flow-zone',hidden:''}),canvas=make('div',{id:'flow-canvas'});zone.appendChild(canvas);main.appendChild(zone);
for(const id of ['flow-links','flow-empty','flow-warnings','flow-episodes'])canvas.appendChild(make(id==='flow-links'?'svg':'div',{id}));
body.querySelector('#flow-warnings').appendChild(make('summary'));body.querySelector('#flow-warnings').appendChild(make('div',{class:'flow-text'}));
main.appendChild(make('button',{id:'flow-new',hidden:''}));
for(const id of ['flow-filter-agent','flow-filter-kind','flow-filter-status','flow-filter-reset','flow-filter-count','flow-zoom-in','flow-zoom-out','flow-zoom-reset'])zone.appendChild(make(id.includes('reset')||id.includes('zoom')?'button':id.includes('count')?'span':'select',{id}));
for(const id of ['topic-bar','pool-dialog','pool-search'])body.appendChild(make('div',{id}));
const messagesBoxes=new Map();
for(const agent of ['claude','codex','grok']){const col=make('section',{class:'thread-col','data-agent':agent});const box=make('div',{class:'messages',id:'messages-'+agent});col.appendChild(box);col.appendChild(make('span',{id:'count-'+agent}));main.appendChild(col);messagesBoxes.set(agent,box);}
const timers=[];let now=1000;const raf=[];let currentId=fixture.topicId,poolRenders=0,threadRebuilds=0;
const events=new Map();const win={Usage,addEventListener:(name,fn)=>events.set(name,fn),dispatchEvent:e=>events.get(e.type)?.(e)};
const U2AAvatarStub={badge:(a)=>{const n=make('span',{class:'role-dot'});n.dataset={agent:a};return n;},Controller:class{constructor(){this.context=null;}update(c){this.context=c;}measure(){}paint(){}setVisible(){}}};
const context=vm.createContext({console,U2AAvatar:U2AAvatarStub,Map,Set,JSON,Math,Error,Element,Date:{now:()=>now},state:fixture,window:win,document:{body,getElementById:id=>body.querySelector('#'+id),querySelector:s=>body.querySelector(s),querySelectorAll:s=>body.querySelectorAll(s),createElementNS:(_,tag)=>make(tag),createTextNode:text=>make('span',{text:String(text)})},
 el:make,$:s=>body.querySelector(s),NAMES:{claude:'Claude Code',codex:'Codex',grok:'Grok',user:'ユーザー'},STATUS_LABEL:{queued:'キュー'},STOP_LABELS:{agreed:'合意成立'},
 currentTopic:()=>fixture.topics.find(t=>t.id===currentId),participantsOf:t=>(t||fixture.topics.find(t=>t.id===currentId))?.participants||['claude','codex'],agentIds:()=>['claude','codex','grok'],
 columnTopic:fixture.topicId,foldedColumns:new Map(),narrowColumnLayout:{matches:false},
 requestAnimationFrame:fn=>{raf.push(fn);return raf.length;},cancelAnimationFrame:()=>{},setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},
 ensureTopic(){},syncAgentDefinitions(){},ensureAgentColumns(){context.columnTopic=currentId;for(const col of main.querySelectorAll(".thread-col"))col.classList.toggle("is-folded",!!context.foldedColumns.get(currentId)?.has(col.dataset.agent));},syncSendTargets(){},renderAuthControls(){},syncAgentAction(){},syncPoolReviewers(){},renderTopicBar(){body.querySelector('#topic-bar').replaceChildren();},renderProjectUI(){},renderTasks(){},renderAgentStatus(){},renderQaBar(){},renderBudgetBar(){},renderUsage(){},renderHealth(){},renderPool(){poolRenders++;},scheduleLinks(){},
 toast:text=>context.lastToast=text,rawView:new Set(),expandedRelays:new Set(),mediaFailed:new Set(),provOf:m=>m.provenance||{},isRelayCopy:m=>!!m.provenance?.source,fmtTime:()=>'',renderMarkdown:text=>text,metaEl:()=>make('div'),isRunning:()=>false,
 poolSelectedId:null,poolCurrentDir:'',poolFocus:null,togglePool:collapse=>body.classList.toggle('pool-collapsed',collapse),
 chooseDestination(){},openTaskDialog(){},openPoolDialog(){},copy(){},ctxItems:()=>[],openCtxMenu(){},
 switchTopic:id=>{currentId=id;context.render();},
});
function extract(name){const match=source.match(new RegExp('^function '+name+'\\([^]*?^}', 'm'));assert.ok(match,name);return match[0];}
vm.runInContext(['messageEl','renderThread','captureThreadBottoms','restoreThreadBottoms','metaText','fmtTok','fmtElapsed','metaEl','taskEl','threadActivity'].map(extract).join('\n'),context);
const originalRenderThread=context.renderThread;context.renderThread=(...args)=>{threadRebuilds++;return originalRenderThread(...args);};
vm.runInContext(source.slice(source.indexOf('const viewModes ='),source.indexOf('// ---- render ----'))+'\n'+extract('render'),context);
const run=s=>vm.runInContext(s,context);const flush=()=>{const jobs=raf.splice(0);jobs.forEach(fn=>fn());};
const checks=[];
const check=(name,condition)=>{assert.ok(condition,name);checks.push(name);};
const cards=()=>run('flowCards');
const graph=()=>run('flowGraph');
const findKind=kind=>graph().nodes.find(n=>n.kind===kind);
const nodeCard=node=>cards().get(node.key);
const filter=(agent='',kind='',status='')=>{body.querySelector('#flow-filter-agent').value=agent;body.querySelector('#flow-filter-kind').value=kind;body.querySelector('#flow-filter-status').value=status;context.changeFlowFilter();flush();};
const visible=()=>[...cards().values()].filter(c=>!c._flowParts.slot.hidden);
const stateBefore=JSON.stringify(fixture);
context.render();check('module未ロード時は列を利用可能',run('displayedView')==='columns');
win.FlowGraph={buildFlowGraph};win.dispatchEvent({type:'flowgraph-ready'});flush();
check('実グラフ導出と描画を結合し3名既定フロー',run('displayedView')==='flow'&&cards().size===graph().nodes.length);
check('未絞り込み時の起点列を従来どおり保持', [...run('flowEpisodes').values()].every(e=>!e._flowParts.origin.hidden));
check('meta欠落・配送コピーを集計しない', context.flowMetaSummary([{id:'no-meta'},{id:'copy',meta:{costUsd:1},provenance:{source:{messageId:'original'}}}]).length===0);
const graphBefore=JSON.stringify(graph());
const countNode=body.querySelector('#flow-filter-count'), countWrites=countNode.textWrites;
context.render();context.render();
check('同じ件数のlive領域を書き換えない',countNode.textWrites===countWrites);
const realMessagesFor=context.flowMessagesFor;let messageScans=0;
context.flowMessagesFor=(...args)=>{messageScans++;return realMessagesFor(...args);};
context.render();
check('未設定フィルタは本文走査を増やさない',messageScans===graph().nodes.length);
context.flowMessagesFor=realMessagesFor;
filter('codex');
check('宛先codexの送信起点も残す',graph().nodes.filter(n=>n.kind==='send'&&(n.lanes||[]).includes('codex')).every(n=>!nodeCard(n)._flowParts.slot.hidden));
for(const kind of ['pending','artifact','relay','task']) {
 check('実行中の'+kind+'を状態で抽出',context.matchesFlowFilter({kind,status:'run'},{status:'run'}));
 check('停止中の'+kind+'を実行中から除外',!context.matchesFlowFilter({kind,status:'ok'},{status:'run'}));
}
filter('','','run');
check('状態セレクトはrunカードを表示',visible().length===graph().nodes.filter(n=>n.status==='run'||n.active).length);
filter('user','task');zone.scrollHeight=zone.clientHeight;
const extra={id:'new-filtered',topicId:fixture.topicId,thread:'codex',author:'codex',text:'new',ts:999999};
fixture.messages.push(extra);context.render();flush();
check('短い絞り込み結果で空振り新着ボタンを出さない',body.querySelector('#flow-new').hidden&&!run('flowStateFor(currentTopic().id).unseen'));
fixture.messages.pop();zone.scrollHeight=2500;filter();context.render();

filter('','artifact');
check('成果物だけ表示しグラフを変更しない',visible().length>0&&visible().every(c=>c.dataset.key.startsWith('art:'))&&JSON.stringify(graph())===graphBefore);
check('非該当の束を非表示', [...run('flowEpisodes').values()].some(e=>e.hidden));
filter('codex','artifact');
check('担当と種別はAND条件',visible().every(c=>graph().nodes.find(n=>n.key===c.dataset.key).origin==='codex'));
filter('user','task');check('0件表示と解除導線',visible().length===0&&!body.querySelector('#flow-empty').hidden&&!body.querySelector('#flow-filter-reset').disabled);
body.querySelector('#flow-filter-reset').click();flush();
check('解除ですべてのカードを復元',visible().length===graph().nodes.length&&body.querySelector('#flow-filter-reset').disabled);
filter('grok','relay');
check('複合リレーは参加者で一致し全手番を保持',visible().length>0&&visible().every(c=>graph().nodes.find(n=>n.key===c.dataset.key).kind==='relay'));
const relay=findKind('relay');const relayCount=context.flowMessagesFor(relay).length;
nodeCard(relay)._flowParts.toggle.click();
check('フィルタ中も複合カードの全文を保持',nodeCard(relay)._flowParts.detail.querySelectorAll('.flow-message').length===relayCount);
context.setViewMode('columns');context.setViewMode('flow');
check('列往復でフィルタ記憶',body.querySelector('#flow-filter-agent').value==='grok'&&body.querySelector('#flow-filter-kind').value==='relay');
filter();
// 元応答に後着したmetaだけが変わるケース。表示関数も本体から抽出した実装。
const reply=graph().nodes.find(n=>n.kind==='replies')||findKind('reply');
const sourceMessages=context.flowMessagesFor(reply);const originalMeta=sourceMessages.map(m=>m.meta);
sourceMessages[0].meta={durationMs:1234,usage:{inTok:1200,outTok:80},billing:{mode:'metered',usd:0.0123},status:'completed'};
context.render();
const replyCard=nodeCard(reply);
check('折りたたみメタは既存表記の時間・使用量・費用',replyCard._flowParts.meta.textContent.includes('1.2k')&&replyCard._flowParts.meta.textContent.includes('$0.0123')&&!replyCard._flowParts.meta.hidden);
sourceMessages[0].meta.billing.usd=0.0456;context.render();
check('タイトル不変のmeta更新を反映',replyCard._flowParts.meta.textContent.includes('$0.0456'));
sourceMessages[0].meta.billing={mode:'unknown'};context.render();
check('費用不明を0円にしない',replyCard._flowParts.meta.textContent.includes('費用不明')&&!replyCard._flowParts.meta.textContent.includes('$0.0000'));
check('欠測トークンを0表示にしない',context.fmtTok(null)==='不明'&&context.fmtTok(0)==='0');
check('合計は同じフォーマッタで桁区切り',context.fmtTok(35900000,{exact:true})==='35,900,000'&&context.fmtElapsed(18360000,{total:true})==='5時間 6分');
check('取消の仮0はフッタでも不明',context.metaText({status:'cancelled',usage:{inTok:0,outTok:0},billing:{mode:'unknown'}}).includes('in 不明 / out 不明'));

replyCard._flowParts.toggle.click();
check('本文展開中は要約を隠す',replyCard._flowParts.meta.hidden);
check('列で開くは既存actions行に配置',replyCard._flowParts.detail.querySelectorAll('.flow-open-column').every(b=>b.parentElement.classes.includes('actions')));
check('各元発言に列で開くを設置',replyCard._flowParts.detail.querySelectorAll('.flow-open-column').length===sourceMessages.length);
const selected=sourceMessages[sourceMessages.length-1];
context.foldedColumns.set(fixture.topicId,new Set([selected.thread]));
replyCard._flowParts.detail.querySelectorAll('.flow-open-column').at(-1).click();
const target=messagesBoxes.get(selected.thread).querySelectorAll('.msg').find(n=>n.dataset.mid===selected.id);
check('複合カード内の選択発言へ列ジャンプ・強調・フォーカス',run('displayedView')==='columns'&&target?.scrolledIntoView&&target.focused&&target.classList.contains('flow-highlight'));
check('対象列の折りたたみ解除',!context.foldedColumns.get(fixture.topicId).has(selected.thread));
check('列ジャンプ後の位置を保存',run('columnScrollStates').get(fixture.topicId)?.has(selected.thread));
const selectedBox=messagesBoxes.get(selected.thread);
check('ジャンプで実際に中間位置へ移動',selectedBox.scrollTop===700);
for(let update=0;update<3;update++) {
 context.render();
 const current=selectedBox.querySelectorAll('.msg').find(n=>n.dataset.mid===selected.id);
 check('SSE相当の再描画'+update+'後も位置・強調・フォーカスを保持',selectedBox.scrollTop===700&&current!==target&&current.classList.contains('flow-highlight')&&context.document.activeElement===current);
}
selectedBox.scrollTop=900;context.render();
check('ジャンプ後の手動スクロールを巻き戻さない',selectedBox.scrollTop===900);
now+=2100;timers.at(-1)();context.render();
check('再生成された発言の強調も期限切れで解除',!selectedBox.querySelectorAll('.msg').some(n=>n.classList.contains('flow-highlight'))&&selectedBox.scrollTop===900);

context.openFlowMessageInColumn('missing');check('消えた発言は理由を表示',context.lastToast==='元の発言が見つかりません');
context.setViewMode('flow');
filter('user','send');const send=findKind('send');const sendCard=nodeCard(send);sendCard._flowParts.toggle.click();
const userMessages=context.flowMessagesFor(send);
check('送信束の各レーンを選択可能',sendCard._flowParts.detail.querySelectorAll('.flow-open-column').length===userMessages.length);
filter('','task');
check('種別で隠した展開本文も消える',!replyCard._flowParts.detail.isConnected&&!sendCard._flowParts.detail.isConnected);
// 隠れたカードを端点にする接続線を描かない。
for(const ep of graph().episodes)run('flowStateFor(currentTopic().id).episodes').set(ep.key,true);
context.refreshFlowDetails(fixture.topicId);flush();
const expectedTaskEdges=graph().edges.filter(e=>e.from?.nodeKey?.startsWith('task:')&&e.to?.nodeKey?.startsWith('task:'));
check('非表示ノードへの線を描かない',expectedTaskEdges.length===0&&body.querySelector('#flow-links').children.length===0);
run('flowJump = { topicId: currentTopic().id, messageId: "r1" }');
context.render();flush();
check('分岐対象ジャンプ時はフィルタ解除し対象を表示',body.querySelector('#flow-filter-kind').value===''&&nodeCard(reply).scrolledIntoView);
filter('','task');
const remembered=run('flowStateFor(currentTopic().id).filters');
const other={id:'legacy',participants:['claude','codex']};fixture.topics.push(other);context.switchTopic('legacy');
check('2名既定の列を維持',run('displayedView')==='columns');context.setViewMode('flow');
check('別トピックのフィルタは独立',body.querySelector('#flow-filter-kind').value==='');
context.switchTopic(fixture.topicId);check('元トピックのフィルタを復元',body.querySelector('#flow-filter-kind').value===remembered.kind);
fixture.topics.pop();sourceMessages.forEach((m,i)=>{if(originalMeta[i]===undefined)delete m.meta;else m.meta=originalMeta[i];});
check('表示操作は永続stateを変更しない',JSON.stringify(fixture)===stateBefore);

// 検索も既存の列DOM代替で検証する。実ブラウザのdialog/CSS検証とは別。
context.Date = class extends Date { static now() { return now; } };
const searchNodes = new Map();
for (const [id, tag] of [['dialog','dialog'],['input','input'],['results','ul'],['count','p'],['more','button'],['close','button'],['form','form']]) {
  const node = make(tag, { id: 'message-search-' + id }); body.appendChild(node); searchNodes.set(id, node);
}
const dialog = searchNodes.get('dialog'), searchInput = searchNodes.get('input'), results = searchNodes.get('results');
results.contains = node => { for (; node; node = node.parentElement) if (node === results) return true; return false; };
Object.defineProperty(results, 'lastElementChild', { get: () => results.children.at(-1) });
const closeJobs = [], closeListeners = [];
const addDialogListener = dialog.addEventListener.bind(dialog);
dialog.addEventListener = (type, fn, options) => type === 'close' ? closeListeners.push({ fn, once: options?.once }) : addDialogListener(type, fn);
dialog.showModal = () => { dialog.open = true; };
dialog.close = () => {
  dialog.open = false;
  // ブラウザの復帰をcloseイベントより前に模擬し、RAF前には列へfocusしないことを確認。
  run('messageSearchButton').focus();
  closeJobs.push(() => {
    for (const listener of [...closeListeners]) { if (listener.once) closeListeners.splice(closeListeners.indexOf(listener), 1); listener.fn(); }
  });
};
const searchTimers = new Map(); let searchTimerId = 0;
context.setTimeout = fn => { searchTimers.set(++searchTimerId, fn); return searchTimerId; };
context.clearTimeout = id => searchTimers.delete(id);
const flushSearchTimers = () => { const jobs = [...searchTimers.values()]; searchTimers.clear(); jobs.forEach(fn => fn()); };
vm.runInContext(source.slice(source.indexOf('// ---- トピック横断の発言検索'), source.indexOf('// ---- 保存済み使用量の内訳')), context);
const searchTopic = { id: 'search-topic', title: '<script>search</script>', participants: ['claude','codex','grok'] };
fixture.topics.push(searchTopic);
for (let i = 0; i < 55; i++) fixture.messages.push({ id: 'search-' + i, topicId: searchTopic.id, thread: 'claude', author: 'claude', text: 'needle <img onerror=evil()> ' + i, ts: i + 1 });
searchInput.value = 'needle'; context.openMessageSearch();
check('検索50件・総数表示', results.children.length === 50 && searchNodes.get('count').textContent.includes('55件'));
check('抜粋一致箇所をtextのmarkで強調', results.querySelector('mark').textContent === 'needle' && !results.querySelector('img') && !results.querySelector('script'));
const stableRow = results.children[0]; stableRow.querySelector('button').focus();
context.noteMessageSearchUpdate(); context.render();
check('SSE通知で結果行・フォーカスを変えない', results.children[0] === stableRow && context.document.activeElement === stableRow.querySelector('button') && searchNodes.get('count').textContent.includes('データ更新あり'));
searchNodes.get('more').click();
check('更新通知後のページングは検索スナップショットを維持', results.children.length === 55 && searchNodes.get('count').textContent.includes('データ更新あり'));
searchInput.focus(); dialog.dispatch('keydown', { key: 'ArrowDown' });
check('入力から下矢印で結果へ', context.document.activeElement === results.children[0].querySelector('button'));
dialog.dispatch('keydown', { key: 'ArrowDown' });
check('下矢印で次の結果へ', context.document.activeElement === results.children[1].querySelector('button'));
searchInput.dispatch('compositionstart'); searchInput.value = 'missing';
searchInput.dispatch('input', { isComposing: true }); context.noteMessageSearchUpdate();
searchNodes.get('form').dispatch('submit');
check('IME中はSSE・submitでも再検索しない', results.children.length === 55 && searchTimers.size === 0);
searchInput.dispatch('compositionend');
check('変換終了後もデバウンス待ち', results.children.length === 55 && searchTimers.size === 1);
searchInput.value = 'needle'; searchInput.dispatch('input');
check('連続入力のタイマーを置き換える', searchTimers.size === 1);
flushSearchTimers();
check('再検索で更新通知を解消', !searchNodes.get('count').textContent.includes('データ更新あり'));
context.foldedColumns.set(searchTopic.id, new Set(['claude']));
const priorId = context.currentTopic().id, priorView = run('displayedView');
const actualGetElementById = context.document.getElementById;
context.document.getElementById = id => id === 'messages-claude' ? null : actualGetElementById(id);
context.openMessageSearchHit(searchTopic.id, 'search-54');
check('描画失敗は検索を残し元トピック・モードへ戻る', dialog.open && context.currentTopic().id === priorId && run('displayedView') === priorView && !run('viewModes').has(searchTopic.id));
check('描画失敗で折りたたみと展開状態を復元', context.foldedColumns.get(searchTopic.id).has('claude') && !context.expandedRelays.has('search-54'));
context.document.getElementById = actualGetElementById;
context.openMessageSearchHit(searchTopic.id, 'search-54');
check('検索成功後にcloseしネイティブのフォーカス復帰を待つ', !dialog.open && context.document.activeElement === run('messageSearchButton'));
context.render(); // close待ちに列ノードが再作成されるケース
closeJobs.shift()(); flush();
const searchTarget = messagesBoxes.get('claude').querySelectorAll('.msg').find(node => node.dataset.mid === 'search-54');
check('close後の最新DOMへフォーカス・スクロール・2秒強調', context.document.activeElement === searchTarget && searchTarget.scrolledIntoView && searchTarget.classList.contains('flow-highlight') && run('flowColumnJump.until') === now + 2000);
context.openMessageSearch(); context.openMessageSearchHit('missing-topic', 'missing');
check('消えた結果は検索ダイアログを閉じない', dialog.open);
context.switchTopic(priorId); context.openMessageSearchHit(searchTopic.id, 'search-54');
fixture.messages = fixture.messages.filter(m => m.id !== 'search-54');
context.render(); closeJobs.shift()(); flush();
check('close待ちに対象が削除された場合も元トピックへ戻して検索を再表示', dialog.open && context.currentTopic().id === priorId);
});


test("発言検索: 旧中継・配送チェーン・分岐境界・孤児を保持する", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const sandbox = vm.createContext({});
  for (const name of ["legacyRelaySource", "searchMessageHits", "messageSearchExcerpt"]) {
    const fn = html.match(new RegExp("^function " + name + "\\([^]*?^}", "m"));
    assert.ok(fn, name); vm.runInContext(fn[0], sandbox);
  }
  const topics = [{ id: "a" }, { id: "b" }];
  const root = { id: "root", topicId: "a", thread: "claude", author: "claude", text: "needle <script> [.*]", ts: 1 };
  const copy = (id, messageId, delivery = "qa-relay", extra = {}) => ({ ...root, id, thread: "codex", ts: 2,
    provenance: { delivery, source: { messageId, agent: "claude" } }, ...extra });
  const messages = [root, copy("legacy", null), copy("relay", "legacy", "relay"), copy("handoff", "relay", "handoff"),
    copy("branch", "root", "qa-relay", { topicId: "b", copiedFromMessageId: "legacy" }),
    copy("orphan", "missing"), copy("cycle-a", "cycle-b"), copy("cycle-b", "cycle-a"),
    { ...root, id: "independent" }, copy("unknown-agent", null, "qa-relay", { provenance: { delivery: "qa-relay", source: { messageId: null } } }),
    copy("other-topic", null, "qa-relay", { topicId: "b" }),
    copy("deleted-topic", "root", "relay", { topicId: "deleted" })];
  deepFreeze(messages); deepFreeze(topics);
  const before = JSON.stringify(messages);
  const hits = sandbox.searchMessageHits(messages, topics, " NEEDLE ");
  assert.equal(hits.find(hit => hit.message.id === "root").copies, 3);
  for (const id of ["branch", "independent", "other-topic"]) assert.ok(hits.some(hit => hit.message.id === id), id);
  assert.equal(hits.find(hit => hit.message.id === "branch").topic.id, "b");
  assert.equal(hits.find(hit => hit.message.id === "branch").unresolved, false);
  for (const id of ["orphan", "cycle-a", "cycle-b", "unknown-agent"]) assert.equal(hits.find(hit => hit.message.id === id).unresolved, true, id);
  assert.equal(hits.some(hit => hit.message.id === "deleted-topic"), false);
  assert.equal(sandbox.searchMessageHits(messages, topics, "  ").length, 0);
  assert.equal(sandbox.searchMessageHits(messages, topics, "[.*]").length, hits.length);
  assert.equal(JSON.stringify(messages), before);
  const excerpt = sandbox.messageSearchExcerpt("İ prefix NEEDLE suffix", "needle");
  assert.equal(excerpt.match, "NEEDLE");
  assert.equal(excerpt.before + excerpt.match + excerpt.after, "İ prefix NEEDLE suffix");
  assert.equal(sandbox.messageSearchExcerpt("İ", "i").match, "İ");
  assert.equal(sandbox.legacyRelaySource(copy("future", null, "relay", { ts: 0 }), [root]), null);
  assert.equal(sandbox.legacyRelaySource(copy("wrong-author", null, "relay", { author: "grok" }), [root]), null);
  assert.equal(sandbox.legacyRelaySource(copy("wrong-text", null, "relay", { text: "different" }), [root]), null);
  for (const delivery of ["qa-relay", "relay", "handoff"]) {
    const branch = copy("branch-" + delivery, "root", delivery, { topicId: "b", copiedFromMessageId: "old" });
    assert.equal(sandbox.searchMessageHits([root, branch], topics, "needle").length, 2);
  }
});
