// 判断トレイ — 純関数テスト（契約: 契約-判断トレイAPI.md §2・§3・§4・§5・§8・§9.1・§10）
// サーバは起動しない。tray.mjs は I/O を持たないので、状態はすべて引数で与える。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractRequestBlocks,
  validateRequestBlock,
  normalizeRequestBlock,
  computeProposalSha256,
  dependencyCandidates,
  resolveDependencies,
  evaluateBlockers,
  canTransition,
  planFromTasks,
  planSendState,
  sendBlockers,
  idempotencyKey,
  buildTrayView,
  answerSummaryText,
  LIMITS,
  REQUEST_STATES,
  TERMINAL_STATES,
} from "../tray.mjs";

const RID = (n) => "req_" + String(n).padStart(16, "0");
const COMMIT = "457acf664cabcd243beb1007074bf517cd031948";
const RELAY = "9f1c2a7b4e0d8a36";

const question = (over = {}) => ({
  v: 1,
  kind: "question",
  to: "user",
  title: "トレイの通知方式",
  questions: [
    {
      id: "notify",
      text: "新着依頼の知らせ方はどれにしますか",
      options: [
        { id: "badge", label: "バッジだけ", effect: "タブに件数を出す" },
        { id: "toast", label: "トースト通知", effect: "右下に数秒出す" },
      ],
      recommended: "badge",
    },
  ],
  ...over,
});

const startTask = (over = {}) => ({
  v: 1,
  kind: "start-task",
  to: "user",
  title: "判断トレイの実装に着手したい",
  outcome: "会議の結論をボタンで承認できるようになる",
  scope: ["tray.mjs と API"],
  tasks: [
    { key: "contract", agent: "claude", title: "契約とサーバ", scope: ["tray.mjs"] },
    { key: "ui", agent: "codex", title: "トレイ UI", scope: ["カード"], after: ["contract"] },
  ],
  baseCommit: COMMIT,
  basis: { relayId: RELAY },
  ...over,
});

const fence = (obj, info = "u2a2a-request") => "```" + info + "\n" + JSON.stringify(obj, null, 2) + "\n```";

// ---- §2.1 抽出 ----

test("§2.1 抽出: 情報文字列が一致するフェンスだけを拾う（~~~ も可・前後の空白は無視）", () => {
  const a = extractRequestBlocks("前置き\n" + fence(question()) + "\n後書き");
  assert.equal(a.length, 1);
  assert.deepEqual(JSON.parse(a[0].raw).kind, "question");
  assert.equal(extractRequestBlocks("~~~u2a2a-request  \n{}\n~~~").length, 1, "~~~ フェンスと末尾空白");
  assert.equal(extractRequestBlocks("```u2a2a-request json\n{}\n```").length, 0, "情報文字列が違えば拾わない");
  assert.equal(extractRequestBlocks("```U2A2A-REQUEST\n{}\n```").length, 0, "大文字小文字は区別する");
  assert.equal(extractRequestBlocks("本文だけ").length, 0, "0 件は拒否ではない");
});

test("§2.1 抽出: 引用の中・他のコードブロックの中・インデントからは拾わない", () => {
  assert.equal(extractRequestBlocks("> ```u2a2a-request\n> {}\n> ```").length, 0, "引用の中");
  assert.equal(extractRequestBlocks("```md\n```u2a2a-request\n{}\n```\n```").length, 0, "他のコードブロックの中");
  assert.equal(extractRequestBlocks("    ```u2a2a-request\n    {}\n    ```").length, 0, "インデントコードブロック");
  assert.equal(extractRequestBlocks("```u2a2a-request\n{}").length, 0, "閉じていないフェンスは採用しない");
});

test("§2.1 抽出: 2 件あればそのまま 2 件返す（捨てる判断は呼び出し側）", () => {
  const two = extractRequestBlocks(fence(question()) + "\n\n" + fence(startTask()));
  assert.equal(two.length, 2);
  assert.ok(two[0].startLine < two[1].startLine);
});

// ---- §2.5 形の検査 ----

