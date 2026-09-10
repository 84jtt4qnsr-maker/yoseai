// U2A2A — 純粋ロジックの切り出し（合意事項F: 大規模分割はせず、守りたい判定だけを単体テスト可能に）
// このファイルは fs / ネットワーク / タイマーに依存しない。

import crypto from "node:crypto";

// 状態ファイルの形状検証。壊れていれば理由付きで throw する
// （loadState はこれを使い、失敗時は原本を退避して起動を拒否する — 空状態で上書きしない）
export function validateStateShape(parsed) {
  if (!parsed || typeof parsed !== "object") throw new Error("state がオブジェクトではありません");
  for (const key of ["messages", "tasks", "pool"]) {
    if (!Array.isArray(parsed[key])) throw new Error(`state.${key} が配列ではありません`);
  }
  if (parsed.topics !== undefined && !Array.isArray(parsed.topics)) {
    throw new Error("state.topics が配列ではありません");
  }
  return parsed;
}

// リレー（転送・質疑中継）かどうかの共通判定。引き継ぎ（handoff）はリレーではない
// （合意事項D: 要約・ミラーの短縮/除外はリレーのみに適用し、引き継ぎ内容は落とさない）
export function isRelay(provenance) {
  const d = provenance && provenance.delivery;
  return d === "qa-relay" || d === "relay";
}

