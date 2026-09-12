// 判断トレイ — 依頼ブロックの解析・版ハッシュ・依存被覆・実行可否（契約: 契約-判断トレイAPI.md）
//
// この場所では I/O を行わない。ファイルも git も触らず、必要な状態はすべて引数で受け取る
// （契約 §13.1）。おかげで独立テストはサーバを起動せずに §2・§3・§5・§8・§10 を固定できる。
// 版ハッシュの土台（canonicalJson / sha256Hex）と相対パス検査は verification.mjs のものを使う（再実装しない）。
import { canonicalJson, sha256Hex, checkRelPath } from "./verification.mjs";

// ---- §1 定数 ----
export const TRAY_SCHEMA_VERSION = 1; // 依頼ブロックの v
export const TRAY_HASH_VERSION = 1; // 版ハッシュの先頭要素
export const TRAY_BLOCK_INFO = "u2a2a-request";
export const REQUEST_KINDS = ["question", "start-task"];
export const REQUEST_STATES = ["pending", "parked", "revision-requested", "answered", "approved", "rejected", "superseded", "cancelled"];
export const TERMINAL_STATES = ["answered", "approved", "rejected", "superseded", "cancelled"];
export const ACTIVE_STATES = ["pending", "parked", "revision-requested"];
export const BASIS_KINDS = ["relay", "memo"];
export const REVISION_TARGETS = ["scope", "assignee", "approach", "other"];
export const SYSTEM_OPTIONS = ["__other", "__defer"];
export const PLAN_SEND_STATES = ["waiting", "ready", "sent", "failed", "blocked"];
// tray.mjs は server.mjs を import できない（循環）。既定値を持ち、呼び出し側は options で上書きする
export const TRAY_DEFAULT_AGENTS = ["claude", "codex", "grok"];

export const LIMITS = Object.freeze({
  title: 60,
  outcome: 200,
  questionText: 300,
  optionLabel: 60,
  optionEffect: 120,
  excludeReason: 500,
  note: 2000,
  scopeItem: 200,
  questions: 3,
  options: 5,
  tasks: 8,
  scope: 10,
  details: 5,
});

export const ID_RE = /^[a-z][a-z0-9_-]{0,39}$/; // 質問 ID・選択肢 ID・task key・issueId
export const REQUEST_ID_RE = /^req_[0-9a-f]{16}$/; // 依頼 ID（"req_" + id()）
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const RELAY_ID_RE = /^[0-9a-f]{16}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

// §2.5 形の検査コード（サーバの状態を見ない検査）
export const SHAPE_CODES = Object.freeze({
  "invalid-json": "依頼ブロックが JSON として読めません",
  "version-unsupported": "対応していない v です（v: 1 のみ）",
  "kind-invalid": "kind は question か start-task です",
  "to-invalid": 'to は "user" 固定です',
  "title-invalid": "title は 1〜60 文字です",
  "reserved-field": "サーバが付けるフィールドはブロックに書けません",
  "unknown-field": "スキーマにないキーがあります",
  "questions-count": "questions は 1〜3 問です",
  "id-invalid": "ID の形が不正です",
  "id-duplicate": "同じ配列の中で ID が重複しています",
  "reserved-option": "__other / __defer はシステムが付ける選択肢です",
  "text-invalid": "question.text は 1〜300 文字です",
  "options-count": "選択肢は 2〜5 個です",
  "option-invalid": "選択肢の label（1〜60 文字）と effect（1〜120 文字）は必須です",
  "recommended-invalid": "recommended はその問の選択肢 ID を 1 つだけ指します",
  "continue-agent-invalid": "continueAgent が対応エージェントではありません",
  "outcome-invalid": "outcome は 1〜200 文字です",
  "scope-invalid": "scope は 1〜10 個、各 1〜200 文字です",
  "tasks-count": "tasks は 1〜8 件です",
  "task-invalid": "tasks の key / agent / title / scope の形が不正です",
  "task-after-invalid": "after は自分より前の要素の key だけを指せます",
  "base-commit-invalid": "baseCommit は 40 桁の完全なコミット ID です",
  "basis-invalid": "basis は relayId か memo のどちらか一方です",
  "path-invalid": "パスは topics/ 起点のプール相対パスです",
  "depends-invalid": "dependsOn の形が不正です",
  "exclude-invalid": "exclude の形が不正です",
  "exclude-reason-invalid": "exclude の reason は 1〜500 文字です",
  "depends-exclude-overlap": "同じ ID が dependsOn と exclude の両方にあります",
  "block-multiple": "1 つの応答に依頼ブロックが 2 件以上あります",
});