test("§2.5 形の検査: 正しい question / start-task は通る", () => {
  const q = validateRequestBlock(JSON.stringify(question()));
  assert.deepEqual(q.errors, []);
  assert.equal(q.ok, true);
  assert.equal(q.kind, "question");
  const t = validateRequestBlock(startTask());
  assert.deepEqual(t.errors, []);
  assert.equal(t.kind, "start-task");
});

test("§2.5 形の検査: サーバ付与フィールドと未知キーは拒否する", () => {
  const codes = (b) => validateRequestBlock(b).errors.map((e) => e.code);
  assert.ok(codes(question({ id: RID(1) })).includes("reserved-field"));
  assert.ok(codes(question({ proposer: "claude" })).includes("reserved-field"));
  assert.ok(codes(question({ status: "pending" })).includes("reserved-field"));
  assert.ok(codes(question({ note: "x" })).includes("unknown-field"));
  assert.ok(codes(question({ questions: [{ id: "a", text: "t", options: [{ id: "x", label: "l", effect: "e" }, { id: "y", label: "l", effect: "e" }], weight: 1 }] })).includes("unknown-field"));
});

test("§2.5 形の検査: 共通フィールドの違反", () => {
  const codes = (b) => validateRequestBlock(b).errors.map((e) => e.code);
  assert.ok(codes(question({ v: 2 })).includes("version-unsupported"));
  assert.ok(codes(question({ kind: "chat" })).includes("kind-invalid"));
  assert.ok(codes(question({ to: "claude" })).includes("to-invalid"));
  assert.ok(codes(question({ title: "" })).includes("title-invalid"));
  assert.ok(codes(question({ title: "あ".repeat(LIMITS.title + 1) })).includes("title-invalid"));
  assert.ok(codes(question({ issueId: "Tray" })).includes("id-invalid"), "大文字は不可");
  assert.ok(codes(question({ replaces: "abc" })).includes("id-invalid"), "replaces は依頼 ID");
  assert.deepEqual(validateRequestBlock("{ではない").errors.map((e) => e.code), ["invalid-json"]);
});

test("§2.5 形の検査: question の件数・選択肢・recommended", () => {
  const codes = (b) => validateRequestBlock(b).errors.map((e) => e.code);
  const q1 = question().questions[0];
  assert.ok(codes(question({ questions: [] })).includes("questions-count"));
  assert.ok(codes(question({ questions: [q1, q1, q1, q1] })).includes("questions-count"));
  assert.ok(codes(question({ questions: [{ ...q1, options: [q1.options[0]] }] })).includes("options-count"));
  assert.ok(codes(question({ questions: [{ ...q1, options: q1.options.map((o) => ({ ...o, effect: "" })) }] })).includes("option-invalid"), "effect は必須");
  assert.ok(codes(question({ questions: [{ ...q1, recommended: "none" }] })).includes("recommended-invalid"));
  assert.ok(codes(question({ questions: [{ ...q1, id: "dup" }, { ...q1, id: "dup" }] })).includes("id-duplicate"));
  assert.ok(codes(question({ questions: [{ ...q1, options: [{ id: "__defer", label: "l", effect: "e" }, q1.options[0]] }] })).includes("reserved-option"));
  assert.ok(codes(question({ continueAgent: "gemini" })).includes("continue-agent-invalid"));
  assert.deepEqual(validateRequestBlock(question({ continueAgent: "gpt" }), { agents: ["gpt"] }).errors, [], "対応エージェントは引数で差し替えられる");
});

