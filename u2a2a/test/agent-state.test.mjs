// エージェント状態の正規化 — 純関数（仕様: SPEC-アバター状態.md）。サーバ不要
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveAgentState,
  agentGlobalState,
  compareRuns,
  nextOutcome,
  sanitizeOutcomes,
  lookCell,
  isSafeSpriteName,
  validateV2Format,
  AGENT_PHASES,
  RUN_KIND_ORDER,
} from "../lib.mjs";

const IDS = ["claude", "codex", "grok"];
const agentsOk = () => ({ claude: { auto: true, authed: true }, codex: { auto: true, authed: true }, grok: { auto: true, authed: null, authCheckedTs: 0 } });
const input = (over = {}) => ({ agentIds: IDS, agents: agentsOk(), budgetHalt: null, runs: [], topics: [{ id: "T1" }, { id: "T2" }], pool: [], unattributedOutcomes: {}, ...over });
const run = (runId, agent, kind, ids, startedAt) => ({ runId, agent, kind, ...ids, startedAt });
const outcome = (id, phase, reason, ts, kind = "thread") => ({ id, kind, phase, reason, ts, runId: "r-" + id, itemId: null, messageId: null, detail: "" });

const FORMAT = {
  spriteVersionNumber: 2,
  atlas: { width: 1536, height: 2288, columns: 8, rows: 11, cellWidth: 192, cellHeight: 208 },
  animations: [
    { row: 0, name: "idle", frames: 6, durationsMs: [280, 110, 110, 140, 140, 320] },
    { row: 7, name: "running", frames: 6, durationsMs: [120, 120, 120, 120, 120, 220] },
  ],
  look: { rows: [9, 10], framesPerRow: 8, stepDeg: 22.5, zeroDeg: "up", clockwise: true },
  neutral: { row: 0, col: 6 },
};

test("1. 何も無ければ全員 idle・byTopic は空。version 1。phase は 7 値", () => {
  const s = deriveAgentState(input());
  assert.equal(s.version, 1);
  assert.deepEqual(Object.keys(s.agents), IDS);
  for (const a of IDS) assert.deepEqual(s.agents[a], { global: { phase: "idle", reason: null, since: null }, runs: [], outcomes: [], byTopic: {} });
  assert.deepEqual(AGENT_PHASES, ["idle", "working", "reviewing", "waiting", "halted", "failed", "off"]);
});

test("2. global の優先順: off > halted(budget) > waiting(unauthed) > idle。authed null は idle", () => {
  const halt = { reason: "上限", ts: 500 };
  assert.deepEqual(agentGlobalState({ auto: false, authed: false }, halt), { phase: "off", reason: "auto-off", since: null });
  assert.deepEqual(agentGlobalState({ auto: true, authed: false, authCheckedTs: 9 }, halt), { phase: "halted", reason: "budget", since: 500 });
  assert.deepEqual(agentGlobalState({ auto: true, authed: false, authCheckedTs: 9 }, null), { phase: "waiting", reason: "unauthed", since: 9 });
  assert.deepEqual(agentGlobalState({ auto: true, authed: false, authCheckedTs: 0 }, null), { phase: "waiting", reason: "unauthed", since: null });
  assert.deepEqual(agentGlobalState({ auto: true, authed: null }, null), { phase: "idle", reason: null, since: null }, "確認中は待たせていない");
  assert.deepEqual(agentGlobalState({ auto: true, authed: true }, null), { phase: "idle", reason: null, since: null });
});

test("3. kind → phase。同じエージェントの別トピック実行は混ざらない", () => {
  const s = deriveAgentState(input({ runs: [run("a", "claude", "thread", { topicId: "T1" }, 10), run("b", "claude", "summary", { topicId: "T2" }, 20)] }));
  const c = s.agents.claude;
  assert.deepEqual(c.byTopic.T1, { phase: "working", kind: "thread", reason: null, since: 10, source: "run", runId: "a", runCount: 1, outcomeId: null });
  assert.deepEqual(c.byTopic.T2, { phase: "working", kind: "summary", reason: null, since: 20, source: "run", runId: "b", runCount: 1, outcomeId: null });
  assert.deepEqual(s.agents.codex.byTopic, {}, "他エージェントへ波及しない");
  assert.equal(c.global.phase, "idle", "実行は global を変えない");
});

