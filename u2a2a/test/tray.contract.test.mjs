// 契約-判断トレイAPI.md 契約版1 からの独立試験。
// 期待値は契約の表・式から立てる。tray.mjs の実装を写さない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../verification.mjs";
import * as T from "../tray.mjs";

const COMMIT = "457acf664cabcd243beb1007074bf517cd031948";
const RELAY = "9f1c2a7b4e0d8a36";
const REQ = (n) => "req_" + n.toString(16).padStart(16, "0");

function fence(json, info = "u2a2a-request") {
  return "```" + info + "\n" + JSON.stringify(json, null, 2) + "\n```";
}

function question(over = {}) {
  return {
    v: 1, kind: "question", to: "user", title: "通知の仕方",
    questions: [{
      id: "q1", text: "新着はどう知らせますか",
      options: [
        { id: "a", label: "バッジ", effect: "件数だけ出す" },
        { id: "b", label: "トースト", effect: "右下に出す" },
      ],
    }],
    ...over,
  };
}

function startTask(over = {}) {
  return {
    v: 1, kind: "start-task", to: "user", title: "トレイに着手したい",
    outcome: "会議の結論をボタンで承認できる",
    scope: ["tray.mjs と API"],
    tasks: [{ key: "api", agent: "claude", title: "サーバ", scope: ["API"] }],
    baseCommit: COMMIT,
    basis: { relayId: RELAY },
    ...over,
  };
}