test("§2.5 形の検査: start-task の tasks / after / basis / パス", () => {
  const codes = (b) => validateRequestBlock(b).errors.map((e) => e.code);
  assert.ok(codes(startTask({ outcome: "" })).includes("outcome-invalid"));
  assert.ok(codes(startTask({ scope: [] })).includes("scope-invalid"));
  assert.ok(codes(startTask({ tasks: [] })).includes("tasks-count"));
  assert.ok(codes(startTask({ tasks: Array.from({ length: LIMITS.tasks + 1 }, (_, i) => ({ key: "k" + i, agent: "claude", title: "t", scope: ["s"] })) })).includes("tasks-count"));
  assert.ok(codes(startTask({ tasks: [{ key: "a", agent: "nobody", title: "t", scope: ["s"] }] })).includes("task-invalid"));
  assert.ok(codes(startTask({ tasks: [{ key: "a", agent: "claude", title: "t", scope: ["s"], after: ["a"] }] })).includes("task-after-invalid"), "自己参照");
  assert.ok(
    codes(startTask({ tasks: [{ key: "a", agent: "claude", title: "t", scope: ["s"], after: ["b"] }, { key: "b", agent: "codex", title: "t", scope: ["s"] }] })).includes("task-after-invalid"),
    "前方参照"
  );
  assert.ok(codes(startTask({ baseCommit: "457acf6" })).includes("base-commit-invalid"), "短縮 ID は不可");
  assert.ok(codes(startTask({ basis: { relayId: RELAY, memo: "topics/t/m.md" } })).includes("basis-invalid"));
  assert.ok(codes(startTask({ basis: {} })).includes("basis-invalid"));
  assert.ok(codes(startTask({ basis: { memo: "../secret.md" } })).includes("path-invalid"));
  assert.ok(codes(startTask({ basis: { memo: "/abs.md" } })).includes("path-invalid"));
  assert.ok(codes(startTask({ details: ["threads/x.md"] })).includes("path-invalid"), "topics/ 起点でない");
  assert.deepEqual(validateRequestBlock(startTask({ basis: { memo: "topics/abc/合意メモ.md" }, details: ["topics/abc/契約.md"] })).errors, []);
});

test("§2.5 形の検査: dependsOn / exclude", () => {
  const codes = (b) => validateRequestBlock(b).errors.map((e) => e.code);
  assert.ok(codes(startTask({ dependsOn: ["nope"] })).includes("depends-invalid"));
  // 重複は dependsOn / exclude 専用の code で出す（§2.5 で両 code に「重複」が挙がっている。特定が一般に優先）
  assert.ok(codes(startTask({ dependsOn: [RID(1), RID(1)] })).includes("depends-invalid"));
  assert.ok(codes(startTask({ exclude: [{ id: RID(1), reason: "a" }, { id: RID(1), reason: "b" }] })).includes("exclude-invalid"));
  assert.ok(codes(startTask({ exclude: [{ id: RID(1) }] })).includes("exclude-reason-invalid"), "理由は必須");
  assert.ok(codes(startTask({ exclude: [{ id: RID(1), reason: "   " }] })).includes("exclude-reason-invalid"), "空白だけは不可");
  assert.ok(codes(startTask({ exclude: [{ id: RID(1), reason: "あ".repeat(LIMITS.excludeReason + 1) }] })).includes("exclude-reason-invalid"));
  assert.ok(codes(startTask({ dependsOn: [RID(1)], exclude: [{ id: RID(1), reason: "r" }] })).includes("depends-exclude-overlap"));
});

// ---- §3 正規形と版ハッシュ ----

const hashOf = (block, over = {}) => computeProposalSha256({ topicId: "T1", proposer: "claude", block, ...over });

test("§3.1/§3.2 版ハッシュ: dependsOn / exclude の記述順は版を変えない", () => {
  const a = startTask({ dependsOn: [RID(1), RID(2)], exclude: [{ id: RID(3), reason: "外す理由" }, { id: RID(4), reason: "別の理由" }] });
  const b = startTask({ dependsOn: [RID(2), RID(1)], exclude: [{ id: RID(4), reason: "別の理由" }, { id: RID(3), reason: "外す理由" }] });
  assert.equal(hashOf(a), hashOf(b));
  // 除外理由は版の一部（件数だけの警告で済ませない）
  const c = startTask({ dependsOn: [RID(1), RID(2)], exclude: [{ id: RID(3), reason: "違う理由" }, { id: RID(4), reason: "別の理由" }] });
  assert.notEqual(hashOf(a), hashOf(c));
});