test("4. review / fix はプール項目のトピックへ帰属。null・項目なし・削除済みトピックは byTopic に出さない", () => {
  const pool = [{ id: "i1", topicId: "T1" }, { id: "i2", topicId: null }, { id: "i3", topicId: "GONE" }];
  const s = deriveAgentState(input({
    pool,
    runs: [
      run("r1", "codex", "review", { itemId: "i1" }, 1),
      run("r2", "codex", "fix", { itemId: "i2" }, 2),
      run("r3", "codex", "review", { itemId: "missing" }, 3),
      run("r4", "codex", "review", { itemId: "i3" }, 4),
    ],
  }));
  const x = s.agents.codex;
  assert.deepEqual(x.runs.map((r) => [r.runId, r.topicId, r.phase]), [["r2", null, "working"], ["r1", "T1", "reviewing"], ["r3", null, "reviewing"], ["r4", "GONE", "reviewing"]]);
  assert.deepEqual(Object.keys(x.byTopic), ["T1"]);
  assert.equal(x.byTopic.T1.kind, "review");
});

test("5. 選択順: thread > fix > review > summary。同 kind は古い順。runCount は件数", () => {
  const pool = [{ id: "i1", topicId: "T1" }, { id: "i2", topicId: "T1" }];
  const s = deriveAgentState(input({
    pool,
    runs: [
      run("rv2", "claude", "review", { itemId: "i2" }, 30),
      run("sum", "claude", "summary", { topicId: "T1" }, 5),
      run("rv1", "claude", "review", { itemId: "i1" }, 20),
    ],
  }));
  assert.deepEqual(s.agents.claude.byTopic.T1, { phase: "reviewing", kind: "review", reason: null, since: 20, source: "run", runId: "rv1", runCount: 3, outcomeId: null });
  const s2 = deriveAgentState(input({ pool, runs: [run("rv1", "claude", "review", { itemId: "i1" }, 1), run("fx", "claude", "fix", { itemId: "i2" }, 9), run("th", "claude", "thread", { topicId: "T1" }, 99)] }));
  assert.equal(s2.agents.claude.byTopic.T1.runId, "th");
  assert.deepEqual(RUN_KIND_ORDER, ["thread", "fix", "review", "summary"]);
  assert.ok(compareRuns({ kind: "x", since: 0, runId: "a" }, { kind: "summary", since: 9, runId: "b" }) > 0, "未知の kind は最後");
});

test("6. 解決順: run > global(非 idle) > outcome。隠れた outcome は outcomeId に残る", () => {
  const topics = [{ id: "T1", agentOutcomes: { grok: outcome("o1", "halted", "stopped-unknown", 50) } }, { id: "T2" }];
  const onlyOutcome = deriveAgentState(input({ topics, agents: { ...agentsOk(), grok: { auto: true, authed: true } } })).agents.grok;
  assert.deepEqual(onlyOutcome.byTopic.T1, { phase: "halted", kind: "thread", reason: "stopped-unknown", since: 50, source: "outcome", runId: "r-o1", runCount: 0, outcomeId: "o1" });
  assert.equal(onlyOutcome.byTopic.T2, undefined, "別トピックへ波及しない");
  assert.equal(onlyOutcome.global.phase, "idle", "outcome は global を変えない");
  const unauthed = deriveAgentState(input({ topics, agents: { ...agentsOk(), grok: { auto: true, authed: false, authCheckedTs: 7 } } })).agents.grok;
  assert.deepEqual(unauthed.byTopic.T1, { phase: "waiting", reason: "unauthed", since: 7, kind: null, source: "global", runId: null, runCount: 0, outcomeId: "o1" });
  const off = deriveAgentState(input({ topics, agents: { ...agentsOk(), grok: { auto: false, authed: true } } })).agents.grok;
  assert.equal(off.byTopic.T1.phase, "off");
  assert.equal(off.byTopic.T1.outcomeId, "o1");
  const running = deriveAgentState(input({ topics, agents: { ...agentsOk(), grok: { auto: false, authed: true } }, runs: [run("g", "grok", "thread", { topicId: "T1" }, 60)] })).agents.grok;
  assert.equal(running.byTopic.T1.source, "run", "手動の実行は auto OFF でも事実として作業中");
  assert.equal(running.byTopic.T1.outcomeId, "o1");
});

test("7. 帰属なしの outcome は outcomes にだけ載り、どのトピックにも出ない。新しい順", () => {
  const topics = [{ id: "T1", agentOutcomes: { codex: outcome("old", "failed", "error", 10, "review") } }, { id: "T2" }];
  const s = deriveAgentState(input({ topics, unattributedOutcomes: { codex: outcome("new", "failed", "project-blocked", 20, "fix") } }));
  assert.deepEqual(s.agents.codex.outcomes.map((o) => [o.id, o.topicId]), [["new", null], ["old", "T1"]]);
  assert.deepEqual(Object.keys(s.agents.codex.byTopic), ["T1"]);
});