function oracleNormalize(block) {
  const copy = JSON.parse(JSON.stringify(block));
  const trim = (s) => String(s).replace(/\r\n/g, "\n").replace(/^\s+|\s+$/g, "");
  const walk = (v) => {
    if (typeof v === "string") return trim(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  const n = walk(copy);
  if (Array.isArray(n.dependsOn)) n.dependsOn = [...new Set(n.dependsOn)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (Array.isArray(n.exclude)) {
    n.exclude = [...n.exclude].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  for (const k of Object.keys(n)) {
    if (n[k] === undefined) delete n[k];
  }
  return n;
}

function oracleSha({ topicId, proposer, block, basisDigest, detailsDigests }) {
  const normalized = oracleNormalize(block);
  const details = [...(detailsDigests || [])].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(canonicalJson([1, topicId, proposer, normalized, basisDigest, details]));
}

// ---------- §2.1 抽出 ----------
test("extractRequestBlocks: 情報文字列がちょうど u2a2a-request のフェンスだけ拾う", () => {
  const ok = T.extractRequestBlocks("前文\n" + fence(question()) + "\n後");
  assert.equal(ok.length, 1);
  assert.match(ok[0].raw, /"kind": "question"/);
});

test("extractRequestBlocks: 引用・他コード・インデントからは拾わない", () => {
  const quoted = T.extractRequestBlocks(["> ```u2a2a-request", "> {\"v\":1,\"kind\":\"question\"}", "> ```"].join("\n"));
  assert.equal(quoted.length, 0);

  const nested = T.extractRequestBlocks([
    "```js",
    "```u2a2a-request",
    JSON.stringify(question()),
    "```",
    "```",
  ].join("\n"));
  assert.equal(nested.length, 0);

  const indented = T.extractRequestBlocks("    ```u2a2a-request\n    {}\n    ```\n");
  assert.equal(indented.length, 0);

  const otherInfo = T.extractRequestBlocks("```json\n" + JSON.stringify(question()) + "\n```");
  assert.equal(otherInfo.length, 0);
});

test("extractRequestBlocks: 2 件なら 2 件返す（先頭採用しない）。受付はすべて捨てる側", () => {
  const two = T.extractRequestBlocks(fence(question()) + "\n\n" + fence(question({ title: "二つ目" })));
  assert.equal(two.length, 2);
});

test("extractRequestBlocks: ~~~ フェンスも拾う", () => {
  const raw = "~~~u2a2a-request\n" + JSON.stringify(question()) + "\n~~~";
  assert.equal(T.extractRequestBlocks(raw).length, 1);
});

// ---------- §2.5 形の検査 28 コード ----------
function codes(raw) {
  const r = T.validateRequestBlock(typeof raw === "string" ? raw : JSON.stringify(raw));
  assert.equal(r.ok, false);
  return new Set(r.errors.map((e) => e.code));
}

test("validateRequestBlock: 合法な question / start-task は ok", () => {
  assert.equal(T.validateRequestBlock(JSON.stringify(question())).ok, true);
  assert.equal(T.validateRequestBlock(JSON.stringify(startTask())).ok, true);
});

test("validateRequestBlock: 契約 §2.5 の 28 コードをそれぞれ出す", () => {
  const expect = (raw, code) => {
    const set = codes(raw);
    assert.ok(set.has(code), `expected ${code}, got ${[...set]}`);
  };
  expect("not-json", "invalid-json");
  expect("[]", "invalid-json");
  expect({ ...question(), v: 2 }, "version-unsupported");
  expect({ ...question(), kind: "vote" }, "kind-invalid");
  expect({ ...question(), to: "claude" }, "to-invalid");
  expect({ ...question(), title: "" }, "title-invalid");
  expect({ ...question(), title: "あ".repeat(61) }, "title-invalid");
  expect({ ...question(), id: "req_0123456789abcdef" }, "reserved-field");
  expect({ ...question(), extra: 1 }, "unknown-field");
  expect({ ...question(), questions: [] }, "questions-count");
  expect({ ...question(), questions: [1, 2, 3, 4].map((i) => ({
    id: "q" + i, text: "質問です", options: [
      { id: "a", label: "A", effect: "A になる" },
      { id: "b", label: "B", effect: "B になる" },
    ],
  })) }, "questions-count");
  expect({ ...question(), questions: [{
    id: "Q1", text: "どちら", options: [
      { id: "a", label: "A", effect: "A" }, { id: "b", label: "B", effect: "B" },
    ],
  }] }, "id-invalid");
  expect({ ...question(), questions: [
    { id: "q1", text: "一", options: [{ id: "a", label: "A", effect: "A" }, { id: "b", label: "B", effect: "B" }] },
    { id: "q1", text: "二", options: [{ id: "a", label: "A", effect: "A" }, { id: "b", label: "B", effect: "B" }] },
  ] }, "id-duplicate");
  expect({ ...question(), questions: [{
    id: "q1", text: "どちら", options: [
      { id: "__other", label: "他", effect: "自由記述" },
      { id: "b", label: "B", effect: "B" },
    ],
  }] }, "reserved-option");
  expect({ ...question(), questions: [{
    id: "q1", text: "   ", options: [
      { id: "a", label: "A", effect: "A" }, { id: "b", label: "B", effect: "B" },
    ],
  }] }, "text-invalid");
  expect({ ...question(), questions: [{
    id: "q1", text: "どちら", options: [{ id: "a", label: "A", effect: "A になる" }],
  }] }, "options-count");
  expect({ ...question(), questions: [{
    id: "q1", text: "どちら", options: [
      { id: "a", label: "A" }, { id: "b", label: "B", effect: "B" },
    ],
  }] }, "option-invalid");
  expect({ ...question(), questions: [{
    id: "q1", text: "どちら", options: [
      { id: "a", label: "A", effect: "A" }, { id: "b", label: "B", effect: "B" },
    ], recommended: "nope",
  }] }, "recommended-invalid");
  expect({ ...question(), continueAgent: "gpt" }, "continue-agent-invalid");
  expect({ ...startTask(), outcome: "" }, "outcome-invalid");
  expect({ ...startTask(), scope: [] }, "scope-invalid");
  expect({ ...startTask(), tasks: [] }, "tasks-count");
  expect({ ...startTask(), tasks: [{ key: "api", agent: "claude", title: "", scope: ["x"] }] }, "task-invalid");
  expect({ ...startTask(), tasks: [
    { key: "a", agent: "claude", title: "A", scope: ["s"] },
    { key: "b", agent: "codex", title: "B", scope: ["s"], after: ["b"] },
  ] }, "task-after-invalid");
  expect({ ...startTask(), tasks: [
    { key: "a", agent: "claude", title: "A", scope: ["s"], after: ["b"] },
    { key: "b", agent: "codex", title: "B", scope: ["s"] },
  ] }, "task-after-invalid");
  expect({ ...startTask(), baseCommit: "457acf6" }, "base-commit-invalid");
  expect({ ...startTask(), basis: {} }, "basis-invalid");
  expect({ ...startTask(), basis: { relayId: RELAY, memo: "topics/x/a.md" } }, "basis-invalid");
  expect({ ...startTask(), details: ["/abs.md"] }, "path-invalid");
  expect({ ...startTask(), details: ["topics/x.md", "topics/y.md", "topics/z.md", "topics/a.md", "topics/b.md", "topics/c.md"] }, "path-invalid");
  expect({ ...startTask(), dependsOn: "req_0123456789abcdef" }, "depends-invalid");
  expect({ ...startTask(), dependsOn: ["req_0123456789abcdef", "req_0123456789abcdef"] }, "depends-invalid");
  expect({ ...startTask(), exclude: ["req_0123456789abcdef"] }, "exclude-invalid");
  expect({ ...startTask(), exclude: [{ id: "req_0123456789abcdef", reason: "   " }] }, "exclude-reason-invalid");
  const both = REQ(1);
  expect({ ...startTask(), dependsOn: [both], exclude: [{ id: both, reason: "重複" }] }, "depends-exclude-overlap");
});

test("SHAPE_CODES は §2.5 の 28 個（block-multiple は抽出側）", () => {
  const listed = [
    "invalid-json", "version-unsupported", "kind-invalid", "to-invalid", "title-invalid",
    "reserved-field", "unknown-field", "questions-count", "id-invalid", "id-duplicate",
    "reserved-option", "text-invalid", "options-count", "option-invalid", "recommended-invalid",
    "continue-agent-invalid", "outcome-invalid", "scope-invalid", "tasks-count", "task-invalid",
    "task-after-invalid", "base-commit-invalid", "basis-invalid", "path-invalid", "depends-invalid",
    "exclude-invalid", "exclude-reason-invalid", "depends-exclude-overlap",
  ];
  assert.equal(listed.length, 28);
  for (const c of listed) {
    const msg = T.SHAPE_CODES[c];
    assert.ok(typeof msg === "string" || (msg && typeof msg.message === "string"), c);
  }
});

// ---------- §3 正規化と版ハッシュ ----------
test("normalizeRequestBlock: dependsOn/exclude だけ整列。questions の順は保つ", () => {
  const b = question({
    dependsOn: [REQ(2), REQ(1)],
    exclude: [{ id: REQ(4), reason: " 後 " }, { id: REQ(3), reason: "先" }],
  });
  b.questions.push({
    id: "q0", text: "二問目", options: [
      { id: "x", label: "X", effect: "X" }, { id: "y", label: "Y", effect: "Y" },
    ],
  });
  const n = T.normalizeRequestBlock(b);
  assert.deepEqual(n.dependsOn, [REQ(1), REQ(2)]);
  assert.deepEqual(n.exclude.map((e) => e.id), [REQ(3), REQ(4)]);
  assert.equal(n.exclude[1].reason, "後");
  assert.equal(n.questions[0].id, "q1");
  assert.equal(n.questions[1].id, "q0");
});

test("computeProposalSha256: dependsOn/exclude の記述順は同じ版。質問の並べ替えは別版（§14-4）", () => {
  const input = (block) => ({
    topicId: "topic1", proposer: "claude", block,
    basisDigest: { kind: "relay", relayId: RELAY },
    detailsDigests: [],
  });
  const a = startTask({ dependsOn: [REQ(2), REQ(1)], exclude: [{ id: REQ(9), reason: "外" }] });
  const b = startTask({ dependsOn: [REQ(1), REQ(2)], exclude: [{ id: REQ(9), reason: "外" }] });
  const shaA = T.computeProposalSha256(input(a));
  const shaB = T.computeProposalSha256(input(b));
  assert.equal(shaA, shaB);
  assert.equal(shaA, oracleSha(input(a)));

  const q1 = question();
  const q2 = question();
  q2.questions = [q2.questions[0], {
    id: "q9", text: "別の順", options: [
      { id: "a", label: "A", effect: "A" }, { id: "b", label: "B", effect: "B" },
    ],
  }];
  q1.questions = [q2.questions[1], q2.questions[0]];
  const h1 = T.computeProposalSha256(input(q1));
  const h2 = T.computeProposalSha256(input(q2));
  assert.notEqual(h1, h2);
});

test("computeProposalSha256: 省略した dependsOn と展開後の明示は正規化後同じ集合なら同じ版、という注は展開後ブロックで見る", () => {
  const expanded = startTask({ dependsOn: [REQ(1), REQ(2)], exclude: [] });
  const same = startTask({ dependsOn: [REQ(2), REQ(1)] });
  const input = (block) => ({
    topicId: "t", proposer: "grok", block,
    basisDigest: { kind: "relay", relayId: RELAY }, detailsDigests: [],
  });
  assert.equal(T.computeProposalSha256(input(expanded)), T.computeProposalSha256(input(same)));
});

// ---------- §5.2 被覆 5 行 ----------
test("resolveDependencies: 契約 §5.2 の 5 行", () => {
  const c1 = REQ(10), c2 = REQ(11);
  const candidates = [c1, c2];
  const run = (block) => T.resolveDependencies({ block, candidates });

  const omit = run(startTask());
  assert.equal(omit.ok, true);
  assert.deepEqual([...omit.dependsOn].sort(), [c1, c2].sort());
  assert.deepEqual(omit.exclude, []);

  const onlyDep = run(startTask({ dependsOn: [c1] }));
  assert.equal(onlyDep.ok, false);
  assert.ok(onlyDep.errors.some((e) => e.code === "dependency-uncovered"));

  const onlyEx = run(startTask({ exclude: [{ id: c2, reason: "範囲外" }] }));
  assert.equal(onlyEx.ok, true);
  assert.deepEqual(onlyEx.dependsOn, [c1]);
  assert.equal(onlyEx.exclude[0].id, c2);

  const both = run(startTask({ dependsOn: [c1], exclude: [{ id: c2, reason: "範囲外" }] }));
  assert.equal(both.ok, true);

  const emptyBad = run(startTask({ dependsOn: [] }));
  assert.equal(emptyBad.ok, false);

  const emptyOk = run(startTask({
    dependsOn: [],
    exclude: [{ id: c1, reason: "今回は不要" }, { id: c2, reason: "今回は不要" }],
  }));
  assert.equal(emptyOk.ok, true);
  assert.deepEqual(emptyOk.dependsOn, []);
});

test("resolveDependencies: 候補が空なら dependsOn: [] を受理", () => {
  const r = T.resolveDependencies({ block: startTask({ dependsOn: [] }), candidates: [] });
  assert.equal(r.ok, true);
});

test("dependencyCandidates: relay はそのリレーの pending/parked 質問だけ。memo はトピック全体。revision-requested は入れない", () => {
  const requests = [
    { id: REQ(1), topicId: "t", kind: "question", status: "pending", relayId: RELAY },
    { id: REQ(2), topicId: "t", kind: "question", status: "parked", relayId: RELAY },
    { id: REQ(3), topicId: "t", kind: "question", status: "revision-requested", relayId: RELAY },
    { id: REQ(4), topicId: "t", kind: "question", status: "pending", relayId: "deadbeefdeadbeef" },
    { id: REQ(5), topicId: "t", kind: "start-task", status: "pending", relayId: RELAY },
    { id: REQ(6), topicId: "u", kind: "question", status: "pending", relayId: RELAY },
  ];
  const relay = T.dependencyCandidates({ basis: { relayId: RELAY }, requests, topicId: "t", relayId: RELAY });
  assert.deepEqual([...relay].sort(), [REQ(1), REQ(2)].sort());
  const memo = T.dependencyCandidates({ basis: { memo: "topics/x/m.md" }, requests, topicId: "t" });
  assert.deepEqual([...memo].sort(), [REQ(1), REQ(2), REQ(4)].sort());
});

// ---------- §4 状態遷移 ----------
test("canTransition: 終端からは動かない。stale は遷移ではなく拒否", () => {
  for (const s of T.TERMINAL_STATES) {
    for (const action of ["park", "unpark", "answer", "approve", "reject", "revision", "supersede", "cancel"]) {
      assert.equal(T.canTransition(s, action), false, `${s} + ${action}`);
    }
  }
  assert.equal(T.canTransition("pending", "park"), true);
  assert.equal(T.canTransition("parked", "unpark"), true);
  assert.equal(T.canTransition("pending", "unpark"), false);
  assert.equal(T.canTransition("revision-requested", "supersede"), true);
  assert.equal(T.canTransition("answered", "approve"), false);
});

test("TERMINAL_STATES / ACTIVE_STATES は契約の集合", () => {
  assert.deepEqual([...T.TERMINAL_STATES].sort(), ["answered", "approved", "cancelled", "rejected", "superseded"].sort());
  assert.deepEqual([...T.ACTIVE_STATES].sort(), ["parked", "pending", "revision-requested"].sort());
});

// ---------- §8 ブロッカー ----------
test("evaluateBlockers: parked は unresolved、answered は消える、superseded は changed", () => {
  const req = {
    kind: "start-task",
    acceptedDependsOn: [REQ(1)],
    acceptedExclude: [],
    block: startTask(),
    basisDigest: { kind: "relay", relayId: RELAY },
    detailsDigests: [],
  };
  const base = {
    agents: { claude: { auto: true, authed: true } },
    budgetHalt: null,
    participants: ["claude", "codex"],
    basisStatus: "ok",
    detailsStatus: [],
    baseCommitStatus: "verified",
    head: COMMIT,
  };
  const parked = T.evaluateBlockers({
    ...base, request: req,
    requests: [{ id: REQ(1), kind: "question", status: "parked", topicId: "t" }],
  });
  assert.ok(parked.some((b) => b.code === "dependency-unresolved"));

  const answered = T.evaluateBlockers({
    ...base, request: req,
    requests: [{ id: REQ(1), kind: "question", status: "answered", topicId: "t" }],
  });
  assert.equal(answered.some((b) => b.code === "dependency-unresolved" || b.code === "dependency-changed"), false);

  const supered = T.evaluateBlockers({
    ...base, request: req,
    requests: [{ id: REQ(1), kind: "question", status: "superseded", topicId: "t" }],
  });
  assert.ok(supered.some((b) => b.code === "dependency-changed"));
});

test("evaluateBlockers: head-moved は警告で不可にしない。coverage-changed は不可", () => {
  const req = {
    kind: "start-task",
    acceptedDependsOn: [REQ(1)],
    acceptedExclude: [],
    block: startTask(),
    basisDigest: { kind: "relay", relayId: RELAY },
    detailsDigests: [],
  };
  const blockers = T.evaluateBlockers({
    request: req,
    agents: { claude: { auto: true, authed: true } },
    budgetHalt: null,
    participants: ["claude"],
    requests: [
      { id: REQ(1), kind: "question", status: "answered", topicId: "t", relayId: RELAY },
      { id: REQ(2), kind: "question", status: "parked", topicId: "t", relayId: RELAY },
    ],
    basisStatus: "ok",
    detailsStatus: [],
    baseCommitStatus: "verified",
    head: "ffffffffffffffffffffffffffffffffffffffff",
  });
  assert.ok(blockers.some((b) => b.code === "head-moved"));
  const actionableStop = blockers.filter((b) => b.code !== "head-moved");
  assert.ok(actionableStop.some((b) => b.code === "dependency-coverage-changed"));
});

// ---------- §10 後続送信: returned では送らず done で送る ----------
test("planSendState: 前提が returned なら waiting。done なら waiting ではない", () => {
  const entry = { key: "ui", agent: "codex", after: ["api"], taskId: "t-ui" };
  const tasksReturned = [
    { id: "t-api", status: "returned" },
    { id: "t-ui", status: "queued" },
  ];
  const ctx = {
    tasks: tasksReturned,
    agents: { codex: { auto: true, authed: true } },
    budgetHalt: null,
    participants: ["codex"],
    taskByKey: { api: "t-api", ui: "t-ui" },
  };
  assert.equal(T.planSendState({ ...entry, after: ["api"] }, { ...ctx, tasks: tasksReturned }), "waiting");
  const tasksDone = [{ id: "t-api", status: "done" }, { id: "t-ui", status: "queued" }];
  const afterDone = T.planSendState(entry, { ...ctx, tasks: tasksDone });
  assert.notEqual(afterDone, "waiting");
});

// ---------- 冪等キー §14-17 ----------
test("冪等キー: 承認は (requestId, proposalSha256)、再送は taskKey を足す", () => {
  const fn = T.idempotencyKey || T.approveIdempotencyKey;
  assert.equal(typeof fn, "function", "差し戻し: tray.mjs が idempotencyKey(requestId, proposalSha256, taskKey?) を export すること");
  const a = fn(REQ(1), "aa".repeat(32));
  const b = fn(REQ(1), "aa".repeat(32));
  const c = fn(REQ(1), "bb".repeat(32));
  const d = fn(REQ(1), "aa".repeat(32), "ui");
  const e = fn(REQ(1), "aa".repeat(32), "ui");
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.notEqual(JSON.stringify(a), JSON.stringify(c));
  assert.notEqual(JSON.stringify(a), JSON.stringify(d));
  assert.equal(JSON.stringify(d), JSON.stringify(e));
});

test("LIMITS: 契約版1の数値（§14-18。異議は APPLY に記載）", () => {
  assert.equal(T.LIMITS.tasks, 8);
  assert.equal(T.LIMITS.scope, 10);
  assert.equal(T.LIMITS.details, 5);
  assert.equal(T.LIMITS.questions, 3);
  assert.equal(T.LIMITS.options, 5);
  assert.equal(T.LIMITS.excludeReason, 500);
});
