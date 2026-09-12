// Yoseai — フロービューのグラフ導出（仕様: pool/topics/9a299f1bac1a09fb/SPEC-フロービュー.md）
// ブラウザ（index.html の <script type="module">）と Node（lib.mjs から再 export、test/flow.test.mjs）が同じファイルを読む。
// import なし・DOM / fs / タイマー不使用。入力は変更しない（Object.freeze された配列でも動く）。
// 例外は投げず、壊れた要素は warnings[] に残して読み飛ばす。同じ入力からは同じ出力（ts 昇順、同 ts は id 昇順）。

export const FLOW_DEFAULTS = Object.freeze({ sendWindowMs: 50, keepOpenTail: 2, headChars: 60 });

// タスク状態 → 発光（server.mjs TASK_STATUSES: queued / working / returned / done）
export const TASK_STATUS = Object.freeze({ queued: "wait", working: "run", returned: "ok", done: "ok" });

// リレー停止理由 → 発光（lib.mjs RELAY_STOP_REASONS）。agreed だけが「決着」。打ち切りは黄、失敗は赤
export const RELAY_STOP_STATUS = Object.freeze({
  agreed: "ok",
  hops: "wait",
  manual: "wait",
  "auto-off": "wait",
  restart: "wait", // 再起動での打ち切り。合意で閉じたわけではないので青（完了）にしない
  error: "err",
  budget: "err",
  unauthed: "err",
  cancelled: "err",
});

const STATUS_RANK = Object.freeze({ run: 0, err: 1, wait: 2, ok: 3 });
const DEFAULT_PROV = Object.freeze({ ingress: "ui", delivery: "direct", trigger: "manual", source: null });

// ---- 小さな判定（server.mjs / lib.mjs と同じ意味。相互 import はしない） ----

export function provOf(m) {
  return m && m.provenance && typeof m.provenance === "object" ? m.provenance : DEFAULT_PROV;
}

// 配送コピー（質疑リレー・転送・引き継ぎ）。ノードにしない
export function isCopy(m) {
  const d = provOf(m).delivery;
  return d === "qa-relay" || d === "relay" || d === "handoff";
}

export function cmpTs(a, b) {
  const d = (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0);
  if (d) return d;
  const x = String((a && a.id) || ""), y = String((b && b.id) || "");
  return x < y ? -1 : x > y ? 1 : 0;
}

export function headOf(text, n = FLOW_DEFAULTS.headChars) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function worst(a, b) {
  return STATUS_RANK[a] <= STATUS_RANK[b] ? a : b;
}

function uniq(list) {
  return [...new Set(list)];
}

// ---- 送信束（合意メモ「エピソード束の鍵と横並び」） ----
// 同一トピック・author=user・UI 直接送信・同一本文・異なる宛先レーン・束の先頭 ts から windowMs 以内、を推定でまとめる。
// 直前候補との差ではなく先頭からの幅なので、0・40・80ms が連鎖して 1 束にならない。
export function groupUserSends(msgs, windowMs = FLOW_DEFAULTS.sendWindowMs) {
  // SPEC ノード表: ingress "cli-sync" はユーザー発言でもすべて sync ノード（送信束の候補にしない）
  const cands = (msgs || []).filter((m) => m && m.author === "user" && !isCopy(m) && provOf(m).ingress !== "cli-sync").slice().sort(cmpTs);
  const out = [];
  let cur = null;
  for (const m of cands) {
    const ui = provOf(m).ingress === "ui";
    const ts = Number(m.ts) || 0;
    if (cur && cur.ui && ui && m.text === cur.text && !cur.lanes.includes(m.thread) && ts - cur.ts <= windowMs) {
      cur.messageIds.push(m.id);
      cur.lanes.push(m.thread);
      continue;
    }
    cur = { key: "msg:" + m.id, startId: m.id, ts, text: m.text, messageIds: [m.id], lanes: [m.thread], ui };
    out.push(cur);
  }
  return out.map(({ ui, ...b }) => ({ ...b, inferred: b.messageIds.length > 1 }));
}

