// 成果物の版と必須検証の共通モジュール（仕様: SPEC-成果物検証.md／契約: 契約-成果物検証API.md 契約版 2）
// §2 純関数・§3 読取専用 I/O・§5 追記ログの行。サーバと CLI（tools/render-apply.mjs）が共有する。
// UI はこれを複製せず API の応答を使う。ここではコマンドを一切実行しない（manifest の argv は記録にすぎない）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---- §1 定数 ----
export const VERIFICATION_SCHEMA_VERSION = 1;
export const POLICY_VERSION = 1;
export const LOG_LINE_VERSION = 1;
export const ARTIFACT_ROLES = ["patch", "support"];
export const CHECK_RESULTS = ["passed", "failed", "not_run"];
export const SOURCES = ["manifest", "ui", "server"]; // server は予約。初版では付与しない
export const RECORD_TYPES = ["check", "classification"];
export const CLASSIFICATION_DECISIONS = ["test", "not-test", "deletion-accepted"];
export const METHOD_CLASS = Object.freeze({ apply: "git-apply-check", tests: "node-test" });
export const TEST_SUITE_TARGET = "u2a2a/test/*.test.mjs";
export const AGGREGATE_STATUSES = ["unsatisfied", "pending", "declared", "confirmed"];
export const AGGREGATE_LABELS = Object.freeze({
  unsatisfied: "未充足",
  pending: "判定保留",
  declared: "必須検証：申告で充足",
  confirmed: "必須検証：確認済み（UI経路）",
});
export const EVIDENCE_STATUSES = ["none", "ok", "missing", "mismatch", "unreadable", "outside"];

const reason = (category, message) => Object.freeze({ category, message });
export const REASON_CODES = Object.freeze({
  "log-error": reason("integrity", "追記ログを完全には読めていません（読み落とした失敗がありえます）"),
  "manifest-missing": reason("integrity", "manifest.json がありません"),
  "manifest-unreadable": reason("integrity", "manifest.json を読めません"),
  "manifest-json": reason("integrity", "manifest.json を JSON として読めません"),
  "manifest-invalid": reason("integrity", "manifest.json がスキーマに合いません"),
  "schema-unsupported": reason("integrity", "未対応の schemaVersion または kind です"),
  "artifact-missing": reason("integrity", "対象ファイルがありません"),
  "artifact-unreadable": reason("integrity", "対象ファイルを読めません"),
  "artifact-outside": reason("integrity", "対象ファイルの実体が impl フォルダの外にあります"),
  "artifact-sha-mismatch": reason("integrity", "対象ファイルの SHA-256 が宣言と違います"),
  "subject-unavailable": reason("integrity", "現行版を計算できません"),
  "base-commit-unverified": reason("pending", "基点コミットを対象リポジトリで確認できません"),
  "diff-unparsable": reason("pending", "diff を解析できません"),
  "diff-binary": reason("pending", "バイナリ差分を含みます（分類では解除できません）"),
  "test-deleted": reason("pending", "対象テストの削除、または対象外へのリネームがあります"),
  "test-path-unrecognized": reason("pending", "テストルート配下に実行範囲の分からないパスがあります"),
  "test-fixtures-only": reason("pending", "テスト本体の変更を伴わない fixtures の変更があります"),
  "test-candidate-unknown": reason("pending", "テストルート外に実行方法の分からないテスト候補があります"),
  "test-config-changed": reason("pending", "テスト実行設定が変わっています"),
  "check-missing": reason("check", "必須検証の記録がありません"),
  "check-stale": reason("check", "記録はありますが、別の版または別の必須集合に対するものです（変更あり）"),
  "check-failed": reason("check", "最新の結果が失敗です"),
  "check-not-run": reason("check", "最新の結果が未実行です"),
  "evidence-missing": reason("check", "最新の成功の証跡が現在ありません"),
  "evidence-mismatch": reason("check", "最新の成功の証跡の SHA-256 が違います"),
  "evidence-unreadable": reason("check", "最新の成功の証跡を読めません"),
  "evidence-outside": reason("check", "最新の成功の証跡の実体が impl フォルダの外にあります"),
});

const SHA_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CHECK_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
const TIMESTAMP_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/;
const TEST_TARGET_RE = /^u2a2a\/test\/[^/]+\.test\.mjs$/;
const TEST_ROOT = "u2a2a/test/";
const FIXTURES_ROOT = "u2a2a/test/fixtures/";
const TEST_CANDIDATE_RE = /\.(test|spec)\.[^/]+$/;
const TEST_CONFIG_PATH = "u2a2a/package.json";
const TEST_CONFIG_LINE_RE = /"(test|pretest|posttest)"\s*:/;
const RESERVED_ARTIFACTS = ["manifest.json", "APPLY.md"];
const SERVER_FIELDS = ["source", "seq", "receivedAt"];
const MANIFEST_KEYS = ["schemaVersion", "kind", "baseCommit", "artifacts", "checks"];
const ARTIFACT_KEYS = ["path", "role", "sha256"];
const CHECK_KEYS = ["id", "subjectSha256", "policyVersion", "requirementsSha256", "actor", "method", "result", "executedAt", "evidence", "reason"];
const CHECK_REQUIRED = ["id", "subjectSha256", "policyVersion", "requirementsSha256", "actor", "method", "result"];
const LOG_KEYS = ["v", "seq", "receivedAt", "source", "type", "recordSha256", "projectKey", "subjectSha256", "policyVersion", "implDir", "itemId", "payload"];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // JavaScript 文字列比較（localeCompare は使わない）
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const isSha = (v) => typeof v === "string" && SHA_RE.test(v);

function isTimestamp(s) {
  const m = typeof s === "string" && TIMESTAMP_RE.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getUTCHours() === h && t.getUTCMinutes() === mi && t.getUTCSeconds() === se;
}

// ---- §2.1 canonicalJson ----
export function canonicalJson(value) {
  return JSON.stringify(canon(value));
}

function canon(v) {
  if (v === null) return null;
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      if (!Number.isFinite(v)) throw new TypeError("canonicalJson: 有限でない数値は使えません");
      return v;
    case "object": {
      if (Array.isArray(v)) return Array.from(v, canon); // 疎配列の穴は undefined として拒否される
      if (!isPlainObject(v)) throw new TypeError("canonicalJson: 素のオブジェクト以外は使えません");
      const out = {};
      for (const k of Object.keys(v).sort(cmp)) out[k] = canon(v[k]);
      return out;
    }
    default:
      throw new TypeError(`canonicalJson: ${typeof v} は使えません`);
  }
}

// ---- §2.2 sha256Hex ----
export function sha256Hex(input) {
  if (typeof input === "string") return crypto.createHash("sha256").update(input, "utf8").digest("hex");
  if (input instanceof Uint8Array) return crypto.createHash("sha256").update(input).digest("hex");
  throw new TypeError("sha256Hex: string か Uint8Array を渡してください");
}