test("8. nextOutcome: 解除条件の表（§4.4）", () => {
  const prev = outcome("p", "failed", "error", 1);
  const stopped = nextOutcome(null, { type: "stopped", kind: "thread", id: "n", ts: 2, runId: "r", messageId: "m", reason: "error" });
  assert.deepEqual(stopped, { id: "n", kind: "thread", phase: "halted", reason: "stopped-unknown", ts: 2, runId: "r", itemId: null, messageId: "m", detail: "" }, "停止は理由を問わず stopped-unknown");
  assert.equal(nextOutcome(prev, { type: "failed", kind: "fix", reason: "history", id: "h" }).reason, "history");
  assert.equal(nextOutcome(prev, { type: "failed", kind: "fix", reason: "stopped-unknown" }).reason, "error", "failed に stopped-unknown は付けない");
  assert.equal(nextOutcome(prev, { type: "failed", kind: "fix", reason: "made-up" }).reason, "error");
  assert.equal(nextOutcome(prev, { type: "failed", kind: "review", detail: "x".repeat(500) }).detail.length, 200);
  assert.equal(nextOutcome(prev, { type: "completed", kind: "review" }), null, "正常完了で消す");
  assert.equal(nextOutcome(prev, { type: "cancelled", kind: "thread" }), prev, "キャンセルは残す");
  assert.equal(nextOutcome(prev, { type: "completed", kind: "summary" }), prev, "summary は解除しない");
  assert.equal(nextOutcome(prev, { type: "failed", kind: "summary" }), prev, "summary は記録しない");
  assert.equal(nextOutcome(null, { type: "failed", kind: "summary" }), null);
  assert.equal(nextOutcome(prev, { type: "ack", kind: "summary" }), null, "ack は常に消す");
});

test("9. sanitizeOutcomes: 対応外エージェント・不正な phase・配列を捨てる", () => {
  const ok = outcome("o", "halted", "stopped-unknown", 1);
  assert.deepEqual(sanitizeOutcomes({ claude: ok, codex: { phase: "working" }, evil: ok, grok: null }, IDS), { claude: ok });
  assert.deepEqual(sanitizeOutcomes([ok], IDS), {});
  assert.deepEqual(sanitizeOutcomes(undefined, IDS), {});
});

test("10. lookCell: 0°=上・時計回り・22.5° 刻み・16 方向", () => {
  assert.deepEqual(lookCell(0), { row: 9, col: 0 });
  assert.deepEqual(lookCell(90), { row: 9, col: 4 });
  assert.deepEqual(lookCell(157.5), { row: 9, col: 7 });
  assert.deepEqual(lookCell(180), { row: 10, col: 0 });
  assert.deepEqual(lookCell(270), { row: 10, col: 4 });
  assert.deepEqual(lookCell(337.5), { row: 10, col: 7 });
  assert.deepEqual(lookCell(350), { row: 9, col: 0 }, "上へ丸める");
  assert.deepEqual(lookCell(-90), { row: 10, col: 4 }, "負の角度");
  assert.deepEqual(lookCell(720 + 45), { row: 9, col: 2 });
  assert.equal(lookCell("x"), null);
});

test("11. validateV2Format / isSafeSpriteName", () => {
  assert.equal(validateV2Format(FORMAT), null);
  const bad = (patch) => validateV2Format({ ...structuredClone(FORMAT), ...patch });
  assert.match(bad({ spriteVersionNumber: 1 }), /spriteVersionNumber/);
  assert.match(bad({ atlas: { ...FORMAT.atlas, width: 1500 } }), /寸法/);
  assert.match(bad({ animations: [{ row: 0, name: "idle", frames: 6, durationsMs: [1, 2] }] }), /durationsMs/);
  assert.match(bad({ animations: [{ row: 11, name: "x", frames: 1, durationsMs: [1] }] }), /row/);
  assert.match(bad({ look: { rows: [12] } }), /look/);
  assert.match(validateV2Format(null), /オブジェクト/);
  assert.ok(isSafeSpriteName("spritesheet.webp"));
  for (const n of ["../x.webp", "a/b.webp", ".hidden.webp", "x.png", "", null]) assert.equal(isSafeSpriteName(n), false, String(n));
});

test("12. 入力を変更しない", () => {
  const inp = input({
    pool: [{ id: "i1", topicId: "T1" }],
    topics: [{ id: "T1", agentOutcomes: { claude: outcome("o", "failed", "error", 3) } }],
    runs: [run("b", "claude", "review", { itemId: "i1" }, 2), run("a", "claude", "thread", { topicId: "T1" }, 1)],
  });
  const before = structuredClone(inp);
  deriveAgentState(inp);
  assert.deepEqual(inp, before);
});