// 応答本文からプール成果物のパス宣言を抽出（合意事項C: 帰属の一次情報）
// U2A2A_RULES.md の「保存したら本文にパスを列挙する」規約に基づく宣言の読み取り
export function extractDeclaredPaths(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/u2a2a\/pool\/([^\s)"'`」()）:*、。，．！？]+)/g) || []) {
    const rel = m[1].replace(/[.,、。]+$/, "");
    if (!rel || rel.startsWith("threads/") || rel.includes("/.") || rel.startsWith(".")) continue;
    if (rel === "U2A2A_RULES.md") continue;
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

// 上限判定（合意事項B: 回数上限も走行中を含めて判定する）
// 純関数: 入力はすべて呼び出し側が用意する
export function judgeBudget({ budgets, usageDay, today, inflightMs, inflightCount, topicUsd, topicCap }) {
  const b = budgets || {};
  const ud = usageDay && usageDay.date === today ? usageDay : { runs: 0, ms: 0 };
  if (b.runCount && ud.runs + (inflightCount || 0) >= b.runCount) {
    return `本日の実行回数上限（${b.runCount}回）に到達（完了 ${ud.runs} + 実行中 ${inflightCount || 0}）`;
  }
  if (b.runMinutes && ud.ms + (inflightMs || 0) >= b.runMinutes * 60000) {
    return `本日の累計実行時間上限（${b.runMinutes}分）に到達`;
  }
  if (topicCap && topicUsd >= topicCap) {
    return `このトピックのコスト上限（$${topicCap}）に到達（累計 $${topicUsd.toFixed(2)}）`;
  }
  return null;
}

// 帰属の推定（合意事項C: 実行中の候補 run が「ちょうど1件」のときだけ推定する）
// 戻り値: { origin, via } — 確定できなければ origin: null / via: "unknown"
export function inferAuthor(relPath, topicId, activeRuns) {
  const candidates = (activeRuns || []).filter((r) => {
    if (r.kind === "thread" || r.kind === "fix") {
      if (topicId) return r.kind === "thread" && r.topicId === topicId;
      return r.kind === "fix";
    }
    return false;
  });
  if (candidates.length === 1) return { origin: candidates[0].agent, via: "inferred", candidates: 1 };
  return { origin: null, via: "unknown", candidates: candidates.length };
}

// ---- 成果物バージョン履歴（仕様: SPEC-成果物バージョン履歴.md。純関数のみ、I/O は server 側）----

// 履歴保存の対象は UTF-8 テキストかつ 256 KiB 以下（仕様「範囲」）
export const HISTORY_MAX_BYTES = 256 * 1024;
// diff API / レビュー添付の上限（仕様「API」: 256 KiB 超は truncated）
export const DIFF_MAX_BYTES = 256 * 1024;

// 履歴対象かどうか。対象なら null、対象外なら理由（"no-file" | "too-large" | "binary"）
export function historyEligibility(buf) {
  if (!buf) return "no-file";
  if (buf.length > HISTORY_MAX_BYTES) return "too-large";
  if (buf.includes(0)) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return "binary";
  }
  return null;
}

export function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// 版ファイル名: v<n> + 元ファイルの拡張子（拡張子なしなら .txt）
export function versionFileName(n, file) {
  const m = /(\.[^./\\]+)$/.exec(String(file || ""));
  return "v" + n + (m ? m[1] : ".txt");
}

// manifest に版を追加する。直前の版と同じ sha256 なら新たに切らず、その版を返す（created: false）
// entry: { sha256, size, ts, reason, runId?, agent?, partial? } — 版ファイル名は manifest.file の拡張子から決める
export function appendVersion(manifest, entry) {
  const versions = Array.isArray(manifest.versions) ? manifest.versions : [];
  const last = versions[versions.length - 1];
  if (last && last.sha256 === entry.sha256) return { manifest, version: last, created: false };
  const n = (last ? last.n : 0) + 1;
  const version = {
    n,
    id: "v" + n + "-" + String(entry.sha256).slice(0, 12),
    sha256: entry.sha256,
    size: entry.size,
    ts: entry.ts,
    reason: entry.reason,
    runId: entry.runId || null,
    agent: entry.agent || null,
    partial: !!entry.partial,
    file: versionFileName(n, manifest.file), // 版ファイル名（manifest.file は追加時点の所在。以後の移動に追従しない）
  };
  return { manifest: { ...manifest, versions: [...versions, version] }, version, created: true };
}

// 版 id から版と比較元を引く。from 省略時は to の直前の版（初版なら null）。存在しない id は null
export function resolveVersionPair(manifest, fromId, toId) {
  const versions = (manifest && manifest.versions) || [];
  const to = versions.find((v) => v.id === toId) || null;
  if (!to) return null;
  const from = fromId ? versions.find((v) => v.id === fromId) || null : versions.filter((v) => v.n < to.n).pop() || null;
  if (fromId && !from) return null;
  return { from, to };
}

// 末尾改行の有無を行トークンに含める（"foo" と "foo\n" を別物として扱い、No newline マーカーを出す）
const NOEOL = "␀noeol";
const NOEOL_MARK = "\n" + "\\" + " No newline at end of file";
function toLines(text) {
  const s = String(text ?? "");
  if (!s) return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  else lines[lines.length - 1] += NOEOL;
  return lines;
}

// Myers 法（O((N+M)D)）。D が上限を超えたら null（呼び出し側が全置換にフォールバック）
function myersOps(a, b, maxD) {
  const n = a.length, m = b.length, max = n + m;
  if (max === 0) return [];
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = []; // 各 d について v[-d-1..d+1] だけを保持（メモリ O(D^2)）
  let found = false;
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return null;
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  const ops = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const t = trace[d];
    const V = (k) => t[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && V(k - 1) < V(k + 1)) ? k + 1 : k - 1;
    const prevX = V(prevK), prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(["=", x - 1, y - 1]);
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? ["+", x, y - 1] : ["-", x - 1, y]);
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

// unified diff（外部依存なし）。同一内容なら空文字列
export function unifiedDiff(aText, bText, opts = {}) {
  const ctx = opts.context ?? 3;
  const a = toLines(aText), b = toLines(bText);
  // 共通の先頭・末尾を先に除いて Myers の対象を小さくする
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf);
  if (!am.length && !bm.length) return "";
  let mid = myersOps(am, bm, opts.maxD ?? 2000);
  if (!mid) mid = [...am.map((_, i) => ["-", i, 0]), ...bm.map((_, j) => ["+", am.length, j])]; // 全置換
  const ops = [
    ...Array.from({ length: pre }, (_, i) => ["=", i, i]),
    ...mid.map(([t, i, j]) => [t, i + pre, j + pre]),
    ...Array.from({ length: suf }, (_, i) => ["=", a.length - suf + i, b.length - suf + i]),
  ];
  const strip = (s) => (s.endsWith(NOEOL) ? s.slice(0, -NOEOL.length) : s);
  const line = (sign, s) => sign + strip(s) + (s.endsWith(NOEOL) ? NOEOL_MARK : "");
  // 変更のある op 位置を context 幅でまとめてハンクにする
  const changes = [];
  ops.forEach((op, i) => {
    if (op[0] !== "=") changes.push(i);
  });
  const hunks = [];
  for (const c of changes) {
    const s = Math.max(0, c - ctx), e = Math.min(ops.length, c + ctx + 1);
    const last = hunks[hunks.length - 1];
    if (last && s <= last.e) last.e = e;
    else hunks.push({ s, e });
  }
  const out = ["--- " + (opts.fromLabel || "a"), "+++ " + (opts.toLabel || "b")];
  for (const h of hunks) {
    const slice = ops.slice(h.s, h.e);
    const aCount = slice.filter((o) => o[0] !== "+").length;
    const bCount = slice.filter((o) => o[0] !== "-").length;
    const aStart = aCount ? slice.find((o) => o[0] !== "+")[1] + 1 : slice[0][1];
    const bStart = bCount ? slice.find((o) => o[0] !== "-")[2] + 1 : slice[0][2];
    out.push("@@ -" + aStart + "," + aCount + " +" + bStart + "," + bCount + " @@");
    for (const [t, i, j] of slice) out.push(t === "+" ? line("+", b[j]) : line(t === "-" ? "-" : " ", a[i]));
  }
  return out.join("\n") + "\n";
}