// §6.2 受理時の検査コード（サーバの状態が要る）
export const ACCEPT_CODES = Object.freeze({
  "not-participant": "提案者がこのトピックの参加者ではありません",
  "continue-agent-not-participant": "continueAgent がこのトピックの参加者ではありません",
  "task-agent-not-participant": "tasks の担当がこのトピックの参加者ではありません",
  "start-task-during-relay": "質疑の進行中は着手提案を出せません（質問のみ）",
  "basis-not-agreed": "合意の成立記録がありません（質疑の終了宣言が受理されているか、合意メモを指してください）",
  "basis-not-found": "basis が指す記録・ファイルが見つかりません",
  "details-not-found": "details のファイルが見つかりません",
  "replaces-not-found": "replaces が指す依頼が同じトピックにありません",
  "pending-conflict": "このトピックには未回答の依頼がすでにあります",
  "dependency-invalid": "dependsOn の先が存在しない／別トピック／質問ではありません",
  "exclude-not-candidate": "exclude の ID が依存候補にありません",
  "dependency-uncovered": "dependsOn にも exclude にも含まれない候補の質問があります",
});

// §8 実行不可理由。severity: block = 押せない / send = 承認はできるが送信は保留 / warn = 警告のみ
export const BLOCKER_CODES = Object.freeze({
  "agent-auto-off": { severity: "send", message: "担当の自動応答が OFF です（ON にすると指示を送れます）" },
  "agent-unauthed": { severity: "send", message: "担当が未認証です" },
  "budget-halt": { severity: "send", message: "上限到達で停止中です（バナーから解除してください）" },
  "assignee-not-participant": { severity: "block", message: "担当がこのトピックの参加者ではありません" },
  "basis-changed": { severity: "block", message: "根拠にしたメモが受付時から変わっています" },
  "details-changed": { severity: "block", message: "details のファイルが受付時から変わっています" },
  "base-commit-unverified": { severity: "block", message: "基点コミットを確認できません" },
  "dependency-unresolved": { severity: "block", message: "依存する質問がまだ回答待ちです" },
  "dependency-changed": { severity: "block", message: "依存先が置換・無効化されています。依存先を書き直してください" },
  "dependency-coverage-changed": { severity: "block", message: "依存候補の質問が増えています。提案を出し直してください" },
  "head-moved": { severity: "warn", message: "現在の HEAD が表示している基点と違います" },
});

// ---- 小道具 ----
const isStr = (v) => typeof v === "string";
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const cp = (s) => Array.from(s).length; // 「文字数」はコードポイントで数える（絵文字を 2 文字にしない）
const nl = (s) => s.replace(/\r\n?/g, "\n");
const tidy = (s) => nl(s).trim();

function inRange(v, max) {
  return isStr(v) && v.trim() !== "" && cp(v.trim()) <= max;
}