test("§3.1 正規形: 質問・選択肢・タスクの並べ替えは別版になる", () => {
  const q1 = question().questions[0];
  const q2 = { ...q1, id: "sound", text: "音は", recommended: undefined };
  delete q2.recommended;
  const a = question({ questions: [q1, q2] });
  const b = question({ questions: [q2, q1] });
  assert.notEqual(hashOf(a), hashOf(b), "ユーザーに見える順序が変わる");
  const swapped = question({ questions: [{ ...q1, options: [q1.options[1], q1.options[0]] }] });
  assert.notEqual(hashOf(question()), hashOf(swapped));
});

test("§3.2 版ハッシュ: basis / details の内容 SHA が版に入る。details の並びは効かない", () => {
  const b = startTask();
  const d1 = [["topics/a/x.md", "a".repeat(64)], ["topics/a/y.md", "b".repeat(64)]];
  const base = hashOf(b, { basisDigest: { kind: "relay", relayId: RELAY }, detailsDigests: d1 });
  assert.equal(base, hashOf(b, { basisDigest: { kind: "relay", relayId: RELAY }, detailsDigests: [d1[1], d1[0]] }));
  assert.notEqual(base, hashOf(b, { basisDigest: { kind: "relay", relayId: RELAY }, detailsDigests: [d1[0], ["topics/a/y.md", "c".repeat(64)]] }), "メモが書き換わったら別版");
  assert.notEqual(base, hashOf(b, { basisDigest: null, detailsDigests: d1 }));
  assert.notEqual(base, computeProposalSha256({ topicId: "T2", proposer: "claude", block: b, basisDigest: { kind: "relay", relayId: RELAY }, detailsDigests: d1 }), "トピックも版の一部");
  assert.notEqual(base, computeProposalSha256({ topicId: "T1", proposer: "codex", block: b, basisDigest: { kind: "relay", relayId: RELAY }, detailsDigests: d1 }), "提案者も版の一部");
});

test("§3.1 正規形: 省略した任意フィールドは null で埋めない。空白と改行は正規化する", () => {
  const n = normalizeRequestBlock(question({ title: "  空白つき \r\n" }));
  assert.equal(n.title, "空白つき");
  assert.equal("continueAgent" in n, false);
  assert.equal("issueId" in n, false);
  assert.equal(normalizeRequestBlock(startTask()).basis.memo, undefined);
});

test("§3.1/§5.2 正規形: dependsOn / exclude は常に配列になる（省略と同じ集合の明示が同じ版）", () => {
  const n = normalizeRequestBlock(question());
  assert.deepEqual(n.dependsOn, []);
  assert.deepEqual(n.exclude, []);
  // 受理時に展開した集合を書き戻すので、空配列の明示と省略も同じ版
  assert.equal(hashOf(startTask({ dependsOn: [RID(2), RID(1)], exclude: [] })), hashOf(startTask({ dependsOn: [RID(1), RID(2)] })));
  assert.equal(hashOf(startTask({ dependsOn: [] })), hashOf(startTask()), "候補が無ければ展開後も空");
});

test("§9.3/§10.4 冪等キー: 版が違えば別、taskKey を足せば別", () => {
  const s1 = "aa".repeat(32);
  const s2 = "bb".repeat(32);
  assert.equal(idempotencyKey(RID(1), s1), idempotencyKey(RID(1), s1));
  assert.notEqual(idempotencyKey(RID(1), s1), idempotencyKey(RID(1), s2));
  assert.notEqual(idempotencyKey(RID(1), s1), idempotencyKey(RID(2), s1));
  assert.notEqual(idempotencyKey(RID(1), s1), idempotencyKey(RID(1), s1, "ui"));
  assert.equal(idempotencyKey(RID(1), s1, "ui"), idempotencyKey(RID(1), s1, "ui"));
  assert.notEqual(idempotencyKey(RID(1), s1, "ui"), idempotencyKey(RID(1), s1, "api"));
});

// ---- §5 依存候補と被覆 ----

const req = (n, over = {}) => ({ id: RID(n), topicId: "T1", kind: "question", status: "pending", relayId: RELAY, ts: n, ...over });