// 文字列を UTF-8 バイト数で切り詰める（diff API の truncated 判定。行境界で切る）
export function truncateUtf8(text, maxBytes = DIFF_MAX_BYTES) {
  const s = String(text ?? "");
  if (Buffer.byteLength(s) <= maxBytes) return { text: s, truncated: false };
  let cut = Buffer.from(s).subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
  const nl = cut.lastIndexOf("\n");
  if (nl > 0) cut = cut.slice(0, nl + 1);
  return { text: cut, truncated: true };
}

// manifest 由来の版ファイル名の安全判定（合意事項外・監査4巡目【高】対応）
// パス区切り・.. を含まない「v<番号>.<拡張子>」のみ許可し、manifest 経由のパストラバーサルを封じる
export function safeVersionFileName(name) {
  return typeof name === "string" && /^v\d+\.[A-Za-z0-9._-]{1,32}$/.test(name) && !name.includes("/") && !name.includes("\\") && !name.includes("..");
}

// ---- ローカルプロジェクト登録とトピック紐付け（仕様: SPEC-プロジェクト紐付け.md。純関数のみ、I/O は server 側）----

export const PROJECT_DIGEST_MAX = 4000; // 初回プロンプトに添える要約の上限（文字）
export const PROJECT_README_MAX_BYTES = PROJECT_DIGEST_MAX * 4; // README の読み取り上限（バイト。UTF-8 は最大 4 バイト/文字）
export const PROJECT_ENTRIES_MAX = 50; // 直下エントリ名の上限
export const PROJECT_DIRTY_LIST_MAX = 12; // 未コミット変更パスの表示上限

// child が parent と同じか配下か（両方とも realpath 済みの絶対パスを渡す）
export function isInsidePath(child, parent) {
  const c = String(child || "").replace(/\/+$/, "");
  const p = String(parent || "").replace(/\/+$/, "");
  return !!p && (c === p || c.startsWith(p + "/"));
}

// probe の正規化。入力: { unregistered?, exists, readable, isGit, git: { branch, head, status } }（各 { ok, out } | { ok:false, err }）
// 出力: { status, branch, head, dirty, dirtyPaths, note }。status: ok | not-git | unavailable | missing | unreadable | unregistered
export function normalizeProbe(input) {
  const base = { status: "ok", branch: null, head: null, dirty: null, dirtyPaths: [], note: null };
  if (!input || input.unregistered) return { ...base, status: "unregistered", note: "登録 id が解決できません" };
  if (!input.exists) return { ...base, status: "missing", note: "パスが存在しないかディレクトリではありません" };
  if (!input.readable) return { ...base, status: "unreadable", note: "読み取り権限がありません" };
  if (!input.isGit) return { ...base, status: "not-git", note: null };
  const g = input.git || {};
  const failed = ["branch", "head", "status"].find((k) => !g[k] || !g[k].ok);
  if (failed) return { ...base, status: "unavailable", note: "確認不可: " + ((g[failed] && g[failed].err) || "git を実行できません") };
  const lines = String(g.status.out || "").split("\n").filter((l) => l.trim());
  const paths = lines.map((l) => l.slice(3).trim()).filter(Boolean);
  return {
    status: "ok",
    branch: String(g.branch.out || "").trim() || null,
    head: String(g.head.out || "").trim() || null,
    dirty: lines.length,
    dirtyPaths: paths.slice(0, PROJECT_DIRTY_LIST_MAX),
    note: null,
  };
}