// ---- §2.3 checkRelPath ----
export function checkRelPath(p) {
  if (typeof p !== "string") return "not-string";
  if (p === "") return "empty";
  if (p.startsWith("/")) return "absolute";
  if (p.includes("\\")) return "backslash";
  const segs = p.split("/");
  if (segs.includes("")) return "empty-segment";
  if (segs.some((s) => s === "." || s === "..")) return "dot-segment";
  return null;
}

// ---- §2.4 validateManifest ----
export function validateManifest(raw) {
  const errors = [];
  const err = (pointer, code, message) => errors.push({ pointer, code, message });
  if (!isPlainObject(raw)) {
    err("", "type", "manifest はオブジェクトです");
    return { ok: false, errors };
  }
  for (const k of Object.keys(raw)) if (!MANIFEST_KEYS.includes(k)) err("/" + k, "unknown-field", `未定義のフィールドです: ${k}`);
  for (const k of MANIFEST_KEYS) if (!(k in raw)) err("/" + k, "required", `${k} は必須です`);
  if ("schemaVersion" in raw && raw.schemaVersion !== VERIFICATION_SCHEMA_VERSION) {
    err("/schemaVersion", typeof raw.schemaVersion === "number" ? "schema-unsupported" : "type", `未対応の schemaVersion です: ${raw.schemaVersion}`);
  }
  if ("kind" in raw && raw.kind !== "patch") err("/kind", typeof raw.kind === "string" ? "kind-unsupported" : "type", `未対応の kind です: ${raw.kind}`);
  if ("baseCommit" in raw) {
    if (typeof raw.baseCommit !== "string") err("/baseCommit", "type", "baseCommit は文字列です");
    else if (!COMMIT_RE.test(raw.baseCommit)) err("/baseCommit", "format", "baseCommit は省略のない小文字 hex（40 桁か 64 桁）です");
  }

  // 証跡のパスは artifacts と重複させない（循環防止）。先に検証行から集める
  const evidencePaths = new Set();
  if ("checks" in raw) {
    if (!Array.isArray(raw.checks)) err("/checks", "type", "checks は配列です");
    else raw.checks.forEach((c, i) => validateCheckLine(c, `/checks/${i}`, err, evidencePaths));
  }
  if ("artifacts" in raw) {
    if (!Array.isArray(raw.artifacts)) err("/artifacts", "type", "artifacts は配列です");
    else if (!raw.artifacts.length) err("/artifacts", "required", "artifacts は 1 件以上必要です");
    else {
      const seen = new Set();
      let patches = 0;
      raw.artifacts.forEach((a, i) => {
        const p = `/artifacts/${i}`;
        if (!isPlainObject(a)) return err(p, "type", "artifact はオブジェクトです");
        for (const k of Object.keys(a)) if (!ARTIFACT_KEYS.includes(k)) err(`${p}/${k}`, "unknown-field", `未定義のフィールドです: ${k}`);
        for (const k of ARTIFACT_KEYS) if (!(k in a)) err(`${p}/${k}`, "required", `${k} は必須です`);
        if ("path" in a) {
          const pc = checkRelPath(a.path);
          if (pc) err(`${p}/path`, pc === "not-string" ? "type" : "path", `パスが不正です（${pc}）`);
          else {
            if (seen.has(a.path)) err(`${p}/path`, "duplicate-path", `パスが重複しています: ${a.path}`);
            seen.add(a.path);
            if (RESERVED_ARTIFACTS.includes(a.path) || evidencePaths.has(a.path)) {
              err(`${p}/path`, "reserved-artifact", `manifest・APPLY.md・証跡は対象ファイルに含められません: ${a.path}`);
            }
          }
        }
        if ("role" in a) {
          if (!ARTIFACT_ROLES.includes(a.role)) err(`${p}/role`, typeof a.role === "string" ? "enum" : "type", "role は patch か support です");
          else if (a.role === "patch") patches++;
        }
        if ("sha256" in a && !isSha(a.sha256)) err(`${p}/sha256`, typeof a.sha256 === "string" ? "format" : "type", "sha256 は 64 桁の小文字 hex です");
      });
      if (patches !== 1) err("/artifacts", "patch-count", `role:patch はちょうど 1 件必要です（${patches} 件）`);
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      schemaVersion: raw.schemaVersion,
      kind: raw.kind,
      baseCommit: raw.baseCommit,
      artifacts: raw.artifacts.map((a) => ({ path: a.path, role: a.role, sha256: a.sha256 })),
      checks: raw.checks.map(normalizeCheck),
    },
  };
}

function validateCheckLine(c, p, err, evidencePaths) {
  if (!isPlainObject(c)) return err(p, "type", "検証行はオブジェクトです");
  for (const k of Object.keys(c)) {
    if (SERVER_FIELDS.includes(k)) err(`${p}/${k}`, "server-field", `${k} はサーバだけが付与します`);
    else if (!CHECK_KEYS.includes(k)) err(`${p}/${k}`, "unknown-field", `未定義のフィールドです: ${k}`);
  }
  for (const k of CHECK_REQUIRED) if (!(k in c)) err(`${p}/${k}`, "required", `${k} は必須です`);
  if ("id" in c && !(typeof c.id === "string" && CHECK_ID_RE.test(c.id))) err(`${p}/id`, typeof c.id === "string" ? "format" : "type", "id は ^[a-z][a-z0-9-]{0,39}$ です");
  for (const k of ["subjectSha256", "requirementsSha256"]) {
    if (k in c && !isSha(c[k])) err(`${p}/${k}`, typeof c[k] === "string" ? "format" : "type", `${k} は 64 桁の小文字 hex です`);
  }
  if ("policyVersion" in c && !(Number.isInteger(c.policyVersion) && c.policyVersion >= 1)) err(`${p}/policyVersion`, "type", "policyVersion は 1 以上の整数です");
  if ("actor" in c && !(typeof c.actor === "string" && c.actor.length >= 1 && c.actor.length <= 80)) err(`${p}/actor`, "type", "actor は 1〜80 文字の文字列です");
  if ("method" in c) validateMethod(c.method, `${p}/method`, err);
  let result = null;
  if ("result" in c) {
    if (CHECK_RESULTS.includes(c.result)) result = c.result;
    else err(`${p}/result`, typeof c.result === "string" ? "enum" : "type", "result は passed / failed / not_run です");
  }
  const executedAt = c.executedAt ?? null;
  if (executedAt !== null && !isTimestamp(executedAt)) err(`${p}/executedAt`, "format", "executedAt は ISO 8601 UTC の日時です");
  const why = c.reason ?? null;
  if (why !== null && typeof why !== "string") err(`${p}/reason`, "type", "reason は文字列か null です");
  const evidence = c.evidence ?? null;
  if (evidence !== null && validateEvidence(evidence, `${p}/evidence`, err)) evidencePaths.add(evidence.path);
  if (result === "not_run") {
    if (executedAt !== null) err(`${p}/executedAt`, "not-run-shape", "not_run の executedAt は null です");
    if (!(typeof why === "string" && why.trim())) err(`${p}/reason`, "reason-required", "not_run には未実行の理由が必要です");
  } else if (result === "passed" || result === "failed") {
    if (executedAt === null) err(`${p}/executedAt`, "required", "passed / failed には executedAt が必要です");
    if (evidence === null) err(`${p}/evidence`, "evidence-required", "passed / failed には証跡が必要です");
  }
}