test("§5.1 候補: basis.relayId はその質疑、basis.memo は同じトピック全部。pending / parked のみ", () => {
  const requests = [
    req(1),
    req(2, { status: "parked" }),
    req(3, { status: "answered" }),
    req(4, { relayId: "0000000000000000" }),
    req(5, { topicId: "T2" }),
    req(6, { kind: "start-task" }),
    req(7, { status: "revision-requested" }),
  ];
  assert.deepEqual(dependencyCandidates({ basis: { relayId: RELAY }, requests, topicId: "T1" }), [RID(1), RID(2)]);
  assert.deepEqual(dependencyCandidates({ basis: { memo: "topics/T1/m.md" }, requests, topicId: "T1" }), [RID(1), RID(2), RID(4)]);
  assert.deepEqual(dependencyCandidates({ basis: { memo: "topics/T2/m.md" }, requests, topicId: "T2" }), [RID(5)]);
});

test("§5.2 展開: 省略・dependsOn のみ・exclude のみ・両方・空配列の 5 通り", () => {
  const cands = [RID(1), RID(2)];
  const r = (block) => resolveDependencies({ block, candidates: cands });

  // 1. 省略 → 候補すべてを待つ
  assert.deepEqual(r(startTask()).dependsOn, cands);
  assert.equal(r(startTask()).ok, true);

  // 2. dependsOn だけ（全部被覆）
  assert.deepEqual(r(startTask({ dependsOn: cands })).dependsOn, cands);
  // 2'. dependsOn だけ（未被覆 → 拒否）
  const uncovered = r(startTask({ dependsOn: [RID(1)] }));
  assert.equal(uncovered.ok, false);
  assert.deepEqual(uncovered.errors.map((e) => e.code), ["dependency-uncovered"]);

  // 3. exclude だけ → 外した以外を待つ。被覆は求めない
  const excOnly = r(startTask({ exclude: [{ id: RID(1), reason: "今回は不要" }] }));
  assert.equal(excOnly.ok, true);
  assert.deepEqual(excOnly.dependsOn, [RID(2)]);

  // 4. 両方（未被覆があれば拒否）
  assert.equal(r(startTask({ dependsOn: [RID(2)], exclude: [{ id: RID(1), reason: "不要" }] })).ok, true);
  assert.equal(r(startTask({ dependsOn: [], exclude: [{ id: RID(1), reason: "不要" }] })).ok, false);

  // 5. dependsOn: [] は候補が無いか、全部を理由付きで外したときだけ
  assert.equal(resolveDependencies({ block: startTask({ dependsOn: [] }), candidates: [] }).ok, true);
  assert.equal(r(startTask({ dependsOn: [] })).ok, false);
  assert.equal(r(startTask({ dependsOn: [], exclude: cands.map((id) => ({ id, reason: "範囲外" })) })).ok, true);
});

test("§5.3 受理時の検査: exclude-not-candidate と dependency-invalid", () => {
  const cands = [RID(1)];
  const notCand = resolveDependencies({ block: startTask({ exclude: [{ id: RID(9), reason: "外す" }] }), candidates: cands });
  assert.ok(notCand.errors.some((e) => e.code === "exclude-not-candidate"));

  const requests = [req(1), req(5, { topicId: "T2" }), req(6, { kind: "start-task" })];
  // 候補外でも同じトピックの質問なら明示できる
  assert.equal(resolveDependencies({ block: startTask({ dependsOn: [RID(1)] }), candidates: cands, requests, topicId: "T1" }).ok, true);
  const bad = resolveDependencies({ block: startTask({ dependsOn: [RID(1), RID(5), RID(6), RID(8)] }), candidates: cands, requests, topicId: "T1" });
  assert.deepEqual(
    bad.errors.filter((e) => e.code === "dependency-invalid").map((e) => e.path),
    ["dependsOn/" + RID(5), "dependsOn/" + RID(6), "dependsOn/" + RID(8)],
    "別トピック・質問でない・存在しない"
  );
});

// ---- §8 実行不可理由 ----

const proposal = (over = {}) => ({
  id: RID(100),
  topicId: "T1",
  kind: "start-task",
  status: "pending",
  proposer: "claude",
  block: normalizeRequestBlock(startTask()),
  acceptedDependsOn: [],
  acceptedExclude: [],
  ts: 100,
  ...over,
});