// 移行用: 旧 state のトピックが「実行済み」かを一度だけ推定する（以後は projectLocked フラグが正）
export function topicHasRunLegacy(topic, messages) {
  const agents = (topic && topic.agents) || {};
  if (Object.values(agents).some((a) => a && a.sessionId)) return true;
  return (messages || []).some((m) => m.topicId === topic.id && m.author !== "user");
}

// 初回プロンプト用の要約。README 冒頭＋直下エントリ名を合計 limit 文字で打ち切る。読めなければ理由の 1 行
export function projectDigest({ readmeName, readmeText, entries, error }, limit = PROJECT_DIGEST_MAX) {
  if (error) return "（プロジェクト要約は取得できませんでした: " + error + "）";
  const names = (entries || [])
    .filter((e) => e.name !== ".git" && e.name !== "node_modules")
    .map((e) => e.name + (e.dir ? "/" : ""))
    .sort((a, b) => a.localeCompare(b));
  const shown = names.slice(0, PROJECT_ENTRIES_MAX);
  let out = "直下のエントリ（" + names.length + " 件）: " + shown.join(", ") + (names.length > shown.length ? " 他 " + (names.length - shown.length) + " 件" : "") + "\n";
  if (readmeName && readmeText) out += "--- " + readmeName + " 冒頭 ---\n" + readmeText;
  else out += "（README は見つかりませんでした）";
  if (out.length > limit) out = out.slice(0, limit) + "\n…（要約は " + limit + " 文字で打ち切り）";
  return out;
}

// プロンプトに入れる対象プロジェクトの 1 行
export function projectPromptLine(project, probe) {
  const p = probe || { status: "unavailable", note: "確認不可" };
  let git;
  if (p.status === "ok") git = "Git: " + (p.branch || "?") + "@" + (p.head || "?") + "、未コミット変更 " + p.dirty + " 件";
  else if (p.status === "not-git") git = "Git 管理外のフォルダ";
  else git = "Git 情報は" + (p.note && p.note.startsWith("確認不可") ? p.note : "確認不可（" + (p.note || p.status) + "）");
  return "対象プロジェクトは「" + project.name + "」（" + project.path + "、閲覧のみ・変更不可）。" + git + "。";
}

// 紐付けありトピックの変更通知（Kometa の監視リストは使わず、対象の未コミット変更を注記する）
export function projectChangeNote(probe) {
  if (!probe || probe.status !== "ok" || !probe.dirty) return "";
  const rest = probe.dirty - probe.dirtyPaths.length;
  return "\n\n（対象プロジェクトの未コミット変更: " + probe.dirtyPaths.join(", ") + (rest > 0 ? " 他 " + rest + " 件" : "") + "）";
}

// 要約・引き継ぎ履歴の出所注記。要約は生成時の対象（topic.summaryProjectId、null = Kometa）を持ち、分岐で要約と一緒に引き継がれる。
// 分岐で持ち込んだ会話の出所は topic.carriedProjectId（undefined = 引き継ぎなし）に恒久記録され、再要約しても消えない。
// 現在の対象（topic.projectId）と違う出所があるときだけ注記を返す。label は id → 表示名
export function summaryOriginNote(topic, label) {
  if (!topic) return "";
  const now = topic.projectId || null;
  const notes = [];
  const from = topic.summaryText ? topic.summaryProjectId || null : undefined;
  if (from !== undefined && from !== now)
    notes.push("（注意: 以下の要約は対象「" + label(from) + "」の時点のものです。現在の対象は「" + label(now) + "」です）");
  const carried = topic.carriedProjectId === undefined ? undefined : topic.carriedProjectId || null;
  if (carried !== undefined && carried !== now && carried !== from)
    notes.push("（注意: 引き継いだ会話には対象「" + label(carried) + "」の時点の内容が含まれます。現在の対象は「" + label(now) + "」です）");
  return notes.length ? notes.join("\n") + "\n" : "";
}

// ---- 多者構成（Grok 参戦。仕様: SPEC-Grok参戦.md。純関数のみ、I/O は server 側）----

