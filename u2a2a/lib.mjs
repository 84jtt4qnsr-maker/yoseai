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
