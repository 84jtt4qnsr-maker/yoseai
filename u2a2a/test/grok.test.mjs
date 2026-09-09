// Grok 参戦（多者構成）— lib.mjs の純関数テスト（仕様: SPEC-Grok参戦.md）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_DEFS,
  LEGACY_AGENTS,
  RELAY_STOP_REASONS,
  peersOf,
  defaultReviewers,
  nextTurn,
  canEndRelay,
  clipBacklog,
  dedupeRelayCopies,
  parseGrokStream,
  grokStepFrom,
  grokMetaFrom,
  isGrokUnauthedError,
} from "../lib.mjs";

test("AGENT_DEFS: 3 エージェントの定義と旧 2 名", () => {
  assert.deepEqual(Object.keys(AGENT_DEFS), ["claude", "codex", "grok"]);
  assert.equal(AGENT_DEFS.grok.name, "Grok");
  assert.equal(AGENT_DEFS.grok.color, "#b99aff");
  assert.deepEqual(LEGACY_AGENTS, ["claude", "codex"]);
  assert.ok(RELAY_STOP_REASONS.includes("agreed") && RELAY_STOP_REASONS.includes("unauthed"));
});

test("peersOf / defaultReviewers: 作者以外の参加者、ユーザー作者は全員、参加者なしは旧 2 名", () => {
  assert.deepEqual(peersOf(["claude", "grok", "codex"], "grok"), ["claude", "codex"]);
  assert.deepEqual(peersOf(["claude", "codex"], "claude"), ["codex"]);
  assert.deepEqual(defaultReviewers(["claude", "codex", "grok"], "codex"), ["claude", "grok"]);
  assert.deepEqual(defaultReviewers(["claude", "codex", "grok"], "user"), ["claude", "codex", "grok"]);
  assert.deepEqual(defaultReviewers([], "claude"), ["codex"]);
  assert.deepEqual(defaultReviewers(null, "user"), ["claude", "codex"]);
});

test("nextTurn / canEndRelay: 手番の循環と全員発言後のみ有効な終了宣言", () => {
  const relay = { participants: ["claude", "grok", "codex"], turn: 2, spoken: { claude: 1, grok: 0, codex: 1 } };
  assert.equal(nextTurn(relay), 0);
  assert.equal(nextTurn({ participants: ["a", "b"], turn: 0 }), 1);
  assert.equal(nextTurn({ participants: [], turn: 0 }), 0);
  assert.equal(canEndRelay(relay, "合意です【質疑終了】", "【質疑終了】"), false, "grok が未発言");
  relay.spoken.grok = 1;
  assert.equal(canEndRelay(relay, "合意です【質疑終了】", "【質疑終了】"), true);
  assert.equal(canEndRelay(relay, "まだ議論中", "【質疑終了】"), false);
  assert.equal(canEndRelay({ participants: ["claude", "codex"], spoken: { claude: 1 } }, "【質疑終了】", "【質疑終了】"), false, "2 名でも相手未発言なら無効");
});

test("clipBacklog / dedupeRelayCopies: 切り詰め件数と relayId+seq の重複排除（turn は 2 周目で重複しない）", () => {
  const msgs = Array.from({ length: 12 }, (_, i) => ({ id: "m" + i }));
  const c = clipBacklog(msgs, 10);
  assert.equal(c.dropped, 2);
  assert.deepEqual(c.msgs.map((m) => m.id), msgs.slice(2).map((m) => m.id));
  assert.deepEqual(clipBacklog(msgs.slice(0, 3), 10), { msgs: msgs.slice(0, 3), dropped: 0 });
  const copy = (seq, turn) => ({ id: "c" + seq + "-" + turn, provenance: { delivery: "qa-relay", source: { relayId: "r1", seq, turn } } });
  const plain = { id: "p", provenance: { delivery: "direct", source: null } };
  const out = dedupeRelayCopies([copy(1, 0), copy(1, 0), plain, copy(2, 1), copy(4, 0)]);
  assert.deepEqual(out.map((m) => m.id), ["c1-0", "p", "c2-1", "c4-0"], "同じ turn でも seq が違えば残る");
  assert.deepEqual(dedupeRelayCopies([{ id: "x", provenance: { delivery: "qa-relay", source: { relayId: "r" } } }]).length, 1, "seq 無しの旧コピーは落とさない");
});