function validateMethod(m, p, err) {
  if (!isPlainObject(m)) return err(p, "type", "method はオブジェクトです");
  if (m.type === "command") {
    for (const k of Object.keys(m)) if (!["type", "argv", "cwd"].includes(k)) err(`${p}/${k}`, "unknown-field", `未定義のフィールドです: ${k}`);
    if (!Array.isArray(m.argv) || !m.argv.length || m.argv.some((a) => typeof a !== "string" || a === "")) err(`${p}/argv`, "format", "argv は空でない文字列の配列です");
    if (!(m.cwd === "." || checkRelPath(m.cwd) === null)) err(`${p}/cwd`, "path", "cwd はリポジトリルートからの相対位置です");
  } else if (m.type === "manual") {
    for (const k of Object.keys(m)) if (!["type", "description"].includes(k)) err(`${p}/${k}`, "unknown-field", `未定義のフィールドです: ${k}`);
    if (!(typeof m.description === "string" && m.description.trim())) err(`${p}/description`, "required", "description に確認方法が必要です");
  } else {
    err(`${p}/type`, "enum", "method.type は command か manual です");
  }
}

// パスが正しければ true（manifest では証跡パスを artifacts との重複検査に使う）
function validateEvidence(ev, p, err) {
  if (!isPlainObject(ev)) {
    err(p, "type", "evidence はオブジェクトか null です");
    return false;
  }
  for (const k of Object.keys(ev)) if (!["path", "sha256"].includes(k)) err(`${p}/${k}`, "unknown-field", `未定義のフィールドです: ${k}`);
  const pc = checkRelPath(ev.path);
  if (pc) err(`${p}/path`, pc === "not-string" ? "type" : "path", `証跡のパスが不正です（${pc}）`);
  if (!isSha(ev.sha256)) err(`${p}/sha256`, typeof ev.sha256 === "string" ? "format" : "type", "証跡の sha256 は 64 桁の小文字 hex です");
  return !pc;
}

// ---- §4.3 / §4.4 要求本文の検査（契約版 2 に無い追加 export。サーバは本文のスキーマを持たず、これを使う）----
const REASON_MAX = 2000;
const CONFIRM_KEYS = ["subjectSha256", "requirementsSha256", "policyVersion", "actor", "checks"];
const CONFIRM_CHECK_KEYS = ["id", "result", "method", "executedAt", "evidence", "reason"];
const CLASSIFY_KEYS = ["subjectSha256", "policyVersion", "path", "decision", "reason", "method"];

export function validateConfirmRequest(body) {
  const errors = [];
  const err = (pointer, code, message) => errors.push({ pointer, code, message });
  if (!isPlainObject(body)) {
    err("", "type", "本文はオブジェクトです");
    return errors;
  }
  for (const k of Object.keys(body)) if (!CONFIRM_KEYS.includes(k)) err("/" + k, "unknown-field", `未定義のフィールドです: ${k}`);
  for (const k of ["subjectSha256", "requirementsSha256"]) if (!isSha(body[k])) err("/" + k, typeof body[k] === "string" ? "format" : "type", `${k} は 64 桁の小文字 hex です`);
  if (!Number.isInteger(body.policyVersion)) err("/policyVersion", "type", "policyVersion は整数です");
  if (body.actor !== undefined && !(typeof body.actor === "string" && body.actor.length >= 1 && body.actor.length <= 80)) err("/actor", "type", "actor は 1〜80 文字の文字列です");
  if (!Array.isArray(body.checks) || !body.checks.length) {
    err("/checks", "required", "checks は 1 件以上必要です");
    return errors;
  }
  const ids = new Set();
  body.checks.forEach((c, i) => {
    const p = `/checks/${i}`;
    if (!isPlainObject(c)) return err(p, "type", "検証項目はオブジェクトです");
    for (const k of Object.keys(c)) {
      if (SERVER_FIELDS.includes(k)) err(`${p}/${k}`, "server-field", `${k} はサーバだけが付与します`);
      else if (!CONFIRM_CHECK_KEYS.includes(k)) err(`${p}/${k}`, "unknown-field", `未定義のフィールドです: ${k}`);
    }
    if (!(typeof c.id === "string" && CHECK_ID_RE.test(c.id))) err(`${p}/id`, typeof c.id === "string" ? "format" : "type", "id は ^[a-z][a-z0-9-]{0,39}$ です");
    else if (ids.has(c.id)) err(`${p}/id`, "duplicate-in-request", `同じ id が要求内で重複しています: ${c.id}`);
    else ids.add(c.id);
    if (!CHECK_RESULTS.includes(c.result)) err(`${p}/result`, typeof c.result === "string" ? "enum" : "type", "result は passed / failed / not_run です");
    validateMethod(c.method, `${p}/method`, err);
    const executedAt = c.executedAt ?? null;
    if (executedAt !== null && !isTimestamp(executedAt)) err(`${p}/executedAt`, "format", "executedAt は ISO 8601 UTC の日時です");
    const why = c.reason ?? null;
    if (why !== null && !(typeof why === "string" && why.length <= REASON_MAX)) err(`${p}/reason`, "type", "reason は 2000 文字以内の文字列か null です");
    const evidence = c.evidence ?? null;
    if (evidence !== null) validateEvidence(evidence, `${p}/evidence`, err);
    if (c.result === "not_run") {
      if (executedAt !== null) err(`${p}/executedAt`, "not-run-shape", "not_run の executedAt は null です");
      if (!(typeof why === "string" && why.trim())) err(`${p}/reason`, "reason-required", "not_run には未実行の理由が必要です");
    } else if ((c.result === "passed" || c.result === "failed") && isPlainObject(c.method) && c.method.type === "command" && evidence === null) {
      err(`${p}/evidence`, "evidence-required", "コマンドで確かめた passed / failed には証跡が必要です");
    }
  });
  return errors;
}