const ctx = (over = {}) => ({
  participants: ["claude", "codex"],
  agents: { claude: { auto: true, authed: true }, codex: { auto: true, authed: true }, grok: { auto: true, authed: true } },
  budgetHalt: null,
  ...over,
});

test("§8 依存: pending / parked は押せない。answered で解ける。superseded は dependency-changed", () => {
  const codes = (depStatus) =>
    evaluateBlockers({
      request: proposal({ acceptedDependsOn: [RID(1)] }),
      requests: [req(1, { status: depStatus })],
      ...ctx(),
    }).map((b) => b.code);
  assert.deepEqual(codes("pending"), ["dependency-unresolved"]);
  assert.deepEqual(codes("parked"), ["dependency-unresolved"], "退避しても依存は解除されない");
  assert.deepEqual(codes("revision-requested"), ["dependency-unresolved"]);
  assert.deepEqual(codes("answered"), []);
  assert.deepEqual(codes("superseded"), ["dependency-changed"]);
  assert.deepEqual(codes("cancelled"), ["dependency-changed"]);
  assert.deepEqual(
    evaluateBlockers({ request: proposal({ acceptedDependsOn: [RID(9)] }), requests: [], ...ctx() }).map((b) => b.code),
    ["dependency-changed"],
    "依存先ごと消えていた場合"
  );
});

test("§8 被覆の再評価: 候補が増えたら dependency-coverage-changed。除外済み・依存済みは増えない", () => {
  const r = proposal({ acceptedDependsOn: [RID(1)], acceptedExclude: [{ id: RID(2), reason: "範囲外" }] });
  const requests = [req(1, { status: "answered" }), req(2, { status: "pending" })];
  assert.deepEqual(evaluateBlockers({ request: r, requests, candidates: [RID(1), RID(2)], ...ctx() }).map((b) => b.code), []);
  const grown = evaluateBlockers({ request: r, requests: [...requests, req(3)], candidates: [RID(1), RID(2), RID(3)], ...ctx() });
  assert.deepEqual(grown.map((b) => b.code), ["dependency-coverage-changed"]);
  assert.equal(grown[0].severity, "block", "提案者が出し直すまで着手不可");
  // candidates を渡さなければ requests と basis から自分で導く（サーバと UI で導き方をずらさない）
  const derived = evaluateBlockers({ request: r, requests: [...requests, req(3)], ...ctx() });
  assert.deepEqual(derived.map((b) => b.code), ["dependency-coverage-changed"]);
  assert.deepEqual(evaluateBlockers({ request: r, requests, ...ctx() }), [], "増えていなければ何も出ない");
});

test("§5.1 候補: トピックを渡さなければ relayId だけで絞る（質疑は 1 トピックに属する）", () => {
  const requests = [req(1), req(2, { topicId: "T2" })];
  assert.deepEqual(dependencyCandidates({ basis: { relayId: RELAY }, requests }), [RID(1), RID(2)]);
  assert.deepEqual(dependencyCandidates({ basis: { relayId: RELAY }, requests, topicId: "T1" }), [RID(1)]);
});

