// import なし・DOM/fs 不使用。ブラウザと Node が共有する使用量の導出。
// 保存済み実行記録の使用量。金額は請求額ではなく metered の実測分のみ。
// 不明値を0の観測値に変換せず、各指標に known / unknown の件数を保持する。
// unknown 課金の取消は CLI 中断時の未計測値。Codex (plan) や
// Grok の結果イベント (metered) に保存された実測 usage はそのまま残す。
export function measuredTokenUsage(meta) {
  if (meta?.status === "cancelled" && meta?.billing?.mode === "unknown") return {};
  return meta?.usage && typeof meta.usage === "object" ? meta.usage : {};
}

export function aggregateUsage(state = {}) {
  const metric = () => ({ value: 0, known: 0, unknown: 0 });
  const bucket = () => ({ records: 0, missingMeta: 0, kinds: { message: 0, review: 0, fix: 0, summary: 0 },
    billing: { metered: 0, plan: 0, unknown: 0 }, inTok: metric(), outTok: metric(), cacheTok: metric(), durationMs: metric(), usd: metric() });
  const total = bucket(), rows = new Map(), topicTotals = new Map();
  const titles = new Map((state.topics || []).map((topic) => [topic.id, topic.title]));
  const excluded = { user: 0, delivery: 0, branch: 0, duplicate: 0, skipped: 0, external: 0 };
  const seen = new Set(), legacySummaryTopics = [];
  const valid = (value, integer = false) => typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value));
  const add = (kind, record, topicId, agent) => {
    const id = record.id == null ? null : JSON.stringify([kind, record.id]);
    if (id && seen.has(id)) { excluded.duplicate++; return; }
    if (id) seen.add(id);
    // historyError は修正後にも付く。beforeVersionId があれば CLI 実行後なので不明記録として残す。
    if (!record.meta && (record.budget || record.skipped || record.blocked || record.projectError ||
      (record.historyError && (kind !== "fix" || !record.beforeVersionId)))) { excluded.skipped++; return; }
    topicId = topicId || null; agent = agent || null;
    if (!topicTotals.has(topicId)) topicTotals.set(topicId, { topicId, title: titles.get(topicId) || (topicId ? "削除済みトピック: " + topicId : "所属不明"), total: bucket() });
    const key = JSON.stringify([topicId, agent]);
    if (!rows.has(key)) rows.set(key, { topicId, agent, ...bucket() });
    const meta = record.meta && typeof record.meta === "object" ? record.meta : null;
    const usage = measuredTokenUsage(meta);
    const billing = meta?.billing;
    const money = billing?.mode === "metered" && valid(billing.usd) ? billing.usd : null;
    const billingKind = money !== null ? "metered" : billing?.mode === "plan" ? "plan" : "unknown";
    const values = { inTok: valid(usage.inTok, true) ? usage.inTok : null, outTok: valid(usage.outTok, true) ? usage.outTok : null,
      cacheTok: valid(usage.cacheTok, true) ? usage.cacheTok : null, durationMs: valid(meta?.durationMs) ? meta.durationMs : null, usd: money };
    for (const target of [total, topicTotals.get(topicId).total, rows.get(key)]) {
      target.records++; target.kinds[kind]++; target.billing[billingKind]++;
      if (!meta) target.missingMeta++;
      for (const [name, value] of Object.entries(values)) {
        if (value === null) target[name].unknown++;
        else { target[name].value += value; target[name].known++; }
      }
    }
  };
  for (const message of state.messages || []) {
    // 複製は新しい実行ではない。元が削除済みでも、コピーへ費用を付け替えない。
    if (message.copiedFromMessageId) { excluded.branch++; continue; }
    if (["qa-relay", "relay", "handoff"].includes(message.provenance?.delivery)) { excluded.delivery++; continue; }
    if (message.author === "user") { excluded.user++; continue; }
    // 外部で実行・再入力された結果は、このアプリ内の実行記録と別扱い。
    // ingress 欠落の旧発言まで未実施と推測しない。
    if (message.taskId || message.provenance?.ingress === "cli-sync") { excluded.external++; continue; }
    add("message", message, message.topicId, message.author);
  }
  for (const item of state.pool || []) {
    for (const review of item.reviews || []) add("review", review, item.topicId, review.reviewer);
    for (const fix of item.fixes || []) add("fix", fix, item.topicId, fix.agent);
  }
  for (const topic of state.topics || []) {
    const history = Array.isArray(topic.summaryUsage) ? topic.summaryUsage : [];
    const legacy = topic.summaryUsageLegacyUnknown === true || (!Array.isArray(topic.summaryUsage) && !!(topic.summaryTs || topic.summaryText || topic.summaryCostUsd));
    if (legacy) legacySummaryTopics.push(topic.id);
    for (const entry of history) add("summary", entry, topic.id, entry.agent || "claude");
  }
  const topicOrder = new Map((state.topics || []).map((t, i) => [t.id, i]));
  const order = (a, b) => (topicOrder.get(a.topicId) ?? topicOrder.size) - (topicOrder.get(b.topicId) ?? topicOrder.size) ||
    String(a.topicId || "").localeCompare(String(b.topicId || "")) || String(a.agent || "").localeCompare(String(b.agent || ""));
  return { total, topics: [...topicTotals.values()].sort(order), rows: [...rows.values()].sort(order), excluded, legacySummaryTopics };
}