test("parseGrokStream: 工程 0 の fixture から本文・end・ステップを得る", () => {
  const lines = [
    JSON.stringify({ type: "available_commands", commands: [] }),
    JSON.stringify({ type: "thought", delta: "考える" }),
    JSON.stringify({ type: "tool_call", toolCallId: "t1", title: "Read README.md", kind: "read", status: "running", toolName: "read_file" }),
    JSON.stringify({ type: "tool_call_update", toolCallId: "t1", status: "done" }),
    JSON.stringify({ type: "text", data: "こんに" }),
    "not json",
    JSON.stringify({ type: "text", data: "ちは" }),
    JSON.stringify({ type: "usage", usage: { input_tokens: 1 } }),
    JSON.stringify({
      type: "end",
      stopReason: "end_turn",
      sessionId: "01a0852e-x",
      usage: { input_tokens: 7208, cache_read_input_tokens: 9984, output_tokens: 32, reasoning_tokens: 27 },
      num_turns: 1,
      total_cost_usd: 0.003332,
      modelUsage: { "grok-4.6-build": { costUSD: 0.003332 } },
    }),
  ];
  const r = parseGrokStream(lines);
  assert.equal(r.text, "こんにちは");
  assert.equal(r.end.sessionId, "01a0852e-x");
  assert.equal(r.error, null);
  assert.deepEqual(r.steps, ["🧠 思考中", "🔧 Read README.md", "✍ 応答を作成中", "✍ 応答を作成中"]);
  // text フィールド名の揺れ（text / content）にも対応
  assert.equal(parseGrokStream([JSON.stringify({ type: "text", text: "a" }), JSON.stringify({ type: "text", content: "b" })]).text, "ab");
  // json 形式（end に本文）にも対応
  assert.equal(parseGrokStream([JSON.stringify({ type: "end", text: "本文", stopReason: "end_turn" })]).text, "本文");
  // 未認証のエラー行
  const e = parseGrokStream([JSON.stringify({ type: "error", message: "Not signed in. Run grok login" })]);
  assert.match(e.error, /Not signed in/);
  assert.equal(isGrokUnauthedError(e.error), true);
  assert.equal(isGrokUnauthedError("permission denied"), false);
  assert.equal(grokStepFrom({ type: "usage" }), null);
});

test("grokMetaFrom: 共通 meta への正規化。cancelled は stopped、費用なしは unknown（0 円とみなさない）", () => {
  const end = {
    stopReason: "end_turn",
    usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 },
    total_cost_usd: 0.01,
    modelUsage: { "grok-4.6-build": {} },
  };
  assert.deepEqual(grokMetaFrom(end, 1234, ""), {
    status: "completed",
    model: "grok-4.6-build",
    durationMs: 1234,
    usage: { inTok: 10, outTok: 3, cacheTok: 5 },
    billing: { mode: "metered", usd: 0.01 },
  });
  const stopped = grokMetaFrom({ stopReason: "cancelled", usage: { input_tokens: 1 }, total_cost_usd: 0.001 }, 10, "grok-x");
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.model, "grok-x", "modelUsage が無ければ指定モデル");
  assert.equal(stopped.billing.usd, 0.001, "停止時も費用を保持");
  const unknown = grokMetaFrom({ stopReason: "end_turn" }, 5, "");
  assert.deepEqual(unknown.billing, { mode: "unknown" });
  assert.equal(unknown.usage.inTok, 0);
});

test("hasEndMark: 最終行末尾の素のマーカーのみ有効（否定・引用・コード・包んだ言及は無効）", async () => {
  const { hasEndMark } = await import("../lib.mjs");
  const M = "【質疑終了】";
  // 有効な形
  assert.equal(hasEndMark("合意です【質疑終了】", M), true, "文末直結");
  assert.equal(hasEndMark("合意しました。\n\n【質疑終了】", M), true, "単独行");
  assert.equal(hasEndMark("- 【質疑終了】", M), true, "箇条書き");
  assert.equal(hasEndMark("締めます **【質疑終了】**", M), true, "強調は許容");
  assert.equal(hasEndMark("```\ncode\n```\n合意です【質疑終了】", M), true, "閉じたフェンスの後は有効");
  assert.equal(hasEndMark("````text\n```\n````\n合意です【質疑終了】", M), true, "4連フェンス内の3連を閉じと誤認しない（誤拒否側の回帰）");
  // 実際に起きた事故
  assert.equal(hasEndMark("確認が出揃ったら締めてください。ここではまだ 【質疑終了】 しません。", M), false, "否定文（実事故）");
  // 無効な形
  assert.equal(hasEndMark("引用です。\n> 【質疑終了】", M), false, "引用行");
  assert.equal(hasEndMark("記載しないでください：「【質疑終了】」", M), false, "鉤括弧で包む");
  assert.equal(hasEndMark("使用例：`【質疑終了】`", M), false, "インラインコード");
  assert.equal(hasEndMark("~~【質疑終了】~~", M), false, "取消線");
  assert.equal(hasEndMark("例:\n```\n【質疑終了】", M), false, "閉じていない```フェンス内");
  assert.equal(hasEndMark("例:\n~~~text\n【質疑終了】", M), false, "~~~フェンス内");
  assert.equal(hasEndMark("例:\n\n    【質疑終了】", M), false, "4スペースインデントのコード表記");
  assert.equal(hasEndMark("````text\n```\n【質疑終了】", M), false, "4連フェンスは3連で閉じない");
  assert.equal(hasEndMark("【質疑終了】と書けば終わります", M), false, "後に本文が続く");
  assert.equal(hasEndMark("```【質疑終了】", M), false, "フェンス行自体");
  assert.equal(hasEndMark("", M), false);
});
