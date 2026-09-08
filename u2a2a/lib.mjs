// U2A2A — 純粋ロジックの切り出し（合意事項F: 大規模分割はせず、守りたい判定だけを単体テスト可能に）
// このファイルは fs / ネットワーク / タイマーに依存しない。

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