// ---- 質疑リレー（配送コピーを relayId で束ね、source.messageId から元応答を引く） ----
export function collectRelays(msgs) {
  const map = new Map();
  for (const m of (msgs || []).slice().sort(cmpTs)) {
    const pv = provOf(m);
    if (pv.delivery !== "qa-relay" || !pv.source || pv.source.relayId == null) continue;
    const s = pv.source;
    let r = map.get(s.relayId);
    if (!r) {
      r = { relayId: s.relayId, hops: [], participants: [], replyIds: [], copyIds: [], seen: new Set() };
      map.set(s.relayId, r);
    }
    r.copyIds.push(m.id);
    // 配送コピーは宛先ごとに複数ある。seq（無ければ元メッセージ ID）で 1 手 1 件に落とす（lib.dedupeRelayCopies と同じ鍵）
    const hopKey = s.seq != null ? "s:" + s.seq : "m:" + (s.messageId || m.id);
    if (r.seen.has(hopKey)) continue;
    r.seen.add(hopKey);
    r.hops.push({ seq: s.seq != null ? Number(s.seq) : null, turn: s.turn != null ? Number(s.turn) : null, agent: s.agent || m.author, messageId: s.messageId || null, copyTs: Number(m.ts) || 0 });
  }
  for (const r of map.values()) {
    r.hops.sort((a, b) => (a.seq == null || b.seq == null ? a.copyTs - b.copyTs : a.seq - b.seq));
    r.participants = uniq(r.hops.map((h) => h.agent));
    r.replyIds = r.hops.map((h) => h.messageId).filter(Boolean);
    delete r.seen;
  }
  return map;
}

// ---- 判定ラベル（承認は発光でなくラベル） ----
export function artifactVerdicts(item) {
  const latest = new Map();
  for (const r of (item && item.reviews) || []) {
    if (!r || !r.reviewer) continue;
    const prev = latest.get(r.reviewer);
    if (!prev || cmpTs(prev, r) <= 0) latest.set(r.reviewer, r);
  }
  const reviewers = uniq([...((item && item.reviewers) || []), ...[...latest.keys()].sort()]);
  return reviewers.map((reviewer) => {
    const r = latest.get(reviewer);
    if (!r) return { reviewer, label: "未実施", ts: null };
    return { reviewer, label: reviewLabel(r), ts: Number(r.ts) || null };
  });
}

function reviewLabel(r) {
  if (r.verdict) return String(r.verdict);
  if (r.skipped) return "スキップ";
  if (r.error) return "エラー";
  if (r.stopped) return "中断";
  return "未判定";
}

// ---- 発光 ----
export function nodeStatus(node, ctx = {}) {
  switch (node.kind) {
    case "reply":
    case "unrelayed":
      return node.stopped ? "err" : "ok";
    case "replies":
      return (node.statuses || ["ok"]).reduce(worst, "ok");
    case "system":
      return "err";
    case "sync":
      return "ok";
    case "pending":
      return "run";
    case "artifact": {
      const id = node.itemId;
      const pend = (ctx.reviewPending && ctx.reviewPending[id]) || (ctx.fixPending && ctx.fixPending[id]);
      return pend && (!Array.isArray(pend) || pend.length) ? "run" : "ok";
    }
    case "task":
      return TASK_STATUS[node.taskStatus] || "wait";
    case "relay":
      if (node.active) return "run";
      if (!node.stopReason) return ""; // 停止理由の記録がない旧リレー: 「終了理由不明」の中立表示（成功の青にしない）
      return RELAY_STOP_STATUS[node.stopReason] || "ok";
    default:
      return "ok";
  }
}

// ---- 分岐（親には子の一覧が無い。子の branchedFrom を全件走査） ----
export function childBranches(topics, topicId) {
  return (topics || [])
    .filter((t) => t && t.branchedFrom && t.branchedFrom.topicId === topicId)
    .map((t) => ({ childTopicId: t.id, title: t.title || "", atMessageId: t.branchedFrom.messageId || null }))
    .sort((a, b) => (a.childTopicId < b.childTopicId ? -1 : a.childTopicId > b.childTopicId ? 1 : 0));
}