test("§8 担当・予算・基点・メモ: severity で「押せない」と「送信保留」を分ける", () => {
  const find = (bs, code) => bs.find((b) => b.code === code);
  const offs = evaluateBlockers({ request: proposal(), requests: [], ...ctx({ agents: { claude: { auto: false, authed: true }, codex: { auto: true, authed: true } } }) });
  assert.equal(find(offs, "agent-auto-off").severity, "send", "承認はできる");
  assert.equal(find(offs, "agent-auto-off").target, "claude");

  const halted = evaluateBlockers({ request: proposal(), requests: [], ...ctx({ budgetHalt: { reason: "上限" } }) });
  assert.equal(find(halted, "budget-halt").severity, "send");

  const notPart = evaluateBlockers({ request: proposal(), requests: [], ...ctx({ participants: ["claude"] }) });
  assert.equal(find(notPart, "assignee-not-participant").severity, "block");
  assert.equal(find(notPart, "assignee-not-participant").target, "codex");

  const grokTask = proposal({ block: normalizeRequestBlock(startTask({ tasks: [{ key: "a", agent: "grok", title: "t", scope: ["s"] }] })) });
  const unauth = evaluateBlockers({ request: grokTask, requests: [], ...ctx({ participants: ["grok"], agents: { grok: { auto: true, authed: null } } }) });
  assert.equal(find(unauth, "agent-unauthed").severity, "send");

  for (const [key, code] of [["basisStatus", "basis-changed"], ["baseCommitStatus", "base-commit-unverified"]]) {
    const bad = key === "basisStatus" ? { basisStatus: "changed" } : { baseCommitStatus: "not-found" };
    const bs = evaluateBlockers({ request: proposal(), requests: [], ...ctx(), ...bad });
    assert.equal(find(bs, code).severity, "block", code);
  }
  const det = evaluateBlockers({ request: proposal(), requests: [], ...ctx(), detailsStatus: { "topics/a/x.md": "missing" } });
  assert.equal(find(det, "details-changed").target, "topics/a/x.md");
});

test("§8 head-moved は警告だけ（基点や担当を自動変更しない）", () => {
  const bs = evaluateBlockers({ request: proposal(), requests: [], ...ctx(), head: "0".repeat(40) });
  assert.deepEqual(bs.map((b) => b.code), ["head-moved"]);
  assert.equal(bs[0].severity, "warn");
  assert.deepEqual(evaluateBlockers({ request: proposal(), requests: [], ...ctx(), head: COMMIT }), []);
});

test("§8 質問には担当・基点の理由を付けない（依存だけ見る）", () => {
  const q = { ...proposal(), kind: "question", block: normalizeRequestBlock(question()), acceptedDependsOn: [] };
  assert.deepEqual(evaluateBlockers({ request: q, requests: [], ...ctx({ participants: [], budgetHalt: { reason: "上限" } }) }), []);
});

// ---- §4.2 遷移 ----

test("§4.2 遷移: 終端からは動かない。park は pending から、unpark は parked から", () => {
  for (const s of TERMINAL_STATES) for (const a of ["answer", "approve", "reject", "revision", "park", "unpark", "supersede", "cancel"]) assert.equal(canTransition(s, a), false, `${s}/${a}`);
  assert.equal(canTransition("pending", "park"), true);
  assert.equal(canTransition("parked", "park"), false);
  assert.equal(canTransition("parked", "unpark"), true);
  assert.equal(canTransition("parked", "answer"), true, "退避中でも回答できる");
  assert.equal(canTransition("revision-requested", "approve"), false, "修正待ちは承認できない");
  assert.equal(canTransition("revision-requested", "supersede"), true);
  assert.equal(canTransition("pending", "unknown-action"), false);
  assert.deepEqual(REQUEST_STATES.filter((s) => !TERMINAL_STATES.includes(s)), ["pending", "parked", "revision-requested"]);
});

// ---- §10 承認計画 ----

test("§10.1/§10.2 計画: after なしは ready、after ありは前提が done になるまで waiting", () => {
  const entries = planFromTasks({ tasks: startTask().tasks, taskIds: { contract: "t1", ui: "t2" } });
  assert.deepEqual(entries.map((e) => [e.key, e.agent, e.taskId, e.send]), [
    ["contract", "claude", "t1", "ready"],
    ["ui", "codex", "t2", "waiting"],
  ]);
  const opts = (status) => ({ entries, tasks: [{ id: "t1", status }], participants: ["claude", "codex"] });
  assert.equal(planSendState(entries[1], opts("queued")), "waiting");
  assert.equal(planSendState(entries[1], opts("returned")), "waiting", "結果到着では後続を開始しない");
  assert.equal(planSendState(entries[1], opts("done")), "ready");
  assert.equal(planSendState({ ...entries[1], send: "sent" }, opts("queued")), "sent", "送信済みは前提の再評価で戻らない");
  assert.equal(planSendState({ ...entries[1], send: "failed" }, opts("done")), "failed");
  assert.equal(planSendState(entries[0], { ...opts("done"), participants: ["codex"] }), "blocked");
});