// エージェント定義（正）。AGENTS / AUTHORS / NAMES はここから派生する
export const AGENT_DEFS = {
  claude: { name: "Claude Code", cssVar: "--claude" },
  codex: { name: "Codex", cssVar: "--codex" },
  grok: { name: "Grok", cssVar: "--grok", color: "#b99aff" },
};
export const LEGACY_AGENTS = ["claude", "codex"]; // 旧トピックの参加者・thread:"both" の意味
// null は「理由が記録されていない」= 不明。移行で復元した過去リレーは基本これになる（偽の確実さを作らない）
export const RELAY_STOP_REASONS = ["agreed", "hops", "budget", "error", "cancelled", "auto-off", "unauthed", "manual", "restart"];

// ---- 質疑リレーの履歴（仕様: SPEC-relayHistory.md）----
// 確定記録 1 件の形。不明な項目は null のままにする（"" や既定値で埋めない）
export function relayRecord(relay, extra = {}) {
  const r = relay || {};
  return {
    id: r.id || null,
    participants: Array.isArray(r.participants) ? r.participants.slice() : [],
    spoken: r.spoken && typeof r.spoken === "object" ? { ...r.spoken } : {},
    hops: Number(r.seq) || 0,
    stopReason: r.stopReason || null,
    agenda: typeof r.agenda === "string" ? r.agenda : null,
    startMessageId: r.startMessageId || null,
    startedTs: r.startedTs || null,
    endedTs: null,
    reconstructed: false,
    ...extra,
  };
}

// 配送コピーの provenance だけから過去リレーを復元する。
// 分かるのは参加者の並び（source.turn が participants の添字）・手番数・時刻の範囲だけ。
// 停止理由・議題・開始メッセージは復元できないので null のまま返す
export function reconstructRelays(msgs) {
  const byId = new Map();
  for (const m of sortByTsId(msgs)) {
    const pv = (m && m.provenance) || {};
    const s = pv.delivery === "qa-relay" ? pv.source : null;
    if (!s || s.relayId == null) continue;
    let r = byId.get(s.relayId);
    if (!r) {
      r = { id: s.relayId, seqs: new Set(), turns: new Map(), spoken: {}, startedTs: m.ts || null, endedTs: m.ts || null };
      byId.set(s.relayId, r);
    }
    r.endedTs = m.ts || r.endedTs;
    if (r.startedTs == null || (m.ts != null && m.ts < r.startedTs)) r.startedTs = m.ts;
    const key = s.seq != null ? "s:" + s.seq : "m:" + (s.messageId || m.id);
    if (r.seqs.has(key)) continue; // 同じ手番の配送コピーは 1 件として数える
    r.seqs.add(key);
    const agent = s.agent || m.author;
    if (agent) {
      r.spoken[agent] = (r.spoken[agent] || 0) + 1;
      if (Number.isInteger(s.turn) && s.turn >= 0) r.turns.set(s.turn, agent); // 手番の添字から参加者の並びを戻す
    }
  }
  return [...byId.values()]
    .map((r) => ({
      id: r.id,
      participants: [...r.turns.keys()].sort((a, b) => a - b).map((k) => r.turns.get(k)),
      spoken: r.spoken,
      hops: r.seqs.size,
      stopReason: null, // 復元できない。不明のまま
      agenda: null,
      startMessageId: null,
      startedTs: r.startedTs,
      endedTs: r.endedTs,
      reconstructed: true,
    }))
    .sort((a, b) => (a.startedTs || 0) - (b.startedTs || 0) || String(a.id).localeCompare(String(b.id)));
}

// 履歴から 1 本引く（フロービューが過去リレーの結末を出すための参照）
export function findRelayRecord(topic, relayId) {
  if (!topic || relayId == null) return null;
  return (topic.relayHistory || []).find((h) => h && h.id === relayId) || null;
}

// 参加者のうち自分以外
export function peersOf(participants, agent) {
  return (participants || []).filter((a) => a !== agent);
}

// レビュー依頼先の既定: 作者以外の参加者。ユーザー作者は参加者全員。参加者が無ければ旧来の 2 名
export function defaultReviewers(participants, origin) {
  const base = participants && participants.length ? participants : LEGACY_AGENTS;
  return origin === "user" || !origin ? base.slice() : peersOf(base, origin);
}

// 次の手番（参加者数で循環）
export function nextTurn(relay) {
  const n = (relay.participants || []).length;
  return n ? (relay.turn + 1) % n : 0;
}