export function validateClassifyRequest(body) {
  const errors = [];
  const err = (pointer, code, message) => errors.push({ pointer, code, message });
  if (!isPlainObject(body)) {
    err("", "type", "本文はオブジェクトです");
    return errors;
  }
  for (const k of Object.keys(body)) if (!CLASSIFY_KEYS.includes(k)) err("/" + k, "unknown-field", `未定義のフィールドです: ${k}`);
  if (!isSha(body.subjectSha256)) err("/subjectSha256", typeof body.subjectSha256 === "string" ? "format" : "type", "subjectSha256 は 64 桁の小文字 hex です");
  if (!Number.isInteger(body.policyVersion)) err("/policyVersion", "type", "policyVersion は整数です");
  const pc = checkRelPath(body.path);
  if (pc) err("/path", pc === "not-string" ? "type" : "path", `path はリポジトリ相対のパスです（${pc}）`);
  if (!CLASSIFICATION_DECISIONS.includes(body.decision)) err("/decision", typeof body.decision === "string" ? "enum" : "type", "decision は test / not-test / deletion-accepted です");
  if (!(typeof body.reason === "string" && body.reason.trim() && body.reason.length <= REASON_MAX)) err("/reason", "required", "reason は 1〜2000 文字で必須です");
  if (body.method != null) validateMethod(body.method, "/method", err);
  else if (body.decision === "test") err("/method", "required", "test に分類するときは確認方法（method）が必要です");
  return errors;
}

// ---- §2.5 版ハッシュ／§2.7 必須集合ハッシュ ----
export function computeSubjectSha256({ baseCommit, artifacts }) {
  const rows = [...artifacts].sort((a, b) => cmp(a.path, b.path)).map((a) => [a.path, a.role, a.sha256]);
  return sha256Hex(JSON.stringify([1, "patch", baseCommit, rows]));
}

export function computeRequirementsSha256(policyVersion, items) {
  const rows = [...items].sort((a, b) => cmp(a.id, b.id)).map((i) => [i.id, i.methodClass, [...i.targets].sort(cmp)]);
  return sha256Hex(JSON.stringify([1, policyVersion, rows]));
}

// ---- §2.6 parseUnifiedDiff ----
const KNOWN_EXT_HEADERS = [
  /^old mode [0-7]+$/,
  /^new mode [0-7]+$/,
  /^deleted file mode [0-7]+$/,
  /^new file mode [0-7]+$/,
  /^similarity index \d+%$/,
  /^dissimilarity index \d+%$/,
  /^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]+)?$/,
  /^(?:rename|copy) (?:from|to) .+$/,
];
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(text) {
  const fail = (message, line) => ({ ok: false, error: { code: "diff-unparsable", message, line } });
  if (typeof text !== "string") return fail("diff が文字列ではありません", null);
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const files = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith("diff --git ")) return fail("diff --git 見出しがありません", i + 1);
    const header = splitGitHeader(lines[i].slice("diff --git ".length));
    const headerLine = i + 1;
    i++;
    let renameFrom = null, renameTo = null, copyFrom = null, copyTo = null, isNew = false, isDeleted = false;
    while (i < lines.length && !lines[i].startsWith("diff --git ") && !lines[i].startsWith("--- ") && !lines[i].startsWith("@@") && !lines[i].startsWith("Binary files ") && lines[i] !== "GIT binary patch") {
      const l = lines[i];
      if (!KNOWN_EXT_HEADERS.some((re) => re.test(l))) return fail(`未知の拡張ヘッダです: ${l.slice(0, 80)}`, i + 1);
      const take = (prefix) => {
        const v = unquotePath(l.slice(prefix.length));
        if (v === null) throw new Error("quote");
        return v;
      };
      try {
        if (l.startsWith("rename from ")) renameFrom = take("rename from ");
        else if (l.startsWith("rename to ")) renameTo = take("rename to ");
        else if (l.startsWith("copy from ")) copyFrom = take("copy from ");
        else if (l.startsWith("copy to ")) copyTo = take("copy to ");
      } catch {
        return fail("引用パスを復号できません", i + 1);
      }
      if (l.startsWith("new file mode ")) isNew = true;
      if (l.startsWith("deleted file mode ")) isDeleted = true;
      i++;
    }
    let minus, plus; // undefined = 行なし、null = /dev/null
    if (i < lines.length && lines[i].startsWith("--- ")) {
      minus = patchPath(lines[i].slice(4));
      if (minus === undefined) return fail("--- 行のパスを解釈できません", i + 1);
      i++;
      if (!(i < lines.length && lines[i].startsWith("+++ "))) return fail("+++ 行がありません", i + 1);
      plus = patchPath(lines[i].slice(4));
      if (plus === undefined) return fail("+++ 行のパスを解釈できません", i + 1);
      i++;
    }
    const f = { oldPath: null, newPath: null, status: "modified", binary: false, changedLines: [] };
    if (i < lines.length && lines[i].startsWith("Binary files ")) {
      f.binary = true;
      i++;
    } else if (i < lines.length && lines[i] === "GIT binary patch") {
      f.binary = true;
      i++;
      while (i < lines.length && !lines[i].startsWith("diff --git ")) i++;
    }
    while (i < lines.length && lines[i].startsWith("@@")) {
      const m = HUNK_RE.exec(lines[i]);
      if (!m) return fail("ハンク見出しが不正です", i + 1);
      let oldLeft = m[2] === undefined ? 1 : Number(m[2]);
      let newLeft = m[4] === undefined ? 1 : Number(m[4]);
      i++;
      while (oldLeft > 0 || newLeft > 0) {
        if (i >= lines.length) return fail("ハンクの行数が見出しと合いません", i);
        const l = lines[i];
        if (l.startsWith("\\")) {
          i++;
          continue;
        }
        if (l === "" || l[0] === " ") {
          oldLeft--;
          newLeft--;
        } else if (l[0] === "-") {
          oldLeft--;
          f.changedLines.push(l.slice(1));
        } else if (l[0] === "+") {
          newLeft--;
          f.changedLines.push(l.slice(1));
        } else {
          return fail("ハンク内の行が不正です", i + 1);
        }
        if (oldLeft < 0 || newLeft < 0) return fail("ハンクの行数が見出しと合いません", i + 1);
        i++;
      }
      while (i < lines.length && lines[i].startsWith("\\")) i++;
    }
    if (i < lines.length && !lines[i].startsWith("diff --git ")) return fail("解析できない行があります", i + 1);

    const oldSide = renameFrom ?? copyFrom ?? (minus !== undefined ? minus : header ? header.a : undefined);
    const newSide = renameTo ?? copyTo ?? (plus !== undefined ? plus : header ? header.b : undefined);
    if (oldSide === undefined || newSide === undefined) return fail("変更対象のパスを特定できません", headerLine);
    if (isNew || oldSide === null) f.status = "added";
    else if (isDeleted || newSide === null) f.status = "deleted";
    else if (renameFrom !== null) f.status = "renamed";
    else if (copyFrom !== null) f.status = "copied";
    f.oldPath = f.status === "added" ? null : oldSide;
    f.newPath = f.status === "deleted" ? null : newSide;
    if ((f.oldPath === null && f.newPath === null) || [f.oldPath, f.newPath].some((p) => p !== null && checkRelPath(p) !== null)) {
      return fail("変更対象のパスが不正です", headerLine);
    }
    files.push(f);
  }
  if (!files.length) return fail("ファイル変更がありません", null);
  return { ok: true, files };
}