// 子側: コピーは新 ID なので copiedFromMessageId で分岐点を探す（ID 同一の前提は置かない）
export function branchOrigin(topics, messages, topicId) {
  const t = (topics || []).find((x) => x && x.id === topicId);
  if (!t || !t.branchedFrom) return null;
  const copy = (messages || []).find((m) => m && m.topicId === topicId && m.copiedFromMessageId === t.branchedFrom.messageId);
  return {
    parentTopicId: t.branchedFrom.topicId || null,
    parentMessageId: t.branchedFrom.messageId || null,
    copyMessageId: copy ? copy.id : null,
  };
}

// ---- 折りたたみ計画（既定値だけ。展開状態はクライアントが持つ） ----
export function foldPlan(episodes, keepOpenTail = FLOW_DEFAULTS.keepOpenTail) {
  const n = episodes.length;
  return episodes.map((ep, i) => {
    const open = i === 0 || i >= n - keepOpenTail || ep.hasRun || ep.hasBranchPoint;
    return { ...ep, folded: !open };
  });
}

// ---- 元メッセージ ID → 所属カード key ----
export function membershipOf(nodes) {
  const out = {};
  for (const n of nodes) {
    if (Array.isArray(n.messageIds)) for (const id of n.messageIds) out[id] = n.key;
    else if (n.messageId) out[n.messageId] = n.key;
    if (n.kind === "relay") for (const h of n.hops) if (h.messageId) out[h.messageId] = n.key;
  }
  return out;
}