// ---- §2.1 抽出 ----
// 情報文字列がちょうど u2a2a-request のフェンス付きコードブロックだけを拾う。
// 引用（行頭 >）の中・他のコードブロックの中・インデントコードブロック（4 スペース／タブ）からは拾わない。
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n`]*)$/;
const QUOTED = /^ {0,3}>/;

export function extractRequestBlocks(text) {
  if (!isStr(text)) return [];
  const lines = nl(text).split("\n");
  const out = [];
  let open = null; // { char, len, info, startLine, body: [] }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      const close = line.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/);
      if (close && close[2][0] === open.char && close[2].length >= open.len) {
        if (open.info === TRAY_BLOCK_INFO) out.push({ raw: open.body.join("\n"), info: open.info, startLine: open.startLine, endLine: i + 1 });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    if (QUOTED.test(line)) continue; // 引用の中は見ない
    if (/^( {4}|\t)/.test(line)) continue; // インデントコードブロック
    const m = line.match(FENCE_OPEN);
    if (m) open = { char: m[2][0], len: m[2].length, info: m[3].trim(), startLine: i + 1, body: [] };
  }
  // 閉じられていないフェンスは採用しない（途中で切れた応答を依頼として受けない）
  return out;
}

// ---- §2.5 形の検査 ----
const COMMON_FIELDS = ["v", "kind", "to", "title", "issueId", "replaces", "dependsOn", "exclude"];
const QUESTION_FIELDS = ["questions", "continueAgent"];
const TASK_FIELDS = ["outcome", "scope", "outOfScope", "tasks", "baseCommit", "basis", "details"];
export const RESERVED_FIELDS = ["id", "proposer", "topicId", "relayId", "status", "proposalSha256", "ts", "acceptedDependsOn", "acceptedExclude", "plan"];

export function validateRequestBlock(raw, { agents = TRAY_DEFAULT_AGENTS } = {}) {
  const errors = [];
  const err = (code, path) => errors.push({ code, path, message: SHAPE_CODES[code] || code });
  let block;
  if (isObj(raw)) block = raw;
  else if (!isStr(raw)) {
    err("invalid-json", "");
    return { ok: false, kind: null, block: null, errors };
  } else {
    try {
      block = JSON.parse(raw);
    } catch {
      err("invalid-json", "");
      return { ok: false, kind: null, block: null, errors };
    }
    if (!isObj(block)) {
      err("invalid-json", "");
      return { ok: false, kind: null, block: null, errors };
    }
  }

  if (block.v !== TRAY_SCHEMA_VERSION) err("version-unsupported", "v");
  const kind = REQUEST_KINDS.includes(block.kind) ? block.kind : null;
  if (!kind) err("kind-invalid", "kind");
  if (block.to !== "user") err("to-invalid", "to");
  if (!inRange(block.title, LIMITS.title)) err("title-invalid", "title");

  // サーバ付与・未知キー（黙って捨てると、次の版で意味を持たせたとき古い提案の解釈が変わる）
  const allowed = new Set([...COMMON_FIELDS, ...(kind === "question" ? QUESTION_FIELDS : kind === "start-task" ? TASK_FIELDS : [...QUESTION_FIELDS, ...TASK_FIELDS])]);
  for (const k of Object.keys(block)) {
    if (RESERVED_FIELDS.includes(k)) err("reserved-field", k);
    else if (!allowed.has(k)) err("unknown-field", k);
  }

  if (block.issueId !== undefined && !(isStr(block.issueId) && ID_RE.test(block.issueId))) err("id-invalid", "issueId");
  if (block.replaces !== undefined && !(isStr(block.replaces) && REQUEST_ID_RE.test(block.replaces))) err("id-invalid", "replaces");

  checkRelations(block, errors, err);
  if (kind === "question") checkQuestion(block, errors, err, agents);
  if (kind === "start-task") checkStartTask(block, errors, err, agents);

  return { ok: errors.length === 0, kind, block: errors.length === 0 ? block : null, errors };
}

function checkRelations(block, errors, err) {
  const dep = block.dependsOn;
  const exc = block.exclude;
  const depIds = [];
  if (dep !== undefined) {
    if (!Array.isArray(dep)) err("depends-invalid", "dependsOn");
    else {
      const seen = new Set();
      dep.forEach((v, i) => {
        // 重複は id-duplicate ではなく depends-invalid（§2.5 で dependsOn 専用の code に「重複」が挙がっている。特定が一般に優先する）
        if (!(isStr(v) && REQUEST_ID_RE.test(v))) err("depends-invalid", `dependsOn[${i}]`);
        else if (seen.has(v)) err("depends-invalid", `dependsOn[${i}]`);
        else {
          seen.add(v);
          depIds.push(v);
        }
      });
    }
  }
  const excIds = [];
  if (exc !== undefined) {
    if (!Array.isArray(exc)) err("exclude-invalid", "exclude");
    else {
      const seen = new Set();
      exc.forEach((e, i) => {
        if (!isObj(e) || !isStr(e.id) || !REQUEST_ID_RE.test(e.id) || Object.keys(e).some((k) => k !== "id" && k !== "reason")) {
          err("exclude-invalid", `exclude[${i}]`);
          return;
        }
        if (seen.has(e.id)) err("exclude-invalid", `exclude[${i}].id`); // 同上（§2.5 の exclude-invalid に「ID 重複」）
        else {
          seen.add(e.id);
          excIds.push(e.id);
        }
        if (!inRange(e.reason, LIMITS.excludeReason)) err("exclude-reason-invalid", `exclude[${i}].reason`);
      });
    }
  }
  for (const id of depIds) if (excIds.includes(id)) err("depends-exclude-overlap", "dependsOn");
}

function checkQuestion(block, errors, err, agents) {
  const qs = block.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > LIMITS.questions) {
    err("questions-count", "questions");
    return;
  }
  const qIds = new Set();
  qs.forEach((q, i) => {
    const at = `questions[${i}]`;
    if (!isObj(q)) {
      err("questions-count", at);
      return;
    }
    for (const k of Object.keys(q)) if (!["id", "text", "options", "recommended"].includes(k)) err("unknown-field", `${at}.${k}`);
    if (!(isStr(q.id) && ID_RE.test(q.id))) err("id-invalid", `${at}.id`);
    else if (qIds.has(q.id)) err("id-duplicate", `${at}.id`);
    else qIds.add(q.id);
    if (!inRange(q.text, LIMITS.questionText)) err("text-invalid", `${at}.text`);
    const opts = q.options;
    if (!Array.isArray(opts) || opts.length < 2 || opts.length > LIMITS.options) {
      err("options-count", `${at}.options`);
      return;
    }
    const oIds = new Set();
    opts.forEach((o, j) => {
      const oat = `${at}.options[${j}]`;
      if (!isObj(o)) {
        err("option-invalid", oat);
        return;
      }
      for (const k of Object.keys(o)) if (!["id", "label", "effect"].includes(k)) err("unknown-field", `${oat}.${k}`);
      if (SYSTEM_OPTIONS.includes(o.id)) err("reserved-option", `${oat}.id`);
      else if (!(isStr(o.id) && ID_RE.test(o.id))) err("id-invalid", `${oat}.id`);
      else if (oIds.has(o.id)) err("id-duplicate", `${oat}.id`);
      else oIds.add(o.id);
      // 「押した結果を明記する」ため effect は必須（合意メモ §7）
      if (!inRange(o.label, LIMITS.optionLabel) || !inRange(o.effect, LIMITS.optionEffect)) err("option-invalid", oat);
    });
    if (q.recommended !== undefined && !oIds.has(q.recommended)) err("recommended-invalid", `${at}.recommended`);
  });
  if (block.continueAgent !== undefined && !agents.includes(block.continueAgent)) err("continue-agent-invalid", "continueAgent");
}

function checkStartTask(block, errors, err, agents) {
  if (!inRange(block.outcome, LIMITS.outcome)) err("outcome-invalid", "outcome");
  checkScopeList(block.scope, "scope", 1, errors, err);
  if (block.outOfScope !== undefined) checkScopeList(block.outOfScope, "outOfScope", 0, errors, err);

  const tasks = block.tasks;
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > LIMITS.tasks) err("tasks-count", "tasks");
  else {
    const keys = [];
    tasks.forEach((t, i) => {
      const at = `tasks[${i}]`;
      if (!isObj(t)) {
        err("task-invalid", at);
        return;
      }
      for (const k of Object.keys(t)) if (!["key", "agent", "title", "scope", "after"].includes(k)) err("unknown-field", `${at}.${k}`);
      if (!(isStr(t.key) && ID_RE.test(t.key))) err("id-invalid", `${at}.key`);
      else if (keys.includes(t.key)) err("id-duplicate", `${at}.key`);
      if (!agents.includes(t.agent)) err("task-invalid", `${at}.agent`);
      if (!inRange(t.title, LIMITS.title)) err("task-invalid", `${at}.title`);
      checkScopeList(t.scope, `${at}.scope`, 1, errors, err);
      if (t.after !== undefined) {
        if (!Array.isArray(t.after)) err("task-after-invalid", `${at}.after`);
        else {
          const seen = new Set();
          t.after.forEach((k, j) => {
            // 前方参照・自己参照を禁じれば循環は起きないが、読み手のために条件を分けて書く
            if (!isStr(k) || k === t.key || !keys.includes(k) || seen.has(k)) err("task-after-invalid", `${at}.after[${j}]`);
            else seen.add(k);
          });
        }
      }
      if (isStr(t.key) && ID_RE.test(t.key)) keys.push(t.key);
    });
  }

  if (!(isStr(block.baseCommit) && COMMIT_RE.test(block.baseCommit))) err("base-commit-invalid", "baseCommit");

  const b = block.basis;
  if (!isObj(b)) err("basis-invalid", "basis");
  else {
    const hasRelay = b.relayId !== undefined;
    const hasMemo = b.memo !== undefined;
    const extra = Object.keys(b).some((k) => k !== "relayId" && k !== "memo");
    if (hasRelay === hasMemo || extra) err("basis-invalid", "basis");
    else if (hasRelay && !(isStr(b.relayId) && RELAY_ID_RE.test(b.relayId))) err("basis-invalid", "basis.relayId");
    else if (hasMemo && !isPoolPath(b.memo)) err("path-invalid", "basis.memo");
  }

  if (block.details !== undefined) {
    if (!Array.isArray(block.details) || block.details.length > LIMITS.details) err("path-invalid", "details");
    else block.details.forEach((p, i) => (isPoolPath(p) ? null : err("path-invalid", `details[${i}]`)));
  }
}

function checkScopeList(list, at, min, errors, err) {
  if (!Array.isArray(list) || list.length < min || list.length > LIMITS.scope) {
    err(at.endsWith("scope") && at.startsWith("tasks") ? "task-invalid" : "scope-invalid", at);
    return;
  }
  list.forEach((s, i) => {
    if (!inRange(s, LIMITS.scopeItem)) err(at.startsWith("tasks") ? "task-invalid" : "scope-invalid", `${at}[${i}]`);
  });
}

function isPoolPath(p) {
  return isStr(p) && checkRelPath(p) === null && p.startsWith("topics/");
}

// ---- §3.1 正規形 ----
// dependsOn / exclude だけを整列する。questions / options / tasks はユーザーに見える順序なので並べ替えない。
export function normalizeRequestBlock(block) {
  if (!isObj(block)) throw new TypeError("normalizeRequestBlock: オブジェクトを渡してください");
  const out = { v: TRAY_SCHEMA_VERSION, kind: block.kind, to: "user", title: tidy(block.title) };
  if (block.issueId !== undefined) out.issueId = block.issueId;
  if (block.replaces !== undefined) out.replaces = block.replaces;
  // dependsOn / exclude は正規形では常に配列として現れる（未指定は []）。
  // 受理時に展開した集合をここへ書き戻すので（§5.2）、「省略」と「同じ集合の明示」が同じ版になる。
  // 他の任意フィールドは §3.1-5 どおりキーごと落とす
  out.dependsOn = [...new Set(block.dependsOn || [])].sort();
  out.exclude = (block.exclude || []).map((e) => ({ id: e.id, reason: tidy(e.reason) })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (block.kind === "question") {
    out.questions = block.questions.map((q) => {
      const o = { id: q.id, text: tidy(q.text), options: q.options.map((x) => ({ id: x.id, label: tidy(x.label), effect: tidy(x.effect) })) };
      if (q.recommended !== undefined) o.recommended = q.recommended;
      return o;
    });
    if (block.continueAgent !== undefined) out.continueAgent = block.continueAgent;
  } else {
    out.outcome = tidy(block.outcome);
    out.scope = block.scope.map(tidy);
    if (block.outOfScope !== undefined) out.outOfScope = block.outOfScope.map(tidy);
    out.tasks = block.tasks.map((t) => {
      const o = { key: t.key, agent: t.agent, title: tidy(t.title), scope: t.scope.map(tidy) };
      if (t.after !== undefined) o.after = t.after.slice();
      return o;
    });
    out.baseCommit = block.baseCommit;
    out.basis = block.basis.relayId !== undefined ? { relayId: block.basis.relayId } : { memo: block.basis.memo };
    if (block.details !== undefined) out.details = block.details.slice();
  }
  return out;
}

// ---- §3.2 版ハッシュ ----
export function computeProposalSha256({ topicId, proposer, block, basisDigest = null, detailsDigests = [] }) {
  if (!isStr(topicId) || !isStr(proposer)) throw new TypeError("computeProposalSha256: topicId と proposer は文字列です");
  const digests = detailsDigests.map(([p, s]) => [p, s]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(canonicalJson([TRAY_HASH_VERSION, topicId, proposer, normalizeRequestBlock(block), basisDigest, digests]));
}

// ---- §5.1 依存候補 ----
// basis が relay ならその質疑の質問、memo なら同じトピックの質問すべて。いずれも pending / parked のみ。
// topicId を渡さない（null / undefined）ときはトピックで絞らない。relayId は 1 本の質疑に固有なので、
// relay を根拠にする場合はそれだけで一意に決まる。
export function dependencyCandidates({ basis, requests = [], topicId = null, relayId = null }) {
  const wantRelay = isObj(basis) && basis.relayId !== undefined ? basis.relayId : null;
  const rid = relayId ?? wantRelay;
  return requests
    .filter((r) => r && (topicId == null || r.topicId === topicId) && r.kind === "question" && (r.status === "pending" || r.status === "parked"))
    .filter((r) => (wantRelay === null ? true : r.relayId === rid))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)))
    .map((r) => r.id);
}

// ---- §5.2 / §5.3 被覆 ----
// requests を渡すと dependency-invalid（存在しない・別トピック・質問でない）も見る。省略時は被覆だけ。
export function resolveDependencies({ block, candidates = [], requests = null, topicId = null }) {
  const errors = [];
  const err = (code, id) => errors.push({ code, path: id ? `dependsOn/${id}` : "dependsOn", message: ACCEPT_CODES[code] || code });
  const hasDep = Array.isArray(block.dependsOn);
  const hasExc = Array.isArray(block.exclude);
  const excl = hasExc ? block.exclude.map((e) => ({ id: e.id, reason: tidy(e.reason) })) : [];
  const exclIds = new Set(excl.map((e) => e.id));

  for (const e of excl) if (!candidates.includes(e.id)) errors.push({ code: "exclude-not-candidate", path: `exclude/${e.id}`, message: ACCEPT_CODES["exclude-not-candidate"] });

  let dependsOn;
  if (!hasDep && !hasExc) dependsOn = candidates.slice(); // 省略 → 候補すべてを待つ
  else if (!hasDep && hasExc) dependsOn = candidates.filter((id) => !exclIds.has(id)); // 外した分以外を待つ
  else dependsOn = [...new Set(block.dependsOn)];

  if (hasDep) {
    const covered = new Set([...dependsOn, ...exclIds]);
    for (const id of candidates) if (!covered.has(id)) errors.push({ code: "dependency-uncovered", path: `候補/${id}`, message: ACCEPT_CODES["dependency-uncovered"] });
  }
  if (Array.isArray(requests)) {
    const byId = new Map(requests.filter(Boolean).map((r) => [r.id, r]));
    for (const id of dependsOn) {
      const r = byId.get(id);
      if (!r || (topicId !== null && r.topicId !== topicId) || r.kind !== "question") err("dependency-invalid", id);
    }
  }
  return { ok: errors.length === 0, dependsOn: dependsOn.slice().sort(), exclude: excl.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), errors };
}

// ---- §8 実行不可理由 ----
export function evaluateBlockers({
  request,
  requests = [],
  participants = [],
  agents = {},
  budgetHalt = null,
  basisStatus = "ok",
  detailsStatus = {},
  baseCommitStatus = "verified",
  head = null,
  candidates = undefined, // 省略時はこの関数が requests から導く（契約 §13.1 の引数一覧に candidates は無い）
}) {
  const out = [];
  const seen = new Set();
  const add = (code, target = null) => {
    const key = code + " " + (target ?? "");
    if (seen.has(key)) return; // 同じ担当が 2 件のタスクを持つときに同じ理由を重ねない
    seen.add(key);
    out.push({ code, target, severity: BLOCKER_CODES[code].severity, message: BLOCKER_CODES[code].message });
  };
  if (!isObj(request)) return out;
  const block = request.block || {};

  if (request.kind === "start-task") {
    for (const t of block.tasks || []) {
      if (!participants.includes(t.agent)) add("assignee-not-participant", t.agent);
      else {
        const a = agents[t.agent] || {};
        if (a.auto === false) add("agent-auto-off", t.agent);
        if (t.agent === "grok" && a.authed !== true) add("agent-unauthed", t.agent);
      }
    }
    if (budgetHalt) add("budget-halt");
    if (basisStatus !== "ok") add("basis-changed", request.basisDigest ? request.basisDigest.path || null : null);
    for (const [p, st] of Object.entries(detailsStatus)) if (st !== "ok") add("details-changed", p);
    if (baseCommitStatus !== "verified") add("base-commit-unverified", block.baseCommit || null);
  }

  const byId = new Map(requests.filter(Boolean).map((r) => [r.id, r]));
  for (const id of request.acceptedDependsOn || []) {
    const dep = byId.get(id);
    // 未知の状態を「回答済み」として自動解除しない（合意メモ §8.4）
    if (!dep || dep.status === "superseded" || dep.status === "cancelled") add("dependency-changed", id);
    else if (dep.status !== "answered") add("dependency-unresolved", id);
  }
  // 被覆の再検査。候補は渡されなければここで導く（サーバと UI で導き方がずれないように 1 か所にまとめる）
  if (request.kind === "start-task") {
    const now = Array.isArray(candidates)
      ? candidates
      : dependencyCandidates({ basis: block.basis, requests, topicId: request.topicId ?? null, relayId: request.relayId ?? null });
    const known = new Set([...(request.acceptedDependsOn || []), ...(request.acceptedExclude || []).map((e) => e.id)]);
    for (const id of now) if (!known.has(id) && id !== request.id) add("dependency-coverage-changed", id);
  }
  if (head && block.baseCommit && head !== block.baseCommit) add("head-moved", block.baseCommit);
  return out;
}

// ---- §4.2 遷移 ----
const TRANSITIONS = Object.freeze({
  answer: ["pending", "parked"],
  approve: ["pending", "parked"],
  reject: ["pending", "parked"],
  revision: ["pending", "parked"],
  park: ["pending"],
  unpark: ["parked"],
  supersede: ["pending", "parked", "revision-requested"],
  cancel: ["pending", "parked", "revision-requested"],
});

export function canTransition(status, action) {
  const from = TRANSITIONS[action];
  return !!from && from.includes(status);
}

// ---- §10 承認計画 ----
export function planFromTasks({ tasks = [], taskIds = {} }) {
  return tasks.map((t) => ({
    key: t.key,
    agent: t.agent,
    taskId: taskIds[t.key] ?? null,
    after: (t.after || []).slice(),
    send: (t.after || []).length ? "waiting" : "ready",
    messageId: null,
    error: null,
    sentTs: null,
  }));
}

// 送信状態。"ready" は「前提は揃った」を意味し、送れるかどうかは sendBlockers で別に見る
// （送れるならサーバが送って "sent" にする。送れないあいだは "ready" のまま理由を表示する）。
// after の key から前提タスクを引くために、entries（同じ計画の全要素）か taskByKey（key → taskId）のどちらかが要る
export function planSendState(entry, { entries = [], tasks = [], participants = [], taskByKey = null } = {}) {
  if (entry.send === "sent") return "sent";
  if (!participants.includes(entry.agent)) return "blocked";
  const byId = new Map(tasks.filter(Boolean).map((t) => [t.id, t]));
  const byKey = new Map(entries.filter(Boolean).map((e) => [e.key, e.taskId]));
  const taskIdOf = (key) => (taskByKey && taskByKey[key] !== undefined ? taskByKey[key] : byKey.get(key));
  const prereqDone = (entry.after || []).every((key) => {
    const tid = taskIdOf(key);
    const task = tid ? byId.get(tid) : null;
    return !!task && task.status === "done"; // returned（結果到着）では後続を開始しない
  });
  if (!prereqDone) return "waiting";
  if (entry.send === "failed") return "failed";
  return "ready";
}

// 送信できない理由（§8 の send 判定ぶん）。空なら送ってよい
export function sendBlockers(agent, { agents = {}, budgetHalt = null, participants = [] } = {}) {
  const out = [];
  const add = (code) => out.push({ code, target: agent, severity: BLOCKER_CODES[code].severity, message: BLOCKER_CODES[code].message });
  if (!participants.includes(agent)) add("assignee-not-participant");
  else {
    const a = agents[agent] || {};
    if (a.auto === false) add("agent-auto-off");
    if (agent === "grok" && a.authed !== true) add("agent-unauthed");
  }
  if (budgetHalt) add("budget-halt");
  return out;
}

// ---- 冪等キー（§9.3・§10.4）----
// 承認は (requestId, proposalSha256)、着手指示の再送は taskKey を足す。
// サーバと UI・テストで作り方がずれないよう、文字列の作り方をここ 1 か所に置く
export function idempotencyKey(requestId, proposalSha256, taskKey = null) {
  return canonicalJson(taskKey == null ? [requestId, proposalSha256] : [requestId, proposalSha256, taskKey]);
}

// ---- §9.1 トレイの表示用構造 ----
// evaluations: { [requestId]: { blockers, basis, details, baseCommit, dependencies } }。サーバが作って渡す
export function buildTrayView({ requests = [], topics = [], now = Date.now(), evaluations = {} }) {
  const view = { version: 1, topics: {}, requests: {} };
  const ids = new Set(topics.map((t) => (isStr(t) ? t : t.id)));
  for (const t of ids) view.topics[t] = { waiting: [], later: [], history: [], pendingSlotTaken: false };
  const sorted = requests.filter(Boolean).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)));
  for (const r of sorted) {
    const slot = view.topics[r.topicId] || (view.topics[r.topicId] = { waiting: [], later: [], history: [], pendingSlotTaken: false });
    if (r.status === "pending") {
      slot.waiting.push(r.id);
      slot.pendingSlotTaken = true;
    } else if (r.status === "parked" || r.status === "revision-requested") slot.later.push(r.id);
    else slot.history.unshift(r.id); // 履歴は新しい順
    const ev = evaluations[r.id] || {};
    const blockers = ev.blockers || [];
    view.requests[r.id] = {
      id: r.id,
      topicId: r.topicId,
      kind: r.kind,
      status: r.status,
      proposer: r.proposer,
      proposerName: ev.proposerName || r.proposer,
      title: (r.block && r.block.title) || "",
      ts: r.ts,
      updatedTs: r.updatedTs || r.ts,
      proposalSha256: r.proposalSha256,
      block: r.block,
      basis: ev.basis || null,
      details: ev.details || [],
      baseCommit: ev.baseCommit || null,
      dependencies: ev.dependencies || { waiting: [], excluded: [], coverage: "ok" },
      blockers,
      actionable: actionableFrom(r, blockers),
      answer: r.answer || null,
      decision: r.decision || null,
      plan: r.plan || null,
      supersededBy: r.supersededBy || null,
      replaces: (r.block && r.block.replaces) || null,
      issueId: (r.block && r.block.issueId) || null,
      ageMs: Math.max(0, now - (r.ts || now)),
    };
  }
  return view;
}

function actionableFrom(request, blockers) {
  const hard = blockers.some((b) => b.severity === "block");
  return {
    answer: request.kind === "question" && canTransition(request.status, "answer") && !hard,
    approve: request.kind === "start-task" && canTransition(request.status, "approve") && !hard,
    park: canTransition(request.status, "park"),
    unpark: canTransition(request.status, "unpark"),
    revision: canTransition(request.status, "revision"),
    reject: canTransition(request.status, "reject"),
  };
}

// ---- §9.2 共有メッセージの本文 ----
export function answerSummaryText(request, answers = []) {
  const block = request.block || {};
  const qs = block.questions || [];
  const lines = [`【判断トレイ】「${block.title || ""}」への回答`, ""];
  qs.forEach((q, i) => {
    const a = answers.find((x) => x.questionId === q.id);
    lines.push(`${i + 1}. ${q.text}`);
    if (!a) lines.push("   → （未回答）");
    else if (a.optionId === "__defer") lines.push("   → あとで答える（保留）");
    else if (a.optionId === "__other") lines.push(`   → その他: ${tidy(a.text || "")}`);
    else {
      const o = (q.options || []).find((x) => x.id === a.optionId);
      lines.push(o ? `   → ${o.label}（${o.effect}）` : `   → ${a.optionId}`);
    }
  });
  return lines.join("\n");
}