// "a/x b/x" / "\"a/…\" \"b/…\"" を a・b に分ける。同名の場合だけ曖昧さなく分けられる（リネームは rename 行が正）
function splitGitHeader(s) {
  if (s.startsWith('"')) {
    const end = closingQuote(s, 0);
    if (end < 0) return null;
    const a = unquotePath(s.slice(0, end + 1));
    const rest = s.slice(end + 2);
    const b = unquotePath(rest);
    return a && b ? { a: stripPrefix(a, "a/"), b: stripPrefix(b, "b/") } : null;
  }
  for (let k = s.indexOf(" b/"); k >= 0; k = s.indexOf(" b/", k + 1)) {
    const a = s.slice(0, k);
    const b = s.slice(k + 1);
    if (a.startsWith("a/") && a.slice(2) === b.slice(2)) return { a: a.slice(2), b: b.slice(2) };
  }
  return null;
}

function closingQuote(s, start) {
  for (let k = start + 1; k < s.length; k++) {
    if (s[k] === "\\") k++;
    else if (s[k] === '"') return k;
  }
  return -1;
}

function patchPath(s) {
  const raw = s.replace(/\t.*$/, "");
  if (raw === "/dev/null") return null;
  const p = unquotePath(raw);
  if (p === null) return undefined;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

const stripPrefix = (p, prefix) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);