// 終了宣言の有効判定: マーカーがあり、かつ参加者全員が開始以降に 1 回以上発言している
// 終了マーカーの有効判定: 空行を除いた最終行の末尾にマーカーがそのまま書かれている場合のみ有効
// （文末直結「賛成です【質疑終了】」・単独行・箇条書き「- 【質疑終了】」は可）。
// 受理しない形: 文中・否定文（実例:「ここではまだ【質疑終了】しません」）、マーカー後に本文が続く、
// 引用行（>）、鉤括弧・括弧・インラインコード・取消線で包んだ言及、コードブロック内
// （``` と ~~~ のフェンスを種類・長さ・開閉で追跡。CommonMark 同様、開いたフェンスは同種・同長以上でのみ閉じる）、
// 4 スペース以上のインデント行（コード表記とみなす）。
// 末尾に許容するのは空白・Markdown 強調（* _）・句読点（。．.!！）のみ。閉じ括弧・バッククォート・~ は不可
const END_MARK_TAIL = /[\s*_。．.!！]*$/;
const END_MARK_WRAP = /[「『（(［\[｢"'“‘`~]$/; // マーカー直前にあれば「包んだ言及」
export function hasEndMark(text, mark) {
  if (!text || !mark) return false;
  const rawLines = String(text).split(/\r?\n/);
  let fence = null; // 開いているフェンス { ch, len } | null
  let lastIdx = -1;
  let lastInCode = false;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      const ch = m[1][0];
      const len = m[1].length;
      if (!fence) fence = { ch, len };
      else if (ch === fence.ch && len >= fence.len) fence = null;
      if (line.trim()) {
        lastIdx = i;
        lastInCode = true; // フェンス行自体は終了宣言の行にならない
      }
      continue;
    }
    if (line.trim()) {
      lastIdx = i;
      lastInCode = !!fence || /^( {4}|\t)/.test(line);
    }
  }
  if (lastIdx < 0 || lastInCode) return false;
  const last = rawLines[lastIdx].trim();
  if (last.startsWith(">")) return false;
  const body = last.replace(END_MARK_TAIL, "");
  if (!body.endsWith(mark)) return false;
  return !END_MARK_WRAP.test(body.slice(0, -mark.length));
}

// 終了宣言の有効判定: 最終行末尾のマーカー（hasEndMark）があり、かつ参加者全員が開始以降に 1 回以上発言している
export function canEndRelay(relay, text, mark) {
  if (!hasEndMark(text, mark)) return false;
  const spoken = relay.spoken || {};
  return (relay.participants || []).every((a) => (spoken[a] || 0) >= 1);
}

// 未読の切り詰め: 末尾 max 件と、落とした件数
export function clipBacklog(msgs, max) {
  const list = msgs || [];
  if (list.length <= max) return { msgs: list, dropped: 0 };
  return { msgs: list.slice(-max), dropped: list.length - max };
}

// 質疑の配送コピーを relayId + seq で重複排除（turn は循環するのでキーにしない）
export function dedupeRelayCopies(msgs) {
  const seen = new Set();
  return (msgs || []).filter((m) => {
    const s = m.provenance && m.provenance.delivery === "qa-relay" ? m.provenance.source : null;
    if (!s || s.relayId == null || s.seq == null) return true;
    const key = s.relayId + ":" + s.seq;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- 要約の鮮度（仕様: SPEC-要約鮮度.md「未反映件数の数え方」）----
// 発言の並び順（ts 昇順、同 ts は id 昇順）。「どこまで要約したか」を指す summaryLastMsgId を書く側と
// 数える側で同じ順序を使う（質疑の配送コピーは同一 ts で複数作られるので、挿入順とは一致しない）
export function sortByTsId(msgs) {
  return (msgs || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)));
}

// 素の件数は 3 名リレーで 1 手番が 3 件（応答 1 ＋ 配送コピー 2）になるため、人が読む単位に合わせて数える。
// 起点は summaryLastMsgId の次から。ID が対象内に無ければ summaryAt 件目から（旧トピック・分岐直後の後方互換）
export function unreflectedMessages(msgs, opts = {}) {
  const list = sortByTsId(msgs);
  let start = null;
  if (opts.summaryLastMsgId) {
    const i = list.findIndex((m) => m && m.id === opts.summaryLastMsgId);
    if (i >= 0) start = i + 1;
  }
  if (start == null) start = Math.min(Math.max(0, Number(opts.summaryAt) || 0), list.length);
  // 配送コピー（qa-relay / relay / handoff）は、元発言が同じトピックに居るなら数えない。
  // 質疑の手番は「応答 1 件（自分のレーン・source なし）＋ 配送コピー 参加者-1 件」で保存されるため、
  // コピーを落とすと 1 手番 = 1 件になる。元発言を辿れない孤児のコピーだけ relayId+seq で 1 件に畳んで残す
  const ids = new Set(list.map((m) => m && m.id));
  const kept = list.slice(start).filter((m) => {
    const pv = (m && m.provenance) || {};
    if (pv.delivery !== "qa-relay" && pv.delivery !== "relay" && pv.delivery !== "handoff") return true;
    const src = pv.source && pv.source.messageId;
    return !(src && ids.has(src));
  });
  return dedupeRelayCopies(kept);
}

export function unreflectedCount(msgs, opts = {}) {
  return unreflectedMessages(msgs, opts).length;
}

// トピックの鮮度。due は表示の強調用（未反映が閾値以上）であって、自動要約の発火条件ではない。
// 自動トリガは checkSummaries の「素の件数 - summaryAt >= SUMMARY_EVERY」のままで、こちらの方が先に立つ
export function summaryFreshness(topic, msgs, threshold) {
  const t = topic || {};
  const unreflected = unreflectedCount(msgs, { summaryLastMsgId: t.summaryLastMsgId, summaryAt: t.summaryAt });
  const th = Number(threshold) || 0;
  return { total: (msgs || []).length, unreflected, threshold: th, due: th > 0 && unreflected >= th };
}

// Grok streaming-json（NDJSON）の解析。text デルタの連結・end の最終メタ・error 行・実況ステップ
// 実測（smoke-Grok工程0.md）: thought / text（デルタ）/ usage / tool_call / tool_call_update / end
export function parseGrokStream(lines) {
  let text = "";
  let end = null;
  let error = null;
  const steps = [];
  for (const raw of lines || []) {
    const line = String(raw || "").trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    if (ev.type === "text") text += String(ev.data ?? ev.delta ?? ev.text ?? ev.content ?? ""); // 実測: デルタは data フィールド（thought と同形）
    else if (ev.type === "end") end = ev;
    else if (ev.type === "error") error = String(ev.message || ev.error || "grok エラー");
    const s = grokStepFrom(ev);
    if (s) steps.push(s);
  }
  // end に本文が含まれる形式（json 形式の text）にも対応
  if (!text && end && typeof end.text === "string") text = end.text;
  return { text, end, error, steps };
}

export function grokStepFrom(ev) {
  if (!ev) return null;
  if (ev.type === "thought") return "🧠 思考中";
  if (ev.type === "tool_call") return "🔧 " + String(ev.title || ev.toolName || "tool").slice(0, 70);
  if (ev.type === "text") return "✍ 応答を作成中";
  return null;
}

// end イベント → 共通 meta。cancelled は「権限要求または中断で停止」（成功扱いにしない）。費用が無ければ unknown（0 円とみなさない）
export function grokMetaFrom(end, durationMs, modelOverride) {
  const e = end || {};
  const u = e.usage || {};
  const model = Object.keys(e.modelUsage || {})[0] || modelOverride || "";
  return {
    status: e.stopReason === "cancelled" ? "stopped" : "completed",
    model,
    durationMs,
    usage: { inTok: u.input_tokens || 0, outTok: u.output_tokens || 0, cacheTok: u.cache_read_input_tokens || 0 },
    billing: typeof e.total_cost_usd === "number" ? { mode: "metered", usd: e.total_cost_usd } : { mode: "unknown" },
  };
}

export const GROK_STOP_NOTE = "Grok が権限要求または中断で停止しました（許可されていない操作の可能性）";

// 未認証のエラー文かどうか
export function isGrokUnauthedError(text) {
  return /not signed in|unauthenticated|please (log|sign) ?in/i.test(String(text || ""));
}

// フロービューのグラフ導出（仕様: SPEC-フロービュー.md）。本体は public/flow-graph.js（ブラウザも同じファイルを読む）。ここはテスト用の再 export
export * from "./public/flow-graph.js";