test("§10.3 送信条件: sendBlockers が空のときだけ送ってよい", () => {
  const base = { agents: { claude: { auto: true, authed: true } }, participants: ["claude"], budgetHalt: null };
  assert.deepEqual(sendBlockers("claude", base), []);
  assert.deepEqual(sendBlockers("claude", { ...base, agents: { claude: { auto: false, authed: true } } }).map((b) => b.code), ["agent-auto-off"]);
  assert.deepEqual(sendBlockers("claude", { ...base, budgetHalt: { reason: "上限" } }).map((b) => b.code), ["budget-halt"]);
  assert.deepEqual(sendBlockers("grok", { agents: { grok: { auto: true, authed: null } }, participants: ["grok"] }).map((b) => b.code), ["agent-unauthed"]);
  assert.deepEqual(sendBlockers("codex", base).map((b) => b.code), ["assignee-not-participant"]);
});

// ---- §9.1 表示用の構造 ----

test("§9.1 トレイ: 判断待ち／あとで／履歴に分け、履歴は新しい順。actionable は severity=block で落ちる", () => {
  const requests = [
    proposal({ id: RID(101), status: "pending", ts: 10 }),
    proposal({ id: RID(102), status: "parked", ts: 20 }),
    proposal({ id: RID(103), status: "revision-requested", ts: 30 }),
    proposal({ id: RID(104), status: "approved", ts: 40 }),
    proposal({ id: RID(105), status: "rejected", ts: 50 }),
  ];
  const view = buildTrayView({
    requests,
    topics: ["T1", "T2"],
    now: 1000,
    evaluations: { [RID(101)]: { blockers: [{ code: "dependency-unresolved", severity: "block", message: "m", target: RID(1) }] } },
  });
  assert.deepEqual(view.topics.T1.waiting, [RID(101)]);
  assert.deepEqual(view.topics.T1.later, [RID(102), RID(103)]);
  assert.deepEqual(view.topics.T1.history, [RID(105), RID(104)], "履歴は新しい順");
  assert.equal(view.topics.T1.pendingSlotTaken, true);
  assert.deepEqual(view.topics.T2, { waiting: [], later: [], history: [], pendingSlotTaken: false });
  assert.equal(view.requests[RID(101)].actionable.approve, false, "押せない理由があれば承認は不可");
  assert.equal(view.requests[RID(101)].actionable.revision, true, "修正依頼と見送りは選べる");
  assert.equal(view.requests[RID(101)].actionable.reject, true);
  assert.equal(view.requests[RID(102)].actionable.approve, true);
  assert.equal(view.requests[RID(102)].actionable.unpark, true);
  assert.equal(view.requests[RID(104)].actionable.approve, false, "終端");
  assert.equal(view.requests[RID(101)].ageMs, 990, "経過時間は表示に出せる（期限切れで消さない）");
  assert.equal(view.requests[RID(101)].title, "判断トレイの実装に着手したい");
});

// ---- §9.2 共有本文 ----

test("§9.2 共有本文: 選んだ結果・その他・保留を読める形で書く", () => {
  const r = { block: normalizeRequestBlock(question({ questions: [question().questions[0], { id: "sound", text: "音は", options: [{ id: "on", label: "鳴らす", effect: "起動音" }, { id: "off", label: "鳴らさない", effect: "無音" }] }] })) };
  const text = answerSummaryText(r, [
    { questionId: "notify", optionId: "badge" },
    { questionId: "sound", optionId: "__other", text: " 起動音だけ " },
  ]);
  assert.match(text, /「トレイの通知方式」への回答/);
  assert.match(text, /1\. 新着依頼の知らせ方はどれにしますか\n {3}→ バッジだけ（タブに件数を出す）/);
  assert.match(text, /2\. 音は\n {3}→ その他: 起動音だけ$/);
  assert.match(answerSummaryText(r, [{ questionId: "notify", optionId: "__defer" }]), /→ あとで答える（保留）/);
});