// Git の C 形式引用（8 進エスケープは UTF-8 のバイト列）を復号する。引用でなければそのまま。失敗は null
function unquotePath(s) {
  if (!s.startsWith('"')) return s;
  if (s.length < 2 || !s.endsWith('"') || closingQuote(s, 0) !== s.length - 1) return null;
  const body = s.slice(1, -1);
  const bytes = [];
  const enc = new TextEncoder();
  const ESC = { n: 10, t: 9, '"': 34, "\\": 92, a: 7, b: 8, f: 12, r: 13, v: 11 };
  for (let k = 0; k < body.length; k++) {
    const ch = body[k];
    if (ch !== "\\") {
      const cp = body.codePointAt(k);
      const str = String.fromCodePoint(cp);
      bytes.push(...enc.encode(str));
      if (cp > 0xffff) k++;
      continue;
    }
    const n = body[k + 1];
    if (n === undefined) return null;
    if (/[0-7]/.test(n)) {
      const oct = body.slice(k + 1, k + 4);
      if (!/^[0-7]{3}$/.test(oct)) return null;
      bytes.push(parseInt(oct, 8));
      k += 3;
    } else if (n in ESC) {
      bytes.push(ESC[n]);
      k += 1;
    } else {
      return null;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

// ---- §2.7 deriveRequirements ----
export function deriveRequirements({ files, classifications = [], policyVersion = POLICY_VERSION }) {
  const applyTargets = new Set();
  const globTargets = new Set();
  for (const f of files) {
    if (f.oldPath) applyTargets.add(f.oldPath);
    if (f.newPath) applyTargets.add(f.newPath);
    if (f.newPath && TEST_TARGET_RE.test(f.newPath)) globTargets.add(f.newPath);
  }
  const candidates = new Map(); // "path\0code" -> { path, oldPath, code, allowed }
  const addCandidate = (pathName, oldPath, code, allowed) => {
    const key = pathName + "\0" + code;
    if (!candidates.has(key)) candidates.set(key, { path: pathName, oldPath, code, allowed });
  };
  const otherTestCode = (p) => {
    if (p.startsWith(FIXTURES_ROOT)) return globTargets.size ? null : "test-fixtures-only";
    if (p.startsWith(TEST_ROOT)) return "test-path-unrecognized";
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (TEST_CANDIDATE_RE.test(base) || p.split("/").includes("__tests__")) return "test-candidate-unknown";
    return null;
  };
  for (const f of files) {
    const kept = f.newPath;
    const removed = f.status === "deleted" ? f.oldPath : f.status === "renamed" && f.oldPath !== f.newPath ? f.oldPath : null;
    if (f.binary) addCandidate(kept ?? f.oldPath, kept && f.oldPath !== kept ? f.oldPath : null, "diff-binary", []);
    if (removed) {
      if (TEST_TARGET_RE.test(removed)) {
        if (!(kept && TEST_TARGET_RE.test(kept))) addCandidate(removed, null, "test-deleted", ["deletion-accepted"]);
      } else {
        const code = otherTestCode(removed);
        if (code) addCandidate(removed, null, code, ["deletion-accepted"]);
      }
    }
    if (kept && !TEST_TARGET_RE.test(kept)) {
      const code = otherTestCode(kept);
      if (code) addCandidate(kept, f.oldPath && f.oldPath !== kept ? f.oldPath : null, code, ["test", "not-test"]);
    }
    if ((f.newPath === TEST_CONFIG_PATH || f.oldPath === TEST_CONFIG_PATH) && (f.changedLines || []).some((l) => TEST_CONFIG_LINE_RE.test(l))) {
      addCandidate(TEST_CONFIG_PATH, null, "test-config-changed", ["test", "not-test"]);
    }
  }
  const latest = new Map();
  for (const c of classifications) {
    const prev = latest.get(c.path);
    if (!prev || c.seq > prev.seq) latest.set(c.path, c);
  }
  const testsTargets = new Set(globTargets);
  const pending = [];
  const resolved = [];
  const sorted = [...candidates.values()].sort((a, b) => cmp(a.path, b.path) || cmp(a.code, b.code));
  for (const cand of sorted) {
    const c = latest.get(cand.path);
    if (c && cand.allowed.includes(c.decision)) {
      resolved.push({ path: cand.path, code: cand.code, decision: c.decision, seq: c.seq });
      if (c.decision === "test") testsTargets.add(cand.code === "test-config-changed" ? TEST_SUITE_TARGET : cand.path);
    } else {
      pending.push({ path: cand.path, oldPath: cand.oldPath, code: cand.code, allowedDecisions: cand.allowed.slice() });
    }
  }
  const items = [{ id: "apply", methodClass: METHOD_CLASS.apply, targets: [...applyTargets].sort(cmp) }];
  if (testsTargets.size) items.push({ id: "tests", methodClass: METHOD_CLASS.tests, targets: [...testsTargets].sort(cmp) });
  return { policyVersion, items, pending, resolved, requirementsSha256: computeRequirementsSha256(policyVersion, items) };
}

// 現行版・現行ポリシーの分類から、パスごとに seq 最大の 1 件を選ぶ
export function latestClassifications(records, { projectKey, subjectSha256, policyVersion = POLICY_VERSION }) {
  const byPath = new Map();
  for (const r of records) {
    if (r.type !== "classification" || r.projectKey !== projectKey || r.subjectSha256 !== subjectSha256 || r.policyVersion !== policyVersion) continue;
    const prev = byPath.get(r.payload.path);
    if (!prev || r.seq > prev.seq) byPath.set(r.payload.path, { path: r.payload.path, decision: r.payload.decision, method: r.payload.method ?? null, seq: r.seq });
  }
  return [...byPath.values()].sort((a, b) => cmp(a.path, b.path));
}

// ---- §2.8 正規化／§2.9 記録ハッシュ ----
function normalizeMethod(m) {
  if (!isPlainObject(m)) throw new TypeError("method がオブジェクトではありません");
  if (m.type === "command") {
    if (!Array.isArray(m.argv) || typeof m.cwd !== "string") throw new TypeError("command の argv / cwd が不正です");
    return { type: "command", argv: m.argv.slice(), cwd: m.cwd };
  }
  if (m.type === "manual") {
    if (typeof m.description !== "string") throw new TypeError("manual の description が不正です");
    return { type: "manual", description: m.description };
  }
  throw new TypeError("method.type が不正です");
}

export function normalizeCheck(check) {
  if (!isPlainObject(check)) throw new TypeError("normalizeCheck: オブジェクトを渡してください");
  for (const k of ["id", "subjectSha256", "requirementsSha256", "actor", "result"]) {
    if (typeof check[k] !== "string") throw new TypeError(`normalizeCheck: ${k} が文字列ではありません`);
  }
  if (!Number.isInteger(check.policyVersion)) throw new TypeError("normalizeCheck: policyVersion が整数ではありません");
  const ev = check.evidence;
  if (ev != null && !(isPlainObject(ev) && typeof ev.path === "string" && typeof ev.sha256 === "string")) throw new TypeError("normalizeCheck: evidence が不正です");
  return {
    id: check.id,
    subjectSha256: check.subjectSha256,
    policyVersion: check.policyVersion,
    requirementsSha256: check.requirementsSha256,
    actor: check.actor,
    method: normalizeMethod(check.method),
    result: check.result,
    executedAt: check.executedAt ?? null,
    evidence: ev == null ? null : { path: ev.path, sha256: ev.sha256 },
    reason: check.reason ?? null,
  };
}

export function normalizeClassification({ path: p, decision, reason: why, method }) {
  if (typeof p !== "string" || typeof decision !== "string" || typeof why !== "string") throw new TypeError("normalizeClassification: path / decision / reason が不正です");
  return { path: p, decision, reason: why, method: method == null ? null : normalizeMethod(method) };
}

export function recordSha256({ type, source, projectKey, payload }) {
  return sha256Hex(canonicalJson([1, type, source, projectKey, payload]));
}

// ---- §2.11 取込可否 ----
// 取込（サーバ）とプレビュー（評価）で同じ判定を使う。evidenceStatus を渡さなければ証跡は照合しない
export function importRejection(check, { currentSubjectSha256, requirementsSha256, evidenceStatus = null }) {
  if (!currentSubjectSha256) return "subject-unavailable";
  if (check.subjectSha256 !== currentSubjectSha256) return "subject-mismatch";
  if (check.policyVersion !== POLICY_VERSION) return "policy-unsupported";
  if (!requirementsSha256 || check.requirementsSha256 !== requirementsSha256) return "requirements-mismatch";
  if (check.evidence != null && evidenceStatus != null && evidenceStatus !== "ok") {
    return EVIDENCE_STATUSES.includes(evidenceStatus) && evidenceStatus !== "none" ? "evidence-" + evidenceStatus : "evidence-unreadable";
  }
  return null;
}

// ---- §2.10 evaluateVerification ----
const ARTIFACT_REASON = { missing: "artifact-missing", unreadable: "artifact-unreadable", "not-file": "artifact-unreadable", outside: "artifact-outside", mismatch: "artifact-sha-mismatch" };

export function evaluateVerification({ itemId = null, implDir = null, projectKey, folder, baseCommit, records = [], log, evidenceStatus = {}, manifestEvidenceStatus = null }) {
  const reasons = [];
  const add = (code, target = null, detail = "") => reasons.push({ code, message: REASON_CODES[code].message + (detail ? `（${detail}）` : ""), target });
  const logInfo = { ok: !!(log && log.ok), errors: (log && log.errors) || [], lastSeq: (log && log.lastSeq) || 0 };
  const mres = folder.manifest;
  const manifestOk = !!(mres && mres.ok);
  const manifestOut = manifestOk
    ? { ok: true, errors: [], schemaVersion: mres.manifest.schemaVersion, kind: mres.manifest.kind, baseCommit: mres.manifest.baseCommit }
    : { ok: false, errors: (mres && mres.errors) || [], schemaVersion: null, kind: null, baseCommit: null };

  // 1. 完全性
  let integrity = false;
  if (!logInfo.ok) {
    add("log-error");
    integrity = true;
  }
  if (!manifestOk) {
    const codes = manifestOut.errors.map((e) => e.code);
    const io = ["manifest-missing", "manifest-unreadable", "manifest-json"].find((c) => codes.includes(c));
    add(io || (codes.includes("schema-unsupported") || codes.includes("kind-unsupported") ? "schema-unsupported" : "manifest-invalid"));
    integrity = true;
  }
  const artifacts = (folder.artifacts || []).map((a) => ({ path: a.path, role: a.role, declaredSha256: a.declaredSha256, actualSha256: a.actualSha256 ?? null, status: a.status }));
  for (const a of artifacts) {
    if (a.status !== "ok") {
      add(ARTIFACT_REASON[a.status] || "artifact-unreadable", a.path);
      integrity = true;
    }
  }
  const current = folder.currentSubjectSha256 || null;
  if (manifestOk && !current) {
    add("subject-unavailable");
    integrity = true;
  }

  // 2. 保留（基点・diff・分類待ち）
  let pendingFlag = false;
  let diffOut = { ok: false, error: null, files: [] };
  let requirements = null;
  if (manifestOk) {
    if (!baseCommit || baseCommit.status !== "verified") {
      add("base-commit-unverified", (baseCommit && baseCommit.value) || null, (baseCommit && (baseCommit.detail || baseCommit.status)) || "");
      pendingFlag = true;
    }
    if (typeof folder.patchText === "string") {
      const parsed = parseUnifiedDiff(folder.patchText);
      if (parsed.ok) {
        diffOut = { ok: true, error: null, files: parsed.files.map((f) => ({ oldPath: f.oldPath, newPath: f.newPath, status: f.status, binary: f.binary })) };
        const classifications = current ? latestClassifications(records, { projectKey, subjectSha256: current }) : [];
        requirements = deriveRequirements({ files: parsed.files, classifications });
        for (const p of requirements.pending) {
          add(p.code, p.path);
          pendingFlag = true;
        }
      } else {
        diffOut = { ok: false, error: parsed.error, files: [] };
        add("diff-unparsable", null, parsed.error.message);
        pendingFlag = true;
      }
    }
  }

  // 3. 必須項目（source を問わず seq 最大の 1 件。executedAt では並べない）
  const requiredRows = [];
  const optionalRows = [];
  if (requirements && current) {
    const reqSha = requirements.requirementsSha256;
    const declared = new Set(folder.declaredSubjects || []);
    const latestById = new Map();
    for (const r of records) {
      if (r.type !== "check" || r.projectKey !== projectKey || r.subjectSha256 !== current || r.policyVersion !== POLICY_VERSION || r.payload.requirementsSha256 !== reqSha) continue;
      const prev = latestById.get(r.payload.id);
      if (!prev || r.seq > prev.seq) latestById.set(r.payload.id, r);
    }
    const row = (id, required) => {
      const r = latestById.get(id) || null;
      const rowReasons = [];
      let effective = "missing";
      let counted = false;
      let ev = null;
      if (!r) {
        const stale = records.some((x) => x.type === "check" && x.projectKey === projectKey && x.payload.id === id && (x.implDir === implDir || declared.has(x.subjectSha256)));
        rowReasons.push(stale ? "check-stale" : "check-missing");
      } else {
        effective = r.payload.result;
        ev = r.payload.evidence == null ? "none" : evidenceStatus[r.seq] || "unreadable";
        if (effective === "failed") rowReasons.push("check-failed");
        else if (effective === "not_run") rowReasons.push("check-not-run");
        else if (ev !== "none" && ev !== "ok") rowReasons.push(EVIDENCE_STATUSES.includes(ev) ? "evidence-" + ev : "evidence-unreadable");
        else counted = true;
      }
      return { id, required, effective, counted, latest: r ? summarizeRecord(r, ev) : null, reasons: rowReasons };
    };
    for (const item of requirements.items) {
      const x = row(item.id, true);
      for (const code of x.reasons) add(code, item.id);
      requiredRows.push(x);
    }
    const requiredIds = new Set(requirements.items.map((i) => i.id));
    for (const id of [...latestById.keys()].filter((k) => !requiredIds.has(k)).sort(cmp)) {
      const x = row(id, false);
      optionalRows.push(x);
    }
  }

  // 4・5. 集約
  let status;
  if (integrity) status = "unsatisfied";
  else if (pendingFlag) status = "pending";
  else if (!requirements || requiredRows.some((x) => !x.counted)) status = "unsatisfied";
  else status = requiredRows.every((x) => x.latest.source === "ui" || x.latest.source === "server") ? "confirmed" : "declared";

  // 取込前プレビュー（受理はしない）
  const preview = [];
  if (manifestOk) {
    mres.manifest.checks.forEach((c, index) => {
      let st = "acceptable";
      let code = null;
      const hash = recordSha256({ type: "check", source: "manifest", projectKey, payload: normalizeCheck(c) });
      if (records.some((r) => r.source === "manifest" && r.recordSha256 === hash)) st = "accepted";
      else {
        code = importRejection(c, {
          currentSubjectSha256: current,
          requirementsSha256: requirements ? requirements.requirementsSha256 : null,
          evidenceStatus: manifestEvidenceStatus ? manifestEvidenceStatus[index] ?? null : null,
        });
        if (code) st = "rejected";
      }
      preview.push({ index, id: c.id, result: c.result, subjectSha256: c.subjectSha256, status: st, code });
    });
  }

  return {
    applicable: true,
    itemId,
    implDir,
    projectKey,
    policyVersion: POLICY_VERSION,
    manifest: manifestOut,
    subject: { current, declared: [...(folder.declaredSubjects || [])], artifacts },
    baseCommit: baseCommit ? { value: baseCommit.value ?? null, status: baseCommit.status, detail: baseCommit.detail || "" } : { value: null, status: "invalid", detail: "" },
    diff: diffOut,
    requirements: requirements
      ? { sha256: requirements.requirementsSha256, items: requirements.items, pending: requirements.pending, resolved: requirements.resolved }
      : { sha256: null, items: [], pending: [], resolved: [] },
    checks: [...requiredRows, ...optionalRows],
    preview,
    log: logInfo,
    aggregate: { status, label: AGGREGATE_LABELS[status], complete: status === "confirmed", reasons },
  };
}

function summarizeRecord(r, evidenceStatusValue) {
  const p = r.payload;
  return {
    seq: r.seq,
    receivedAt: r.receivedAt,
    source: r.source,
    actor: p.actor,
    result: p.result,
    executedAt: p.executedAt,
    method: p.method,
    evidence: p.evidence,
    evidenceStatus: evidenceStatusValue,
    reason: p.reason,
  };
}

// ---- §5 追記ログの行 ----
export function buildLogRecord({ seq, receivedAt, source, type, projectKey, subjectSha256, policyVersion, implDir = null, itemId = null, payload }) {
  const rec = { v: LOG_LINE_VERSION, seq, receivedAt, source, type, recordSha256: recordSha256({ type, source, projectKey, payload }), projectKey, subjectSha256, policyVersion, implDir, itemId, payload };
  const shape = logRecordShapeError(rec);
  if (shape) throw new TypeError("buildLogRecord: " + shape);
  return rec;
}

export function formatChecksLogLine(record) {
  return canonicalJson(record) + "\n";
}

// ログ全文を検査して復元する純関数。読めた行だけを records に入れ、問題はすべて errors に積む
export function parseChecksLog(text) {
  const records = [];
  const errors = [];
  let lastSeq = 0;
  if (typeof text !== "string") return { ok: false, records, errors: [{ line: 0, code: "log-unreadable", message: "ログが文字列ではありません" }], lastSeq };
  if (text === "") return { ok: true, records, errors, lastSeq };
  const truncated = !text.endsWith("\n");
  const lines = text.split("\n");
  if (!truncated) lines.pop();
  lines.forEach((line, idx) => {
    const n = idx + 1;
    if (truncated && idx === lines.length - 1) {
      errors.push({ line: n, code: "line-truncated", message: "末尾の行に改行がありません（書き込み途中の可能性）" });
      return;
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      errors.push({ line: n, code: "line-json", message: "JSON として読めません" });
      return;
    }
    const shape = logRecordShapeError(rec);
    if (shape) {
      errors.push({ line: n, code: "line-shape", message: shape });
      return;
    }
    if (rec.seq <= lastSeq) {
      errors.push({ line: n, code: "seq-order", message: `seq ${rec.seq} が直前の ${lastSeq} 以下です` });
      return;
    }
    let expected;
    try {
      expected = recordSha256({ type: rec.type, source: rec.source, projectKey: rec.projectKey, payload: rec.payload });
    } catch {
      errors.push({ line: n, code: "line-shape", message: "payload を正規化できません" });
      return;
    }
    if (expected !== rec.recordSha256) {
      errors.push({ line: n, code: "record-hash", message: "recordSha256 が再計算値と違います" });
      return;
    }
    lastSeq = rec.seq;
    records.push(rec);
  });
  return { ok: errors.length === 0, records, errors, lastSeq };
}

function logRecordShapeError(r) {
  if (!isPlainObject(r)) return "行がオブジェクトではありません";
  for (const k of Object.keys(r)) if (!LOG_KEYS.includes(k)) return `未知のフィールドです: ${k}`;
  if (r.v !== LOG_LINE_VERSION) return `未対応の v です: ${r.v}`;
  if (!(Number.isInteger(r.seq) && r.seq >= 1)) return "seq が 1 以上の整数ではありません";
  if (!isTimestamp(r.receivedAt)) return "receivedAt が ISO 8601 UTC ではありません";
  if (!SOURCES.includes(r.source)) return "source が不正です";
  if (!RECORD_TYPES.includes(r.type)) return "type が不正です";
  if (!isSha(r.recordSha256)) return "recordSha256 が不正です";
  if (typeof r.projectKey !== "string" || !r.projectKey) return "projectKey が不正です";
  if (!isSha(r.subjectSha256)) return "subjectSha256 が不正です";
  if (!(Number.isInteger(r.policyVersion) && r.policyVersion >= 1)) return "policyVersion が不正です";
  if (!(r.implDir === null || typeof r.implDir === "string")) return "implDir が不正です";
  if (!(r.itemId === null || typeof r.itemId === "string")) return "itemId が不正です";
  if (!isPlainObject(r.payload)) return "payload がオブジェクトではありません";
  const p = r.payload;
  if (r.type === "check") {
    if (p.subjectSha256 !== r.subjectSha256 || p.policyVersion !== r.policyVersion) return "payload と最上位の版情報が一致しません";
    if (typeof p.id !== "string" || !CHECK_RESULTS.includes(p.result) || !isSha(p.requirementsSha256) || !isPlainObject(p.method)) return "check の payload が不正です";
  } else if (typeof p.path !== "string" || !CLASSIFICATION_DECISIONS.includes(p.decision) || typeof p.reason !== "string") {
    return "classification の payload が不正です";
  }
  return null;
}

// ---- §3 読取専用 I/O ----
export function fileSha256(absPath) {
  return sha256Hex(fs.readFileSync(absPath));
}

// impl フォルダ相対のファイルを、フォルダ外への逃げ（シンボリックリンク含む）を拒否して読む
function readInside(absDir, rel) {
  if (checkRelPath(rel) !== null) return { status: "outside", bytes: null };
  let realDir;
  try {
    realDir = fs.realpathSync(absDir);
  } catch {
    return { status: "missing", bytes: null };
  }
  let real;
  try {
    real = fs.realpathSync(path.join(absDir, ...rel.split("/")));
  } catch (e) {
    return { status: e && e.code === "ENOENT" ? "missing" : "unreadable", bytes: null };
  }
  if (!real.startsWith(realDir + path.sep)) return { status: "outside", bytes: null };
  try {
    if (!fs.statSync(real).isFile()) return { status: "not-file", bytes: null };
    return { status: "ok", bytes: fs.readFileSync(real) };
  } catch {
    return { status: "unreadable", bytes: null };
  }
}

export function resolveImplDir(poolDir, itemFile) {
  if (checkRelPath(itemFile) !== null) return null;
  const segs = itemFile.split("/");
  segs.pop();
  while (segs.length) {
    if (segs.length === 2 && segs[0] === "topics") return null; // トピックフォルダ自身は impl ではない
    if (!(segs.length === 1 && segs[0] === "topics")) {
      try {
        if (fs.statSync(path.join(poolDir, ...segs, "manifest.json")).isFile()) return segs.join("/");
      } catch {
        // 無ければ上へ
      }
    }
    segs.pop();
  }
  return null;
}

export function readImplFolder(absImplDir) {
  const empty = (code, message) => ({ manifest: { ok: false, errors: [{ pointer: "", code, message }] }, artifacts: [], currentSubjectSha256: null, patchText: null, declaredSubjects: [] });
  let text;
  try {
    text = fs.readFileSync(path.join(absImplDir, "manifest.json"), "utf8");
  } catch (e) {
    return e && e.code === "ENOENT" ? empty("manifest-missing", "manifest.json がありません") : empty("manifest-unreadable", "manifest.json を読めません");
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty("manifest-json", "manifest.json を JSON として読めません");
  }
  const manifest = validateManifest(raw);
  if (!manifest.ok) return { manifest, artifacts: [], currentSubjectSha256: null, patchText: null, declaredSubjects: [] };
  const m = manifest.manifest;
  let patchText = null;
  const artifacts = m.artifacts.map((a) => {
    const r = readInside(absImplDir, a.path);
    const actual = r.bytes ? sha256Hex(r.bytes) : null;
    // 版の計算と diff の解析は同じバイト列から行う（読み直すと途中で書き換わった内容を混ぜうる）
    if (a.role === "patch" && r.bytes) patchText = new TextDecoder("utf-8").decode(r.bytes);
    return { path: a.path, role: a.role, declaredSha256: a.sha256, actualSha256: actual, status: r.status === "ok" ? (actual === a.sha256 ? "ok" : "mismatch") : r.status };
  });
  const currentSubjectSha256 = artifacts.every((a) => a.actualSha256)
    ? computeSubjectSha256({ baseCommit: m.baseCommit, artifacts: artifacts.map((a) => ({ path: a.path, role: a.role, sha256: a.actualSha256 })) })
    : null;
  const declaredSubjects = [...new Set(m.checks.map((c) => c.subjectSha256))].sort(cmp);
  return { manifest, artifacts, currentSubjectSha256, patchText, declaredSubjects };
}

export function evidenceStatusOf(absImplDir, evidence) {
  if (evidence == null) return "none";
  const r = readInside(absImplDir, evidence.path);
  if (r.status !== "ok") return r.status === "not-file" ? "unreadable" : r.status;
  return sha256Hex(r.bytes) === evidence.sha256 ? "ok" : "mismatch";
}