// ---- 本体 ----
export function buildFlowGraph(input, options = {}) {
  const opt = { ...FLOW_DEFAULTS, ...(options || {}) };
  const names = opt.names || {};
  const nameOf = (a) => names[a] || a;
  const warnings = [];
  const inp = input && typeof input === "object" ? input : {};
  const topicId = inp.topicId == null ? null : String(inp.topicId);
  const topics = Array.isArray(inp.topics) ? inp.topics : [];
  const allMessages = Array.isArray(inp.messages) ? inp.messages : [];
  const pool = Array.isArray(inp.pool) ? inp.pool : [];
  const tasks = Array.isArray(inp.tasks) ? inp.tasks : [];
  const running = inp.running && typeof inp.running === "object" ? inp.running : {};
  const ctx = { reviewPending: inp.reviewPending || {}, fixPending: inp.fixPending || {} };
  const empty = { topicId, episodes: [], nodes: [], edges: [], membership: {}, branches: [], origin: null, warnings };
  if (!topicId) {
    warnings.push("topicId がありません");
    return empty;
  }
  const topic = topics.find((t) => t && t.id === topicId) || null;
  if (!topic) warnings.push("topics に " + topicId + " がありません（relay・分岐は無しとして続行）");
  const relayState = (topic && topic.relay) || null;
  // 過去リレーの結末は topic.relayHistory から引く（topic.relay は現在の 1 本しか持たない）。
  // 履歴に無い、または stopReason が null のリレーは「終了理由不明」の中立表示のまま（仕様: SPEC-relayHistory.md）
  const relayHistory = new Map(((topic && topic.relayHistory) || []).filter((h) => h && h.id).map((h) => [h.id, h]));

  const msgs = allMessages.filter((m) => m && typeof m === "object" && m.topicId === topicId && m.id != null).slice().sort(cmpTs);
  if (allMessages.some((m) => !m || typeof m !== "object" || m.id == null)) warnings.push("id の無いメッセージを読み飛ばしました");
  const msgById = new Map(msgs.map((m) => [m.id, m]));
  const tsOf = (m) => Number(m.ts) || 0;

  // 1. リレー（先に確定し、手番の応答を通常応答から除く）
  const relays = collectRelays(msgs);
  const relayOfReply = new Map();
  for (const r of relays.values()) for (const id of r.replyIds) relayOfReply.set(id, r.relayId);

  // 2. ノード生成
  const nodes = [];
  const laneNodes = []; // 束へ推定所属させるもの（reply / unrelayed / system / sync）
  const sends = groupUserSends(msgs, opt.sendWindowMs);
  const sendNodes = sends.map((b) => ({ kind: "send", key: b.key, ts: b.ts, messageIds: b.messageIds, lanes: b.lanes, text: b.text, head: headOf(b.text, opt.headChars), inferred: b.inferred }));
  for (const n of sendNodes) nodes.push(n);
  const sendIds = new Set(sends.flatMap((b) => b.messageIds));

  for (const m of msgs) {
    if (sendIds.has(m.id) || isCopy(m)) continue;
    if (m.author === "user" && provOf(m).ingress !== "cli-sync") continue; // 送信束が拾う（cli-sync のユーザー発言は下の sync ノードへ）
    if (relayOfReply.has(m.id)) continue; // リレーの手番応答は複合カードの中
    const pv = provOf(m);
    const lane = m.thread || m.author;
    const base = { key: "msg:" + m.id, messageId: m.id, ts: tsOf(m), agent: m.author, lane, text: m.text, head: headOf(m.text, opt.headChars) };
    let n;
    if (m.staleRelayId) n = { kind: "unrelayed", ...base, staleRelayId: m.staleRelayId, stopped: !!m.stopped };
    else if (pv.ingress === "cli-sync") n = { kind: "sync", ...base };
    else if (m.blocked || m.cancelled) n = { kind: "system", ...base, reason: m.blocked ? "blocked" : "cancelled" };
    else n = { kind: "reply", ...base, stopped: !!m.stopped, meta: m.meta || null, taskId: m.taskId || null };
    if (!m.provenance) warnings.push("provenance の無いメッセージ " + m.id + " を direct として扱いました");
    n.status = nodeStatus(n, ctx);
    nodes.push(n);
    laneNodes.push(n);
  }

  // リレー複合カード
  const relayNodes = [];
  for (const r of [...relays.values()].sort((a, b) => a.hops[0].copyTs - b.hops[0].copyTs)) {
    const hops = r.hops.map((h) => {
      const m = h.messageId ? msgById.get(h.messageId) : null;
      if (h.messageId && !m) warnings.push("リレー " + r.relayId + " の手番 " + h.seq + " の元応答 " + h.messageId + " が見つかりません");
      return { seq: h.seq, turn: h.turn, agent: h.agent, messageId: h.messageId, ts: m ? tsOf(m) : h.copyTs };
    });
    const current = relayState && relayState.id === r.relayId;
    const rec = relayHistory.get(r.relayId) || null;
    // 参加者は「現在のリレー → 確定記録 → 配送コピーからの復元」の順に確からしい方を採る
    const participants =
      current && Array.isArray(relayState.participants) && relayState.participants.length
        ? relayState.participants.slice()
        : rec && Array.isArray(rec.participants) && rec.participants.length
          ? rec.participants.slice()
          : r.participants;
    const n = {
      kind: "relay",
      key: "relay:" + r.relayId,
      relayId: r.relayId,
      ts: Math.min(...hops.map((h) => h.ts)),
      participants,
      hops,
      active: !!(current && relayState.active),
      stopReason: current ? relayState.stopReason || null : rec ? rec.stopReason || null : null,
      startMessageId: current ? relayState.startMessageId || null : rec ? rec.startMessageId || null : null,
      agenda: current ? relayState.agenda || null : rec ? rec.agenda || null : null,
      endedTs: rec ? rec.endedTs || null : null,
      // 記録が復元由来（停止理由が分からない）ことを UI に伝える。true のとき stopReason は必ず null
      reconstructed: !!(rec && rec.reconstructed),
      copyIds: r.copyIds,
    };
    n.status = nodeStatus(n, ctx);
    nodes.push(n);
    relayNodes.push(n);
  }

  // 実行中（末尾の束に置く）
  const pendingNodes = [];
  for (const agent of Object.keys(running).filter((k) => k.startsWith(topicId + ":") && running[k]).map((k) => k.slice(topicId.length + 1)).sort()) {
    const n = { kind: "pending", key: "run:" + agent, agent, lane: agent, ts: null, status: "run" };
    nodes.push(n);
    pendingNodes.push(n);
  }

  // 成果物・タスク
  const artifactNodes = pool
    .filter((p) => p && p.topicId === topicId && p.id != null)
    .slice()
    .sort(cmpTs)
    .map((p) => {
      const n = { kind: "artifact", key: "art:" + p.id, itemId: p.id, ts: tsOf(p), title: p.title || p.file || "", file: p.file || null, origin: p.origin || null, itemStatus: p.status || null, fromMessageId: p.fromMessageId || null, verdicts: artifactVerdicts(p) };
      n.pending = nodeStatus(n, ctx) === "run";
      n.status = n.pending ? "run" : "ok";
      return n;
    });
  const taskNodes = tasks
    .filter((t) => t && t.topicId === topicId && t.id != null)
    .slice()
    .sort(cmpTs)
    .map((t) => {
      const n = { kind: "task", key: "task:" + t.id, taskId: t.id, ts: tsOf(t), agent: t.agent || null, title: t.title || "", taskStatus: t.status || null, fromMessageId: t.fromMessageId || null };
      n.status = nodeStatus(n, ctx);
      return n;
    });
  for (const n of artifactNodes) nodes.push(n);
  for (const n of taskNodes) nodes.push(n);

  // 3. 束（エピソード）
  const startId = relayState && relayState.startMessageId;
  const episodes = sendNodes.map((s) => ({
    key: "ep:" + s.messageIds[0],
    kind: startId && s.messageIds.includes(startId) ? "relay" : "send",
    ts: s.ts,
    lanes: s.lanes,
    sendKey: s.key,
    members: [s],
  }));
  const epOfNode = new Map(); // nodeKey -> episode
  for (const ep of episodes) epOfNode.set(ep.sendKey, ep);
  const latestSendFor = (lane, ts) => {
    for (let i = episodes.length - 1; i >= 0; i--) {
      const ep = episodes[i];
      if (ep.ts <= ts && ep.lanes.includes(lane)) return ep;
    }
    return null;
  };
  const orphans = [];
  const attach = (n, ep) => {
    if (ep) {
      ep.members.push(n);
      epOfNode.set(n.key, ep);
    } else orphans.push(n);
  };
  for (const n of laneNodes) attach(n, latestSendFor(n.lane, n.ts));

  // リレー: 現行リレーは startMessageId で明示、過去は先手レーンの直前ユーザー発言を推定
  const relayStartEdges = [];
  for (const n of relayNodes) {
    let ep = null, style = null;
    if (n.startMessageId) {
      ep = episodes.find((e) => e.members[0].messageIds.includes(n.startMessageId)) || null;
      if (ep) style = "solid";
      else warnings.push("リレー " + n.relayId + " の startMessageId " + n.startMessageId + " が送信束にありません");
    }
    if (!ep && n.hops.length) {
      ep = latestSendFor(n.hops[0].agent, n.ts);
      if (ep) style = "dashed";
    }
    attach(n, ep);
    if (ep) relayStartEdges.push({ ep, n, style });
  }

  // 同一束・同一著者の応答が 2 件以上 → グループカード
  for (const ep of episodes) {
    const byAgent = new Map();
    for (const n of ep.members) if (n.kind === "reply") (byAgent.get(n.agent) || byAgent.set(n.agent, []).get(n.agent)).push(n);
    for (const [agent, list] of byAgent) {
      if (list.length < 2) continue;
      const g = {
        kind: "replies",
        key: "grp:" + list[0].messageId,
        ts: list[0].ts,
        agent,
        lane: list[0].lane,
        messageIds: list.map((n) => n.messageId),
        count: list.length,
        head: list[0].head,
        statuses: list.map((n) => n.status),
      };
      g.status = nodeStatus(g, ctx);
      const drop = new Set(list.map((n) => n.key));
      ep.members = ep.members.filter((n) => !drop.has(n.key));
      ep.members.push(g);
      for (const n of list) {
        nodes.splice(nodes.indexOf(n), 1);
        epOfNode.delete(n.key);
      }
      nodes.push(g);
      epOfNode.set(g.key, ep);
    }
  }

  let membership = membershipOf(nodes);

  // 成果物・タスク: 明示 fromMessageId が所属カードを指すときだけぶら下げる
  const hangEdges = [];
  for (const n of [...artifactNodes, ...taskNodes]) {
    const fromKey = n.fromMessageId ? membership[n.fromMessageId] : null;
    if (fromKey && epOfNode.get(fromKey)) {
      attach(n, epOfNode.get(fromKey));
      hangEdges.push({ kind: n.kind === "artifact" ? "artifact" : "task", fromKey, toKey: n.key });
    } else attach(n, null);
  }

  // 起点の無いもの: 時刻順にスパインへ混ぜる（送信束の間ごとに 1 つの orphan 束）
  const gapOf = (ts) => {
    let g = 0;
    for (const ep of episodes) if (ep.kind !== "orphan" && ep.ts <= ts) g++;
    return g;
  };
  const orphanBuckets = new Map();
  for (const n of orphans.slice().sort(cmpTs)) {
    const g = gapOf(n.ts);
    let ep = orphanBuckets.get(g);
    if (!ep) {
      ep = { key: "ep:orphan:" + n.key.replace(/^[a-z]+:/, ""), kind: "orphan", ts: n.ts, lanes: [], sendKey: null, members: [] };
      orphanBuckets.set(g, ep);
    }
    ep.members.push(n);
    epOfNode.set(n.key, ep);
  }
  const allEpisodes = [...episodes, ...orphanBuckets.values()].sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : 1));

  // 実行中は末尾の束へ（束が無ければ orphan 束を作る）
  if (pendingNodes.length) {
    let last = allEpisodes[allEpisodes.length - 1];
    if (!last) {
      last = { key: "ep:orphan:pending", kind: "orphan", ts: 0, lanes: [], sendKey: null, members: [] };
      allEpisodes.push(last);
    }
    for (const n of pendingNodes) {
      last.members.push(n);
      epOfNode.set(n.key, last);
    }
  }

  // 4. 分岐
  const origin0 = topic ? branchOrigin(topics, msgs, topicId) : null;
  let origin = null;
  if (origin0) {
    const anchorKey = origin0.copyMessageId ? membership[origin0.copyMessageId] || null : null;
    if (!anchorKey) warnings.push("分岐元 " + origin0.parentMessageId + " に対応するコピーがこのトピックにありません");
    origin = { parentTopicId: origin0.parentTopicId, parentMessageId: origin0.parentMessageId, anchorKey };
    const anchor = anchorKey ? nodes.find((n) => n.key === anchorKey) : null;
    if (anchor) anchor.branchPoint = true;
  }
  // 分岐点が配送コピーを指すときは source.messageId の所属カード、それも無ければ同時刻の束の起点カード
  const resolveAnchor = (messageId, what) => {
    if (messageId && membership[messageId]) return membership[messageId];
    const m = messageId ? msgById.get(messageId) : null;
    const src = m && provOf(m).source && provOf(m).source.messageId;
    if (src && membership[src]) {
      warnings.push(what + " " + messageId + " は配送コピーのため元応答 " + src + " のカードに付けました");
      return membership[src];
    }
    if (m) {
      const ep = [...allEpisodes].reverse().find((e) => e.kind !== "orphan" && e.ts <= tsOf(m));
      if (ep) {
        warnings.push(what + " " + messageId + " の所属カードが無いため束 " + ep.key + " の起点に付けました");
        return ep.sendKey;
      }
    }
    warnings.push(what + " " + messageId + " をこのトピックで解決できません");
    return null;
  };
  const branches = childBranches(topics, topicId).map((b) => ({ ...b, anchorKey: resolveAnchor(b.atMessageId, "分岐点") }));

  // 5. 束ごとの並びとノード順（起点 → レーン順 → ぶら下がり → 実行中）
  const order = { send: 0, reply: 1, replies: 1, unrelayed: 1, system: 1, sync: 1, relay: 1, artifact: 2, task: 2, pending: 3 };
  const orderedNodes = [];
  for (const ep of allEpisodes) {
    ep.members.sort((a, b) => order[a.kind] - order[b.kind] || (a.ts === b.ts ? (a.key < b.key ? -1 : 1) : a.ts - b.ts));
    for (const n of ep.members) orderedNodes.push(n);
  }
  membership = membershipOf(orderedNodes);

  // 6. エッジ
  const edges = [];
  const edge = (kind, from, to, style, via) => {
    const toKey = to.nodeKey || "mark:" + to.mark;
    edges.push({ id: "e:" + kind + ":" + from.nodeKey + ":" + toKey + (via && via.length ? ":" + via[0] : ""), kind, from, to, style, viaMessageIds: via || [] });
  };
  const right = (k) => ({ nodeKey: k, port: "right" });
  const left = (k) => ({ nodeKey: k, port: "left" });
  for (const ep of allEpisodes) {
    if (!ep.sendKey) continue;
    for (const n of ep.members) {
      if (n.kind === "reply" || n.kind === "replies" || n.kind === "system" || n.kind === "sync" || n.kind === "pending") edge("answer", right(ep.sendKey), left(n.key), "dashed", []);
    }
  }
  for (const { ep, n, style } of relayStartEdges) edge("relay-start", right(ep.sendKey), left(n.key), style, n.startMessageId ? [n.startMessageId] : []);
  for (const n of relayNodes) {
    for (let i = 1; i < n.hops.length; i++) {
      const via = [n.hops[i - 1].messageId, n.hops[i].messageId].filter(Boolean);
      edges.push({ id: "e:relay-hop:" + n.key + ":" + n.hops[i].seq, kind: "relay-hop", from: { nodeKey: n.key, port: "bottom" }, to: { nodeKey: n.key, port: "top" }, style: "solid", viaMessageIds: via });
    }
  }
  for (const n of orderedNodes) if (n.kind === "unrelayed") edge("unrelayed", right(n.key), { mark: "unrelayed", label: "中継なし" }, "gray", [n.messageId]);
  for (const m of msgs) {
    const pv = provOf(m);
    if (pv.delivery !== "relay" && pv.delivery !== "handoff") continue;
    const srcId = pv.source && pv.source.messageId;
    const fromKey = srcId ? membership[srcId] : null;
    if (!fromKey) {
      warnings.push((pv.delivery === "handoff" ? "引き継ぎ" : "転送") + "コピー " + m.id + " の元メッセージ " + (srcId || "（ID なし）") + " がこのトピックにありません");
      continue;
    }
    const to = pv.delivery === "handoff" ? { mark: "handoff", label: "🤝 → " + nameOf(m.thread) } : { mark: "forward", label: "転送済み → " + nameOf(m.thread) };
    edge(pv.delivery === "handoff" ? "handoff" : "forward", right(fromKey), to, "solid", [m.id]);
  }
  for (const h of hangEdges) edge(h.kind, { nodeKey: h.fromKey, port: "bottom" }, { nodeKey: h.toKey, port: "top" }, "solid", []);
  for (const n of orderedNodes) {
    if (n.kind !== "reply" && n.kind !== "replies") continue;
    const ids = n.kind === "replies" ? n.messageIds : [n.messageId];
    for (const id of ids) {
      const m = msgById.get(id);
      const t = m && m.taskId ? taskNodes.find((x) => x.taskId === m.taskId) : null;
      if (t) edge("task-return", { nodeKey: t.key, port: "bottom" }, { nodeKey: n.key, port: "top" }, "solid", [id]);
      else if (m && m.taskId) warnings.push("発言 " + id + " の taskId " + m.taskId + " がこのトピックのタスクにありません");
    }
  }
  for (const b of branches) if (b.anchorKey) edge("branch", right(b.anchorKey), { mark: "branch", label: b.title, childTopicId: b.childTopicId }, "solid", b.atMessageId ? [b.atMessageId] : []);

  // 7. 折りたたみ計画と件数
  const eps = allEpisodes.map((ep) => {
    const count = { replies: 0, artifacts: 0, tasks: 0, syncs: 0 };
    let hasRun = false, hasBranchPoint = false;
    for (const n of ep.members) {
      if (n.kind === "reply" || n.kind === "unrelayed" || n.kind === "system") count.replies++;
      else if (n.kind === "replies") count.replies += n.count;
      else if (n.kind === "artifact") count.artifacts++;
      else if (n.kind === "task") count.tasks++;
      else if (n.kind === "sync") count.syncs++;
      if (n.status === "run") hasRun = true;
      if (n.branchPoint) hasBranchPoint = true;
    }
    return { key: ep.key, kind: ep.kind, ts: ep.ts, nodeKeys: ep.members.map((n) => n.key), count, hasRun, hasBranchPoint };
  });
  const planned = foldPlan(eps, opt.keepOpenTail).map(({ hasRun, hasBranchPoint, ...ep }) => ep);

  const outNodes = orderedNodes.map((n) => {
    const { statuses, copyIds, ...rest } = n;
    return rest;
  });
  return { topicId, episodes: planned, nodes: outNodes, edges, membership, branches, origin, warnings };
}
