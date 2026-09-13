// Yoseai — zero-dependency local server
// User <-> Claude Code <-> Codex message hub + task queue.
// State persists to data/state.json; clients sync over SSE.
// Agent auto-reply: spawns `claude -p` / `codex exec` CLIs (read-only) when available.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  validateStateShape,
  isRelay,
  extractDeclaredPaths,
  judgeBudget,
  inferAuthor,
  historyEligibility,
  sha256Hex,
  appendVersion,
  resolveVersionPair,
  unifiedDiff,
  truncateUtf8,
  HISTORY_MAX_BYTES,
  DIFF_MAX_BYTES,
  safeVersionFileName,
  isInsidePath,
  normalizeProbe,
  topicHasRunLegacy,
  projectDigest,
  projectPromptLine,
  projectChangeNote,
  summaryOriginNote,
  PROJECT_DIGEST_MAX,
  PROJECT_README_MAX_BYTES,
  AGENT_DEFS,
  LEGACY_AGENTS,
  peersOf,
  defaultReviewers,
  nextTurn,
  canEndRelay,
  clipBacklog,
  dedupeRelayCopies,
  parseGrokStream,
  grokStepFrom,
  grokMetaFrom,
  GROK_STOP_NOTE,
  isGrokUnauthedError,
  summaryFreshness,
  relayRecord,
  reconstructRelays,
  sortByTsId,
  deriveAgentState,
  nextOutcome,
  sanitizeOutcomes,
  validateV2Format,
  isSafeSpriteName,
  classifyBackendError,
} from "./lib.mjs";
// 成果物の版と必須検証の共通モジュール（契約: 契約-成果物検証API.md）。名前の衝突を避けるため名前空間で読む
import * as verif from "./verification.mjs";
// 判断トレイの共通モジュール（契約: 契約-判断トレイAPI.md）。I/O を持たない純関数の集まり
import * as tray from "./tray.mjs";
// 強制層・資格層（契約: 契約-資格隔離API.md）。どちらも I/O を持たない
import * as sandbox from "./sandbox.mjs";
import * as cred from "./credentials.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
// 判断トレイの依頼ログ（契約 §12.1）。1 行 = その時点の依頼レコード全体。
// 追記だけで、読み込み時は id ごとに最後の行を採る（依頼は状態が変わるので、checks.jsonl のような不変記録ではない）
const TRAY_FILE = path.join(DATA_DIR, "tray.jsonl");
// 強制層（契約-資格隔離API.md §3）。プロファイルはエージェントの書き込み領域の外に置き、denyRead にも入れる
const SANDBOX_PROFILES_FILE = path.join(__dirname, "sandbox-profiles.json");
const SANDBOX_RUNTIME_CMD = process.env.U2A2A_SANDBOX_CMD || "srt";
// 隔離規則は symlink 解決後の実パスで判定される（/tmp 表記では効かない・実測）
const SYSTEM_TMP = (() => {
  try {
    return fs.realpathSync("/tmp");
  } catch {
    return "/tmp";
  }
})();
// 設定ファイルは起動ごとに書き出す（プロファイルの変数を展開した実体）。エージェントからは読めない場所へ
const SANDBOX_SETTINGS_DIR = path.join(DATA_DIR, "sandbox");
const REPO_ROOT = path.resolve(__dirname, "..");
// 共有タスクプールの実体はリポジトリ内のフォルダ（DAS）。
// エージェント CLI（cwd=リポジトリ・読み取り可）からパスでそのまま読める。
const POOL_DIR = path.join(__dirname, "pool");
const POOL_TRASH = path.join(POOL_DIR, ".trash");
// 成果物バージョン履歴の置き場（仕様: SPEC-成果物バージョン履歴.md）。
// .versions/<itemId>/manifest.json が正本で、アイテム削除後も残す（ドット始まりなのでスキャン対象外）
const POOL_VERSIONS = path.join(POOL_DIR, ".versions");
// スレッド履歴の自動ミラー置き場（成果物アイテムとしては登録しないシステム領域）
const POOL_THREADS = path.join(POOL_DIR, "threads");
// トピック別成果物の保存先（合意: パスは完全 topicId で不変。タイトルは UI が state から表示）
const topicDirRel = (topicId) => "topics/" + topicId;
function ensureTopicDir(topicId) {
  const abs = path.join(POOL_DIR, "topics", topicId);
  fs.mkdirSync(path.join(abs, ".work"), { recursive: true }); // .work は中間生成物用（ドット除外で一覧に出ない）
  return abs;
}
const PORT = Number(process.env.U2A2A_PORT || 4742);

// 対応エージェント一覧は lib の AGENT_DEFS（正）から派生。参加者はトピックごと（topic.participants）
const AGENTS = Object.keys(AGENT_DEFS);
const AUTHORS = ["user", ...AGENTS];
const TASK_STATUSES = ["queued", "working", "returned", "done"];
const AGENT_TIMEOUT_MS = 15 * 60 * 1000; // 大きな成果物のレビューは5分では足りない
const MAX_BACKLOG = 10;

// エージェントのグローバル設定（トピック横断）
function defaultAgent(agentId = "claude") {
  // auto: 新しい環境は OFF から始める（最初の発言で CLI が走って課金されないように。ON は画面から選ぶ）。
  //   既存の state.json は loadState の移行で保存値を維持する（ここの既定値は新規作成時だけ効く）
  // authed: grok のみ判定する（null = 確認中）。claude / codex は従来どおり true 扱い
  return { auto: false, lastError: "", model: "", modelOverride: "", authed: agentId === "grok" ? null : true, authCheckedTs: 0, availability: null };
}

// 参加・宛先として選べるか（自動応答 ON かつ認証済み）
function agentReady(agent) {
  const a = state.agents[agent];
  return !!a && a.auto && a.authed === true && !state.budgetHalt;
}

// トピック内のエージェント別セッション状態
function topicAgent() {
  return { sessionId: null, lastSeenTs: Date.now(), transcriptOffset: null };
}

function defaultRelay() {
  return { active: false, remaining: 0, hopsDone: 0, id: null, participants: [], turn: 0, seq: 0, spoken: {}, stopReason: null };
}

// リレーを止めて理由を残す（合意成立 agreed と打ち切りを区別する）。
// 確定した 1 本は relayHistory へ追記する。topic.relay は次の質疑で上書きされるため、
// ここで残さないと過去リレーの結末は永久に復元できない（仕様: SPEC-relayHistory.md）
function stopRelay(topic, reason) {
  const r = topic.relay;
  if (!r.active) return;
  r.active = false;
  r.stopReason = reason;
  appendRelayHistory(topic, r, reason);
}

// 同じ id を二重に積まない。既にあれば確定した結末で上書きする（移行で復元した不明分を上書きする経路）
function appendRelayHistory(topic, relay, reason, endedTs = Date.now()) {
  if (!relay || !relay.id) return null;
  topic.relayHistory = topic.relayHistory || [];
  const rec = relayRecord(relay, { stopReason: reason || null, endedTs, reconstructed: false });
  const i = topic.relayHistory.findIndex((h) => h && h.id === relay.id);
  if (i >= 0) topic.relayHistory[i] = { ...topic.relayHistory[i], ...rec };
  else topic.relayHistory.push(rec);
  return rec;
}

// トピックの参加者のうち自分以外（OTHER の置き換え）
const peers = (topic, agent) => peersOf(topic.participants, agent);

// 要約の最後の試行の結果（仕様: SPEC-要約鮮度.md）。成功したら idle に戻し、成功の事実は summaryTs / summaryAt が表す
function defaultSummaryState() {
  return { phase: "idle", reason: null, detail: "", ts: 0, startedTs: null, trigger: null };
}

// summaryState を書き換えて UI へ届ける（無言のスキップを作らない）。
// 中身が変わらないときは何もしない: 予算見送りは 30 秒ごとの checkSummaries で同じ判定を繰り返すので、
// そのたびに touch() すると全 SSE クライアントへ publicState() を撒き続けることになる
function setSummaryState(topic, patch) {
  const prev = topic.summaryState || defaultSummaryState();
  const next = { ...prev, ...patch };
  const same = topic.summaryState && ["phase", "reason", "detail", "trigger", "startedTs"].every((k) => prev[k] === next[k]);
  if (same) return;
  topic.summaryState = { ...next, ts: Date.now() };
  touch();
}

function defaultTopic(title, participants = LEGACY_AGENTS) {
  const list = [...new Set(participants.filter((a) => AGENTS.includes(a)))];
  return {
    id: crypto.randomBytes(8).toString("hex"),
    title,
    ts: Date.now(),
    relay: defaultRelay(),
    participants: list.length ? list : LEGACY_AGENTS.slice(), // 順序付き。作成時に固定
    agents: Object.fromEntries((list.length ? list : LEGACY_AGENTS).map((a) => [a, topicAgent()])),
    projectId: null, // 対象プロジェクト（null = 未紐付け = アプリのリポジトリ）
    projectLocked: false, // 初回実行で立つ。以後は対象を変更できない（仕様: 実行後の変更は新規トピック）
    summaryState: defaultSummaryState(),
    summaryUsage: [],
    summaryUsageLegacyUnknown: false,
    relayHistory: [], // 終わった質疑リレーの確定記録（仕様: SPEC-relayHistory.md）
    agentOutcomes: {}, // エージェント別の最新の終了状態（仕様: SPEC-アバター状態.md §4。分岐先には引き継がない）
    trayContinuation: null, // 判断トレイの継続予約（契約-判断トレイAPI.md §10.3）。1 件だけ持つ
  };
}

function defaultBudgets() {
  return { topicUsd: null, runCount: null, runMinutes: null };
}

function emptyState() {
  return {
    messages: [],
    tasks: [],
    pool: [],
    topics: [defaultTopic("メイン")],
    projects: [],
    agents: Object.fromEntries(AGENTS.map((a) => [a, defaultAgent(a)])),
    budgets: defaultBudgets(),
    usageDay: null,
    budgetHalt: null,
    unattributedOutcomes: {}, // トピックに帰属しない review / fix の終了状態（仕様: SPEC-アバター状態.md §4.3）
    trayRequests: [], // 判断トレイの依頼（正本は data/tray.jsonl。state.json には保存しない）
  };
}

// 旧フラット形式のメタを合意の正規形 {status, model, durationMs, usage, billing} へ移行
function migrateMeta(holder) {
  const o = holder && holder.meta;
  if (!o || o.usage !== undefined || o.inTok === undefined) return;
  holder.meta = {
    status: "completed",
    model: o.model || "",
    durationMs: o.durationMs || 0,
    usage: { inTok: o.inTok || 0, outTok: o.outTok || 0, cacheTok: o.cacheTok || 0 },
    billing: o.costUsd != null ? { mode: "metered", usd: o.costUsd } : { mode: "unknown" },
  };
}

// 履歴保護（合意事項A・最重要）: 読めない state.json で空起動すると、
// 次の保存が全履歴を上書きし、writeThreadMirrors が旧ミラーまで削除する。
// 初回のファイル不在のみ新規作成し、それ以外は原本をコピー退避して起動を拒否する
function fatalStateLoad(reason) {
  try {
    const backup = STATE_FILE + ".broken-" + Date.now();
    fs.copyFileSync(STATE_FILE, backup);
    console.error("[Yoseai] 原本をコピー退避しました:", backup);
  } catch {
    // 退避できなくても原本はそのまま残る
  }
  console.error("[Yoseai] state.json を読み込めないため、履歴保護のため起動を中止します:", reason);
  process.exit(1);
}

function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return emptyState(); // 初回のみ新規作成
    fatalStateLoad("読み込み失敗: " + (e.message || e));
  }
  try {
    const parsed = validateStateShape(JSON.parse(raw));
    {
      parsed.agents = parsed.agents || {};
      if (!Array.isArray(parsed.pool)) parsed.pool = [];
      // 旧形式（単一スレッド）→ トピック制へ移行
      if (!Array.isArray(parsed.topics) || !parsed.topics.length) {
        const main = defaultTopic("メイン");
        for (const a of LEGACY_AGENTS) {
          const old = parsed.agents[a] || {};
          main.agents[a] = {
            sessionId: old.sessionId || null,
            lastSeenTs: old.lastSeenTs || Date.now(),
            transcriptOffset: old.transcriptOffset ?? null,
          };
        }
        parsed.topics = [main];
        for (const m of parsed.messages) m.topicId = m.topicId || main.id;
        for (const t of parsed.tasks) t.topicId = t.topicId || main.id;
      }
      for (const a of AGENTS) {
        // キー無し（後から増えたエージェント）と、キーはあるが auto が無い（旧形式）を区別する。
        // 旧形式は従来どおり ON で復元し、保存済みの boolean はそのまま維持する（全件 OFF へ倒す移行はしない）
        const hasKey = Object.prototype.hasOwnProperty.call(parsed.agents, a);
        const old = parsed.agents[a] || {};
        parsed.agents[a] = {
          ...defaultAgent(a),
          auto: hasKey ? (typeof old.auto === "boolean" ? old.auto : true) : false,
          lastError: "",
          model: old.model || "",
          modelOverride: old.modelOverride || "",
          // schemaVersion 7: grok の認証状態は起動時に再判定する（保存値は「確認中」に戻す）
          authed: a === "grok" ? null : true,
          authCheckedTs: 0,
          availability: null, // 再起動で再評価（未評価へ戻す。キーは常に存在させ /api/state の形を安定させる——指摘#8）
        };
      }
      for (const t of parsed.topics) {
        t.relayHistory = Array.isArray(t.relayHistory) ? t.relayHistory : [];
        // 保存時に走っていた・終わっていたリレーを、解除する前に確定記録として拾う。
        // active のまま保存されたものは「再起動で打ち切られた」が事実なので restart。既に止まっていれば理由をそのまま残す
        if (t.relay && t.relay.id && !t.relayHistory.some((h) => h && h.id === t.relay.id)) {
          t.relayHistory.push({
            ...relayRecord(t.relay, {
              stopReason: t.relay.active ? "restart" : t.relay.stopReason || null,
              endedTs: t.relay.active ? Date.now() : null,
              reconstructed: false,
            }),
          });
        }
        // schemaVersion 9: 配送コピーの provenance から過去リレーを復元する。
        // 分かるのは参加者の並び・手番数・時刻だけ。停止理由・議題・開始メッセージは不明のまま null にする
        if (!parsed.schemaVersion || parsed.schemaVersion < 9) {
          const known = new Set(t.relayHistory.map((h) => h && h.id));
          const msgs = parsed.messages.filter((m) => m.topicId === t.id);
          for (const rec of reconstructRelays(msgs)) if (!known.has(rec.id)) t.relayHistory.push(rec);
        }
        t.relayHistory.sort((a, b) => (a.startedTs || 0) - (b.startedTs || 0) || String(a.id).localeCompare(String(b.id)));
        t.relay = defaultRelay(); // 再起動後にリレーが勝手に再開しないよう常に解除
        // schemaVersion 7: 参加者。旧トピックは claude / codex の 2 名（grok のセッション・未読は作らない）
        if (!Array.isArray(t.participants) || !t.participants.length) t.participants = LEGACY_AGENTS.slice();
        t.participants = [...new Set(t.participants.filter((a) => AGENTS.includes(a)))];
        t.agents = t.agents || {};
        for (const a of t.participants) t.agents[a] = { ...topicAgent(), ...t.agents[a] };
        // schemaVersion 8: 要約の試行結果。再起動時に running のまま固まらないよう idle から始める
        t.summaryState = { ...defaultSummaryState(), ...(t.summaryState || {}) };
        if (t.summaryState.phase === "running") t.summaryState = { ...defaultSummaryState(), ts: Date.now() };
      }
      delete parsed.relay;
      parsed.budgets = { ...defaultBudgets(), ...(parsed.budgets || {}) };
      parsed.usageDay = parsed.usageDay || null;
      parsed.budgetHalt = parsed.budgetHalt || null;
      // schemaVersion 10: 終了状態の保持先（仕様: SPEC-アバター状態.md §4.5）。
      // 過去の停止・失敗からは復元しない（解除の履歴が無く、解決済みの停止を蘇らせるため）
      parsed.unattributedOutcomes = sanitizeOutcomes(parsed.unattributedOutcomes, AGENTS);
      for (const t of parsed.topics) t.agentOutcomes = sanitizeOutcomes(t.agentOutcomes, AGENTS);
      // schemaVersion 11: 判断トレイ（契約-判断トレイAPI.md §12.2）。
      // 依頼そのものは data/tray.jsonl から読むのでここでは器だけ用意する。
      // 過去の応答本文を遡って依頼を復元することはしない（受付は応答時の 1 回だけ）
      parsed.trayRequests = [];
      for (const t of parsed.topics) t.trayContinuation = sanitizeContinuation(t.trayContinuation);
      for (const m of parsed.messages) migrateMeta(m);
      // schemaVersion 5: 既存プールアイテムへ所属（topicId）と作者（origin）を補完する
      // （合意事項: 既存ファイルは動かさない。情報の補完のみ）
      // 帰属訂正は「登録時刻の前後10分以内に、エージェント自身のレーンでパスに言及」した場合のみ
      // （後からレビュー等で言及しただけのファイルを誤帰属しないため）
      if (!parsed.schemaVersion || parsed.schemaVersion < 5) {
        const msgById = new Map(parsed.messages.map((m) => [m.id, m]));
        for (const item of parsed.pool) {
          if (item.topicId === undefined) item.topicId = null;
          // 所属: 由来メッセージ → そのトピック
          if (!item.topicId && item.fromMessageId) {
            const src = msgById.get(item.fromMessageId);
            if (src) item.topicId = src.topicId || null;
          }
          // 帰属の再計算（v4 の緩い判定も含めてやり直す）
          if (item.file && (item.via === "folder" || item.via === "agent")) {
            const mention = parsed.messages.find(
              (m) =>
                (m.author === "claude" || m.author === "codex") &&
                m.thread === m.author &&
                m.text.includes("u2a2a/pool/" + item.file) &&
                Math.abs(m.ts - item.ts) < 10 * 60 * 1000
            );
            if (mention) {
              item.origin = mention.author;
              item.via = "agent";
              if (!item.topicId) item.topicId = mention.topicId || null;
            } else if (item.via === "agent") {
              item.origin = "user"; // v4 の誤帰属を取り消し
              item.via = "folder";
            }
          }
        }
      }
      // schemaVersion 3: 散在フラグ（relayedFrom/qa/external/auto）→ 直交構造 provenance へ移行
      if (!parsed.schemaVersion || parsed.schemaVersion < 3) {
        for (const t of parsed.topics) {
          t.qaCount = parsed.messages.filter((m) => m.topicId === t.id && m.qa && m.author === "user").length;
        }
        for (const m of parsed.messages) {
          if (!m.provenance) {
            m.provenance = {
              ingress: m.external ? "cli-sync" : m.auto || m.cancelled || m.budget ? "agent-loop" : "ui",
              delivery: m.relayedFrom ? (m.qa ? "qa-relay" : "relay") : "direct",
              trigger: m.auto ? "auto" : "manual",
              source: m.relayedFrom
                ? { topicId: m.topicId, messageId: m.sourceId || null, agent: m.relayedFrom }
                : null,
            };
          }
          delete m.relayedFrom;
          delete m.sourceId;
          delete m.qa;
          delete m.external;
          delete m.auto;
        }
      }
      for (const p of parsed.pool) {
        for (const r of p.reviews || []) migrateMeta(r);
        for (const f of p.fixes || []) migrateMeta(f);
      }
      // schemaVersion 6: プロジェクト登録とトピック紐付け（仕様: SPEC-プロジェクト紐付け.md）
      // projectLocked は旧トピックについて一度だけ推定し、以後はフラグが正（再計算しない）
      parsed.projects = Array.isArray(parsed.projects) ? parsed.projects : [];
      for (const t of parsed.topics) {
        if (t.projectId === undefined) t.projectId = null;
        if (typeof t.projectLocked !== "boolean") t.projectLocked = topicHasRunLegacy(t, parsed.messages);
        // 要約の出所（要約生成時の対象）。未記録なら「現在の対象で作られた要約」とみなす
        if (t.summaryProjectId === undefined) t.summaryProjectId = t.summaryText ? t.projectId : null;
      }
      // 移行はここまでで完了している。メモリ上の版も現行へ揃える
      // （persistState 任せだと初回保存までの間、API が旧版を返す。CI で実測）
      parsed.schemaVersion = 11;
      return parsed;
    }
  } catch (e) {
    fatalStateLoad("解析または移行に失敗: " + (e.stack || e.message || e));
  }
}

let state = loadState();
let saveTimer = null;

// ---- 運用イベントログ（合意事項⑩: 重要な失敗の構造化可視化。永続化しない・最新100件）----
const events = [];

function logEvent(area, message, level = "error") {
  const msg = String(message).slice(0, 300);
  const last = events[events.length - 1];
  // 同一エラーの連発は集約（5分以内）
  if (last && last.area === area && last.message === msg && Date.now() - last.ts < 300000) {
    last.ts = Date.now();
    last.count = (last.count || 1) + 1;
  } else {
    events.push({ ts: Date.now(), level, area, message: msg, count: 1 });
    if (events.length > 100) events.shift();
  }
  try {
    broadcast();
  } catch {
    // 起動直後など broadcast 不能時は無視
  }
}

// ---- ストレージ層（合意事項⑨: 計測付き・スキーマ版・物理分割は観測後）----
const storageMetrics = { saves: 0, lastMs: 0, lastBytes: 0, totalMs: 0 };

function persistState() {
  const t0 = Date.now();
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    state.schemaVersion = 11;
    // trayRequests の正本は data/tray.jsonl。state.json に二重に持つと、どちらが正か分からなくなる
    const { trayRequests, ...persisted } = state;
    const jsonStr = JSON.stringify(persisted, null, 2);
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, jsonStr);
    fs.renameSync(tmp, STATE_FILE);
    storageMetrics.saves++;
    storageMetrics.lastMs = Date.now() - t0;
    storageMetrics.lastBytes = Buffer.byteLength(jsonStr);
    storageMetrics.totalMs += storageMetrics.lastMs;
  } catch (e) {
    logEvent("persist", "state.json の保存に失敗: " + (e.message || e));
  }
  try {
    writeThreadMirrors(); // スレッド履歴を pool/threads/ の実ファイルへ同期
  } catch (e) {
    logEvent("mirror", "スレッドミラー生成に失敗: " + (e.message || e), "warn");
  }
}

// 実行中フラグは永続化しない（クラッシュ後に張り付くのを防ぐ）。キー: "<topicId>:<agent>"
const running = {};
const needsRun = {};
// needsRun の世代。実行中に届いた新しい起動要求（新リレー開始など）を、
// 旧実行のキャンセル終了処理が needsRun[key] = false で消してしまわないよう区別する
const needsRunGen = {};
const runKey = (topicId, agent) => topicId + ":" + agent;
// 合意事項: auto はユーザーの意思、budgetHalt はシステムの安全ラッチ。実効値は両者のAND
const agentAutoOn = (agent) => state.agents[agent].auto && !state.budgetHalt;
const findTopic = (topicId) => state.topics.find((t) => t.id === topicId);

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistState, 100);
}

// ---- スレッド履歴ミラー ----
// 各トピックの会話を pool/threads/<title>-<id8>.md として実ファイル化する。
// DAS の一部としてブラウズ・検索・コピーでき、エージェントもパスで読める。
const mirrorCache = {};

function threadMirrorName(t) {
  return "threads/" + (sanitizeSegment(t.title) || "thread") + "-" + t.id.slice(0, 8) + ".md";
}

function buildThreadMirror(t, msgs) {
  const fmtT = (ts) => new Date(ts).toLocaleString("ja-JP");
  const qaSessions = t.qaCount || 0;
  const fm =
    `---\n` +
    `topicId: ${t.id}\n` +
    `created: ${new Date(t.ts).toISOString()}\n` +
    `updated: ${msgs.length ? new Date(msgs[msgs.length - 1].ts).toISOString() : new Date(t.ts).toISOString()}\n` +
    `messages: ${msgs.length}\n` +
    `qaSessions: ${qaSessions}\n` +
    `participants: ${(t.participants || LEGACY_AGENTS).join(", ")}\n` +
    (t.participants || LEGACY_AGENTS).map((a) => `${a}Session: ${(t.agents[a] && t.agents[a].sessionId) || "(未開始)"}\n`).join("") +
    (t.branchedFrom
      ? `branchedFrom: ${(findTopic(t.branchedFrom.topicId) || {}).title || t.branchedFrom.topicId}（message ${t.branchedFrom.messageId}）\n`
      : "") +
    (t.projectId ? `project: ${(findProject(t.projectId) || { name: "(登録解除済み)", path: t.projectId }).name} (${(findProject(t.projectId) || { path: "" }).path})\n` : "") +
    `---\n\n`;

  // 📦 成果物索引: このスレッドのメッセージ由来のプールアイテム＋本文で言及されたプールファイル
  const msgIds = new Set(msgs.map((m) => m.id));
  const artifacts = new Map(); // rel -> 初出時刻
  for (const p of state.pool) {
    if (p.file && p.fromMessageId && msgIds.has(p.fromMessageId)) artifacts.set(p.file, p.ts);
  }
  for (const m of msgs) {
    for (const full of m.text.match(/u2a2a\/pool\/[^\s)"'`」()）]+/g) || []) {
      const rel = full.slice("u2a2a/pool/".length);
      if (!rel.startsWith("threads/") && !artifacts.has(rel)) artifacts.set(rel, m.ts);
    }
  }
  const artifactSec = artifacts.size
    ? `## 📦 成果物\n\n` +
      [...artifacts.entries()].map(([rel, ts]) => `- \`u2a2a/pool/${rel}\`（${fmtT(ts)}）`).join("\n") + "\n\n"
    : "";

  const tasks = state.tasks.filter((x) => x.topicId === t.id);
  const taskSec = tasks.length
    ? `## 🗂 タスク\n\n` +
      tasks.map((x) => `- [${x.status === "done" ? "x" : " "}] ${x.title}（${NAMES[x.agent]}／${x.status}）`).join("\n") + "\n\n"
    : "";

  const summarySec = t.summaryText
    ? `## 📌 概要（自動要約 ${fmtT(t.summaryTs)} 時点）\n\n${t.summaryText}\n\n`
    : "";

  const history = msgs
    .map((m) => {
      const pv = m.provenance || {};
      const tags = [
        pv.trigger === "auto" ? "自動応答" : null,
        pv.delivery === "qa-relay" ? "質疑" : null,
        pv.delivery === "handoff" ? "引き継ぎ" : null,
        pv.ingress === "cli-sync" ? "外部同期" : null,
      ]
        .filter(Boolean)
        .join("・");
      const head = `### ${NAMES[m.author]} → ${NAMES[m.thread]} 側（${fmtT(m.ts)}${tags ? "／" + tags : ""}）`;
      if (isRelay(pv)) {
        // 受信側の中継コピーは冒頭のみ（原文は送信元レーンに全文が残る）。引き継ぎは全文を残す
        const headLine = m.text.split("\n").find((l) => l.trim()) || "";
        return `${head}\n\n> ↪ ${NAMES[pv.source.agent]} 側から中継: ${headLine.slice(0, 100)}${m.text.length > 100 ? "…（全文は中継元を参照）" : ""}\n`;
      }
      return `${head}\n\n${m.text}\n`;
    })
    .join("\n");

  return (
    fm +
    `# ${t.title}\n\n` +
    `（Yoseai スレッド履歴 — 自動生成ミラー。スレッドID: \`${t.id}\`。編集しても会話には反映されません）\n\n` +
    summarySec + artifactSec + taskSec +
    `## 💬 履歴\n\n` + history
  );
}

function writeThreadMirrors() {
  fs.mkdirSync(POOL_THREADS, { recursive: true });
  const valid = new Set();
  const index = [];
  for (const t of state.topics) {
    const rel = threadMirrorName(t);
    valid.add(rel);
    t.mirrorFile = rel;
    const msgs = state.messages.filter((m) => m.topicId === t.id);
    const updated = msgs.length ? msgs[msgs.length - 1].ts : t.ts;
    index.push(
      `- \`${t.id}\` — ${t.title} → \`u2a2a/pool/${rel}\`` +
        `（参加者: ${(t.participants || LEGACY_AGENTS).join("・")}／${msgs.length} 件／更新 ${new Date(updated).toLocaleString("ja-JP")}）`
    );
    const body = buildThreadMirror(t, msgs);
    if (mirrorCache[rel] === body) continue;
    fs.writeFileSync(path.join(POOL_DIR, rel), body);
    mirrorCache[rel] = body;
  }
  // スレッドID → ミラーファイルの対応表。タイトル改名でファイル名が変わっても ID から辿れる
  const indexRel = "threads/INDEX.md";
  valid.add(indexRel);
  const indexBody =
    `# スレッド索引\n\n（Yoseai 自動生成 — スレッドIDからミラーファイルを引く対応表。編集しても反映されません）\n\n` +
    index.join("\n") + "\n";
  if (mirrorCache[indexRel] !== indexBody) {
    fs.writeFileSync(path.join(POOL_DIR, indexRel), indexBody);
    mirrorCache[indexRel] = indexBody;
  }
  // 改名・削除で不要になった古いミラーは片付ける
  for (const f of fs.readdirSync(POOL_THREADS)) {
    const rel = "threads/" + f;
    if (f.endsWith(".md") && !valid.has(rel)) {
      try {
        fs.unlinkSync(path.join(POOL_THREADS, f));
      } catch {
        // 消せなければ次回に持ち越し
      }
      delete mirrorCache[rel];
    }
  }
}

// ---- SSE ----
const sseClients = new Set();

// itemId -> 実行中レビュアー名の配列（永続化しない）
const reviewPending = {};

// itemId -> 修正中エージェント名（1件につき同時1修正。永続化しない）
const fixPending = {};

// 共通実行レジストリ（合意事項: thread/review/fix を一元登録。永続化しない）
// runs[runId] = { runId, kind, agent, topicId?, itemId?, startedAt, ctl, sessionId? }
const runs = {};

function startRun(kind, agent, ids = {}) {
  const run = { runId: id(), kind, agent, ...ids, startedAt: Date.now(), ctl: {} };
  runs[run.runId] = run;
  return run;
}

function endRun(runId) {
  const r = runs[runId];
  if (r) {
    bumpUsageDay(Date.now() - r.startedAt);
    // run が消える前に一度スキャンし、書かれたばかりのファイルの帰属を確定させる（合意事項C）
    try {
      if (scanPoolDir()) touch();
    } catch {
      // スキャン失敗は定期スキャンで回収
    }
  }
  delete runs[runId];
}

// ---- 上限管理（合意事項⑦: USD上限＋回数/累計時間上限の二本立て）----

function todayStr() {
  return new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD
}

function bumpUsageDay(ms) {
  const day = todayStr();
  if (!state.usageDay || state.usageDay.date !== day) state.usageDay = { date: day, runs: 0, ms: 0 };
  state.usageDay.runs++;
  state.usageDay.ms += ms;
}

function topicCostUsd(topicId) {
  const msgUsd = state.messages.reduce(
    (a, m) => a + (m.topicId === topicId && m.meta && m.meta.billing && m.meta.billing.mode === "metered" ? m.meta.billing.usd : 0),
    0
  );
  const t = findTopic(topicId);
  return msgUsd + ((t && t.summaryCostUsd) || 0);
}

// 上限超過なら理由文字列を返す。回数・時間とも走行中を含めて判定する（lib.judgeBudget）
function budgetStatus(topicId) {
  const inflight = Object.values(runs);
  return judgeBudget({
    budgets: state.budgets,
    usageDay: state.usageDay,
    today: todayStr(),
    inflightMs: inflight.reduce((a, r) => a + (Date.now() - r.startedAt), 0),
    inflightCount: inflight.length,
    topicUsd: topicId ? topicCostUsd(topicId) : 0,
    topicCap: topicId ? (state.budgets || {}).topicUsd : null,
  });
}

// 上限到達: 自動実行・全質疑リレーを停止し、理由を記録して UI に明示する
function triggerBudgetHalt(topicId, agent, reason) {
  if (state.budgetHalt) return;
  state.budgetHalt = { reason, ts: Date.now() }; // 安全ラッチ（ユーザーの auto 設定には触れない）
  for (const t of state.topics) stopRelay(t, "budget");
  state.messages.push({
    id: id(),
    topicId,
    thread: agent,
    author: agent,
    text: "🚫 上限到達のため自動応答を停止しました: " + reason,
    budget: true,
    provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null },
    ts: Date.now(),
  });
  touch();
}

function publicRuns() {
  return Object.values(runs).map(({ ctl, ...r }) => r);
}

// エージェント状態の正規化（仕様: SPEC-アバター状態.md）。UI はこれだけを読み、業務データを再解釈しない
function agentStateNow() {
  return deriveAgentState({
    agentIds: AGENTS,
    agents: state.agents,
    budgetHalt: state.budgetHalt,
    runs: publicRuns(),
    topics: state.topics,
    pool: state.pool,
    unattributedOutcomes: state.unattributedOutcomes,
  });
}

// 終了状態の記録（§4）。topicId: 文字列=そのトピック／null=帰属なし／undefined=記録しない（帰属先が削除済み）
function noteOutcome(topicId, agent, ev) {
  if (topicId === undefined) return;
  let store;
  if (topicId === null) {
    store = state.unattributedOutcomes ||= {};
  } else {
    const t = findTopic(topicId);
    if (!t) return; // 実行中にトピックが削除された。null に付け替えると帰属を偽る
    store = t.agentOutcomes ||= {};
  }
  const next = nextOutcome(store[agent] || null, { id: id(), ts: Date.now(), ...ev });
  if (next) store[agent] = next;
  else delete store[agent];
}

// review / fix の帰属（§4.3）: 項目のトピック。項目がトピック外なら null、指すトピックが削除済みなら undefined
function itemOutcomeTopic(item) {
  if (!item || !item.topicId) return null;
  return findTopic(item.topicId) ? item.topicId : undefined;
}

// 実行中 CLI の進捗実況（永続化しない）。key: "thread:claude" / "review:<itemId>:<reviewer>"
const activity = {};

function actStart(key, label, runId = null) {
  activity[key] = { label, step: "CLI 起動中…", startedAt: Date.now(), steps: [], runId };
  broadcast();
}

function actStep(key, step) {
  const a = activity[key];
  if (!a || !step || a.step === step) return;
  a.step = step;
  a.steps.push(step);
  if (a.steps.length > 6) a.steps.shift();
  broadcast();
}

function actEnd(key) {
  delete activity[key];
  broadcast();
}

// 未紐付け（projectId = null）のときの既定対象。画面の詳細欄がフォルダ名と絶対パスを出せるように渡す
// （合意: 表示名は「アプリのリポジトリ（既定）」で固定し、実体は詳細で示す）。起動中は変わらないので定数
const REPO_ROOT_INFO = { name: path.basename(REPO_ROOT), path: REPO_ROOT };

// 隔離の公開形（契約 §2.4）。UI は label だけを出す。profiles / settingsPaths は内部情報なので載せない
function isolationView() {
  return {
    mode: isolation.mode,
    runtime: isolation.runtime,
    version: isolation.version,
    reason: isolation.reason,
    verified: isolation.verified,
    verifiedAt: isolation.verifiedAt,
    profilesSha256: isolation.profilesSha256,
    unverified: isolation.unverified,
    credentials: CREDENTIALS_ENABLED, // 資格の検査が生きているか（管理資格そのものは決して載せない）
    coverage: isolation.coverage || null, // 検証済みのとき、その被覆（agents / 行数）
    label: sandbox.describeIsolation(isolation),
  };
}

function publicState() {
  // running / reviewPending / fixPending は互換用の派生値。正は runs レジストリ
  return { ...state, agentDefs: AGENT_DEFS, running, reviewPending, fixPending, activity, poolDirs, repoRoot: REPO_ROOT_INFO, runs: publicRuns(), agentState: agentStateNow(), tray: trayViewNow(), events, storageMetrics, isolation: isolationView() };
}

function broadcast() {
  const payload = `data: ${JSON.stringify(publicState())}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function touch() {
  saveState();
  broadcast();
}

// ---- helpers ----
const id = () => crypto.randomBytes(8).toString("hex");

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// ---- 共通ルール（pool/U2A2A_RULES.md）----
// アプリ専用の CLAUDE.md × AGENTS.md。DAS 内に住むのでユーザーはプールから閲覧・編集でき、
// エージェントはパスで参照できる。CLI のネイティブ読み込みには依存せず、サーバが全プロンプト経路へ注入する
const RULES_FILE = path.join(POOL_DIR, "U2A2A_RULES.md");
const DEFAULT_RULES = `# Yoseai 共通ルール

このファイルは Yoseai の全エージェント（Claude Code / Codex / Grok）に、
通常応答・レビュー・修正のすべての実行で自動的に読み込まれます。編集すれば次の実行から反映されます。

## 役割（実行種別ごと）

- **通常応答**: 参加者の対話。簡潔に。実装作業の提案はするが、大きな作業はタスク化をユーザーに委ねる
- **レビュー**: 忖度なく具体的に。リポジトリの実態と突き合わせ、行番号や数値の根拠を示す
- **修正**: レビューの妥当な指摘に対応し、誤った指摘には従わず理由を述べる

## パスの規約

- パスは常に \`u2a2a/pool/\` 起点で書く（本文に書けばアプリがインライン表示する）
- 成果物はトピック別フォルダ \`u2a2a/pool/topics/<topicId>/\` に保存する
- 中間生成物・一時ファイルは \`.work/\` サブフォルダへ（一覧に表示されない）
- 他スレッドの経緯は \`u2a2a/pool/threads/\` のミラーで参照できる（スレッドID→ファイルの対応表は \`u2a2a/pool/threads/INDEX.md\`）

## 成果物の提出

- 保存したら本文にパスを列挙する（何をどこに置いたか）
- 実行可能なもの（スクリプト等）は再実行方法を一行添える

## 外部情報

- web 検索や外部資料を使った場合は、出典（URL）を本文に示す
- 「オフライン」指定の依頼では検索を使わず、リポジトリと成果物の内容だけで判断する
`;
let rulesCache = { mtime: 0, text: "" };

function commonRulesBlock(kind) {
  try {
    if (!fs.existsSync(RULES_FILE)) fs.writeFileSync(RULES_FILE, DEFAULT_RULES);
    const st = fs.statSync(RULES_FILE);
    if (st.mtimeMs !== rulesCache.mtime) {
      rulesCache = { mtime: st.mtimeMs, text: fs.readFileSync(RULES_FILE, "utf8").slice(0, 4000) };
    }
    return (
      `\n\n--- Yoseai 共通ルール（u2a2a/pool/U2A2A_RULES.md／実行種別: ${kind}）---\n` +
      rulesCache.text +
      `\n--- 共通ルールここまで ---`
    );
  } catch (e) {
    logEvent("cli", "U2A2A_RULES.md の読み込みに失敗: " + (e.message || e), "warn");
    return "";
  }
}

// ---- ローカルプロジェクト登録とトピック紐付け（仕様: SPEC-プロジェクト紐付け.md）----
// 書き込み範囲は変えない（Claude は Edit(u2a2a/pool/**)、Codex は -C pool）。対象は絶対パスで読むだけ。
// Claude はリポジトリ外を読めないので --add-dir <path> を足す（工程 0 で読み取り可・書き込み拒否を確認済み）

const PROJECT_PROBE_TIMEOUT_MS = 3000;
const findProject = (pid) => (pid ? state.projects.find((p) => p.id === pid) || null : null);
// 対象の表示名（null = このアプリのリポジトリ、解決できない id = 登録解除済み）
const projectLabel = (pid) => (pid ? (findProject(pid) || { name: "(登録解除済み)" }).name : "アプリのリポジトリ（既定）");
// トピックの対象プロジェクト id（成果物登録時に写す）
const projectIdOfTopic = (tid) => {
  const t = tid ? findTopic(tid) : null;
  return t && t.projectId ? t.projectId : null;
};

function poolRealPath() {
  try {
    return fs.realpathSync(POOL_DIR);
  } catch {
    return path.resolve(POOL_DIR);
  }
}

// 登録時の検証: 絶対パス → realpath 正規化 → ディレクトリ → プール外。戻り値 { ok, path, kind } or { error, status }
function validateProjectPath(input) {
  if (typeof input !== "string" || !input.trim()) return { error: "path は必須です", status: 400 };
  const raw = input.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(raw)) return { error: "絶対パスを指定してください", status: 400 };
  let real;
  try {
    real = fs.realpathSync(raw);
  } catch {
    return { error: "パスが存在しません", status: 404 };
  }
  let st;
  try {
    st = fs.statSync(real);
  } catch {
    return { error: "パスが存在しません", status: 404 };
  }
  if (!st.isDirectory()) return { error: "ディレクトリではありません", status: 400 };
  if (isInsidePath(real, poolRealPath())) return { error: "プール（u2a2a/pool/）配下は登録できません", status: 400 };
  const kind = fs.existsSync(path.join(real, ".git")) ? "git" : "dir";
  return { ok: true, path: real, kind };
}

// git を shell を介さず実行する（要件 a）。失敗は例外にせず { ok: false, err } で返す
function gitExec(cwd, args) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (r) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    try {
      const child = execFile(
        "git",
        args,
        { cwd, timeout: PROJECT_PROBE_TIMEOUT_MS, env: { ...spawnEnv(), GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (!err) return fin({ ok: true, out: String(stdout) });
          const msg = err.killed
            ? `タイムアウト（${PROJECT_PROBE_TIMEOUT_MS / 1000}秒）`
            : err.code === "ENOENT"
              ? "git が見つかりません"
              : String(stderr || err.message || "").trim().slice(0, 200) || "git エラー";
          fin({ ok: false, err: msg });
        }
      );
      child.on("error", (e) => fin({ ok: false, err: String(e.message || e) }));
    } catch (e) {
      fin({ ok: false, err: String(e.message || e) });
    }
  });
}

// プロジェクトの現況（存在・読み取り・Git 情報）。エラーにせず status で表す（unavailable は実行を止めない）
async function probeProject(project) {
  if (!project) return normalizeProbe({ unregistered: true });
  let exists = false;
  let readable = false;
  try {
    exists = fs.statSync(project.path).isDirectory();
  } catch {
    exists = false;
  }
  if (exists) {
    try {
      fs.accessSync(project.path, fs.constants.R_OK | fs.constants.X_OK);
      readable = true;
    } catch {
      readable = false;
    }
  }
  const isGit = exists && readable && fs.existsSync(path.join(project.path, ".git"));
  let git = null;
  if (isGit) {
    const [branch, head, status] = await Promise.all([
      gitExec(project.path, ["rev-parse", "--abbrev-ref", "HEAD"]),
      gitExec(project.path, ["rev-parse", "--short", "HEAD"]),
      gitExec(project.path, ["status", "--porcelain"]),
    ]);
    git = { branch, head, status };
  }
  return normalizeProbe({ exists, readable, isGit, git });
}

// 通常ファイルか（symlink は辿る。FIFO・ソケット・デバイスは除外 — 開くと固まる／読み終わらない）
function isRegularFile(abs) {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

// ファイル冒頭を maxBytes だけ読む（全読みしない）。末尾で切れた多バイト文字（置換文字 U+FFFD）は落とす
function readHeadUtf8(abs, maxBytes) {
  const fd = fs.openSync(abs, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    let text = buf.toString("utf8", 0, n);
    const bad = String.fromCharCode(0xfffd);
    while (text.endsWith(bad)) text = text.slice(0, -1);
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

// 初回プロンプト用の要約（README 冒頭＋直下エントリ名、合計 4,000 文字）。読めなくても会話は開始できる。
// README は通常ファイルに限り、読み取り自体を PROJECT_README_MAX_BYTES で打ち切る（巨大 README で全体を待たせない）
function projectDigestFor(project) {
  try {
    const entries = fs.readdirSync(project.path, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
    const readme = entries.find((e) => !e.dir && /^readme(\..+)?$/i.test(e.name) && isRegularFile(path.join(project.path, e.name)));
    let readmeText = "";
    if (readme) readmeText = readHeadUtf8(path.join(project.path, readme.name), PROJECT_README_MAX_BYTES).slice(0, PROJECT_DIGEST_MAX);
    return projectDigest({ readmeName: readme ? readme.name : null, readmeText, entries });
  } catch (e) {
    return projectDigest({ error: String(e.message || e).slice(0, 120) });
  }
}

// 実行前の対象確認。{ project, probe, blockReason } — blockReason があれば実行しない
// （missing / unreadable / unregistered は止める。unavailable は「確認不可」として続行。未紐付けは何もしない）
async function projectContext(projectId) {
  if (!projectId) return { project: null, probe: null, blockReason: null };
  const project = findProject(projectId);
  const probe = await probeProject(project);
  const blockReason = ["missing", "unreadable", "unregistered"].includes(probe.status)
    ? `対象プロジェクトを確認できません（${project ? project.path : projectId}: ${probe.status}／${probe.note}）`
    : null;
  return { project, probe, blockReason };
}

// Claude の起動引数（書き込みは pool のみ。対象があれば --add-dir で読み取りを許可）
// 相対規則は作業ディレクトリ基準で解決され、resume はシェルの cd 位置も引き継ぐため、
// pool 深部で止まる事故が再発した（実測: .work/impl-*/ 内で停止）。絶対パス規則を併記する。
// Write 規則は以前は不活性だったが、現行 CLI では新規ファイル作成が Edit 規則で許可されない
// （実測: 既存ファイルの Edit は通り、同じフォルダへの Write が拒否される）ため、Write も両形式で渡す
function claudeToolArgs(project) {
  const args = ["--allowedTools",
    "Edit(u2a2a/pool/**)", `Edit(${POOL_DIR}/**)`,
    "Write(u2a2a/pool/**)", `Write(${POOL_DIR}/**)`,
    "Bash(python3:*)", "Bash(ffmpeg:*)"];
  if (project) args.push("--add-dir", project.path);
  return args;
}

// ---- ファイル変更スナップショット（合意事項: レビュアーの根拠が黙って失効しないように）----
// 前回プロンプト生成時点のファイル状態（mtime/size）を (topic, agent) ごとに保存し、
// 次回プロンプトに「変更・追加・削除されたパス」を一行添える。対象は固定リストで有界
// poolOnly: 紐付けありトピック用。アプリのリポジトリ側（server.mjs / public / runtime / ルートの .md）は走査せず、
// プール内（共通ルールとこのトピックの成果物）だけを見る（対象プロジェクト側の変化は probe で注記する）
function takeFileSnapshot(topicId, { poolOnly = false } = {}) {
  const snap = {};
  const addFile = (abs, rel) => {
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) snap[rel] = Math.round(st.mtimeMs) + ":" + st.size;
    } catch {
      // 消えたファイルはスナップショットに含めない（削除として検出される）
    }
  };
  const walk = (absDir, relDir, depth = 0) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // .work / .trash / 隠しファイルは対象外
      if (e.name === "node_modules" || e.name === "threads") continue;
      const abs = path.join(absDir, e.name);
      const rel = relDir + "/" + e.name;
      if (e.isDirectory()) walk(abs, rel, depth + 1);
      else addFile(abs, rel);
    }
  };
  if (!poolOnly) {
    addFile(path.join(REPO_ROOT, "u2a2a/server.mjs"), "u2a2a/server.mjs");
    walk(path.join(REPO_ROOT, "u2a2a/public"), "u2a2a/public");
  }
  addFile(RULES_FILE, "u2a2a/pool/U2A2A_RULES.md");
  if (topicId) walk(path.join(POOL_DIR, "topics", topicId), "u2a2a/pool/topics/" + topicId);
  if (poolOnly) return snap;
  walk(path.join(REPO_ROOT, "runtime"), "runtime");
  try {
    for (const e of fs.readdirSync(REPO_ROOT, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".md")) addFile(path.join(REPO_ROOT, e.name), e.name);
    }
  } catch {
    // ルート走査失敗は無視
  }
  return snap;
}

function fileChangeNote(prev, cur) {
  if (!prev) return "";
  const changed = [];
  const added = [];
  const removed = [];
  for (const [rel, sig] of Object.entries(cur)) {
    if (!(rel in prev)) added.push(rel);
    else if (prev[rel] !== sig) changed.push(rel);
  }
  for (const rel of Object.keys(prev)) if (!(rel in cur)) removed.push(rel);
  if (!changed.length && !added.length && !removed.length) return "";
  const fmt = (arr) => (arr.length > 12 ? arr.slice(0, 12).join(", ") + ` 他${arr.length - 12}件` : arr.join(", "));
  const parts = [];
  if (changed.length) parts.push("変更: " + fmt(changed));
  if (added.length) parts.push("追加: " + fmt(added));
  if (removed.length) parts.push("削除: " + fmt(removed));
  return `\n\n（あなたの前回の応答以降に変わったファイル — 古い根拠に注意: ${parts.join("／")}）`;
}

// ---- agent CLI runners ----
const NAMES = { user: "ユーザー", ...Object.fromEntries(AGENTS.map((a) => [a, AGENT_DEFS[a].name])) };
// OTHER（2 者の相互参照）は廃止。相手は peers(topic, agent) で参加者から求める
const QA_END_MARK = "【質疑終了】";

// 子へ渡す環境変数は列挙する（契約-資格隔離API.md §5）。以前は process.env を丸ごと渡していた。
// 管理資格は決してここへ入れない —— 名前を足せないよう、実装で弾く
const ENV_ALLOW = ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TZ", "TERM", "SHELL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"];
const ENV_NEVER = /^(U2A2A_ADMIN_CREDENTIAL|.*(TOKEN|SECRET|PASSWORD|APIKEY|API_KEY))$/i;

const envNeverWarned = new Set(); // 同じ名前を毎回書かない（起動ごとに 1 回）
function spawnEnv(extraAllow = []) {
  const extra = [path.join(os.homedir(), ".homebrew/bin"), path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const env = { PATH: [process.env.PATH, ...extra].filter(Boolean).join(":") };
  for (const k of [...ENV_ALLOW, ...extraAllow]) {
    if (ENV_NEVER.test(k)) {
      // 許可リストに書かれても秘密らしい名前は渡さない。ただし黙って落とすと
      // 「envAllow に書いたのに効かない」に見えるので、落とした事実は記録する（P2-④）
      if (extraAllow.includes(k) && !envNeverWarned.has(k)) {
        envNeverWarned.add(k);
        logEvent("isolation", `envAllow の「${k}」は秘密らしい名前のため子プロセスへ渡しません（ENV_NEVER）`, "warn");
      }
      continue;
    }
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  return env;
  // 限界: これはサーバが渡す変数を絞るだけ。CLI が自分の子のために設定する変数は対象外（段2・初版では保証しない）
}

// ---- 資格層（契約: 契約-資格隔離API.md §4）----
// 起動のたびに 1 個作り、メモリにだけ置く。ファイルにも state にも書かないので、
// publicState() にも絶対に載せない（載せると SSE で撒かれる）
//
// U2A2A_ADMIN_CREDENTIAL はテストが固定値を差し込むための入口。64 桁 16 進のときだけ採る。
// spawnEnv の ENV_NEVER がこの名前を弾くので、子プロセスへは渡らない
const FIXED_CREDENTIAL = /^[0-9a-f]{64}$/.test(process.env.U2A2A_ADMIN_CREDENTIAL || "") ? process.env.U2A2A_ADMIN_CREDENTIAL : null;
// 段階 1 を入れる前の互換動作を残すための逃げ道。既定は有効。無効にした起動は画面に「資格なし」と出す
const CREDENTIALS_ENABLED = process.env.U2A2A_CREDENTIALS !== "off";
let adminCredential = cred.newAdminCredential(Date.now(), FIXED_CREDENTIAL);
const ticketStore = cred.createTicketStore();

function printCredentialBanner() {
  if (!CREDENTIALS_ENABLED) {
    console.log(`\n  Yoseai: http://127.0.0.1:${PORT}\n  U2A2A_CREDENTIALS=off — 管理資格の検査を止めています（ローカルの誰でも API を叩けます）\n`);
    return;
  }
  console.log(cred.credentialBanner(PORT, adminCredential.value));
}

// 出所検査（403）の次に置く。本文を読む前に 401 を返す（§4.4）
function checkApiCredential(req, url) {
  if (!CREDENTIALS_ENABLED) return null;
  const r = cred.checkCredential({ method: req.method, pathname: url.pathname, headers: req.headers, admin: adminCredential });
  if (!r) return null;
  // SSE だけは切符でも通す。EventSource は Authorization を付けられないため（§4.2）
  if ((req.method || "GET").toUpperCase() === "GET" && url.pathname === "/api/events") {
    if (ticketStore.consume(url.searchParams.get("ticket") || "")) return null;
    return { status: 401, code: "ticket-invalid", error: "SSE の切符が無効か、期限切れです（10 秒で失効します）" };
  }
  return r;
}

// ---- 強制層（契約: 契約-資格隔離API.md §2）----
// 「ラッパーが入っていない（unprotected・起動する）」と「あるが初期化に失敗した（blocked・起動しない）」を分ける。
// 黙って未保護へ落ちないことが肝。判定と変換は sandbox.mjs（I/O なし）、ここは I/O と状態だけ

const isolation = {
  mode: "unprotected",
  runtime: sandbox.DEFAULT_RUNTIME,
  version: null,
  reason: "not-initialized",
  verified: false,
  verifiedAt: null,
  coverage: null, // 検証済みのとき、その被覆（P1-1）。verified と一緒にしか立たない
  profilesSha256: null,
  unverified: [],
  profiles: [],
  settingsPaths: {}, // "<agent>/<phase>" -> 設定ファイルの絶対パス
};

function sandboxAvailability() {
  try {
    const r = spawnSync(SANDBOX_RUNTIME_CMD, ["--version"], { encoding: "utf8", timeout: 5000 });
    if (r.error) return { available: false, reason: r.error.code === "ENOENT" ? "runtime-missing" : String(r.error.message || r.error) };
    if (r.status !== 0) return { available: false, reason: `runtime-exit-${r.status}` };
    return { available: true, reason: "", version: String(r.stdout || "").trim().slice(0, 40) };
  } catch (e) {
    return { available: false, reason: String(e.message || e) };
  }
}

// 起動時に 1 回。プロファイルを読み、変数を展開した設定ファイルを data/sandbox/ へ書き出す。
// 1 つでも展開に失敗したら mode は blocked（その状態で CLI を起こさない）
function initIsolation() {
  // 前回起動の設定ファイルの残骸を掃除する（P2-③）。実行のたびに書き直すので、持ち越す理由がない
  try { fs.rmSync(SANDBOX_SETTINGS_DIR, { recursive: true, force: true }); } catch {}
  const avail = sandboxAvailability();
  let raw = null;
  try {
    const text = fs.readFileSync(SANDBOX_PROFILES_FILE, "utf8");
    isolation.profilesSha256 = verif.sha256Hex(text);
    raw = JSON.parse(text);
  } catch (e) {
    isolation.mode = avail.available ? "blocked" : "unprotected";
    isolation.reason = "profiles-unreadable: " + String(e.message || e).slice(0, 160);
    isolation.version = avail.version || null;
    logEvent("isolation", "sandbox-profiles.json を読めません: " + isolation.reason, avail.available ? "error" : "warn");
    return;
  }
  const v = sandbox.validateProfiles(raw);
  if (!v.ok) {
    isolation.mode = avail.available ? "blocked" : "unprotected";
    isolation.reason = "profiles-invalid: " + v.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join(" / ");
    logEvent("isolation", "sandbox-profiles.json が不正です: " + isolation.reason, avail.available ? "error" : "warn");
    return;
  }
  isolation.profiles = v.profiles;
  isolation.unverified = [...new Set(v.profiles.flatMap((p) => p.unverified || []))].sort();
  isolation.version = avail.version || null;
  if (!avail.available) {
    isolation.mode = "unprotected";
    isolation.reason = avail.reason;
    logEvent("isolation", `OS の隔離は掛かっていません（${avail.reason}）。未保護のまま実行します`, "warn");
    return;
  }
  isolation.mode = "enforced";
  isolation.reason = "";
  // 前回の検証記録は、プロファイルが 1 バイトでも変わっていれば捨てる（§7.3）
  const prev = state.isolationVerification;
  // runtime は名前だけでなく**版**も一致が要る（P1-1）。プロファイルは 1 バイト、強制層は 1 版でも
  // 変わっていれば前回の検証は無効。旧記録（version 未保存）も同じ扱いで捨てる
  if (prev && prev.profilesSha256 === isolation.profilesSha256 && prev.runtime === isolation.runtime && prev.version && prev.version === isolation.version) {
    isolation.verified = true;
    isolation.verifiedAt = prev.verifiedAt || null;
    isolation.coverage = prev.coverage || coverageSummary();
  } else if (prev) {
    state.isolationVerification = null;
    logEvent("isolation", "プロファイルまたは強制層の版が変わったため、前回の検証記録を破棄しました。再測定が要ります", "warn");
  }
}

// (agent, phase) ごとの設定ファイル。トピックや対象プロジェクトで変数が変わるので、実行のたびに書き出す。
// 対象プロジェクトも名前に入れる——入れないと同じ (agent, phase, topic) の同時実行が別プロジェクトの
// 設定を取り違えうる（修正リスト-確定 P2-③）。残骸は起動時の initIsolation が丸ごと掃除する
function sandboxSettingsFor(profile, agent, phase, topicId, projectPath) {
  const t = sandbox.toRuntimeSettings(profile, isolation.runtime);
  if (!t.ok) return { ok: false, reason: "unsupported: " + t.unsupported.map((u) => u.key).join(" / ") };
  const proj = crypto.createHash("sha256").update(String(projectPath || "")).digest("hex").slice(0, 8);
  const name = `${agent}-${phase}-${topicId || "none"}-${proj}.json`.replace(/[^\w.-]/g, "_");
  const file = path.join(SANDBOX_SETTINGS_DIR, name);
  try {
    fs.mkdirSync(SANDBOX_SETTINGS_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(t.settings, null, 2), { mode: 0o600 });
  } catch (e) {
    return { ok: false, reason: "settings-write-failed: " + String(e.message || e).slice(0, 160) };
  }
  isolation.settingsPaths[`${agent}/${phase}`] = file;
  return { ok: true, file };
}

// runCli から呼ぶ。戻り値の mode で「包んだ」「そのまま」「起動しない」を決める
function planRun({ agent, phase, topicId, projectPath }, cmd, args) {
  // 指定漏れは「未保護で走らせる」ではなく「起動しない」（fail-closed）。srt 不在の unprotected は
  // 環境の事実だが、呼び出し忘れは実装の欠陥であり、黙って未保護実行に倒すと UI は enforced のまま
  // 素通りが起きる（修正リスト-確定 P0-2。CLI 起動経路は現在4つで全て isolation を渡している）
  if (!agent || !phase) return { mode: "blocked", cmd, args, reason: "no-profile-requested" };
  if (isolation.mode === "unprotected") return { mode: "unprotected", cmd, args, reason: isolation.reason };
  if (isolation.mode === "blocked") return { mode: "blocked", cmd, args, reason: isolation.reason };
  const vars = {
    repoRoot: REPO_ROOT,
    poolDir: POOL_DIR,
    poolTopicDir: topicId ? path.join(POOL_DIR, "topics", topicId) : POOL_DIR,
    dataDir: DATA_DIR,
    home: os.homedir(),
    tmpDir: os.tmpdir(),
    // Claude Code は TMPDIR を渡しても無視して、ここへコマンド出力の受け皿
    // （claude-<uid>/ と毎回名前の変わる claude-<hex>-cwd）を作る。許可しないと Bash が
    // 丸ごと EPERM で落ちる。srt は glob も単体指定も受けないので範囲を絞れない（実測）。
    // ここを開けてもリポジトリ・pool 外・資格ファイルの保護は変わらないことを確認済み
    systemTmp: SYSTEM_TMP,
    profilesPath: SANDBOX_PROFILES_FILE,
    projectPath: projectPath || REPO_ROOT,
  };
  const r = sandbox.resolveProfile(isolation.profiles, { agent, phase, vars });
  if (!r.ok) return { mode: "blocked", cmd, args, reason: "profile: " + r.errors.map((e) => e.message).join(" / ") };
  const s = sandboxSettingsFor(r.profile, agent, phase, topicId, vars.projectPath);
  if (!s.ok) return { mode: "blocked", cmd, args, reason: s.reason };
  return sandbox.planIsolation({
    availability: { available: true, version: isolation.version },
    profiles: isolation.profiles,
    agent,
    phase,
    vars,
    runtimeCmd: SANDBOX_RUNTIME_CMD,
    settingsPath: s.file,
    cmd,
    args,
    runtime: isolation.runtime,
  });
}

// §6 の再測定。接尾辞ごとに期待する観測で、ここに挙げたものが 1 つでも欠けるか食い違えば verified は立たない。
// 「記録のみ」の項目（-unv-socket / -unv-mcp）は判断材料であって合否ではないので、条件に入れない。
// -init-fail だけは期待が not_run —— 起動失敗を対象操作の denied と書かない（§6 の但し書き・合意メモ §5）。
// つまり「not_run があれば verified は立たない」（§7.3）は、判定を期待している試験についての規律で、
// ここは「起動していないこと」自体が期待する観測にあたる
const REQUIRED_PROBES = {
  "-fs-child": "denied",
  "-fs-tool": "denied",
  "-fs-self": "denied",
  "-net-loopback": "denied",
  "-net-vendor": "allowed",
  "-exec-tests": "allowed",
  "-init-fail": "not_run",
  "-cred-none": "denied",
  "-cred-env": "denied",
  "-cred-file": "denied",
};

// 修正リスト-確定 P1-1: 必須 probe は §6 の汎用接尾辞に加えて、**実在するプロファイル行単位**で要る。
// 行ごとに「書き込み境界」1 本（probe-isolation-boundary-<agent>-<phase>。phase "*" は "any"）、
// エージェントごとに「本番経路（runCli）で包んでいること」1 本（probe-isolation-wrap-<agent>）。
// これで「1 エージェント分の記録で全体の保護成立が点く」「プロファイルに行を足しても未測定のまま点く」
// を機械的に防ぐ。旧スイートの取込は missing で弾かれ、点灯は新 probe が揃うまで自動的に待つ
function requiredProbeSuffixes() {
  const req = { ...REQUIRED_PROBES };
  const agents = new Set();
  for (const p of isolation.profiles || []) {
    if (!p || !p.agent || p.agent === "*") continue; // 現物のプロファイルは全行 agent 指定
    agents.add(p.agent);
    req[`-boundary-${p.agent}-${p.phase === "*" ? "any" : p.phase}`] = "denied";
  }
  for (const a of agents) req[`-wrap-${a}`] = "denied";
  return req;
}

// 取り込んだ記録から被覆の要約を作る（表示・保存用。判定は requiredProbeSuffixes が正）
function coverageSummary() {
  const agents = [...new Set((isolation.profiles || []).map((p) => p.agent).filter((a) => a && a !== "*"))].sort();
  const rows = (isolation.profiles || []).filter((p) => p && p.agent && p.agent !== "*").length;
  return { agents, rows };
}

// §7.3: サーバは自分で verified を立てない。再測定の記録を取り込んだときだけ立つ
function applyIsolationVerification(body) {
  if (!body || typeof body !== "object") return { ok: false, code: "invalid-body", error: "本文が読めません" };
  if (isolation.mode !== "enforced") {
    return { ok: false, code: "not-enforced", error: `隔離が enforced ではありません（${isolation.mode}）。この状態を「検証済み」にはできません` };
  }
  if (!isolation.profilesSha256 || body.profilesSha256 !== isolation.profilesSha256) {
    return { ok: false, code: "profiles-mismatch", error: "プロファイルの版が現行と違います。プロファイルを変えたら検証はやり直しです" };
  }
  if (body.runtime && body.runtime !== isolation.runtime) {
    return { ok: false, code: "runtime-mismatch", error: `runtime が現行（${isolation.runtime}）と違います` };
  }
  // 強制層の実装が入れ替わっても検証記録が生き残らないよう、名前だけでなく版も突き合わせる（P1-1）
  if (body.version && isolation.version && body.version !== isolation.version) {
    return { ok: false, code: "runtime-version-mismatch", error: `runtime の版が現行（${isolation.version}）と違います。強制層を入れ替えたら検証はやり直しです` };
  }
  const probes = Array.isArray(body.probes) ? body.probes : [];
  const missing = [];
  const mismatched = [];
  for (const [suffix, expected] of Object.entries(requiredProbeSuffixes())) {
    const hits = probes.filter((p) => p && typeof p.probeId === "string" && p.probeId.endsWith(suffix));
    if (!hits.length) {
      missing.push(suffix);
      continue;
    }
    // 同じ試験が複数エージェント分あってもよい。1 つでも期待どおりでなければ落とす
    for (const h of hits) if (h.observation !== expected) mismatched.push({ probeId: h.probeId, expected, observation: h.observation || "not_run" });
  }
  if (missing.length || mismatched.length) {
    return { ok: false, code: "probes-incomplete", error: "再測定の記録が足りないか、期待と違う観測があります", missing, mismatched };
  }
  isolation.verified = true;
  isolation.verifiedAt = new Date().toISOString();
  isolation.coverage = coverageSummary(); // 何が検証されたのかを点灯と一緒に持ち歩く（P1-1）
  // 保存するのは取り込んだ記録そのもの。次の起動では profilesSha256 が一致するときだけ復元する
  state.isolationVerification = {
    verifiedAt: isolation.verifiedAt,
    profilesSha256: isolation.profilesSha256,
    runtime: isolation.runtime,
    version: body.version || isolation.version || null,
    coverage: isolation.coverage,
    probes: probes.map((p) => ({ probeId: String(p.probeId || ""), observation: String(p.observation || "not_run"), evidenceSha256: p.evidenceSha256 || null })),
  };
  logEvent("isolation", `再測定の記録を取り込みました（${probes.length} 件）。保護成立として表示します`, "info");
  return { ok: true };
}

// 呼び出し側が runCli へ渡す隔離の指定。ここで作らないと planRun は「指定なし＝包まない」に倒れるので、
// CLI を起こす経路はすべてこれを通す
function isolationFor(agent, phase, topicId, project) {
  return { agent, phase, topicId: topicId || null, projectPath: (project && project.path) || null };
}

// P0-0（修正候補。受入は -codex-nested 測定の完了が必須・修正リスト-確定）:
// macOS の Seatbelt は入れ子の sandbox_apply を拒否するため、srt の中で codex が自前の
// OS サンドボックスを適用するとシェルツールが全滅する（実測: exit 71、pool 内の読取も不能）。
// enforced のときだけ codex 自身の OS サンドボックスを外し、境界を srt に一本化する。
// CLI の権限規則（--allowedTools / --allow / resumeWritable / writeDir）は維持——外すのは OS 層の
// 入れ子だけ（合意メモ-隔離方式 §C の例外。契約補遺に明記）。
// 判定は起動引数を組む直前に planRun と同じ入力で行い、runCli まで同期区間なので計画はずれない。
// blocked なら runCli が起動を拒否する（fail-closed——素起動には決して落ちない）
function isolationModeFor(iso) {
  return planRun(iso || {}, "codex", []).mode;
}

// blocked は「起動していない」。呼び出し側の catch に合流させ、失敗として記録させる
function isolationError(reason) {
  const e = new Error("隔離を初期化できないため実行しませんでした: " + (reason || "unknown"));
  e.isolationBlocked = true;
  e.reason = "isolation-init-failed";
  return e;
}

// ---- エージェント不在の可視化（契約: 契約-不在可視化.md 契約版 1）----
// 実行失敗（キャンセル以外）を黙らせない: 依頼のあったスレッドに ⚠ 行を1通、トピック側 ta.lastError、
// 可用性（unavailable / unknown）とバッジ用の a.lastError を1か所で更新する。
// thread / review / fix の3経路の catch から共通で呼ぶ（分類関数を経路ごとに散らすと漏れる——契約 §1）
// cli は実行バックエンドの CLI（第1段は席＝CLI。第2段で resolveBackend() が入っても差分がここで済むよう分離——指摘#5）
function noteRunFailure(topicId, agent, e, kind, cli = agent) {
  const cls = classifyBackendError(cli, e);
  const a = state.agents[agent];
  if (a) {
    a.availability = cls.availability; // unknown も上書きする（unavailable が残り続けない——契約 §4）
    a.lastError = cls.detail;
  }
  const topic = findTopic(topicId);
  if (topic) {
    const ta = topic.agents && topic.agents[agent];
    if (ta) ta.lastError = cls.detail; // どのスレッドで死んだかを画面に出す（契約 §2）
    state.messages.push({
      id: id(),
      topicId,
      thread: agent,
      author: agent,
      text: `⚠ 応答できませんでした（${cls.detail}）`,
      failed: true,
      provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null },
      meta: (e && e.meta) || null,
      ts: Date.now(),
    });
  }
  // events は SSE・運用画面に流れる（publicState 経由）ので、ここも定型短文のみ（契約 §2・codex 再レビュー3）。
  // 生文は起動端末の stderr にだけ出す（資格バナーと同じ「端末にだけ」の規律）
  console.error(`[yoseai] ${NAMES[agent]} の${kind}失敗（生文・端末のみ）: ${String((e && e.message) || e || "").slice(0, 500)}`);
  logEvent("cli", `${NAMES[agent]} の${kind}が失敗しました（可用性: ${cls.availability}）: ${cls.detail}`, "warn");
  return cls;
}

// 実行成功（stopped / cancelled を除く）で可用性とトピック側エラーを戻す（契約 §3・§4）
function noteRunSuccess(topicId, agent) {
  const a = state.agents[agent];
  const wasUnavailable = !!(a && a.availability === "unavailable");
  const seatError = a ? a.lastError : "";
  if (a) {
    a.availability = "available";
    a.lastError = ""; // available と旧エラーを併存させない（契約 §4・codex レビュー）
  }
  const topic = findTopic(topicId);
  const ta = topic && topic.agents && topic.agents[agent];
  if (ta) ta.lastError = "";
  // 残高切れ等の「席全体の事情」は各トピックに同じ短文で複製される。席が復帰したら全トピック分を消す
  // （残すと、復帰後も別トピックの列で古い残高エラーが availability より先に表示され続ける——指摘#4）。
  // 複製かどうかは文言の厳密一致で判定できる（unavailable の detail は定型）
  if (wasUnavailable && seatError) {
    for (const t of state.topics) {
      const tta = t.agents && t.agents[agent];
      if (tta && tta.lastError === seatError) tta.lastError = "";
    }
  }
}

// 退避ファイルを最後まで回収できなかった実行は成功にしない（修正リスト-確定 P1-2）。
// isolationBlocked と同じく throw で各 call* の失敗経路へ合流させる
function outputLostError(err) {
  const e = new Error("CLI 出力の退避ファイルを回収できませんでした。出力が失われている可能性があるため、この実行は失敗として扱います。" + String(err || "").slice(-300));
  e.outputLost = true;
  e.reason = "output-lost";
  return e;
}

// 調査用に残した退避ファイルの削除期限（P1-2 の受入条件）。起動時に 24 時間を過ぎたものを掃除する
function sweepRunRedirects(maxAgeMs = 24 * 3600_000) {
  let removed = 0;
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!/^yoseai-run-[0-9a-f]{16}\.(out|err)$/.test(name)) continue;
      const p = path.join(os.tmpdir(), name);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) { fs.unlinkSync(p); removed++; }
      } catch {} // 消えていた・読めない残骸はスキップ
    }
  } catch {}
  if (removed) logEvent("isolation", `期限切れの退避ファイルを ${removed} 件掃除しました`, "info");
}

// プロセスグループごとシグナル送信（ツール実行の子孫プロセスも道連れにする）
function killTree(child, sig) {
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      // 既に終了している
    }
  }
}

function runCli(cmd, args, stdinData, timeoutMs = AGENT_TIMEOUT_MS, onLine = null, cwd = REPO_ROOT, ctl = null, iso = null) {
  // 強制層への唯一の差し込み点（契約 §2.2）。runner テーブルや callXxx は起動引数を組み立てるだけで、
  // 包むかどうかはここだけが決める
  const plan = planRun(iso || {}, cmd, args);
  if (plan.mode === "blocked") {
    logEvent("isolation", `隔離を初期化できないため実行しませんでした: ${plan.reason}`, "error");
    return Promise.resolve({ code: null, out: "", err: "", isolationBlocked: true, isolationReason: plan.reason });
  }
  // 隔離時は子の stdout / stderr を一時ファイルへ逃がす。grok は自分の stdout を
  // 非ブロッキングにして EAGAIN でリトライしないため、srt が 1 段挟まってパイプ詰まりが
  // 起きると "stdout write failed: os error 35" で落ちる（実測で再現）。通常ファイルは
  // EAGAIN を返さないので確実に受け取れる。全プロファイルが <tmpDir> 書き込みを許可済み。
  let redirect = null;
  let runArgs = plan.args;
  if (plan.mode === "enforced") {
    const base = path.join(os.tmpdir(), "yoseai-run-" + crypto.randomBytes(8).toString("hex"));
    redirect = { out: base + ".out", err: base + ".err" };
    // 先に 0600 で作っておく（シェルの > は truncate するだけ）。回収に失敗して残す場合の閲覧を自分に限る
    try { fs.writeFileSync(redirect.out, "", { mode: 0o600 }); fs.writeFileSync(redirect.err, "", { mode: 0o600 }); } catch {}
    // plan.args の末尾は srt の -c に渡すシェル文字列。stdin は触らずリダイレクトだけ足す
    runArgs = [...plan.args];
    runArgs[runArgs.length - 1] += ` > ${sandbox.shellQuote(redirect.out)} 2> ${sandbox.shellQuote(redirect.err)}`;
  }
  return new Promise((resolve) => {
    // 追加の環境変数はプロファイルの envAllow だけ（契約 §5）。既定は空
    const child = spawn(plan.cmd, runArgs, { cwd, env: spawnEnv(plan.envAllow || []), stdio: ["pipe", "pipe", "pipe"], detached: true });
    let closed = false;
    if (ctl) {
      // キャンセル: SIGTERM → 3秒猶予 → SIGKILL 昇格
      ctl.cancel = () => {
        if (closed || ctl.cancelled) return;
        ctl.cancelled = true;
        killTree(child, "SIGTERM");
        setTimeout(() => {
          if (!closed) killTree(child, "SIGKILL");
        }, 3000);
      };
    }
    child.stdin.on("error", () => {});
    child.stdin.end(stdinData);
    let out = "", err = "", lineBuf = "";
    const feed = (chunk) => {
      const s = chunk.toString();
      out += s;
      if (!onLine) return;
      lineBuf += s;
      let idx;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        try {
          onLine(line);
        } catch {
          // 実況の失敗で本処理を止めない
        }
      }
    };
    let tailPos = 0, tailTimer = null;
    const drainFile = () => {
      if (!redirect) return;
      try {
        const st = fs.statSync(redirect.out);
        if (st.size > tailPos) {
          const fd = fs.openSync(redirect.out, "r");
          const buf = Buffer.alloc(st.size - tailPos);
          const n = fs.readSync(fd, buf, 0, buf.length, tailPos);
          fs.closeSync(fd);
          tailPos += n;
          feed(buf.subarray(0, n));
        }
      } catch {
        // まだ作られていない・読めない間は次のティックで拾う
      }
    };
    if (redirect) {
      // ファイル追尾で実況。srt 自身の出力（診断）はパイプ側で拾い err へ
      tailTimer = setInterval(drainFile, 120);
      child.stdout.on("data", (d) => (err += "[srt] " + d));
      child.stderr.on("data", (d) => (err += d));
    } else {
      child.stdout.on("data", (d) => feed(d));
      child.stderr.on("data", (d) => (err += d));
    }
    const finish = (result) => {
      if (tailTimer) clearInterval(tailTimer);
      let outputLost = false;
      if (redirect) {
        // 最終回収の成否は独立に記録する（修正リスト-確定 P1-2）。定期 tick の沈黙 catch は
        // 「未作成の間は次で拾う」ための正当なものだが、close 後のここで拾えないのは事故:
        //   missing    = ファイルが無い（リダイレクト自体が走っていない系統。> は空でも作る）
        //   unreadable = 在るのに読めない（許可パスが死んだときの本命。EPERM 等）
        // 空の出力は正常（CLI が何も書いていないだけ）なので ok。
        const drainStatus = (file, read) => {
          try { read(file); return "ok"; } catch (e) { return e && e.code === "ENOENT" ? "missing" : "unreadable"; }
        };
        const outStatus = drainStatus(redirect.out, () => {
          const st = fs.statSync(redirect.out);
          if (st.size > tailPos) {
            const fd = fs.openSync(redirect.out, "r");
            const buf = Buffer.alloc(st.size - tailPos);
            const nRead = fs.readSync(fd, buf, 0, buf.length, tailPos);
            fs.closeSync(fd);
            tailPos += nRead;
            feed(buf.subarray(0, nRead));
          }
        });
        const errStatus = drainStatus(redirect.err, () => { err += fs.readFileSync(redirect.err, "utf8"); });
        result.stdoutDrain = outStatus;
        result.stderrDrain = errStatus;
        // ok だったファイルだけ消す。回収できなかったファイルは原因調査のために残し（0600 で作成済み）、
        // パスを err に書く。残骸は起動時の sweepRunRedirects が期限（24h）で掃除する
        if (outStatus === "ok") { try { fs.unlinkSync(redirect.out); } catch {} }
        if (errStatus === "ok") { try { fs.unlinkSync(redirect.err); } catch {} }
        if (outStatus !== "ok" || errStatus !== "ok") {
          outputLost = true;
          const kept = [outStatus !== "ok" ? redirect.out : null, errStatus !== "ok" ? redirect.err : null].filter(Boolean);
          err += `\n(退避ファイルの最終回収に失敗: stdout=${outStatus} / stderr=${errStatus}。調査用に残しました: ${kept.join(" ")})`;
          logEvent("isolation", `CLI 出力の退避ファイルを回収できませんでした（stdout=${outStatus} / stderr=${errStatus}）。この実行は成功として扱いません`, "error");
        }
      }
      resolve({ ...result, out, err, outputLost });
    };
    const timer = setTimeout(() => {
      err += `\n(タイムアウト: ${timeoutMs / 1000}秒)`;
      killTree(child, "SIGTERM"); // キャンセルと同じ作法で穏当に止め、3秒で昇格
      setTimeout(() => {
        if (!closed) killTree(child, "SIGKILL");
      }, 3000);
    }, timeoutMs);
    child.on("error", (e) => {
      closed = true;
      clearTimeout(timer);
      err = String(e.message || e);
      finish({ code: -1, cancelled: !!(ctl && ctl.cancelled) });
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timer);
      finish({ code, cancelled: !!(ctl && ctl.cancelled) });
    });
  });
}

function buildPrompt(topic, agent, msgs, isFirst, changesNote = "", projectInfo = null, extra = {}) {
  const participants = topic.participants || LEGACY_AGENTS;
  const peerNames = peersOf(participants, agent).map((a) => NAMES[a]);
  const rootCwd = agent !== "codex"; // claude / grok は cwd=リポジトリルート（書き込みは pool のみ）、codex は cwd=pool
  const project = projectInfo && projectInfo.project ? projectInfo.project : null;
  // 対象プロジェクトの 1 行（name・path・branch・HEAD・未コミット数、または確認不可）。probe は毎回取り直すので初回に限らず毎回添える
  const projectLine = project ? projectPromptLine(project, projectInfo.probe) : "";
  // 作業範囲の説明: 紐付けありなら対象プロジェクト（閲覧のみ）、未紐付けはこのアプリのリポジトリ
  const workNote = project
    ? (rootCwd ? "" : `作業ディレクトリは u2a2a/pool（成果物置き場・書き込み可）。`) + projectLine
    : rootCwd
      ? `作業ディレクトリはアプリのリポジトリ（${REPO_ROOT}、閲覧のみ、変更は不可）。` // 書き込み先（u2a2a/pool/ 配下のみ）は artifactNote で示す。文言は既存テストが照合している
      : `作業ディレクトリは u2a2a/pool（成果物置き場・書き込み可）。アプリのリポジトリ本体（${REPO_ROOT}）は閲覧のみ。`;
  const activeRelayId = topic.relay.active ? topic.relay.id : null;
  const lines = msgs
    .map((m) => {
      const pv = m.provenance || {};
      // 引き継ぎ: 単なる転送ではなく「ここから先はあなたが進める」という依頼として届ける
      if (pv.delivery === "handoff" && pv.source) {
        const mirrorRef = topic.mirrorFile ? `u2a2a/pool/${topic.mirrorFile}` : "スレッド履歴ミラー";
        return (
          `【引き継ぎ依頼】以下は ${NAMES[pv.source.agent]} 側スレッドでの作業内容です。` +
          `ここから先をあなたが引き継いで進めてください（経緯の全文脈は ${mirrorRef} で参照できます）:\n` +
          `[${NAMES[m.author]}] ${m.text}`
        );
      }
      if (m.test) {
        return (
          `【テスト送信 — 明示された生成・操作は行ってよいが、そこから追加調査・実装へは広げないこと】\n` +
          `[${NAMES[m.author]}] ${m.text}`
        );
      }
      // 終了・中止した質疑の配送コピーは経緯として渡すだけ（返信を求めず、起動理由にもならない）
      if (pv.delivery === "qa-relay" && (!activeRelayId || !pv.source || pv.source.relayId !== activeRelayId)) {
        return `【終了した質疑の経緯・返信不要】\n[${NAMES[m.author]}] ${m.text}`;
      }
      return `[${NAMES[m.author]}] ${m.text}`;
    })
    .join("\n\n");
  // 未読を切り詰めた場合は捨てずに件数とミラーの参照先を示す
  const mirrorRefText = topic.mirrorFile ? ` u2a2a/pool/${topic.mirrorFile} ` : "スレッド履歴ミラー";
  const backlogNote = extra.dropped ? `（これ以前の未読 ${extra.dropped} 件は${mirrorRefText}を参照）\n\n` : "";
  const participantList = participants.map((a) => NAMES[a] + (a === agent ? "（あなた）" : "")).join("・");
  const preamble = isFirst
    ? `あなたは「Yoseai」アプリの ${NAMES[agent]} 側スレッドの担当エージェントです。` +
      `このスレッドのトピックは「${topic.title}」です。` +
      `参加者はユーザー・${participantList} です。` +
      workNote +
      `新着メッセージに ${NAMES[agent]} として日本語で簡潔に返答してください。` +
      `実装作業が必要な場合は作業内容を提案し、タスク化はユーザーに委ねてください。\n\n--- 新着メッセージ ---\n`
    : (projectLine ? projectLine + "\n\n" : "") + "--- 新着メッセージ ---\n"; // 継続でも最新の Git 情報は毎回渡す（概要だけ初回限定）
  // 質疑の初手（このエージェントがまだ発言しておらず、発端も未見）には論点・発端・ミラー・要約を添える
  let qaJoinNote = "";
  const r = topic.relay;
  if (r.active && r.startMessageId) {
    const startMsg = state.messages.find((m) => m.id === r.startMessageId);
    const startInUnseen = msgs.some((m) => m.id === r.startMessageId);
    const spokeSince = startMsg && state.messages.some((m) => m.topicId === topic.id && m.author === agent && m.ts > startMsg.ts);
    if (startMsg && !startInUnseen && !spokeSince) {
      qaJoinNote =
        `\n\n（この質疑の発端［${NAMES[startMsg.author]}］: ${startMsg.text.slice(0, 300)}${startMsg.text.length > 300 ? "…" : ""}` +
        (topic.mirrorFile ? `／全経緯は u2a2a/pool/${topic.mirrorFile} で参照可` : "") +
        (topic.summaryText ? `\nスレッドの現況要約:\n${topic.summaryText.slice(0, 600)}` : "") +
        `）`;
    }
  }
  const relayOrder = (topic.relay.participants || []).map((a) => NAMES[a]).join(" → ");
  const qaNote = topic.relay.active
    ? `\n\n（現在 ${peerNames.join("・")} との質疑応答モードです${relayOrder ? `（手番順: ${relayOrder}）` : ""}。議論が浅いうちは結論に飛びつかず、質問・反論・検討を返してください。` +
      `${QA_END_MARK} は、参加者全員の見解を少なくとも一度聞いた上で合意・結論に達した場合のみ、応答の最終行の末尾にそのまま書いてください（文中・否定文での言及や、引用行・鉤括弧・コード・取消線で包んだ言及は終了宣言になりません）。` +
      `まだ発言していない参加者がいる段階での終了宣言は無効です。残り自動中継 ${topic.relay.remaining} 手）`
    : "";
  const saveDir = `u2a2a/pool/${topicDirRel(topic.id)}`;
  const artifactNote =
    rootCwd
      ? `\n\n（成果物ファイルの保存先は ${saveDir}/ です（書き込みは u2a2a/pool/ 配下のみ許可）。` +
        `中間生成物は ${saveDir}/.work/ へ。画像・音声・動画は python3 / ffmpeg による描画・変換で作れます。いわゆる「画像生成」は python3 u2a2a/tools/nanobanana.py "プロンプト" 保存先.png で可能です（Nano Banana / Gemini。キー未設定だとその旨のエラーになるので、その場合は得意な参加者（Codex / Grok）への引き継ぎを提案してください）。` +
        `保存したら本文にそのパスを書いてください — アプリがインライン表示します）`
      : `\n\n（カレントディレクトリ＝ ${saveDir}/ が成果物の保存先です（書き込みはここのみ）。` +
        `中間生成物は .work/ へ。python3 / ffmpeg で画像・音声・動画を生成できます。` +
        (project ? `対象プロジェクトは ${project.path} を絶対パスで参照（閲覧のみ）。` : `リポジトリ本体は ${REPO_ROOT} を絶対パスで参照（閲覧のみ）。`) +
        `保存したら本文に ${saveDir}/〜 のパスを書いてください — アプリがインライン表示します。` +
        `短い SVG 等は本文のコードブロックでも構いません）`;
  // キャンセル等で新セッションになった場合、保存済み要約で文脈を再注入する
  // 要約・引き継ぎ会話の出所が現在の対象と違えば注記する（別対象への分岐、分岐後の対象変更、いずれも同じ判定）
  const originNote = isFirst ? summaryOriginNote(topic, projectLabel) : "";
  const contextNote =
    isFirst && topic.summaryText && state.messages.some((m) => m.topicId === topic.id)
      ? `\n\n--- これまでのスレッドの要約（新しいセッションのための文脈） ---\n${originNote}${topic.summaryText}\n`
      : originNote
        ? `\n\n${originNote}`
        : "";
  // 紐付けありの初回のみ、対象プロジェクトの概要（README 冒頭＋直下エントリ名、4,000 文字まで）
  const digestNote = isFirst && project && projectInfo.digest ? `\n\n--- 対象プロジェクトの概要（初回のみ） ---\n${projectInfo.digest}\n` : "";
  // Grok は権限拒否で応答全体が停止するため、拒否されるシェルを最初から使わないよう明示する（工程0の実測: 複合シェル偵察で停止）
  const grokShellNote =
    agent === "grok"
      ? `\n\n（Grok への注意: シェルで許可されているのは python3 / ffmpeg だけで、しかも必ず 1 行で書いてください（複数行コマンドや mkdir・sips 等は権限拒否となり、応答全体がその場で停止します）。確認は read_file / list_dir / grep ツールで。画像・動画は image_gen / image_edit / image_to_video が使えます — 生成物は python3 の 1 行（例: from PIL import Image; …）で保存先へコピー・変換してください）`
      : "";
  return preamble + contextNote + digestNote + qaJoinNote + backlogNote + lines + qaNote + changesNote + artifactNote + grokShellNote + commonRulesBlock("通常応答");
}

// 質疑リレーを 1 本開始する。/api/qa/start と、判断トレイの「3 人で再検討」（契約-判断トレイAPI.md §9.4）で共用する。
// check: true なら検査だけして状態を変えない（押す前に「始められるか」を確かめるため）。
// 検査に落ちたときは { error } を返し、そのときも状態は変えない
function openRelay(topic, { first, order, hops = 6, agenda = "", text = "", check = false }) {
  // 進行中のリレーを上書きするかどうかは呼び出し側の判断（/api/qa/start は従来どおり上書きする）
  const tparts = topic.participants || LEGACY_AGENTS;
  if (state.budgetHalt) return { error: "上限停止中です（バナーから解除してください）" };
  if (!order.includes(first)) return { error: "first は参加者に含めてください" };
  const ordered = [first, ...order.filter((a) => a !== first)];
  if (ordered.length < 2) return { error: "質疑には 2 名以上の参加者が必要です" };
  const outsider = ordered.find((a) => !tparts.includes(a));
  if (outsider) return { error: `${NAMES[outsider] || outsider} はこのトピックの参加者ではありません` };
  const off = ordered.find((a) => !state.agents[a].auto);
  if (off) return { error: `質疑モードには参加者全員の自動応答を ON にしてください（${NAMES[off]} が OFF）` };
  if (ordered.includes("grok") && state.agents.grok.authed !== true) {
    return { error: "Grok が未認証（または確認中）のため質疑を開始できません", reason: "unauthed", agent: "grok" };
  }
  if (check) return { ok: true, participants: ordered };
  topic.relay = {
    ...defaultRelay(),
    active: true,
    remaining: hops,
    hopsDone: 0,
    startMessageId: null,
    agenda: String(agenda || "").trim().slice(0, 120),
    id: "r_" + id(),
    startedTs: Date.now(),
    participants: ordered,
    turn: 0,
    seq: 0,
    spoken: Object.fromEntries(ordered.map((a) => [a, 0])),
    stopReason: null,
  };
  topic.qaCount = (topic.qaCount || 0) + 1;
  topic.projectLocked = true; // 質疑の開始も実行の開始
  const msg = {
    id: id(),
    topicId: topic.id,
    thread: first,
    author: "user",
    text,
    provenance: { ingress: "ui", delivery: "direct", trigger: "manual", source: null },
    ts: Date.now(),
  };
  topic.relay.startMessageId = msg.id;
  state.messages.push(msg);
  return { relay: topic.relay, message: msg, first };
}

// 質疑モード（仕様: SPEC-Grok参戦.md「リレー機構」）: 応答者以外の参加者全員へ配送し、手番の 1 名だけを起動する。
// 2 名でも 3 名でも同じ機構。配送は常に先（終了宣言・最終手の発言も他の参加者へ届く）
function qaHop(topic, agent, replyText, sourceMsgId) {
  const r = topic.relay;
  if (!r.active) return;
  const parts = r.participants && r.participants.length ? r.participants : LEGACY_AGENTS;
  if (parts[r.turn] !== agent) return; // 手番外の応答は中継しない
  r.spoken = r.spoken || {};
  r.spoken[agent] = (r.spoken[agent] || 0) + 1;
  r.seq = (r.seq || 0) + 1;
  for (const to of peersOf(parts, agent)) {
    state.messages.push({
      topicId: topic.id,
      id: id(),
      thread: to,
      author: agent,
      text: replyText,
      provenance: {
        ingress: "agent-loop",
        delivery: "qa-relay",
        trigger: "auto",
        source: { topicId: topic.id, messageId: sourceMsgId || null, agent, relayId: r.id, seq: r.seq, turn: r.turn },
      },
      ts: Date.now(),
    });
  }
  // 終了宣言は最終行末尾にそのまま書かれたマーカーのみ有効（lib.hasEndMark: 文中・否定文・引用・コードで包んだ言及では発火しない）、かつ参加者全員が 1 回以上発言した後のみ
  if (canEndRelay(r, replyText, QA_END_MARK)) {
    stopRelay(topic, "agreed");
    summarizeTopic(topic.id, "relay-agreed"); // 質疑の決着は要約の節目
    return;
  }
  if (r.remaining <= 0) {
    stopRelay(topic, "hops");
    return;
  }
  r.remaining--;
  r.hopsDone++;
  r.turn = nextTurn(r);
  const next = parts[r.turn];
  if (!agentAutoOn(next)) {
    stopRelay(topic, "auto-off");
    return;
  }
  if (next === "grok" && state.agents.grok.authed !== true) {
    stopRelay(topic, "unauthed");
    return;
  }
  // 最終手（remaining が 0）でも次の参加者を起動する。その応答は配送された後に「hops」で停止する
  agentLoop(topic.id, next);
}

// stream-json イベント → 実況用の1行テキスト
function claudeStepFrom(ev) {
  if (ev.type === "system" && ev.subtype === "init") return "セッション初期化";
  if (ev.type === "system" && ev.subtype === "task_summary" && ev.detail) return "⚙ " + ev.detail;
  if (ev.type === "system" && ev.subtype === "thinking_tokens") return "🧠 思考中（~" + ev.estimated_tokens + " tokens）";
  if (ev.type === "assistant") {
    for (const b of ev.message?.content || []) {
      if (b.type === "tool_use") {
        const i = b.input || {};
        const target = i.file_path || i.path || i.command || i.pattern || i.query || "";
        return "🔧 " + b.name + (target ? ": " + String(target).slice(-70) : "");
      }
      if (b.type === "text" && b.text) return "✍ 応答を作成中";
    }
  }
  return null;
}

async function callClaude(prompt, sessionId, modelOverride, onStep, opts = {}) {
  const t0 = Date.now();
  // プロンプトは stdin 渡し（"---" 等で始まってもオプションと誤認されないように）
  // stream-json でイベントを逐次受け取り、進捗を実況する
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (sessionId) args.push("--resume", sessionId);
  if (modelOverride) args.push("--model", modelOverride);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  // オフライン指定: プロンプトの指示に加えて web ツールを CLI 側でも拒否する（末尾に置く。可変長引数が後続を吸わないように）
  if (opts.offline) args.push("--disallowedTools", "WebSearch", "WebFetch");
  let result = null;
  const onLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "system" && ev.subtype === "init" && ev.session_id && opts.onSessionId) opts.onSessionId(ev.session_id);
    if (ev.type === "result") result = ev;
    else if (onStep) {
      const s = claudeStepFrom(ev);
      if (s) onStep(s);
    }
  };
  const { code, err, out, cancelled, isolationBlocked, isolationReason, outputLost } = await runCli("claude", args, prompt, AGENT_TIMEOUT_MS, onLine, opts.cwd, opts.ctl, opts.isolation);
  if (isolationBlocked) throw isolationError(isolationReason);
  if (outputLost) throw outputLostError(err);
  if (cancelled)
    throw Object.assign(new Error("キャンセルされました"), {
      cancelled: true,
      meta: {
        status: "cancelled",
        model: modelOverride || "",
        durationMs: Date.now() - t0,
        usage: { inTok: null, outTok: null, cacheTok: null },
        billing: { mode: "unknown" },
      },
    });
  if (!result && code !== 0) throw new Error((err || out || "claude CLI エラー").trim().slice(0, 500));
  if (!result) throw new Error("claude: 結果イベントを受信できませんでした");
  if (result.is_error) throw new Error(String(result.result || "claude エラー").slice(0, 500));
  // modelUsage のキーがモデルID（"claude-opus-5[1m]" の [1m] はfastモード印なので除く）
  const model = Object.keys(result.modelUsage || {})[0]?.replace(/\[.*\]$/, "") || "";
  const u = result.usage || {};
  const meta = {
    status: "completed",
    model,
    durationMs: Date.now() - t0,
    usage: { inTok: u.input_tokens || 0, outTok: u.output_tokens || 0, cacheTok: u.cache_read_input_tokens || 0 },
    billing:
      typeof result.total_cost_usd === "number" ? { mode: "metered", usd: result.total_cost_usd } : { mode: "unknown" },
  };
  return { text: result.result || "(空の応答)", sessionId: result.session_id || sessionId, model, meta };
}

// codex は --json だとモデル名を出力しないため、セッションの rollout ファイル冒頭から読む
function codexModelFromRollout(sessionId) {
  if (!sessionId) return "";
  try {
    const files = fs.globSync(path.join(os.homedir(), ".codex/sessions/**/rollout-*" + sessionId + ".jsonl"));
    if (!files.length) return "";
    for (const line of fs.readFileSync(files[0], "utf8").split("\n").slice(0, 10)) {
      try {
        const m = JSON.parse(line)?.payload?.model;
        if (typeof m === "string" && m) return m;
      } catch {
        // JSON でない行は無視
      }
    }
  } catch {
    // rollout が読めなくてもモデル名表示を諦めるだけ
  }
  return "";
}

// codex --json イベント → 実況用の1行テキスト
function codexStepFrom(ev) {
  if (ev.type === "thread.started") return "セッション開始";
  if (ev.type === "turn.started") return "🧠 思考中…";
  const it = ev.item || {};
  if (ev.type === "item.started" || ev.type === "item.completed") {
    if (it.type === "command_execution") return "🔧 exec: " + String(it.command || "").slice(0, 70);
    if (it.type === "reasoning") return "🧠 思考中";
    if (it.type === "file_change") return "📝 ファイル変更";
    if (it.type === "agent_message") return "✍ 応答を作成中";
    if (it.type === "web_search") return "🌐 検索: " + String(it.query || "").slice(0, 50);
  }
  return null;
}

async function callCodex(prompt, sessionId, modelOverride, onStep, opts = {}) {
  const t0 = Date.now();
  const usage = { inTok: 0, outTok: 0, cacheTok: 0 };
  let earlySessionId = sessionId || null;
  const outFile = path.join(os.tmpdir(), `u2a2a-codex-${id()}.txt`);
  const base = ["--json", "-o", outFile, "--skip-git-repo-check"];
  // resume は -s / -C を受け付けない（cwd は元セッションから継承）。sandbox は config 経由で明示する。
  // resumeWritable は「cwd=pool で作られたセッション」のみ true にすること（リポジトリ cwd の旧セッションを
  // workspace-write で再開するとリポジトリ全体が書き込み可能になってしまう）
  // P0-0: enforced では codex の自前 OS サンドボックスを外して srt に一本化（isolationModeFor 参照）。
  // unprotected / blocked では従来どおり自前サンドボックスを使う（blocked は runCli が起動を拒否）
  const selfSandbox = isolationModeFor(opts.isolation) !== "enforced";
  const resumeMode = selfSandbox ? (opts.resumeWritable ? "workspace-write" : "read-only") : "danger-full-access";
  const newMode = selfSandbox ? (opts.writeDir ? "workspace-write" : "read-only") : "danger-full-access";
  const args = sessionId
    ? ["exec", "resume", sessionId, "-", ...base, "-c", `sandbox_mode="${resumeMode}"`]
    : opts.writeDir
      ? ["exec", "-", ...base, "-s", newMode, "-C", opts.writeDir]
      : ["exec", "-", ...base, "-s", newMode, "-C", REPO_ROOT];
  if (modelOverride) args.push("-m", modelOverride);
  const onLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "turn.completed" && ev.usage) {
      usage.inTok += ev.usage.input_tokens || 0;
      usage.outTok += ev.usage.output_tokens || 0;
      usage.cacheTok += ev.usage.cached_input_tokens || 0;
    }
    // thread ID は開始イベントで早期捕捉（キャンセル時も interrupted として保持できる）
    if (ev.type === "thread.started" && ev.thread_id) {
      earlySessionId = ev.thread_id;
      if (opts.onSessionId) opts.onSessionId(ev.thread_id);
    }
    if (onStep) {
      const s = codexStepFrom(ev);
      if (s) onStep(s);
    }
  };
  const { code, out, err, cancelled, isolationBlocked, isolationReason, outputLost } = await runCli("codex", args, prompt, AGENT_TIMEOUT_MS, onLine, REPO_ROOT, opts.ctl, opts.isolation);
  if (isolationBlocked) throw isolationError(isolationReason);
  if (outputLost) throw outputLostError(err);
  if (cancelled)
    throw Object.assign(new Error("キャンセルされました"), {
      cancelled: true,
      sessionId: earlySessionId,
      meta: {
        status: "cancelled",
        model: modelOverride || "",
        durationMs: Date.now() - t0,
        usage: { ...usage },
        billing: { mode: "plan" },
      },
    });
  let text = "";
  try {
    text = fs.readFileSync(outFile, "utf8").trim();
    fs.unlinkSync(outFile);
  } catch {
    // -o が書かれなかった場合は JSONL から拾う
  }
  let newSessionId = sessionId;
  for (const line of out.split("\n")) {
    try {
      const ev = JSON.parse(line);
      if (ev.thread_id) newSessionId = ev.thread_id;
      if (ev.session_id) newSessionId = ev.session_id;
      if (!text && ev.item && ev.item.type === "agent_message" && ev.item.text) text = ev.item.text;
    } catch {
      // JSON でない行は無視
    }
  }
  if (code !== 0 && !text) throw new Error((err || out || "codex CLI エラー").trim().slice(0, 500));
  const model = codexModelFromRollout(newSessionId);
  const meta = {
    status: "completed",
    model,
    durationMs: Date.now() - t0,
    usage: { ...usage },
    billing: { mode: "plan" }, // codex はプラン課金（実測USDなし）
  };
  return { text: text || "(空の応答)", sessionId: newSessionId, model, meta };
}

// ---- Grok Build CLI アダプタ（仕様: SPEC-Grok参戦.md、実測: smoke-Grok工程0.md）----
// 権限は毎回渡す（--resume は権限を継承しない）。プロンプトは一時ファイル経由（--prompt-file）。
// 書き込みは claude 互換の allow 規則で pool に限定し、spawn_subagent は除外する
// Grok はシェルを与えない（実測: 冒頭に git status && ls 等の複合コマンドで状況把握する流儀のため、
// Bash(python3:*) のような個別 allow では複合コマンドが拒否され、その場で cancelled 停止してしまう。
// run_terminal_command ごと外せば read_file / list_dir / grep で探索して完走する。メディア生成は当面 claude/codex 担当）
// 画像・動画は Grok 内蔵の生成スイートを許可（実測: 生成物は ~/.grok/sessions/ 配下に落ちる）。
// シェルは python3 / ffmpeg の 1 行のみ（複数行・他コマンドは拒否 → プロンプト注意で誘導）。保存は python3 の 1 行コピーで pool へ
// Claude 同様、相対規則の cd 依存を避けるため絶対パス規則を併記する
const GROK_WRITE_ARGS = ["--allow", "Edit(u2a2a/pool/**)", "--allow", `Edit(${POOL_DIR}/**)`, "--allow", "Bash(python3:*)", "--allow", "Bash(ffmpeg:*)", "--allow", "image_gen", "--allow", "image_edit", "--allow", "image_to_video", "--allow", "reference_to_video", "--disallowed-tools", "spawn_subagent"];
// レビューは読み取りツールの正のホワイトリストで絞る。Grok は権限拒否で実行全体が停止するため、
// read-only サンドボックス下で拒否され得る書き込み系ツール（search_replace 等）を持たせない
// （web 検索 search_tool は --tools の対象外で残る。実測: whitelist 下でも呼べて完走する）
const GROK_READ_ARGS = ["--sandbox", "read-only", "--tools", "read_file,list_dir,grep", "--disallowed-tools", "spawn_subagent,run_terminal_command"];
const GROK_AUTH_FILE = path.join(os.homedir(), ".grok", "auth.json");

async function callGrok(prompt, sessionId, modelOverride, onStep, opts = {}) {
  const t0 = Date.now();
  const promptFile = path.join(os.tmpdir(), `u2a2a-grok-${id()}.md`);
  fs.writeFileSync(promptFile, prompt);
  const args = ["--prompt-file", promptFile, "--output-format", "streaming-json"];
  if (sessionId) args.push("--resume", sessionId);
  if (modelOverride) args.push("-m", modelOverride);
  if (opts.extraArgs) args.push(...opts.extraArgs);
  if (opts.offline) args.push("--disable-web-search");
  const onLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev.type === "end" && ev.sessionId && opts.onSessionId) opts.onSessionId(ev.sessionId);
    if (onStep) {
      const st = grokStepFrom(ev);
      if (st) onStep(st);
    }
  };
  const { code, out, err, cancelled, isolationBlocked, isolationReason, outputLost } = await runCli("grok", args, "", AGENT_TIMEOUT_MS, onLine, opts.cwd, opts.ctl, opts.isolation);
  if (isolationBlocked) throw isolationError(isolationReason);
  if (outputLost) throw outputLostError(err);
  try {
    fs.unlinkSync(promptFile);
  } catch {
    // 既に無ければ無視
  }
  if (cancelled)
    throw Object.assign(new Error("キャンセルされました"), {
      cancelled: true,
      meta: { status: "cancelled", model: modelOverride || "", durationMs: Date.now() - t0, usage: { inTok: null, outTok: null, cacheTok: null }, billing: { mode: "unknown" } },
    });
  const parsed = parseGrokStream(out.split("\n"));
  if (parsed.error) {
    if (isGrokUnauthedError(parsed.error)) {
      state.agents.grok.authed = false;
      state.agents.grok.authCheckedTs = Date.now();
    }
    throw new Error("grok: " + parsed.error.slice(0, 500));
  }
  if (!parsed.end && code !== 0) throw new Error((err || out || "grok CLI エラー").trim().slice(0, 500));
  if (!parsed.end) throw new Error("grok: end イベントを受信できませんでした");
  const meta = grokMetaFrom(parsed.end, Date.now() - t0, modelOverride);
  if (meta.billing.mode === "unknown") logEvent("billing", "Grok の費用を取得できませんでした（不明として扱い、0 円とはみなしません）", "warn");
  // stopReason: cancelled は成功扱いにしない。本文・usage・費用は保持し、呼び出し側が「権限要求または中断で停止」を表示する
  return { text: parsed.text || (meta.status === "stopped" ? "(応答なし)" : "(空の応答)"), sessionId: parsed.end.sessionId || sessionId, model: meta.model, meta };
}

// 認証判定: ~/.grok/auth.json の存在＋軽量プローブ（起動時と再確認時のみ。実行のたびには判定しない）
async function checkGrokAuth() {
  const g = state.agents.grok;
  if (!g) return null;
  let ok = false;
  let message = "";
  if (!fs.existsSync(GROK_AUTH_FILE)) {
    message = "未認証（grok login が必要）";
    g.availability = "unknown"; // ログアウト後に「available」を残さない（契約 §4「証拠なしに利用可能を示さない」——指摘#7）
  } else {
    // プローブは ping を返すだけで何も書かないので、読み取りのみのプロファイル（grok/review）で起こす。
    // 隔離が blocked のときは起動されないので、認証は「不明」ではなく未認証扱いにせず、そのまま前回値を残す
    const r = await runCli("grok", ["-p", "ping", "--output-format", "json", "--max-turns", "1"], "", 20_000, null, REPO_ROOT, null, isolationFor("grok", "review", null, null));
    if (r.isolationBlocked || r.outputLost) {
      // 再確認を実行できなかった: 認証は前回値のまま（設計）だが、可用性は「不明」へ落として画面に出す
      //（available のまま残すと「再確認不能なのに利用可能」になる——契約 §4・codex レビュー）
      g.availability = "unknown";
      g.lastError = "再確認を実行できませんでした（" + (r.isolationBlocked ? "隔離を初期化できない" : "退避出力を回収できない") + "）";
      touch();
      return null;
    }
    const parsed = parseGrokStream(r.out.split("\n"));
    ok = r.code === 0 && !parsed.error && !isGrokUnauthedError(r.out + r.err);
    message = ok ? "" : String(parsed.error || r.err || "プローブに失敗").slice(0, 200);
    // 手動「再確認」にも同じ分類を適用する（契約-不在可視化 §4）: 402 → unavailable、判定不能 → unknown、成功 → available。
    // 認証（authed）の判定はこれまでどおり——認証済みであることと応答可能であることは別軸
    if (ok) g.availability = "available";
    else {
      const cls = classifyBackendError("grok", parsed.error || r.err || r.out || message);
      g.availability = cls.availability;
      // unknown でも生文を残さない（codex 再レビュー2）。events も SSE・画面に流れるので定型のみ（再レビュー3）。
      // 生文は起動端末の stderr にだけ
      console.error("[yoseai] Grok 再確認プローブ失敗（生文・端末のみ）: " + String(parsed.error || r.err || "").slice(0, 500));
      logEvent("cli", "Grok の再確認プローブが失敗: " + cls.detail, "warn");
      message = cls.detail;
    }
  }
  g.authed = ok;
  g.authCheckedTs = Date.now();
  g.lastError = ok ? "" : message; // available へ戻すときは旧エラーを残さない（契約 §4・codex レビュー）
  touch();
  return ok;
}

// runner テーブル: 通常応答・レビュー・修正の起動オプションをエージェントごとに集約（agent === "claude" 型の分岐を置換）
// isolation は強制層（OS）へ渡す指定。CLI 側の規則（extraArgs・writeDir）と二重に掛ける — 片方が抜けても
// もう片方が残るように、どちらかへ寄せない（合意メモ-隔離方式 §C）
const RUNNERS = {
  claude: {
    call: callClaude,
    threadOpts: (topic, ta, project) => ({ extraArgs: claudeToolArgs(project), isolation: isolationFor("claude", "thread", topic.id, project) }),
    reviewOpts: (project, topicId) => ({ ...(project ? { extraArgs: ["--add-dir", project.path] } : {}), isolation: isolationFor("claude", "review", topicId, project) }),
    fixOpts: (project, topicId) => ({ extraArgs: claudeToolArgs(project), isolation: isolationFor("claude", "fix", topicId, project) }),
  },
  codex: {
    call: callCodex,
    threadOpts: (topic, ta, project) => ({ writeDir: ensureTopicDir(topic.id), resumeWritable: !!ta.codexPoolCwd, isolation: isolationFor("codex", "thread", topic.id, project) }),
    reviewOpts: (project, topicId) => ({ isolation: isolationFor("codex", "review", topicId, project) }),
    fixOpts: (project, topicId) => ({ writeDir: POOL_DIR, isolation: isolationFor("codex", "fix", topicId, project) }),
  },
  grok: {
    call: callGrok,
    threadOpts: (topic, ta, project) => ({ extraArgs: GROK_WRITE_ARGS, isolation: isolationFor("grok", "thread", topic.id, project) }),
    reviewOpts: (project, topicId) => ({ extraArgs: GROK_READ_ARGS, isolation: isolationFor("grok", "review", topicId, project) }),
    fixOpts: (project, topicId) => ({ extraArgs: GROK_WRITE_ARGS, isolation: isolationFor("grok", "fix", topicId, project) }),
  },
};

// ---- 共有タスクプール: 相互レビュー ----
// レビューはスレッドとは独立した使い捨てセッションで実行する
// （スレッド文脈を汚さず、進行中の会話と並列でも衝突しない）

const POOL_STATUSES = ["submitted", "reviewing", "approved", "rejected"];

const TEXT_EXTS = new Set([".md", ".txt", ".log", ".json", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".rs", ".html", ".css", ".csv", ".yaml", ".yml", ".toml", ".sh", ".diff", ".patch"]);
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp" };
const MEDIA_MIME = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

// プール内相対パス（サブフォルダ可）を検証して絶対パスへ。".." や絶対パスは拒否
function poolFilePath(name) {
  const clean = path.normalize(String(name || "")).replace(/^[/\\]+/, "");
  if (!clean || clean.split(path.sep).some((s) => s === ".." || s.startsWith("."))) return null;
  const resolved = path.join(POOL_DIR, clean);
  return resolved.startsWith(POOL_DIR + path.sep) ? resolved : null;
}

// フォルダ名・ファイル名の1セグメントを安全化
function sanitizeSegment(s) {
  return String(s || "").replace(/[^\w\-.぀-ヿ一-鿿（）()]+/g, "_").replace(/^\.+/, "").slice(0, 80);
}

// タイトル/ファイル名から安全な一意のプール内相対パスを作る（dir はプール内相対フォルダ）
function uniquePoolName(base, dir = "") {
  const ext = path.extname(base) || ".md";
  const stem = sanitizeSegment(path.basename(base, path.extname(base))).slice(0, 60) || "item";
  const prefix = dir ? dir.replace(/\/+$/, "") + "/" : "";
  let name = prefix + stem + ext;
  let n = 2;
  while (fs.existsSync(path.join(POOL_DIR, name))) name = `${prefix}${stem}-${n++}${ext}`;
  return name;
}

// パス topics/<id>/… から所属トピックを導出（登録時の初期値。以後 file を動かしても topicId は不変）
function topicIdFromPath(rel) {
  const m = /^topics\/([0-9a-f]{16})\//.exec(rel || "");
  return m && findTopic(m[1]) ? m[1] : null;
}

function statPoolFile(name) {
  try {
    const file = poolFilePath(name);
    if (!file) return null;
    const st = fs.statSync(file);
    return { size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

function isTextPoolFile(name) {
  return TEXT_EXTS.has(path.extname(name).toLowerCase());
}

// レビュー本文の先頭 8000 文字だけを添え、全文の参照先（リポジトリ相対パス）を示す
const REVIEW_TEXT_MAX_CHARS = 8000;
function clipReviewText(full, fullRefPath) {
  return full.length > REVIEW_TEXT_MAX_CHARS
    ? full.slice(0, REVIEW_TEXT_MAX_CHARS) + `\n…（先頭${REVIEW_TEXT_MAX_CHARS}文字のみ。全文は ${fullRefPath} を参照）`
    : full;
}

// レビュー用にファイル内容を読む（テキストのみ・先頭8000文字）。履歴対象外のアイテム用（対象なら保存版の本文を使う）
function readPoolTextForReview(item) {
  if (!item.file) return item.body || null; // 旧形式フォールバック
  if (!isTextPoolFile(item.file)) return null;
  try {
    const full = fs.readFileSync(poolFilePath(item.file), "utf8");
    if (full.includes("\0")) return null;
    return clipReviewText(full, `u2a2a/pool/${item.file}`);
  } catch {
    return null;
  }
}

// ---- 成果物バージョン履歴（仕様: SPEC-成果物バージョン履歴.md）----
// 実体は pool/.versions/<itemId>/{manifest.json, v<n>.<ext>}。manifest が正本、item.versions は参照用コピー。
// 対象は UTF-8 テキスト・256 KiB 以下。版が切られるのは修正前後とレビュー開始時のみ（外部変更は stale 検知だけ）

const REVIEW_DIFF_MAX_BYTES = 12_000; // レビュープロンプトに添える差分の上限（本文の 8000 文字制限と同程度）

const versionsDir = (itemId) => path.join(POOL_VERSIONS, String(itemId));

// manifest を読む。無ければ null。壊れていれば throw（黙って新規扱いにして既存の版ファイルを上書きしない）
function readManifest(itemId) {
  const file = path.join(versionsDir(itemId), "manifest.json");
  if (!fs.existsSync(file)) return null;
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!m || !Array.isArray(m.versions)) throw new Error("manifest.json の形式が不正です");
  // 監査4巡目【高】: manifest の内容は信頼しない。itemId と各版のファイル名・形式を検証し、
  // 版ディレクトリ外への読み書き（パストラバーサル）を入口で遮断する
  if (m.itemId !== undefined && String(m.itemId) !== String(itemId))
    throw new Error(`manifest.json の itemId が一致しません（${m.itemId}）`);
  for (const v of m.versions) {
    if (!v || !Number.isInteger(v.n) || v.n < 1 || !safeVersionFileName(v.file) || !/^[0-9a-f]{64}$/.test(v.sha256 || ""))
      throw new Error(`manifest.json の版エントリが不正です（n=${v && v.n}, file=${String(v && v.file).slice(0, 40)}）`);
  }
  return m;
}

// 版ファイルの絶対パス。ファイル名検証・ディレクトリ封じ込め・シンボリックリンク拒否を通す
function versionAbsPath(itemId, version) {
  if (!safeVersionFileName(version.file)) throw new Error(`版ファイル名が不正です: ${String(version.file).slice(0, 40)}`);
  const dir = versionsDir(itemId);
  const abs = path.join(dir, version.file);
  if (!abs.startsWith(dir + path.sep)) throw new Error("版ファイルのパスが版ディレクトリ外を指しています");
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) throw new Error(`版ファイル ${version.file} がシンボリックリンクです（拒否）`);
  } catch (e) {
    if (!isMissingError(e)) throw e;
  }
  return abs;
}

// 「ファイルが無い」系のエラーか。EIO / EACCES 等の読み取り障害と区別する
const isMissingError = (e) => e && (e.code === "ENOENT" || e.code === "ENOTDIR");

// tmp に書いて rename（途中で落ちても中途半端なファイルを正本の名前で残さない）。上書きを意図する manifest・復旧用
function writeFileAtomic(file, data) {
  fs.writeFileSync(file + ".tmp", data);
  fs.renameSync(file + ".tmp", file);
}

// 新しい版ファイル用: 同名のファイルが既にあれば上書きせず失敗する（link は既存を置き換えない）。
// manifest と版ファイルが食い違った状態で版を切り直しても、保存済みの本文を潰さないための書き込み側の防護
function writeFileExclusive(file, data) {
  fs.writeFileSync(file + ".tmp", data);
  try {
    fs.linkSync(file + ".tmp", file);
  } catch (e) {
    if (e && e.code === "EEXIST") throw new Error(`版ファイル ${path.basename(file)} が既に存在します（manifest と版ファイルの食い違い。上書きせず中止）`);
    throw e;
  } finally {
    fs.rmSync(file + ".tmp", { force: true });
  }
}

function writeManifest(itemId, manifest) {
  const dir = versionsDir(itemId);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
}

// 版ディレクトリに残っている版ファイル名（manifest が無いときに「新規履歴か索引欠損か」を見分けるのに使う）
function listVersionFiles(itemId) {
  try {
    return fs.readdirSync(versionsDir(itemId)).filter((f) => /^v\d+\./.test(f));
  } catch (e) {
    if (isMissingError(e)) return [];
    throw e;
  }
}

// 版を切るときに使う manifest。無ければ新規履歴として空の manifest を返す — ただし版ファイルや item.versions
// （索引の写し）が残っているなら「新規」ではなく「索引欠損」なので throw する（呼び出し側は保存失敗として中止）。
// 初版として書き直すと既存の v1 を新しい本文で上書きし、保存済みの内容が消えるため。
// 復旧は manifest.json の復元（.bak 等）か、.versions/<itemId>/ ごと退避したうえで item.versions を空にすること
function manifestForAppend(item) {
  const m = readManifest(item.id);
  if (m) return m;
  const files = listVersionFiles(item.id);
  const refs = (item.versions || []).length;
  if (files.length || refs) {
    throw new Error(
      `manifest.json が無いのに履歴が残っています（版ファイル ${files.length} 件／索引の写し ${refs} 件）。` +
        `初版として書き直すと既存の版を上書きするため中止。manifest.json を復元するか .versions/${item.id}/ を退避してください`,
    );
  }
  return { itemId: item.id, file: item.file, versions: [] };
}

// 版ファイルのプール内相対パス（レビュープロンプトの全文参照先に使う）
const versionRelPath = (itemId, version) => `.versions/${itemId}/${version.file}`;

// 版ファイルを読み、内容の sha256 が manifest と一致することを確認する（不一致は code: "EINTEGRITY" で throw）。
// 差分・レビュー添付に使う旧版は必ずここを通す（破損した旧版を「前版と同一内容」等の正常な差分として見せない）
function readVersionVerified(itemId, version) {
  const buf = fs.readFileSync(versionAbsPath(itemId, version));
  if (sha256Hex(buf) !== version.sha256) {
    const e = new Error(`版ファイル ${version.file} の内容が manifest の sha256 と一致しません（破損の疑い）`);
    e.code = "EINTEGRITY";
    throw e;
  }
  return buf;
}

function readVersionText(manifest, version) {
  return readVersionVerified(manifest.itemId, version).toString("utf8");
}

// 版ファイルの実体が manifest と一致するか（無い→false／内容の sha256 が違う→false／読み取り障害→throw）
function versionFileIntact(itemId, version) {
  try {
    readVersionVerified(itemId, version);
    return true;
  } catch (e) {
    if (isMissingError(e) || e.code === "EINTEGRITY") return false;
    throw e;
  }
}

// 現在の実ファイルを履歴用に読む。{ buf, unsupported } — unsupported: null | "no-file" | "too-large" | "binary"
// 不存在だけを "no-file"（対象外）にし、EIO / EACCES 等の読み取り障害は throw する。
// 対象外は「保存をスキップして続行」だが、障害は「保存失敗（修正中止）」として扱う必要があるため混同しない
function readForHistory(item) {
  const abs = item.file ? poolFilePath(item.file) : null;
  if (!abs) return { buf: null, unsupported: "no-file" };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { buf: null, unsupported: "no-file" };
    if (st.size > HISTORY_MAX_BYTES) return { buf: null, unsupported: "too-large" };
    const buf = fs.readFileSync(abs);
    return { buf, unsupported: historyEligibility(buf) };
  } catch (e) {
    if (isMissingError(e)) return { buf: null, unsupported: "no-file" };
    throw e;
  }
}

// 現在の実ファイルの sha256（不存在・読み取り障害なら null）。レビューの stale 判定用（null は対象版と一致しない＝stale）
function currentSha(item) {
  try {
    const { buf } = readForHistory(item);
    return buf ? sha256Hex(buf) : null;
  } catch {
    return null;
  }
}

// 版を切る。戻り値: { version, created, sha256, buf }／対象外: { unsupported }／読み取り障害・保存失敗: throw
// 直前の版と同じ内容なら新たに切らず既存の版を返す（無変更の修正で版が増えない）。
// 既存の版を再利用するときは版ファイルの実体（存在・sha256）を検証し、欠落・不整合なら今読んだ内容から復旧する
// （manifest の sha256 と一致する内容が手元にあるので復旧できる。復旧も失敗すれば throw → 呼び出し側が保存失敗として扱う）。
// 新しい版は既存ファイルを上書きしない書き込み（writeFileExclusive）で切り、manifest 欠損時は履歴の残骸があれば中止する
function snapshotVersion(item, { reason, runId = null, agent = null, partial = false }) {
  const { buf, unsupported } = readForHistory(item);
  if (unsupported) {
    item.versionsUnsupported = unsupported;
    return { unsupported };
  }
  const sha256 = sha256Hex(buf);
  const base = manifestForAppend(item);
  base.file = item.file; // 版ファイルの拡張子は追加時点の所在から決める
  const { manifest, version, created } = appendVersion(base, { sha256, size: buf.length, ts: Date.now(), reason, runId, agent, partial });
  const dir = versionsDir(item.id);
  if (created) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      writeFileExclusive(versionAbsPath(item.id, version), buf);
    } catch (e) {
      // 監査4巡目【中】: 「版ファイル保存成功 → manifest 保存失敗 → 再試行」の残骸なら、
      // 内容一致（sha256）を確認したうえで既存ファイルを採用して復旧する。不一致なら従来どおり中止
      if (!/既に存在します/.test(e.message || "")) throw e;
      if (!versionFileIntact(item.id, version))
        throw new Error(`版ファイル ${version.file} が既存かつ内容不一致のため中止（.versions/${item.id}/ の手動確認が必要）`);
      logEvent("versions", `既存の版ファイル ${version.file} を採用（前回の索引保存失敗からの復旧）（${item.file}）`, "warn");
    }
    writeManifest(item.id, manifest);
  } else if (!versionFileIntact(item.id, version)) {
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(versionAbsPath(item.id, version), buf);
    if (!versionFileIntact(item.id, version)) throw new Error(`版ファイル ${version.file} を復旧できません`);
    logEvent("versions", `版ファイル ${version.file} が欠落／不整合だったため現在の内容から復旧（${item.file}）`, "warn");
  }
  item.versions = manifest.versions;
  item.versionsUnsupported = null;
  return { version, created, sha256, buf };
}

// 起動時に manifest（正本）から item.versions を復元する（再起動後の履歴保持）
function syncVersionsFromManifests() {
  for (const item of state.pool) {
    try {
      const m = readManifest(item.id);
      if (m) item.versions = m.versions;
    } catch (e) {
      logEvent("versions", `履歴 manifest の読み込みに失敗（${item.file}）: ` + (e.message || e), "warn");
    }
  }
}

// レビュープロンプト用の履歴情報: 対象版の本文（保存したスナップショットそのもの）・前版・前版からの差分・前回までの判定
// snap は snapshotVersion の戻り値。本文は snap.buf（保存した版と同一のバイト列）を使い、実ファイルは再読込しない
// （レビュー中の外部編集で「記録は v1・読んだのは v2」になるのを防ぐ）。差分の取得失敗は diffError として区別する
function buildReviewHistory(item, snap) {
  const { version, buf } = snap;
  const text = buf.toString("utf8");
  const snapshotFile = versionRelPath(item.id, version);
  let manifest = null, prev = null, diff = "", truncated = false, diffError = null;
  try {
    manifest = readManifest(item.id);
    const pair = manifest ? resolveVersionPair(manifest, null, version.id) : null;
    prev = pair ? pair.from : null;
    if (prev) {
      const full = unifiedDiff(readVersionText(manifest, prev), text, { fromLabel: "v" + prev.n, toLabel: "v" + version.n });
      ({ text: diff, truncated } = truncateUtf8(full, REVIEW_DIFF_MAX_BYTES));
    }
  } catch (e) {
    diffError = String(e.message || e).slice(0, 200);
    logEvent("versions", `前版との差分生成に失敗（${item.file}）: ` + (e.message || e), "warn");
  }
  const verdicts = (item.reviews || [])
    .filter((r) => !r.error)
    .map((r) => {
      const v = (item.versions || []).find((x) => x.id === r.versionId);
      return NAMES[r.reviewer] + ": " + (r.verdict || "判定なし") + (v ? "（v" + v.n + "）" : "");
    })
    .join("／");
  return { version, text, snapshotFile, prev, diff, truncated, diffError, verdicts };
}

// レビュー記録に付ける版情報。終了時点の実ファイルが対象版と違えば stale
function reviewVersionFields(item, history) {
  if (!history) return { versionId: null, sha256: null, stale: false };
  return { versionId: history.version.id, sha256: history.version.sha256, stale: currentSha(item) !== history.version.sha256 };
}

// 旧形式（body 内蔵）のアイテムをファイル実体へ移行する
function migratePoolItems() {
  for (const item of state.pool) {
    if (item.file || typeof item.body !== "string") continue;
    try {
      const name = uniquePoolName(item.title + ".md");
      fs.writeFileSync(path.join(POOL_DIR, name), item.body);
      item.file = name;
      const st = statPoolFile(name);
      if (st) Object.assign(item, st);
      delete item.body;
    } catch {
      // 移行できなければ body のまま動かす
    }
  }
}

// プール内のフォルダ一覧（相対パス）。スキャンごとに更新し、UI のツリー表示に使う
let poolDirs = [];

// 応答本文のパス宣言に基づく確定登録（合意事項C: 帰属の一次経路。規約に基づく宣言の読み取り）
// 成果物のレビュー依頼先: 指定があればそれ（参加者内・作者以外）、無ければ既定（作者以外の参加者。ユーザー作者は全員）
function participantsOfTopic(topicId) {
  const t = topicId ? findTopic(topicId) : null;
  return t ? t.participants || LEGACY_AGENTS : LEGACY_AGENTS;
}
function reviewersFor(topicId, origin, requested) {
  const parts = participantsOfTopic(topicId);
  if (Array.isArray(requested)) {
    const bad = requested.find((r) => !parts.includes(r) || r === origin);
    if (bad) return { error: `レビュアー ${bad} は参加者でないか作者本人です` };
    return { reviewers: [...new Set(requested)] };
  }
  return { reviewers: defaultReviewers(parts, origin) };
}

function registerDeclaredArtifacts(text, agent, topicId, msgId) {
  let changed = false;
  for (const rel of extractDeclaredPaths(text)) {
    const abs = poolFilePath(rel);
    let st;
    try {
      st = abs && fs.statSync(abs);
    } catch {
      continue; // 言及だけで実在しないパスは登録しない
    }
    if (!st || !st.isFile()) continue;
    const item = state.pool.find((p) => p.file === rel);
    if (!item) {
      state.pool.push({
        id: id(),
        title: rel,
        file: rel,
        origin: agent,
        via: "declared",
        topicId: topicIdFromPath(rel) || topicId || null,
        projectId: projectIdOfTopic(topicIdFromPath(rel) || topicId || null),
        reviewers: reviewersFor(topicIdFromPath(rel) || topicId || null, agent).reviewers,
        status: "submitted",
        reviews: [],
        fromMessageId: msgId,
        ...statPoolFile(rel),
        ts: Date.now(),
      });
      verifQueueAutoImport(state.pool[state.pool.length - 1]);
      changed = true;
    } else if (item.via === "inferred" || item.via === "unknown" || (item.via === "folder" && item.origin === "user")) {
      // 宣言は推定より強い
      item.origin = agent;
      item.via = "declared";
      if (!item.topicId) item.topicId = topicIdFromPath(rel) || topicId || null;
      if (!item.fromMessageId) item.fromMessageId = msgId;
      changed = true;
    }
  }
  return changed;
}

// フォルダ監視: pool/ 以下（サブフォルダ含む）のファイルを再帰的に自動登録
function scanPoolDir() {
  let changed = false;
  const files = [];
  const dirs = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue; // .trash / 隠しファイルは対象外
      const childRel = rel ? rel + "/" + e.name : e.name;
      if (childRel === "threads") continue; // スレッド履歴ミラーは成果物アイテムにしない（UI が特別扱い）
      if (e.isDirectory()) {
        dirs.push(childRel);
        walk(path.join(dir, e.name), childRel);
      } else if (e.isFile()) {
        files.push(childRel);
      }
    }
  };
  walk(POOL_DIR, "");
  if (JSON.stringify(dirs) !== JSON.stringify(poolDirs)) {
    poolDirs = dirs;
    changed = true;
  }
  const known = new Set(state.pool.map((p) => p.file).filter(Boolean));
  for (const name of files) {
    if (!known.has(name)) {
      const tid = topicIdFromPath(name);
      // 帰属判定（合意事項C）: 候補 run がちょうど1件のときだけ推定。複数なら「作者未確定」。
      // 候補ゼロ（実行なし）は従来どおりユーザーの手動投入とみなす
      const inf = inferAuthor(name, tid, Object.values(runs));
      const origin = inf.origin || (inf.candidates === 0 ? "user" : null);
      state.pool.push({
        id: id(),
        title: name,
        file: name,
        origin,
        via: inf.origin ? "inferred" : inf.candidates === 0 ? "folder" : "unknown",
        topicId: tid,
        projectId: projectIdOfTopic(tid),
        reviewers: reviewersFor(tid, origin).reviewers,
        status: "submitted",
        reviews: [],
        ...statPoolFile(name),
        ts: Date.now(),
      });
      verifQueueAutoImport(state.pool[state.pool.length - 1]);
      changed = true;
    }
  }
  // 既存アイテムのサイズ/更新時刻を追従（外部編集の反映）、消えたファイルに印
  for (const item of state.pool) {
    if (!item.file) continue;
    const st = statPoolFile(item.file);
    if (!st) {
      if (!item.missing) { item.missing = true; changed = true; }
    } else if (item.missing || st.mtime !== item.mtime || st.size !== item.size) {
      item.missing = false;
      Object.assign(item, st);
      changed = true;
    }
  }
  return changed;
}

setInterval(() => {
  try {
    if (scanPoolDir()) touch();
  } catch (e) {
    logEvent("pool", "プールスキャンに失敗: " + (e.message || e), "warn");
  }
}, 20_000);

function verdictFrom(text) {
  const m = text.match(/【判定】\s*(承認|条件付き承認|差し戻し)/);
  return m ? m[1] : "";
}

// 成果物の対象を表す文言（item.projectId があればそのプロジェクト、なければこのアプリのリポジトリ）。
// Git 情報は文章を再解析して取り出さず（名前に「。」があると崩れる）、probe から整形した 1 行を targetLine で別に添える
function targetPhrase(pc) {
  if (!pc || !pc.project) return `アプリのリポジトリ（閲覧のみ可）`;
  return `対象プロジェクト「${pc.project.name}」（${pc.project.path}、閲覧のみ可）`;
}
// 対象プロジェクトの現況 1 行（name・path・branch・HEAD・未コミット数／確認不可）＋改行。未紐付けなら空
function targetLine(pc) {
  return pc && pc.project ? projectPromptLine(pc.project, pc.probe) + "\n" : "";
}

function buildReviewPrompt(item, reviewer, history = null, pc = null, offline = false) {
  const rel = item.file ? `u2a2a/pool/${item.file}` : null;
  const offlineNote = offline ? `\n（オフライン指定: web 検索や外部資料は使わず、リポジトリと成果物の内容だけで判断してください）` : "";
  const origin = NAMES[item.origin] || "作者未確定";
  let contentPart;
  if (history) {
    // 履歴対象: 本文も全文参照先も保存済みスナップショットに固定する（実ファイルはレビュー中に変わり得るため参照させない）
    const snapRel = `u2a2a/pool/${history.snapshotFile}`;
    contentPart =
      `--- 成果物「${item.title}」（持ち込み: ${origin}／ファイル: ${rel}／レビュー対象: v${history.version.n} のスナップショット ${snapRel}） ---\n` +
      clipReviewText(history.text, snapRel) +
      `\n（レビュー対象はこの v${history.version.n} の本文です。全文が必要なら ${snapRel} を読んでください。${rel} は実行中に変更され得るので参照しないこと）`;
  } else {
    const text = readPoolTextForReview(item);
    contentPart =
      text != null
        ? `--- 成果物「${item.title}」（持ち込み: ${origin}${rel ? `／ファイル: ${rel}` : ""}） ---\n${text}`
        : `成果物「${item.title}」（持ち込み: ${origin}）はリポジトリ内のファイル ${rel} にあります。` +
          `内容を読み取ってレビューしてください（読み取れない形式ならその旨を書いてください）。`;
  }
  // 履歴（仕様: 最新版全文は従来どおり。前版との差分と前回判定は補助情報として添える）
  let historyPart = "";
  if (history && history.version) {
    const head = history.prev ? `前版 v${history.prev.n} からの差分` : "初版（前版なし）";
    const body = history.diffError
      ? `（前版との差分を取得できませんでした: ${history.diffError}。差分は使えないので上記の本文全体で判断してください）`
      : history.diff
        ? history.diff + (history.truncated ? "\n…（差分が大きいため先頭のみ）" : "")
        : history.prev
          ? "（前版と同一内容）"
          : "";
    historyPart =
      `\n\n--- 履歴（レビュー対象: v${history.version.n}／${head}） ---\n` +
      body +
      (history.verdicts ? `\n前回までの判定: ${history.verdicts}` : "");
  }
  return (
    `あなたは「Yoseai」の共有タスクプール（u2a2a/pool/ = アプリ専用の成果物置き場）のレビュアー（${NAMES[reviewer]}）です。` +
    `以下の成果物を、${targetPhrase(pc)}の実態と照らして、忖度なく具体的にレビューしてください。\n` +
    targetLine(pc) +
    `- 問題点・リスク・改善案を挙げる\n` +
    `- 既存の実装や他タスク・プール内の他成果物との重複、不要な作業の兆候があれば指摘する\n` +
    `- 良い点は簡潔に認める\n` +
    `- 最後に必ず1行、次の形式で判定を書く: 【判定】承認 / 条件付き承認 / 差し戻し\n\n` +
    contentPart +
    historyPart +
    offlineNote +
    commonRulesBlock("レビュー")
  );
}

async function runReview(itemId, reviewer, ropts = {}) {
  const item = state.pool.find((p) => p.id === itemId);
  if (!item) return;
  if (fixPending[itemId]) return; // 修正実行中は書き込み途中のファイルをレビューしない（API は 409、ここは二重防御）
  if ((reviewPending[itemId] || []).includes(reviewer)) return; // 同一レビュアーの多重起動防止
  // 自動依頼で実行できない相手（未認証・自動応答 OFF）は skipped として記録し、レビュー済みに数えない（手動依頼は API が 400）
  if (reviewer === "grok" && state.agents.grok.authed !== true) {
    item.reviews.push({ id: id(), reviewer, text: "（未実施: Grok が未認証のためスキップ）", verdict: "", skipped: true, reason: "未認証", ts: Date.now() });
    touch();
    return;
  }
  if (ropts.auto && !state.agents[reviewer].auto) {
    item.reviews.push({ id: id(), reviewer, text: "（未実施: 自動応答 OFF のためスキップ）", verdict: "", skipped: true, reason: "自動応答OFF", ts: Date.now() });
    touch();
    return;
  }
  const overBudget = budgetStatus(null); // レビューは回数/時間の全体枠で判定
  if (overBudget) {
    item.reviews.push({ id: id(), reviewer, text: "（上限到達のためスキップ: " + overBudget + "）", verdict: "", error: true, skipped: true, reason: "上限到達", ts: Date.now() });
    touch();
    return;
  }
  (reviewPending[itemId] ||= []).push(reviewer);
  if (item.status === "submitted") item.status = "reviewing";
  touch();
  const actKey = "review:" + itemId + ":" + reviewer;
  const run = startRun("review", reviewer, { itemId });
  actStart(actKey, NAMES[reviewer] + " レビュー", run.runId);
  const finish = () => {
    endRun(run.runId);
    actEnd(actKey);
    reviewPending[itemId] = (reviewPending[itemId] || []).filter((r) => r !== reviewer);
    if (!reviewPending[itemId].length) delete reviewPending[itemId];
    touch();
  };
  // 成果物に記録された対象プロジェクトを確認（開いているトピックからは推測しない）
  const pc = await projectContext(item.projectId);
  if (pc.blockReason) {
    item.reviews.push({
      id: id(),
      reviewer,
      text: "（レビュー中止: " + pc.blockReason + "）",
      verdict: "",
      error: true,
      projectError: pc.blockReason,
      ts: Date.now(),
      ...reviewVersionFields(item, null),
    });
    logEvent("project", pc.blockReason, "warn");
    noteOutcome(itemOutcomeTopic(item), reviewer, { type: "failed", kind: "review", reason: "project-blocked", runId: run.runId, itemId, detail: pc.blockReason });
    finish();
    return;
  }
  // レビュー対象の版を保存し、何を見て判定したかを記録する。プロンプトの本文はこの保存版（同一バイト列）から作る。
  // 履歴対象のファイルで保存に失敗したら（読み取り障害・manifest 破損／索引欠損・版ファイル復旧不能）レビューは中止し、
  // error 付きの記録に historyError を残す（修正の「前版が保存できなければ実行しない」と同じ扱い。
  // 続行すると「どの版を見た判定か」も「レビュー中の変更検知」も保証できず、通常の判定と区別が付かなくなる）。
  // 対象外（binary／too-large／no-file）はこれまでどおり versionId: null で実ファイルからレビューする
  let history = null;
  try {
    const snap = snapshotVersion(item, { reason: "review", runId: run.runId, agent: reviewer });
    if (!snap.unsupported) history = buildReviewHistory(item, snap);
  } catch (e) {
    const historyError = "レビュー対象版を保存できません: " + String(e.message || e).slice(0, 200);
    item.reviews.push({
      id: id(),
      reviewer,
      text: "（レビュー中止: " + historyError + "。履歴の保存先を直してから再レビューしてください）",
      verdict: "",
      error: true,
      historyError,
      ts: Date.now(),
      ...reviewVersionFields(item, null),
    });
    logEvent("versions", `レビュー対象版の保存に失敗（${item.file}）: ` + (e.message || e));
    noteOutcome(itemOutcomeTopic(item), reviewer, { type: "failed", kind: "review", reason: "history", runId: run.runId, itemId, detail: historyError });
    finish();
    return;
  }
  try {
    const runner = RUNNERS[reviewer];
    // 読み取りのみのオプション（claude: --add-dir、codex: read-only、grok: --sandbox read-only）。offline は検索を使わない指示
    const callOpts = { ...runner.reviewOpts(pc.project, itemOutcomeTopic(item)), offline: !!ropts.offline };
    const { text, meta } = await runner.call(buildReviewPrompt(item, reviewer, history, pc, !!ropts.offline), null, state.agents[reviewer].modelOverride, (s) => actStep(actKey, s), callOpts);
    // 権限要求・中断で止まった応答（meta.status === "stopped"）は本文・費用を残すが、判定は抽出しない（途中の文言を判定として扱わない）
    const stopped = !!(meta && meta.status === "stopped");
    item.reviews.push({ id: id(), reviewer, text, verdict: stopped ? "" : verdictFrom(text), meta, ts: Date.now(), ...(stopped ? { stopped: true } : {}), ...reviewVersionFields(item, history) });
    noteOutcome(itemOutcomeTopic(item), reviewer, stopped ? { type: "stopped", kind: "review", runId: run.runId, itemId } : { type: "completed", kind: "review" });
    if (!stopped) noteRunSuccess(itemOutcomeTopic(item), reviewer);
  } catch (e) {
    item.reviews.push({
      id: id(),
      reviewer,
      text: "（レビュー失敗: " + String(e.message || e).slice(0, 300) + "）",
      verdict: "",
      error: true,
      meta: e.meta || null,
      ts: Date.now(),
      ...reviewVersionFields(item, history),
    });
    const cls = e.cancelled ? null : noteRunFailure(itemOutcomeTopic(item), reviewer, e, "レビュー"); // キャンセルは対象外（契約 §2）
    noteOutcome(
      itemOutcomeTopic(item),
      reviewer,
      e.cancelled
        ? { type: "stopped", kind: "review", reason: "cancelled", runId: run.runId, itemId } // キャンセルは失敗として表示しない（合意§3）
        : { type: "failed", kind: "review", reason: "error", runId: run.runId, itemId, detail: cls.detail } // 生文を outcome に残さない（指摘#1）
    );
  } finally {
    finish();
  }
}

// ---- レビュー後の修正: 担当エージェントがプールフォルダ限定の書き込み権限でファイルを直す ----

function buildFixPrompt(item, agent, pc = null, offline = false) {
  // 未実施（skipped）のレビューは本文がないので渡さない。中断したレビューは途中までの内容として明示する
  const reviews = (item.reviews || [])
    .filter((r) => !r.error && !r.skipped)
    .map((r) => `--- ${NAMES[r.reviewer]} のレビュー（判定: ${r.verdict || "なし"}${r.stopped ? "・途中で中断" : ""}） ---\n${r.text}`)
    .join("\n\n");
  const offlineNote = offline ? `\n（オフライン指定: web 検索や外部資料は使わず、リポジトリと成果物の内容だけで修正してください）` : "";
  // Claude は cwd=リポジトリルート（書き込み規則 Edit(u2a2a/pool/**) が効く配置）、Codex は cwd=pool
  const fileRef = agent !== "codex" ? `u2a2a/pool/${item.file}（リポジトリルートからの相対パス）` : `${item.file}（カレントディレクトリ＝ u2a2a/pool）`;
  return (
    `あなたは Yoseai の共有タスクプールの成果物を修正する担当（${NAMES[agent]}）です。` +
    `成果物ファイル ${fileRef} を、以下のレビューを踏まえて修正し、` +
    `**同じファイル名で上書き保存**してください。新しいファイルは作らないこと。` +
    `照合先は${targetPhrase(pc)}。\n` +
    targetLine(pc) +
    `- 妥当な指摘には対応する\n` +
    `- 誤っている・過剰な指摘には従わず、応答で理由を述べる\n` +
    `- ファイル保存を済ませてから、応答として「何をどう直したか／直さなかったか」の要約を簡潔に書く\n\n` +
    (reviews || "（レビューはまだありません。成果物の品質を自己点検して改善してください）") +
    offlineNote +
    (agent === "grok"
      ? `\n（Grok への注意: シェルは python3 / ffmpeg のみ・必ず 1 行で（複数行や git 等は権限拒否で修正全体が停止）。確認は read_file / list_dir / grep ツールで）`
      : "") +
    commonRulesBlock("修正")
  );
}

async function runFix(itemId, agent, fopts = {}) {
  const item = state.pool.find((p) => p.id === itemId);
  if (!item || !item.file || fixPending[itemId] || reviewPending[itemId]) return; // レビュー中の修正は API が 409。ここは二重防御
  const overBudget = budgetStatus(null);
  if (overBudget) {
    item.fixes = item.fixes || [];
    item.fixes.push({ id: id(), agent, text: "（上限到達のためスキップ: " + overBudget + "）", error: true, skipped: true, ts: Date.now() });
    touch();
    return;
  }
  fixPending[itemId] = agent;
  const actKey = "fix:" + itemId;
  const run = startRun("fix", agent, { itemId });
  actStart(actKey, NAMES[agent] + " 修正", run.runId);
  item.fixes = item.fixes || [];
  const fix = { id: id(), agent, ts: Date.now() };
  const finish = () => {
    endRun(run.runId);
    actEnd(actKey);
    delete fixPending[itemId];
    touch();
  };
  // 成果物に記録された対象プロジェクトを確認（missing / unreadable / unregistered なら修正しない）
  const pc = await projectContext(item.projectId);
  if (pc.blockReason) {
    fix.projectError = pc.blockReason;
    fix.text = "（修正中止: " + pc.blockReason + "）";
    fix.error = true;
    item.fixes.push(fix);
    logEvent("project", pc.blockReason, "warn");
    noteOutcome(itemOutcomeTopic(item), agent, { type: "failed", kind: "fix", reason: "project-blocked", runId: run.runId, itemId, detail: pc.blockReason });
    finish();
    return;
  }
  // 修正前の版を保存（仕様: 保存失敗は修正を中止。履歴対象外のファイルは従来どおり .trash へ世代バックアップして続行）
  let tracked = false;
  try {
    const snap = snapshotVersion(item, { reason: "fix-before", runId: run.runId, agent });
    if (snap.unsupported) {
      try {
        fs.copyFileSync(poolFilePath(item.file), path.join(POOL_TRASH, Date.now() + "-prefix-" + item.file.replaceAll("/", "__")));
      } catch {
        // 対象外ファイルのバックアップ失敗は従来どおり続行
      }
    } else {
      tracked = true;
      fix.beforeVersionId = snap.version.id;
    }
  } catch (e) {
    fix.historyError = "修正前の版を保存できません: " + String(e.message || e).slice(0, 200);
    fix.text = "（修正中止: " + fix.historyError + "）";
    fix.error = true;
    item.fixes.push(fix);
    logEvent("versions", `修正前の版の保存に失敗（${item.file}）: ` + (e.message || e));
    noteOutcome(itemOutcomeTopic(item), agent, { type: "failed", kind: "fix", reason: "history", runId: run.runId, itemId, detail: fix.historyError });
    finish();
    return;
  }
  let cliOk = false;
  try {
    const prompt = buildFixPrompt(item, agent, pc, !!fopts.offline);
    const onStep = (s) => actStep(actKey, s);
    const override = state.agents[agent].modelOverride;
    // Claude: acceptEdits は --add-dir 先の編集まで自動承認するため使わない。通常応答と同じ
    // cwd=リポジトリルート＋ Edit(u2a2a/pool/**) 規則（工程 0 で読み取り可・外部への書き込み拒否を実測済み）
    const runner = RUNNERS[agent];
    const { text, meta } = await runner.call(prompt, null, override, onStep, { ...runner.fixOpts(pc.project, itemOutcomeTopic(item)), offline: !!fopts.offline });
    const stopped = !!(meta && meta.status === "stopped");
    Object.assign(fix, { text, meta }, stopped ? { stopped: true } : {});
    const st = statPoolFile(item.file); // 中断でもファイルは途中まで書かれ得るので stat は更新する
    if (st) Object.assign(item, st);
    if (stopped) {
      // 権限要求・中断で止まった修正は正常完了として扱わない: 本文・費用は残し、修正後の版は partial で保存し、
      // 状態は動かさず自動再レビューも起動しない（ユーザーが内容を確認して再修正・手動レビューを選ぶ）
      logEvent("cli", `${NAMES[agent]} の修正が途中で停止しました（${item.file}）: ` + GROK_STOP_NOTE, "warn");
    } else {
      cliOk = true;
      item.status = "submitted";
      noteRunSuccess(itemOutcomeTopic(item), agent);
    }
  } catch (e) {
    Object.assign(fix, { text: "（修正失敗: " + String(e.message || e).slice(0, 300) + "）", error: true, cancelled: !!e.cancelled, meta: fix.meta || e.meta || null });
    if (!e.cancelled) fix.publicDetail = noteRunFailure(itemOutcomeTopic(item), agent, e, "修正").detail; // キャンセルは対象外（契約 §2）
  }
  // 修正後の版を成否問わず保存（失敗・中断時は partial）→ ロック解除 → 正常完了かつ履歴保存に成功したときだけ自動再レビュー
  let historyOk = true;
  if (tracked) {
    try {
      const snap = snapshotVersion(item, { reason: "fix-after", runId: run.runId, agent, partial: !cliOk });
      if (snap.unsupported) {
        historyOk = false;
        fix.historyError = "修正後のファイルが履歴対象外になりました: " + snap.unsupported;
      } else {
        fix.afterVersionId = snap.version.id;
      }
    } catch (e) {
      historyOk = false;
      fix.historyError = "修正後の版を保存できません: " + String(e.message || e).slice(0, 200);
      logEvent("versions", `修正後の版の保存に失敗（${item.file}）: ` + (e.message || e));
    }
  }
  item.fixes.push(fix);
  // 結末の優先: 停止 > 失敗 > 修正後の版の保存失敗 > 正常完了（§4.1・§4.4）
  noteOutcome(
    itemOutcomeTopic(item),
    agent,
    fix.stopped || fix.cancelled
      ? { type: "stopped", kind: "fix", ...(fix.cancelled ? { reason: "cancelled" } : {}), runId: run.runId, itemId }
      : fix.error
        ? { type: "failed", kind: "fix", reason: "error", runId: run.runId, itemId, detail: fix.publicDetail || "実行に失敗しました（分類外のエラー。詳細は起動端末のログに出力）" } // 生文を outcome に残さない（指摘#1）
        : !historyOk
          ? { type: "failed", kind: "fix", reason: "history", runId: run.runId, itemId, detail: fix.historyError }
          : { type: "completed", kind: "fix" }
  );
  finish();
  if (cliOk && historyOk) {
    // 実際にレビューした人（修正者以外）が自動で再レビュー。無ければ保存済みの依頼先（旧成果物は既定から導出）
    const done = [...new Set((item.reviews || []).filter((r) => !r.error && !r.skipped).map((r) => r.reviewer))].filter((r) => r !== agent);
    const saved = (item.reviewers || defaultReviewers(participantsOfTopic(item.topicId), item.origin)).filter((r) => r !== agent);
    for (const r of done.length ? done : saved) runReview(item.id, r, { auto: true });
  }
}

// ---- スレッド自動要約 ----
// 節目（12メッセージごと・質疑終了時）に haiku で増分要約し、ミラー冒頭の 📌概要 を更新する
const SUMMARY_EVERY = 12;
const summaryPending = new Set();

// trigger: "auto"（件数閾値）/ "manual"（UI）/ "relay-agreed"（質疑の決着）。
// 起動判定は同期で終える（呼び出し側は promise を待たない）。戻り値は { started, state }。
// 予算・発言なしの見送りは summaryState に理由を残すが、**already-running だけは残さない**:
// checkSummaries は 30 秒ごとに閾値超えのトピックを呼ぶので、走行中の要約は必ずここへ入る。
// 永続化すると「更新中」表示が開始直後に「見送り」で潰れる（仕様: SPEC-要約鮮度.md。応答にだけ返す）
function summarizeTopic(topicId, trigger = "auto") {
  const topic = findTopic(topicId);
  if (!topic) return { started: false, state: null };
  if (summaryPending.has(topicId)) {
    const cur = topic.summaryState || defaultSummaryState();
    return { started: false, state: { ...cur, phase: "skipped", reason: "already-running", detail: "", trigger, ts: Date.now() } };
  }
  // 予算管理下に置く（合意事項B）: 停止中・上限超過なら halt は起こさず見送る（理由は残す）
  if (state.budgetHalt) {
    setSummaryState(topic, { phase: "skipped", reason: "budget-halt", detail: String(state.budgetHalt.reason || state.budgetHalt), trigger });
    return { started: false, state: topic.summaryState };
  }
  const cap = budgetStatus(topicId);
  if (cap) {
    setSummaryState(topic, { phase: "skipped", reason: "budget-cap", detail: String(cap), trigger });
    return { started: false, state: topic.summaryState };
  }
  const msgs = state.messages.filter((m) => m.topicId === topicId);
  if (!msgs.length) {
    setSummaryState(topic, { phase: "skipped", reason: "no-messages", detail: "", trigger });
    return { started: false, state: topic.summaryState };
  }
  summaryPending.add(topicId);
  setSummaryState(topic, { phase: "running", reason: null, detail: "", startedTs: Date.now(), trigger });
  runSummary(topic, msgs, trigger); // 完了・失敗は summaryState（＝SSE）で伝える。呼び出し側は待たない
  return { started: true, state: topic.summaryState };
}

async function runSummary(topic, msgs, trigger) {
  const topicId = topic.id;
  // 要約の出所は開始時点の対象で固定する（await の間に PATCH で対象が変わっても、この要約は開始時点の対象の文脈で作られたもの）
  const originProjectId = topic.projectId || null;
  // 前回の要約が別の対象（分岐元など）で作られたもの、または分岐で引き継いだ会話の出所（carriedProjectId、
  // 再要約でも消えない恒久マーク）が現在の対象と違うなら、要約入力にその旨を明示し、旧対象での合意を区別して残すよう指示する
  const prevOrigin = topic.summaryText ? topic.summaryProjectId || null : null;
  const carriedSummary = !!topic.summaryText && prevOrigin !== originProjectId;
  const inheritedOrigin = topic.carriedProjectId === undefined ? undefined : topic.carriedProjectId || null;
  const carriedConv = inheritedOrigin !== undefined && inheritedOrigin !== originProjectId;
  const carried = carriedSummary || carriedConv;
  const prevLabel = projectLabel(carriedSummary ? prevOrigin : carriedConv ? inheritedOrigin : null);
  const nowLabel = projectLabel(originProjectId);
  const run = startRun("summary", "claude", { topicId });
  let summaryMeta = null, summaryAttempted = false;
  const legacySummaryUsage = !Array.isArray(topic.summaryUsage) && !!(topic.summaryTs || topic.summaryText || topic.summaryCostUsd);
  const actKey = "summary:" + topicId;
  actStart(actKey, "スレッド要約", run.runId);
  try {
    const recent = msgs.filter((m) => !isRelay(m.provenance)).slice(-40); // 引き継ぎは要約対象に含める
    const lines = recent
      .map((m) => `[${NAMES[m.author]}→${NAMES[m.thread]}側] ${m.text.slice(0, 500)}`)
      .join("\n\n");
    const prompt =
      `以下は「Yoseai」のスレッド「${topic.title}」の会話です。` +
      `対象プロジェクトは「${nowLabel}」です。` +
      (topic.summaryText ? `\n\n--- 前回までの要約${carriedSummary ? `（対象「${projectLabel(prevOrigin)}」の時点のもの）` : ""} ---\n${topic.summaryText}\n` : "") +
      (carriedConv ? `\n（この会話には、分岐で引き継いだ対象「${projectLabel(inheritedOrigin)}」の時点の内容が含まれます）\n` : "") +
      `\n--- 会話（直近・抜粋） ---\n${lines}\n\n--- 指示 ---\n` +
      `このスレッドの現況要約を日本語・最大12行で書いてください。` +
      `必ず「## 合意済み」「## 未決」の2見出しで構造化し、生成された成果物（u2a2a/pool/ パス）は合意済み側に含める。` +
      (carried
        ? `前回までの要約と、対象が「${prevLabel}」だった時点の会話で決まった事項を合意済みに残す場合は、` +
          `各項目に「（旧対象「${prevLabel}」での合意）」と明記し、現在の対象「${nowLabel}」で改めて確認した事項と区別する。`
        : "") +
      `前置きなしで要約本文のみを出力。`;
    summaryAttempted = true;
    const { text, meta } = await callClaude(prompt, null, "haiku", (s2) => actStep(actKey, s2), { ctl: run.ctl, isolation: isolationFor("claude", "summary", topicId, null) });
    summaryMeta = meta || null;
    if (meta && meta.billing && meta.billing.mode === "metered") {
      topic.summaryCostUsd = (topic.summaryCostUsd || 0) + meta.billing.usd; // 計上漏れ防止
    }
    // 旧対象の要約を引き継いで更新した場合は、モデルの出力に依らず引き継ぎの注記を先頭に固定で残す
    topic.summaryText = (carried ? `（この要約は対象「${prevLabel}」の時点の内容を引き継ぎ、対象「${nowLabel}」で更新したものです）\n` : "") + text.trim();
    topic.summaryProjectId = originProjectId; // 要約の出所（開始時点の対象。分岐で要約と一緒に引き継ぐ）
    topic.summaryAt = msgs.length;
    topic.summaryTs = Date.now();
    topic.summaryLastMsgId = sortByTsId(msgs).pop().id; // 「どこまでを対象にした要約か」を固定（数える側と同じ並び順）
    setSummaryState(topic, { phase: "idle", reason: null, detail: "", trigger }); // 成功の事実は summaryTs / summaryAt が表す
    touch();
  } catch (e) {
    if (!summaryMeta) summaryMeta = e.meta || null;
    if (e.cancelled) {
      // 明示的な中断は失敗ではない（見送り扱い）
      setSummaryState(topic, { phase: "skipped", reason: "cancelled", detail: "", trigger });
    } else {
      setSummaryState(topic, { phase: "failed", reason: "error", detail: classifyBackendError("claude", e).detail, trigger }); // summaryState も publicState で配信される。生文を載せない（#1 と同型）
      console.error("[yoseai] 要約の失敗（生文・端末のみ）: " + String((e && e.message) || e || "").slice(0, 500));
      logEvent("summary", `スレッド要約の生成に失敗（${topic.title}）: ` + (e.message || e), "warn");
    }
  } finally {
    if (summaryAttempted) {
      if (!Array.isArray(topic.summaryUsage)) topic.summaryUsage = [];
      if (legacySummaryUsage) topic.summaryUsageLegacyUnknown = true;
      topic.summaryUsage.push({ id: run.runId, agent: "claude", ts: Date.now(), trigger, meta: summaryMeta });
      touch();
    }
    endRun(run.runId);
    actEnd(actKey);
    summaryPending.delete(topicId);
  }
}

// 鮮度の一件分（API と SSE 利用側で同じ形を使う）
function summaryStatus(topic) {
  const msgs = state.messages.filter((m) => m.topicId === topic.id);
  const f = summaryFreshness(topic, msgs, SUMMARY_EVERY);
  return {
    topicId: topic.id,
    summaryTs: topic.summaryTs || null,
    summaryAt: topic.summaryAt || 0,
    summaryLastMsgId: topic.summaryLastMsgId || null,
    total: f.total,
    unreflected: f.unreflected,
    threshold: f.threshold,
    due: f.due,
    state: topic.summaryState || defaultSummaryState(),
  };
}

// 自動トリガ（変更なし）。判定は「素の件数 - summaryAt」で、表示用の unreflected（配送コピー除外）とは別物。
// 30 秒ごとに呼ばれるので、走行中のトピックは毎回 already-running で戻る（summaryState は running のまま）
function checkSummaries() {
  for (const t of state.topics) {
    const n = state.messages.filter((m) => m.topicId === t.id).length;
    if (n && n - (t.summaryAt || 0) >= SUMMARY_EVERY) summarizeTopic(t.id, "auto");
  }
}

// 未読: 末尾 MAX_BACKLOG 件を渡し、落とした件数も返す（プロンプトで参照先を示す）。質疑の配送コピーは relayId+seq で重複排除
function unseenInfo(topic, agent) {
  const ta = topic.agents[agent];
  if (!ta) return { msgs: [], dropped: 0 };
  const all = dedupeRelayCopies(
    state.messages.filter((m) => m.topicId === topic.id && m.thread === agent && m.author !== agent && !(m.provenance && m.provenance.ingress === "cli-sync") && m.ts > ta.lastSeenTs)
  );
  return clipBacklog(all, MAX_BACKLOG);
}

function unseenFor(topic, agent) {
  return unseenInfo(topic, agent).msgs;
}

// ---- 外部セッション同期 ----
// デスクトップ版/ターミナルで同じセッションを続けた分を、記録ファイルの増分から取り込む

function transcriptPath(agent, sessionId) {
  if (!sessionId) return null;
  if (agent === "grok") return null; // Grok の transcript の所在は未確認（次フェーズ）
  if (agent === "claude") {
    const proj = REPO_ROOT.replace(/[^a-zA-Z0-9]/g, "-");
    const f = path.join(os.homedir(), ".claude", "projects", proj, sessionId + ".jsonl");
    return fs.existsSync(f) ? f : null;
  }
  const files = fs.globSync(path.join(os.homedir(), ".codex/sessions/**/rollout-*" + sessionId + ".jsonl"));
  return files[0] || null;
}

function textFromBlocks(content, textKey) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  if (content.some((b) => b && b.type === "tool_result")) return ""; // ツール結果はユーザー発言ではない
  return content
    .filter((b) => b && (b.type === "text" || b.type === textKey) && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function extractExternalMessages(agent, chunk) {
  const out = [];
  for (const line of chunk.split("\n")) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    let author = null;
    let text = "";
    if (agent === "claude") {
      if (e.isMeta) continue;
      if (e.type === "user") {
        author = "user";
        text = textFromBlocks(e.message?.content, "text");
      } else if (e.type === "assistant") {
        author = "claude";
        text = textFromBlocks(e.message?.content, "text");
      }
    } else if (e.type === "response_item" && e.payload?.type === "message") {
      if (e.payload.role === "user") {
        author = "user";
        text = textFromBlocks(e.payload.content, "input_text");
      } else if (e.payload.role === "assistant") {
        author = "codex";
        text = textFromBlocks(e.payload.content, "output_text");
      }
    }
    text = (text || "").trim();
    if (!author || !text) continue;
    if (text.startsWith("<")) continue; // 注入されたコンテキストブロック類は除く
    out.push({ author, text });
  }
  return out;
}

// 応答完了直後に呼び、自分の発言分まで読み取り位置を進める
function markTranscriptSynced(topic, agent) {
  const ta = topic.agents[agent];
  const file = transcriptPath(agent, ta.sessionId);
  if (file) {
    try {
      ta.transcriptOffset = fs.statSync(file).size;
    } catch {
      ta.transcriptOffset = null;
    }
  } else {
    ta.transcriptOffset = null;
  }
}

function syncExternal(topic, agent) {
  const a = topic.agents[agent];
  const file = transcriptPath(agent, a.sessionId);
  if (!file) return false;
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return false;
  }
  if (a.transcriptOffset == null || a.transcriptOffset > size) {
    a.transcriptOffset = size; // 初回は履歴の一括取り込みをせず現在位置から
    return false;
  }
  if (size <= a.transcriptOffset) return false;
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(size - a.transcriptOffset);
  fs.readSync(fd, buf, 0, buf.length, a.transcriptOffset);
  fs.closeSync(fd);
  const chunk = buf.toString("utf8");
  const lastNl = chunk.lastIndexOf("\n");
  if (lastNl < 0) return false; // 書き込み途中の行しかない
  a.transcriptOffset += Buffer.byteLength(chunk.slice(0, lastNl + 1), "utf8");
  let added = false;
  for (const m of extractExternalMessages(agent, chunk.slice(0, lastNl + 1))) {
    state.messages.push({
      id: id(),
      topicId: topic.id,
      thread: agent,
      author: m.author,
      text: m.text,
      provenance: { ingress: "cli-sync", delivery: "direct", trigger: "manual", source: null },
      ts: Date.now(),
    });
    if (m.author !== "user") topic.projectLocked = true; // 外部で実行された分も「実行済み」に数える
    added = true;
  }
  return added;
}

// 外部での続きを受動的にも読めるよう定期チェック（全トピック）
setInterval(() => {
  let changed = false;
  for (const topic of state.topics) {
    for (const agent of topic.participants || LEGACY_AGENTS) {
      if (running[runKey(topic.id, agent)]) continue; // 自分の応答書き込み中は増分を読まない
      try {
        if (syncExternal(topic, agent)) changed = true;
      } catch (e) {
        logEvent("sync", `外部セッション同期に失敗（${topic.title}/${agent}）: ` + (e.message || e), "warn");
      }
    }
  }
  if (changed) touch();
  // 時間上限に走行中で到達したら、実行を中断してラッチを立てる（合意事項B）
  if (!state.budgetHalt) {
    const reason = budgetStatus(null);
    if (reason && /実行時間上限/.test(reason) && Object.keys(runs).length) {
      const anyRun = Object.values(runs)[0];
      for (const r of Object.values(runs)) if (r.ctl && r.ctl.cancel) r.ctl.cancel();
      triggerBudgetHalt(anyRun.topicId || state.topics[0].id, anyRun.agent || "claude", reason + "（実行中の処理を中断しました）");
    }
  }
  checkSummaries();
}, 30_000);

async function agentLoop(topicId, agent) {
  const key = runKey(topicId, agent);
  if (running[key]) {
    needsRun[key] = true;
    needsRunGen[key] = (needsRunGen[key] || 0) + 1;
    return;
  }
  running[key] = true;
  {
    // 対象の固定（仕様: 初回起動の準備より前・await より前に立て、失敗・中断・リセット後も下ろさない）
    const t0 = findTopic(topicId);
    if (t0 && !t0.projectLocked) t0.projectLocked = true;
  }
  broadcast();
  try {
    while (true) {
      needsRun[key] = false;
      const topic = findTopic(topicId);
      if (!topic) break;
      if (!(topic.participants || LEGACY_AGENTS).includes(agent)) break; // 参加者でないエージェントは動かない（セッション状態もない）
      const a = state.agents[agent];
      const ta = topic.agents[agent];
      try {
        if (syncExternal(topic, agent)) touch(); // 外部での続きを取り込んでから応答する
      } catch {
        // 同期失敗しても応答は続行
      }
      const { msgs, dropped } = unseenInfo(topic, agent);
      if (!agentAutoOn(agent) || !msgs.length) break;
      // 質疑リレー中は手番の参加者だけが実行する（手番外は未読を残して終了。手番で qaHop が起動する）
      const r0 = topic.relay;
      const relayParts = r0.active ? r0.participants || LEGACY_AGENTS : null;
      if (relayParts && relayParts.includes(agent) && relayParts[r0.turn] !== agent) break;
      // この実行がどのリレーの手番として始まったか（リレー外の応答は null）。CLI 完了後にも照合し、
      // 応答待ちの間に停止・別リレー開始があれば、旧実行の成否が新しいリレーを変更しないようにする
      const relayIdAtStart = relayParts && relayParts.includes(agent) ? r0.id : null;
      const sameRelay = () => topic.relay.active && !!relayIdAtStart && topic.relay.id === relayIdAtStart;
      // 対象プロジェクトの確認（Git 実行を含む、起動前で唯一の await）。
      // missing / unreadable / unregistered なら実行せず理由を残す。unavailable は続行
      const pc = await projectContext(topic.projectId);
      // 確認待ちの間に自動応答 OFF・上限停止・トピック削除が起きていれば起動しない
      if (!agentAutoOn(agent) || findTopic(topicId) !== topic) break;
      // リレー起動は、確認待ちの間にリレーが終了・別リレーになっていたら中止する（通常応答として扱い直さない）。
      // ただし待機中に新しい起動要求（停止→同じ先手で新規開始など）が needsRun に入っていれば、旧起動を捨てた上で
      // 先頭から再評価する（break で終えると新リレーが active のまま誰も走らない）
      const r1 = topic.relay;
      const parts1 = r1.active ? r1.participants || LEGACY_AGENTS : null;
      const relayIdNow = parts1 && parts1.includes(agent) ? r1.id : null;
      if (relayIdNow !== relayIdAtStart || (parts1 && parts1.includes(agent) && parts1[r1.turn] !== agent)) {
        if (needsRun[key]) continue;
        break;
      }
      if (pc.blockReason) {
        if (sameRelay()) stopRelay(topic, "error");
        a.lastError = pc.blockReason;
        ta.lastError = pc.blockReason; // 列は ta のみを読む（契約 §3）。ここだけ書き漏れると理由が列から消える（指摘#2）
        state.messages.push({
          id: id(),
          topicId,
          thread: agent,
          author: agent,
          text: "⛔ " + pc.blockReason + "。登録先を直してから送り直してください",
          blocked: true,
          provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null },
          ts: Date.now(),
        });
        logEvent("project", pc.blockReason, "warn");
        noteOutcome(topicId, agent, { type: "failed", kind: "thread", reason: "project-blocked", detail: pc.blockReason, messageId: state.messages[state.messages.length - 1].id });
        touch();
        break; // 既読位置は進めない（登録先を戻せば同じメッセージから再開できる）
      }
      // 予算判定は確認の後、実行登録（startRun）の直前。ここから startRun までは同期処理だけで await を挟まない
      // （同時送信でも、先に登録された run が走行中件数に数えられ、上限を超えて起動しない）
      const overBudget = budgetStatus(topicId);
      if (overBudget) {
        triggerBudgetHalt(topicId, agent, overBudget);
        break;
      }
      // 紐付けありではアプリのリポジトリ側は走査せず、プール内（このトピックの成果物・共通ルール）の変化と対象の未コミット変更を注記する
      const curSnapshot = takeFileSnapshot(topicId, { poolOnly: !!pc.project });
      const changesNote = fileChangeNote(ta.fileSnapshot, curSnapshot) + (pc.project ? projectChangeNote(pc.probe) : "");
      const projectInfo = pc.project ? { ...pc, digest: !ta.sessionId ? projectDigestFor(pc.project) : "" } : null;
      const prompt = buildPrompt(topic, agent, msgs, !ta.sessionId, changesNote, projectInfo, { dropped });
      const actKey = "thread:" + topicId + ":" + agent;
      const run = startRun("thread", agent, { topicId });
      run.sessionId = ta.sessionId || null;
      // この実行の開始時点の起動要求世代（キャンセル終了処理で、実行中に届いた新要求を消さないため）
      const genAtRunStart = needsRunGen[key] || 0;
      actStart(actKey, NAMES[agent] + " 応答", run.runId);
      try {
        // 起動オプションは runner テーブルから（claude: pool 限定の Edit 規則＋python3/ffmpeg、codex: cwd=pool の workspace-write、grok: allow 規則）
        const runner = RUNNERS[agent];
        const call = runner.call;
        const hadSession = !!ta.sessionId;
        const opts = runner.threadOpts(topic, ta, pc.project);
        opts.ctl = run.ctl;
        opts.onSessionId = (sid) => (run.sessionId = sid); // 早期捕捉（キャンセル時に interrupted として保持）
        const { text, sessionId, model, meta } = await call(prompt, ta.sessionId, a.modelOverride, (s) => actStep(actKey, s), opts);
        ta.sessionId = sessionId;
        if (agent === "codex" && !hadSession) ta.codexPoolCwd = true; // 新方式（cwd=pool）で作られた印
        if (model) a.model = model;
        ta.lastSeenTs = msgs[msgs.length - 1].ts;
        const stopped = !!(meta && meta.status === "stopped");
        // 権限要求または中断で停止した応答は赤字で示す（UI は ta を読む——契約 §3）。
        // 成功時の a.lastError クリアは noteRunSuccess に一元化する: 先にここで消すと、
        // 「席全体の複製を一括クリアする」判定材料（旧 a.lastError）が失われる（指摘#4 の回帰で発覚）
        if (stopped) {
          a.lastError = GROK_STOP_NOTE;
          ta.lastError = GROK_STOP_NOTE;
        } else {
          noteRunSuccess(topicId, agent); // 成功系のみ可用性を戻す（stopped は戻さない——契約 §4）
        }
        // 応答待ちの間にリレーが停止・別リレーになっていたら、この応答は旧リレーの発言。記録はするが中継・議題採用はしない
        const relayLive = sameRelay();
        const stale = !!relayIdAtStart && !relayLive;
        const replyMsg = {
          id: id(),
          topicId,
          thread: agent,
          author: agent,
          text,
          provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null },
          meta,
          ...(stopped ? { stopped: true } : {}),
          ...(stale ? { staleRelayId: relayIdAtStart } : {}),
          ts: Date.now(),
        };
        state.messages.push(replyMsg);
        noteOutcome(topicId, agent, stopped ? { type: "stopped", kind: "thread", runId: run.runId, messageId: replyMsg.id } : { type: "completed", kind: "thread" });
        // 質疑の論点が未定なら、先手の応答冒頭の起案を採用（ユーザーは qa バーで修正可能）。同じリレーの手番の応答に限る
        if (relayLive && !stopped && !topic.relay.agenda) {
          // 「今回決めること: 〜」形式にも「## 今回決めること」見出し＋次行にも対応
          const am = text.match(/今回決めること[:：]?[ \t]*\n*[-*\s]*([^\n]+)/);
          if (am) {
            const clean = am[1].replace(/\*\*/g, "").replace(/^[#\-\s]+/, "").trim();
            if (clean) topic.relay.agenda = clean.slice(0, 120);
          }
        }
        registerDeclaredArtifacts(text, agent, topicId, replyMsg.id); // 宣言に基づく成果物の確定登録
        ta.fileSnapshot = curSnapshot; // 変更通知の基準を今回時点へ進める
        markTranscriptSynced(topic, agent); // 自分の応答分は外部同期の対象外にする
        if (stale) {
          logEvent("qa", `${NAMES[agent]} の応答は停止済みの質疑（${relayIdAtStart}）宛てのため中継しません`, "warn");
        } else if (stopped) {
          // 中断した応答は正常完了ではない: 相手へ中継せず、自分の手番のリレーなら止める（次の手番を空回りさせない）。
          // 停止理由は lib の RELAY_STOP_REASONS / UI の表示名にある "cancelled"（実行を中断）を共用する（独自の理由は増やさない）
          if (relayLive) stopRelay(topic, "cancelled");
        } else if (relayLive) {
          qaHop(topic, agent, text, replyMsg.id);
        }
        // 判断トレイの受付は qaHop の後（契約 §6.1）。ここまで来れば「終了宣言が受理されたか」が確定していて、
        // 合意メモ §2 の「終了が不受理なら同じ応答の着手提案も捨てる」を判定できる。
        // stale（古いリレー宛て）と stopped（権限要求・中断）は本文が途中で切れている可能性があるので受け付けない
        if (!stale && !stopped) trayIntake(topic, agent, text, replyMsg.id);
      } catch (e) {
        // エラー/キャンセルで質疑が空回りしないよう停止（この実行の手番のリレーに限る。別リレーは触らない）
        if (sameRelay()) stopRelay(topic, e.cancelled ? "cancelled" : "error");
        ta.lastSeenTs = msgs[msgs.length - 1].ts; // 同じメッセージで無限リトライしない
        if (e.cancelled) {
          // キャンセル: エラーではなく cancelled として記録し、セッションは interrupted 扱いに
          // （この実行の開始後に新しい起動要求（新リレー開始など）が届いていれば needsRun は残す）
          if ((needsRunGen[key] || 0) === genAtRunStart) needsRun[key] = false;
          const interruptedId = run.sessionId || e.sessionId || ta.sessionId;
          if (interruptedId) {
            ta.interruptedSessionId = interruptedId;
            ta.interruptedPoolCwd = ta.codexPoolCwd;
          }
          ta.sessionId = null; // 次回は新セッション（要約を再注入）。明示操作でのみ resume
          ta.transcriptOffset = null;
          state.messages.push({
            id: id(),
            topicId,
            thread: agent,
            author: agent,
            text: "⏹ 応答をキャンセルしました",
            cancelled: true,
            provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null },
            meta: e.meta || null,
            ts: Date.now(),
          });
        } else {
          const cls = noteRunFailure(topicId, agent, e, "応答"); // ⚠ 行・ta.lastError・可用性・a.lastError を一括（契約 §1〜§4）
          // outcome の detail も定型短文（生文は agentOutcomes → state.json / API へ永続配信されてしまう——指摘#1）
          noteOutcome(topicId, agent, { type: "failed", kind: "thread", reason: "error", runId: run.runId, detail: cls.detail });
        }
      } finally {
        endRun(run.runId);
        actEnd(actKey);
      }
      touch();
      if (!needsRun[key]) break;
    }
  } finally {
    running[key] = false;
    // 実行中は見送っていた継続予約をここで拾う（§10.3。armed でない ＝ 再起動で復元した予約は動かない）
    const t = findTopic(topicId);
    if (t) trayFireContinuation(t);
    touch();
  }
}

function maybeTrigger(messages) {
  for (const m of messages) {
    if (!AGENTS.includes(m.thread) || m.author === m.thread) continue;
    const t = findTopic(m.topicId);
    if (!t || !(t.participants || LEGACY_AGENTS).includes(m.thread)) continue; // 参加者でない宛先は起動しない
    if (agentAutoOn(m.thread)) agentLoop(m.topicId, m.thread);
  }
}

// ---- モデル一覧の収集 ----
// CLI にカタログ取得コマンドがないため、実際に使われた実測値から集める。
// claude: エイリアス＋アプリ内 meta.model。codex: アプリ内 meta.model＋最近の rollout の payload.model
let modelsCache = null;
let modelsCacheTs = 0;

function collectModels() {
  if (modelsCache && Date.now() - modelsCacheTs < 5 * 60 * 1000) return modelsCache;
  // エイリアス＋この環境で指定が通ることを検証済みのモデルをベースラインに
  const claude = new Set(["opus", "sonnet", "haiku", "fable"]);
  const codex = new Set(["gpt-6-astra"]);
  const grok = new Set(["grok-4.6-build"]); // 工程 0 の実測既定モデル
  const harvest = (meta) => {
    if (!meta || !meta.model) return;
    (meta.model.startsWith("claude") ? claude : meta.model.startsWith("grok") ? grok : codex).add(meta.model);
  };
  for (const m of state.messages) harvest(m.meta);
  for (const p of state.pool) {
    for (const r of p.reviews || []) harvest(r.meta);
    for (const f of p.fixes || []) harvest(f.meta);
  }
  try {
    const files = fs
      .globSync(path.join(os.homedir(), ".codex/sessions/**/rollout-*.jsonl"))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 60);
    for (const { f } of files) {
      try {
        for (const line of fs.readFileSync(f, "utf8").split("\n").slice(0, 5)) {
          try {
            const m = JSON.parse(line)?.payload?.model;
            if (typeof m === "string" && m) {
              codex.add(m);
              break;
            }
          } catch {
            // JSON でない行は無視
          }
        }
      } catch {
        // 読めない rollout はスキップ
      }
    }
  } catch (e) {
    logEvent("cli", "codex rollout のモデル走査に失敗: " + (e.message || e), "warn");
  }
  modelsCache = { claude: [...claude], codex: [...codex].sort(), grok: [...grok].sort() };
  modelsCacheTs = Date.now();
  return modelsCache;
}

// 参加者指定の検証: 省略時は「自動応答 ON かつ認証済み」の全員。grok は authed === true のときだけ選べる
function validateParticipants(requested) {
  if (requested === undefined || requested === null) {
    const ready = AGENTS.filter((a) => state.agents[a] && state.agents[a].auto && state.agents[a].authed === true);
    return { participants: ready.length ? ready : LEGACY_AGENTS.slice() };
  }
  if (!Array.isArray(requested) || !requested.length) return { error: "participants は 1 名以上の配列で指定してください" };
  const unknown = requested.find((a) => !AGENTS.includes(a));
  if (unknown) return { error: `不明なエージェント: ${unknown}` };
  if (requested.includes("grok") && state.agents.grok.authed !== true) {
    return { error: state.agents.grok.authed === null ? "Grok の認証を確認中です（「再確認」の後に選べます）" : "Grok が未認証です（grok login の後に「再確認」してください）", reason: "unauthed" };
  }
  return { participants: [...new Set(requested)] };
}

// ---- API ----
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  // 資格検査が有効かどうかだけを返す唯一の public API（修正リスト-確定 P0-3）。
  // 出所検査（403）は通った後。返すのは boolean 1 個だけ——public 面をこれ以上広げない。
  // 取得に失敗した画面側は「off」と解釈してはいけない（起動エラーとして表示する）
  if (req.method === "GET" && url.pathname === "/api/access") {
    return json(res, 200, { credentials: CREDENTIALS_ENABLED });
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    return json(res, 200, publicState());
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // SSE の使い捨て切符（§4.2）。ここへ来られている時点で管理資格は検査済み
  if (req.method === "POST" && url.pathname === "/api/events/ticket") {
    return json(res, 201, ticketStore.issue());
  }

  // 現行資格を捨てて作り直す（§4.4）。端末に新しい URL を出すので、開いている画面は貼り直しが要る
  if (req.method === "POST" && url.pathname === "/api/credentials/revoke") {
    adminCredential = cred.newAdminCredential();
    // 失効は資格だけでなく、その資格で得たアクセスも切る（修正リスト-確定 P2-②）:
    // 発行済みの SSE 切符（最大 10 秒有効）と、開いている SSE 接続を全部落とす
    ticketStore.clear();
    for (const c of [...sseClients]) { try { c.end(); } catch {} sseClients.delete(c); }
    logEvent("security", "管理資格を作り直しました。端末に出た新しい URL で開き直してください", "warn");
    printCredentialBanner();
    return json(res, 200, { ok: true, revokedAt: new Date().toISOString() });
  }

  // §7.3: verified はサーバが自分で立てない。再測定の記録を取り込んだときだけ立つ
  if (req.method === "POST" && url.pathname === "/api/isolation/verification") {
    const body = await readBody(req);
    const r = applyIsolationVerification(body);
    if (!r.ok) return json(res, 400, { error: r.error, code: r.code, missing: r.missing || [], mismatched: r.mismatched || [] });
    touch();
    return json(res, 200, { ok: true, verified: isolation.verified, verifiedAt: isolation.verifiedAt });
  }

  if (req.method === "POST" && url.pathname === "/api/messages") {
    const body = await readBody(req);
    const author = AUTHORS.includes(body.author) ? body.author : null;
    const thread = AGENTS.includes(body.thread) ? body.thread : null;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const topic = findTopic(body.topicId) || state.topics[0];
    if (!author || !text) return json(res, 400, { error: "author と text は必須です" });
    if (!topic) return json(res, 400, { error: "トピックがありません" });
    const parts = topic.participants || LEGACY_AGENTS;
    // 宛先: 参加者のいずれか／"both"（claude＋codex。両方が参加者のときのみ）／"all"（参加者全員）
    let threads = null;
    if (thread) threads = parts.includes(thread) ? [thread] : null;
    else if (body.thread === "both" && author === "user" && LEGACY_AGENTS.every((a) => parts.includes(a))) threads = LEGACY_AGENTS.slice();
    else if (body.thread === "all" && author === "user") threads = parts.slice();
    if (!threads) return json(res, 400, { error: `thread はこのトピックの参加者（${parts.join(" / ")}）/ both / all(userのみ)` });
    // 送信前に全宛先を検証し、一部だけ届く状態を作らない（未認証・確認中の Grok 宛ては理由付きで拒否）
    if (threads.includes("grok") && state.agents.grok.authed !== true) {
      const why = state.agents.grok.authed === null ? "Grok の認証を確認中です（ヘッダの「再確認」で判定できます）" : "Grok が未認証です（grok login の後に「再確認」してください）";
      return json(res, 400, { error: why, reason: "unauthed", agent: "grok" });
    }
    const created = threads.map((t) => ({
      id: id(),
      topicId: topic.id,
      thread: t,
      author,
      text,
      provenance: { ingress: "ui", delivery: "direct", trigger: "manual", source: null },
      test: body.test === true || undefined, // テスト送信印（明示された操作のみ・追加調査へ広げない）
      ts: Date.now(),
    }));
    state.messages.push(...created);
    touch();
    maybeTrigger(created);
    return json(res, 201, created);
  }

  // エージェント状態（仕様: SPEC-アバター状態.md §6）。SSE を待たずに取るための補助
  if (req.method === "GET" && url.pathname === "/api/agent-state") return json(res, 200, agentStateNow());
  if (req.method === "POST" && url.pathname === "/api/agent-state/ack") {
    const body = await readBody(req);
    if (!AGENTS.includes(body.agent)) return json(res, 400, { error: "agent が不正です" });
    if (body.topicId !== null && typeof body.topicId !== "string") return json(res, 400, { error: "topicId は文字列か null です" });
    let store;
    if (body.topicId === null) {
      store = state.unattributedOutcomes ||= {};
    } else {
      const t = findTopic(body.topicId);
      if (!t) return json(res, 404, { error: "topic not found" });
      store = t.agentOutcomes ||= {};
    }
    const cleared = !!store[body.agent];
    delete store[body.agent];
    if (cleared) touch();
    return json(res, 200, { ok: true, cleared });
  }

  // ---- 判断トレイ（契約: 契約-判断トレイAPI.md §9）----
  if (parts[0] === "api" && parts[1] === "tray") {
    if (req.method === "GET" && parts.length === 2) {
      const tid = url.searchParams.get("topicId");
      await trayRefreshAll(tid); // 取得時にも再評価する（§8）
      const view = trayViewNow();
      if (!tid) return json(res, 200, view);
      const slot = view.topics[tid] || { waiting: [], later: [], history: [], pendingSlotTaken: false };
      const ids = new Set([...slot.waiting, ...slot.later, ...slot.history]);
      return json(res, 200, { ...view, topics: { [tid]: slot }, requests: Object.fromEntries(Object.entries(view.requests).filter(([k]) => ids.has(k))) });
    }

    if (req.method === "POST" && parts.length === 4 && ["answer", "approve", "revision", "reject", "park", "unpark"].includes(parts[3])) {
      return trayAction(req, res, parts[2], parts[3]);
    }
    if (req.method === "POST" && parts.length === 5 && parts[3] === "plan" && parts[4] === "retry") {
      return trayAction(req, res, parts[2], "retry");
    }
  }

  // アバター配信（§7）: manifest は再検証、画像は内容ハッシュ付き URL で immutable
  if (req.method === "GET" && url.pathname === "/api/avatars") return serveAvatarManifest(req, res);
  if (req.method === "GET" && url.pathname.startsWith("/api/avatars/")) return serveAvatarImage(req, res, url.pathname);

  // 実行のキャンセル（初版は thread 実行のみ。SIGTERM→3秒→SIGKILL・プロセスグループ停止）
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "runs" && parts[2] && parts[3] === "cancel") {
    const run = runs[parts[2]];
    if (!run) return json(res, 404, { error: "run not found（既に終了しています）" });
    if (run.kind !== "thread" && run.kind !== "summary")
      return json(res, 400, { error: "キャンセルできるのはスレッド応答と要約のみです" });
    const topic = findTopic(run.topicId);
    // 質疑リレーも止める。defaultRelay() での全消去はせず、停止理由・進行記録（id/spoken）を保持する
    if (topic && topic.relay && topic.relay.active) stopRelay(topic, "cancelled");
    needsRun[runKey(run.topicId, run.agent)] = false;
    if (run.ctl.cancel) run.ctl.cancel();
    touch();
    return json(res, 202, { ok: true });
  }

  // 運用イベントログのクリア
  if (req.method === "POST" && url.pathname === "/api/events/clear") {
    events.length = 0;
    touch();
    return json(res, 200, { ok: true });
  }

  // 選択可能なモデル一覧（実測ベース: アプリ内で使われたモデル＋codex は rollout 走査）
  if (req.method === "GET" && url.pathname === "/api/models") {
    return json(res, 200, collectModels());
  }

  // ---- 上限設定 ----
  if (req.method === "PATCH" && url.pathname === "/api/budgets") {
    const body = await readBody(req);
    for (const k of ["topicUsd", "runCount", "runMinutes"]) {
      if (k in body) {
        const v = body[k];
        state.budgets[k] = typeof v === "number" && v > 0 ? v : null;
      }
    }
    // 上限を緩めた/外した場合、停止状態が解消していれば自動では復帰させず、明示解除に委ねる
    touch();
    return json(res, 200, state.budgets);
  }

  if (req.method === "POST" && url.pathname === "/api/budgets/resume") {
    state.budgetHalt = null; // ラッチ解除のみ。ユーザーが OFF にした auto には触れない
    touch();
    return json(res, 200, { ok: true });
  }

  // 手動転送（検証付き）: 元メッセージをサーバー側で複製して相手レーンへ
  if (req.method === "POST" && url.pathname === "/api/relay") {
    const body = await readBody(req);
    const src = state.messages.find((m) => m.id === body.messageId);
    if (!src || !AGENTS.includes(src.thread)) return json(res, 404, { error: "元メッセージが見つかりません" });
    // 宛先は明示（候補が 1 名のときだけ省略可）。送信元・宛先とも参加者であること
    const srcTopic = findTopic(src.topicId);
    const candidates = srcTopic ? peers(srcTopic, src.thread) : [];
    const toAgent = typeof body.toAgent === "string" ? body.toAgent : candidates.length === 1 ? candidates[0] : null;
    if (!toAgent || !candidates.includes(toAgent)) return json(res, 400, { error: `toAgent を指定してください（候補: ${candidates.join(" / ") || "なし"}）` });
    if (toAgent === "grok" && state.agents.grok.authed !== true) return json(res, 400, { error: "Grok が未認証（または確認中）です", reason: "unauthed", agent: "grok" });
    const copy = {
      id: id(),
      topicId: src.topicId,
      thread: toAgent,
      author: src.author,
      text: src.text,
      provenance: {
        ingress: "ui",
        delivery: "relay",
        trigger: "manual",
        source: { topicId: src.topicId, messageId: src.id, agent: src.thread },
      },
      ts: Date.now(),
    };
    state.messages.push(copy);
    touch();
    maybeTrigger([copy]);
    return json(res, 201, copy);
  }

  // 引き継ぎ: 相手エージェントへ作業のバトンを渡す（受け手には引き継ぎ依頼としてプロンプト整形される）
  if (req.method === "POST" && url.pathname === "/api/handoff") {
    const body = await readBody(req);
    const src = state.messages.find((m) => m.id === body.messageId);
    if (!src || !AGENTS.includes(src.thread)) return json(res, 404, { error: "元メッセージが見つかりません" });
    // 宛先は明示（候補が 1 名のときだけ省略可）。送信元・宛先とも参加者であること
    const srcTopic = findTopic(src.topicId);
    const candidates = srcTopic ? peers(srcTopic, src.thread) : [];
    const toAgent = typeof body.toAgent === "string" ? body.toAgent : candidates.length === 1 ? candidates[0] : null;
    if (!toAgent || !candidates.includes(toAgent)) return json(res, 400, { error: `toAgent を指定してください（候補: ${candidates.join(" / ") || "なし"}）` });
    if (toAgent === "grok" && state.agents.grok.authed !== true) return json(res, 400, { error: "Grok が未認証（または確認中）です", reason: "unauthed", agent: "grok" });
    const copy = {
      id: id(),
      topicId: src.topicId,
      thread: toAgent,
      author: src.author,
      text: src.text,
      provenance: {
        ingress: "ui",
        delivery: "handoff",
        trigger: "manual",
        source: { topicId: src.topicId, messageId: src.id, agent: src.thread },
      },
      ts: Date.now(),
    };
    state.messages.push(copy);
    touch();
    maybeTrigger([copy]);
    return json(res, 201, copy);
  }

  // ---- トピック（スレッド）管理 ----
  // ---- ローカルプロジェクト登録（仕様: SPEC-プロジェクト紐付け.md） ----
  if (req.method === "GET" && url.pathname === "/api/projects") {
    return json(res, 200, { projects: state.projects });
  }
  if (req.method === "POST" && url.pathname === "/api/projects") {
    const body = await readBody(req);
    const v = validateProjectPath(body.path);
    if (!v.ok) return json(res, v.status, { error: v.error });
    const existing = state.projects.find((p) => p.path === v.path);
    if (existing) return json(res, 200, { project: existing, existing: true });
    const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 60) : path.basename(v.path);
    const project = { id: "p_" + id(), name, path: v.path, kind: v.kind, addedTs: Date.now() };
    state.projects.push(project);
    touch();
    return json(res, 201, { project });
  }
  if (parts[0] === "api" && parts[1] === "projects" && parts[2]) {
    const project = findProject(parts[2]);
    if (!project) return json(res, 404, { error: "project not found" });
    if (req.method === "GET" && parts[3] === "probe") {
      return json(res, 200, await probeProject(project));
    }
    if (req.method === "PATCH" && parts.length === 3) {
      const body = await readBody(req);
      if (typeof body.name === "string" && body.name.trim()) project.name = body.name.trim().slice(0, 60);
      touch();
      return json(res, 200, { project });
    }
    if (req.method === "DELETE" && parts.length === 3) {
      // 参照されている登録は削除できない（強制削除は設けない — 合意「既定のリポジトリへ自動で戻さない」）
      const topics = state.topics.filter((t) => t.projectId === project.id).map((t) => t.id);
      const items = state.pool.filter((it) => it.projectId === project.id).map((it) => it.id);
      if (topics.length || items.length) return json(res, 409, { error: "トピックまたは成果物から参照されているため削除できません", topics, items });
      state.projects = state.projects.filter((p) => p.id !== project.id);
      touch();
      return json(res, 200, { ok: true });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/topics") {
    const body = await readBody(req);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 60) : "新しいスレッド";
    // 参加者: 指定があればそれ（1 名以上・対応エージェント・grok は認証済み）。省略時は自動応答 ON かつ認証済みの全員
    const pv = validateParticipants(body.participants);
    if (pv.error) return json(res, 400, { error: pv.error, reason: pv.reason });
    const topic = defaultTopic(title, pv.participants);
    if (body.projectId) {
      if (!findProject(body.projectId)) return json(res, 400, { error: "未登録の projectId です" });
      topic.projectId = body.projectId;
    }
    state.topics.push(topic);
    touch();
    return json(res, 201, topic);
  }

  // タブの並べ替え（ブラウザライクなドラッグ入れ替え）
  if (req.method === "POST" && url.pathname === "/api/topics/reorder") {
    const body = await readBody(req);
    if (Array.isArray(body.order)) {
      const byId = new Map(state.topics.map((t) => [t.id, t]));
      const next = body.order.map((tid) => byId.get(tid)).filter(Boolean);
      for (const t of state.topics) if (!next.includes(t)) next.push(t);
      state.topics = next;
      touch();
    }
    return json(res, 200, { ok: true });
  }

  if (parts[0] === "api" && parts[1] === "topics" && parts[2]) {
    const topic = findTopic(parts[2]);
    if (!topic) return json(res, 404, { error: "topic not found" });
    // 手動での要約更新
    if (req.method === "POST" && parts[3] === "summarize") {
      // 起動判定は同期。already-running はトピックに残さないので、応答は戻り値の state を使う
      const { started, state: st } = summarizeTopic(topic.id, "manual");
      return json(res, 202, { ok: true, started, state: st || defaultSummaryState() });
    }

    // 鮮度の確認（SSE を待たずに開いた瞬間に確かめるための補助。数え方は lib.unreflectedCount）
    if (req.method === "GET" && parts[3] === "summary-status") {
      return json(res, 200, summaryStatus(topic));
    }

    // 分岐: 指定メッセージ地点までの履歴を新トピックへコピーする
    // （合意事項: コピーの provenance は不変。CLI セッションは継承せず新規 topicAgent で開始）
    if (req.method === "POST" && parts[3] === "branch") {
      const body = await readBody(req);
      const at = state.messages.find((m) => m.id === body.messageId && m.topicId === topic.id);
      if (!at) return json(res, 404, { error: "分岐点のメッセージが見つかりません" });
      // 参加者: 省略時は分岐元を継承（招待の代替: 新セッション＋要約から参加し、過去発言を再処理しない）。継承分も明示指定と同じ検証を通す（未認証 Grok を含む分岐は拒否）
      const bpv = validateParticipants(body.participants === undefined ? (topic.participants || LEGACY_AGENTS).slice() : body.participants);
      if (bpv.error) return json(res, 400, { error: bpv.error, reason: bpv.reason });
      const branched = defaultTopic(topic.title.slice(0, 50) + "＃分岐", bpv.participants);
      branched.branchedFrom = { topicId: topic.id, messageId: at.id };
      // 対象プロジェクト: 省略時は継承
      if (body.projectId !== undefined && body.projectId !== null && !findProject(body.projectId)) return json(res, 400, { error: "未登録の projectId です" });
      branched.projectId = body.projectId === undefined ? topic.projectId : body.projectId;
      branched.projectLocked = false; // 発言のコピーは実行ではない。分岐先自身の初回実行で立つ
      // 分岐元の要約を持ち込む（新セッションの初回応答で文脈として再注入される）。
      // 出所（summaryProjectId）も要約と一緒に引き継ぎ、現在の対象と違うときは buildPrompt が注記する
      // （別対象への分岐だけでなく、分岐後・初回実行前に PATCH で対象を変えた場合も同じ判定で注記される）
      branched.summaryText = topic.summaryText || "";
      branched.summaryProjectId = topic.summaryText ? topic.summaryProjectId || null : null;
      // 引き継いだ会話の出所（要約の有無に依らず記録。再要約でも上書きされない恒久マーク）。
      // 分岐元自身が引き継ぎ元を持つ場合はそれを保ち、最初の出所を失わない
      branched.carriedProjectId = topic.carriedProjectId !== undefined ? topic.carriedProjectId : topic.projectId || null;
      branched.summaryTs = topic.summaryTs || null;
      branched.qaCount = topic.qaCount || 0;
      const copies = state.messages
        .filter((m) => m.topicId === topic.id && m.ts <= at.ts)
        .map((m) => ({
          ...m,
          id: id(),
          topicId: branched.id,
          copiedFromMessageId: m.id, // provenance.source は上書きしない（複製履歴は別軸）
        }));
      branched.summaryAt = copies.length;
      // 要約が「どこまでを見たか」はコピー後の ID で持つ（親の ID は分岐先に存在しない）。
      // 末尾は挿入順ではなく数える側と同じ並び（ts 昇順・同 ts は id 昇順）で取る。
      // 質疑の配送コピーは同一 ts で複数作られ、ID はランダム hex なので挿入順の末尾とは一致しない
      branched.summaryLastMsgId = copies.length ? sortByTsId(copies).pop().id : null;
      // 分岐直後に旧履歴へ自動応答が走らないよう、既読位置を分岐時点に合わせる
      for (const a of branched.participants) branched.agents[a].lastSeenTs = Date.now();
      state.topics.push(branched);
      state.messages.push(...copies);
      touch();
      return json(res, 201, branched);
    }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      // 入力をすべて検証してから状態を変える（400／409 で返すときはトピックに何も残さない）。
      // 対象プロジェクトの紐付けの可否はサーバが判定: 実行済み＝projectLocked なら 409、未登録 id は 400
      const setProject = "projectId" in body;
      if (setProject) {
        if (topic.projectLocked) return json(res, 409, { error: "実行後は対象プロジェクトを変更できません（🌿 分岐で別プロジェクトのトピックを作れます）", reason: "locked" });
        if (body.projectId !== null && !findProject(body.projectId)) return json(res, 400, { error: "未登録の projectId です" });
      }
      if (typeof body.title === "string" && body.title.trim()) topic.title = body.title.trim().slice(0, 60);
      // 要約の出所（summaryProjectId）は触らない — 現在の対象と違えば初回プロンプトで注記される
      if (setProject) topic.projectId = body.projectId;
      // CLI セッションのリセット（次の応答から新セッション。codex は新方式 cwd=pool で始まる）
      if (AGENTS.includes(body.resetAgent) && topic.agents[body.resetAgent]) {
        const ta = topic.agents[body.resetAgent];
        ta.sessionId = null;
        ta.transcriptOffset = null;
        delete ta.codexPoolCwd;
        delete ta.interruptedSessionId;
        delete ta.interruptedPoolCwd;
      }
      // 中断（キャンセル）したセッションの明示的な再開
      if (AGENTS.includes(body.resumeInterrupted) && topic.agents[body.resumeInterrupted]) {
        const ta = topic.agents[body.resumeInterrupted];
        if (ta.interruptedSessionId) {
          ta.sessionId = ta.interruptedSessionId;
          ta.codexPoolCwd = ta.interruptedPoolCwd;
          delete ta.interruptedSessionId;
          delete ta.interruptedPoolCwd;
        }
      }
      touch();
      return json(res, 200, topic);
    }
    if (req.method === "DELETE") {
      if (state.topics.length <= 1) return json(res, 400, { error: "最後のトピックは削除できません" });
      state.topics = state.topics.filter((t) => t.id !== topic.id);
      state.messages = state.messages.filter((m) => m.topicId !== topic.id);
      touch();
      return json(res, 200, { ok: true });
    }
  }

  // コピー / 移動（Finder 風ブラウザ用）。src はプール内相対パス（ファイルまたはフォルダ）
  if (req.method === "POST" && (url.pathname === "/api/pool/copy" || url.pathname === "/api/pool/move")) {
    const isMove = url.pathname.endsWith("/move");
    const body = await readBody(req);
    let src = typeof body.src === "string" ? body.src.replace(/\/+$/, "") : "";
    let destDir = typeof body.destDir === "string" ? body.destDir.replace(/\/+$/, "") : "";
    const srcAbs = poolFilePath(src);
    const destDirAbs = destDir ? poolFilePath(destDir) : POOL_DIR;
    if (!srcAbs || !fs.existsSync(srcAbs)) return json(res, 400, { error: "src が見つかりません" });
    if (!destDirAbs || !fs.existsSync(destDirAbs) || !fs.statSync(destDirAbs).isDirectory())
      return json(res, 400, { error: "destDir が不正です" });
    // パス表記の違い（./ や余分な区切り等）で実行中チェックを迂回できないよう、実体パスから正準化する
    src = path.relative(POOL_DIR, srcAbs);
    destDir = destDirAbs === POOL_DIR ? "" : path.relative(POOL_DIR, destDirAbs);
    const isDir = fs.statSync(srcAbs).isDirectory();
    if (isDir && (destDir === src || destDir.startsWith(src + "/")))
      return json(res, 400, { error: "フォルダを自分自身の中へは移動/コピーできません" });
    // 修正／レビュー実行中のアイテム（とそれを含むフォルダ）は移動しない。CLI には開始時のパスを渡しているので、
    // 途中で移動すると修正は旧パスに書かれ、後版保存は移動先の未修正内容を「修正後」として記録してしまう
    if (isMove) {
      const busy = state.pool.find(
        (p) => p.file && (fixPending[p.id] || reviewPending[p.id]) && (p.file === src || (isDir && p.file.startsWith(src + "/"))),
      );
      if (busy) return json(res, 409, { error: `実行中（修正／レビュー）のアイテム ${busy.file} を含むため移動できません（完了後に移動してください）` });
    }
    const srcParent = src.includes("/") ? src.slice(0, src.lastIndexOf("/")) : "";
    if (isMove && srcParent === destDir) return json(res, 200, { ok: true, dest: src }); // 同じ場所への移動は何もしない
    // 衝突しない移動/コピー先の名前を決める
    const base = src.split("/").pop();
    let destRel = destDir ? destDir + "/" + base : base;
    if (fs.existsSync(path.join(POOL_DIR, destRel))) {
      const ext = isDir ? "" : path.extname(base);
      const stem = isDir ? base : base.slice(0, base.length - ext.length);
      let n = 2;
      do {
        destRel = (destDir ? destDir + "/" : "") + stem + "-" + n++ + ext;
      } while (fs.existsSync(path.join(POOL_DIR, destRel)));
    }
    const destAbs = poolFilePath(destRel);
    if (!destAbs) return json(res, 400, { error: "移動先パスが不正です" });
    if (isMove) {
      fs.renameSync(srcAbs, destAbs);
      // メタデータ（レビュー・修正履歴つき）をパス書き換えで追従させる
      for (const p of state.pool) {
        if (!p.file) continue;
        if (p.file === src) p.file = destRel;
        else if (isDir && p.file.startsWith(src + "/")) p.file = destRel + p.file.slice(src.length);
      }
    } else {
      fs.cpSync(srcAbs, destAbs, { recursive: true }); // コピー分は次のスキャンで新規アイテムとして登録される
    }
    scanPoolDir();
    touch();
    return json(res, 200, { ok: true, dest: destRel });
  }

  // 新規フォルダ作成（Finder 風ブラウザ用）
  if (req.method === "POST" && url.pathname === "/api/pool/mkdir") {
    const body = await readBody(req);
    const parent = typeof body.dir === "string" ? body.dir : "";
    const seg = sanitizeSegment(body.name);
    if (!seg) return json(res, 400, { error: "name は必須です" });
    const rel = parent ? parent.replace(/\/+$/, "") + "/" + seg : seg;
    const abs = poolFilePath(rel);
    if (!abs) return json(res, 400, { error: "不正なフォルダ名です" });
    fs.mkdirSync(abs, { recursive: true });
    scanPoolDir();
    touch();
    return json(res, 201, { dir: rel });
  }

  // 新規（空）ファイル作成
  if (req.method === "POST" && url.pathname === "/api/pool/newfile") {
    const body = await readBody(req);
    const dir = typeof body.dir === "string" ? body.dir : "";
    const base = sanitizeSegment(body.name || "untitled.md");
    if (!base) return json(res, 400, { error: "name は必須です" });
    const name = uniquePoolName(base, dir);
    const abs = poolFilePath(name);
    if (!abs) return json(res, 400, { error: "不正なファイル名です" });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "");
    const item = {
      id: id(),
      title: name,
      file: name,
      origin: "user",
      topicId: topicIdFromPath(name),
      projectId: projectIdOfTopic(topicIdFromPath(name)),
      reviewers: reviewersFor(topicIdFromPath(name), "user").reviewers,
      via: "created",
      status: "submitted",
      reviews: [],
      ...statPoolFile(name),
      ts: Date.now(),
    };
    state.pool.push(item);
    scanPoolDir();
    touch();
    return json(res, 201, item);
  }

  // 共有タスクプール: テキスト持ち込み（pool/ に .md として保存。相手エージェントが自動レビュー）
  if (req.method === "POST" && url.pathname === "/api/pool") {
    const body = await readBody(req);
    const origin = AUTHORS.includes(body.origin) ? body.origin : null;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body.trim() : "";
    const bodyTopic = findTopic(body.topicId) || state.topics[0];
    let dir = typeof body.dir === "string" ? body.dir : "";
    if (!dir && bodyTopic) {
      dir = topicDirRel(bodyTopic.id); // 既定はトピック別フォルダ（合意事項）
      ensureTopicDir(bodyTopic.id);
    }
    if (!origin || !title || !text) return json(res, 400, { error: "origin / title / body は必須です" });
    const rv = reviewersFor(bodyTopic ? bodyTopic.id : null, origin, body.reviewers);
    if (rv.error) return json(res, 400, { error: rv.error });
    // filename 指定があれば拡張子ごと尊重（コードブロック保存用）。なければ .md
    const fname =
      typeof body.filename === "string" && body.filename.trim() ? sanitizeSegment(body.filename.trim()) : title + ".md";
    const name = uniquePoolName(fname, dir);
    const abs = poolFilePath(name);
    if (!abs) return json(res, 400, { error: "不正な保存先です" });
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    const item = {
      id: id(),
      title,
      file: name,
      origin,
      topicId: topicIdFromPath(name) || (bodyTopic ? bodyTopic.id : null),
      projectId: projectIdOfTopic(topicIdFromPath(name) || (bodyTopic ? bodyTopic.id : null)),
      reviewers: rv.reviewers,
      status: "submitted",
      reviews: [],
      fromMessageId: typeof body.fromMessageId === "string" ? body.fromMessageId : null,
      ...statPoolFile(name),
      ts: Date.now(),
    };
    state.pool.push(item);
    touch();
    // 依頼先（既定: 作者以外の参加者。ユーザー持ち込みは参加者全員）へ自動レビュー。実行できない相手は skipped で記録
    if (body.autoReview !== false) for (const r of item.reviewers) runReview(item.id, r, { auto: true });
    return json(res, 201, item);
  }

  // ファイルアップロード（base64）
  if (req.method === "POST" && url.pathname === "/api/pool/upload") {
    const body = await readBody(req, 16_000_000);
    const origin = AUTHORS.includes(body.origin) ? body.origin : "user";
    const rawName = typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : "file";
    if (typeof body.dataBase64 !== "string") return json(res, 400, { error: "dataBase64 は必須です" });
    const data = Buffer.from(body.dataBase64, "base64");
    const upTopic = findTopic(body.topicId) || state.topics[0];
    const urv = reviewersFor(upTopic ? upTopic.id : null, origin, body.reviewers);
    if (urv.error) return json(res, 400, { error: urv.error });
    let upDir = typeof body.dir === "string" ? body.dir : "";
    if (!upDir && upTopic) {
      upDir = topicDirRel(upTopic.id);
      ensureTopicDir(upTopic.id);
    }
    const name = uniquePoolName(rawName, upDir);
    const absUp = poolFilePath(name);
    if (!absUp) return json(res, 400, { error: "不正な保存先です" });
    fs.mkdirSync(path.dirname(absUp), { recursive: true });
    fs.writeFileSync(absUp, data);
    const item = {
      id: id(),
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : rawName,
      file: name,
      origin,
      topicId: topicIdFromPath(name) || (upTopic ? upTopic.id : null),
      projectId: projectIdOfTopic(topicIdFromPath(name) || (upTopic ? upTopic.id : null)),
      reviewers: urv.reviewers,
      via: "upload",
      status: "submitted",
      reviews: [],
      ...statPoolFile(name),
      ts: Date.now(),
    };
    state.pool.push(item);
    touch();
    if (body.autoReview === true) {
      for (const r of item.reviewers) runReview(item.id, r, { auto: true });
    }
    return json(res, 201, item);
  }

  // プールファイルの取得（プレビュー・ダウンロード用。サブフォルダのパスにも対応）
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "pool" && parts[2] === "file" && parts[3]) {
    const file = poolFilePath(decodeURIComponent(parts.slice(3).join("/")));
    // ディレクトリを createReadStream すると EISDIR がストリームの 'error' で飛び、
    // 未処理だとプロセスごと落ちる（2026-09-13 の実走で発生）。ファイル以外は 404
    let st = null;
    try { st = file ? fs.statSync(file) : null; } catch {}
    if (!st || !st.isFile()) return json(res, 404, { error: "file not found" });
    const ext = path.extname(file).toLowerCase();
    const mime =
      ext === ".html" || ext === ".htm"
        ? "text/html; charset=utf-8" // HTML 成果物（ゲーム等）はそのまま実行できる形で配信
        : IMAGE_MIME[ext] || MEDIA_MIME[ext] || (isTextPoolFile(file) ? "text/plain; charset=utf-8" : "application/octet-stream");
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    const stream = fs.createReadStream(file);
    stream.on("error", () => res.destroy()); // ヘッダ送信後はエラー応答を返せない。接続だけ切ってプロセスは守る
    stream.pipe(res);
    return;
  }

  // 版一覧（仕様: 削除済みアイテムでも manifest があれば返す。対象外の理由は現状のファイルから判定）
  // 成果物の版と必須検証（契約: 契約-成果物検証API.md §4）
  if (req.method === "GET" && url.pathname === "/api/verification/history") {
    const r = verifHistory(url);
    return json(res, r.status, r.body);
  }
  if (parts[0] === "api" && parts[1] === "pool" && parts[2] && parts[3] === "verification" && parts.length <= 5) {
    const item = state.pool.find((p) => p.id === parts[2]);
    if (!item) return json(res, 404, { error: "pool item not found", code: "item-not-found" });
    const op = parts[4] || null;
    if (req.method === "GET" && !op) return json(res, 200, await verifEvaluate(item)); // 読取専用。申告は受理しない
    if (req.method === "POST" && op === "import") {
      await verifDrainBody(req); // 本文は使わない（§4.2「送っても無視」）。JSON として解釈せず、読み捨ててから応答する
      const r = await verifImport(item);
      return json(res, r.status, r.body);
    }
    if (req.method === "POST" && (op === "confirm" || op === "classify")) {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return json(res, 400, { error: "本文を JSON として読めません: " + (e.message || e), code: "invalid-json" });
      }
      const r = op === "confirm" ? await verifConfirm(item, body) : await verifClassify(item, body);
      return json(res, r.status, r.body);
    }
    return json(res, 404, { error: "not found" });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "pool" && parts[2] && parts[3] === "versions" && parts.length === 4) {
    const item = state.pool.find((p) => p.id === parts[2]);
    let manifest;
    try {
      manifest = readManifest(parts[2]);
    } catch (e) {
      return json(res, 500, { error: "履歴 manifest を読めません: " + (e.message || e) });
    }
    if (!item && !manifest) return json(res, 404, { error: "pool item not found" });
    const versions = manifest ? manifest.versions : (item && item.versions) || [];
    let unsupportedReason = null;
    if (item) {
      try {
        unsupportedReason = readForHistory(item).unsupported;
      } catch (e) {
        unsupportedReason = "read-error"; // EIO / EACCES 等。対象外ではなく「今は読めない」（UI は理由文字列をそのまま表示）
        logEvent("versions", `実ファイルを読めません（${item.file}）: ` + (e.message || e), "warn");
      }
    }
    // currentSha: 現在の実ファイルの sha256（不存在・読めない場合は null）。
    // レビュー記録の sha256 と描画のたびに比べ、レビュー終了後の変更を表示するために返す（合意メモ-成果物検証 §4）
    return json(res, 200, { versions, unsupportedReason, currentSha: item ? currentSha(item) : null });
  }

  // 指定版間の unified diff（from 省略時は to の直前の版。256 KiB 超は truncated）
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "pool" && parts[2] && parts[3] === "diff" && parts.length === 4) {
    const toId = url.searchParams.get("to");
    if (!toId) return json(res, 400, { error: "to（版 id）を指定してください" });
    let manifest;
    try {
      manifest = readManifest(parts[2]);
    } catch (e) {
      return json(res, 500, { error: "履歴 manifest を読めません: " + (e.message || e) });
    }
    if (!manifest) return json(res, 404, { error: "履歴がありません" });
    const pair = resolveVersionPair(manifest, url.searchParams.get("from") || null, toId);
    if (!pair) return json(res, 404, { error: "指定の版が見つかりません" });
    const { from, to } = pair;
    try {
      const full = from
        ? unifiedDiff(readVersionText(manifest, from), readVersionText(manifest, to), { fromLabel: "v" + from.n, toLabel: "v" + to.n })
        : "";
      const { text, truncated } = truncateUtf8(full, DIFF_MAX_BYTES);
      return json(res, 200, { from, to, diff: text, truncated });
    } catch (e) {
      return json(res, 500, { error: "版ファイルを読めません: " + (e.message || e) });
    }
  }

  if (parts[0] === "api" && parts[1] === "pool" && parts[2]) {
    const item = state.pool.find((p) => p.id === parts[2]);
    if (!item) return json(res, 404, { error: "pool item not found" });

    if (req.method === "POST" && parts[3] === "review") {
      const body = await readBody(req);
      const reviewer = AGENTS.includes(body.reviewer) ? body.reviewer : null;
      if (!reviewer) return json(res, 400, { error: "reviewer は " + AGENTS.join(" / ") });
      if (!participantsOfTopic(item.topicId).includes(reviewer)) return json(res, 400, { error: `${NAMES[reviewer]} はこの成果物のトピックの参加者ではありません` });
      if (reviewer === "grok" && state.agents.grok.authed !== true) return json(res, 400, { error: "Grok が未認証（または確認中）です", reason: "unauthed", agent: "grok" });
      if (fixPending[item.id]) return json(res, 409, { error: "このアイテムは修正実行中です（完了後にレビューしてください）" });
      runReview(item.id, reviewer, { offline: body.offline === true });
      return json(res, 202, { ok: true });
    }

    // レビューを踏まえた修正（書き込みは pool/ 限定。完了後は元レビュアーが自動再レビュー）
    if (req.method === "POST" && parts[3] === "fix") {
      const body = await readBody(req);
      const agent = AGENTS.includes(body.agent) ? body.agent : null;
      if (!agent) return json(res, 400, { error: "agent は " + AGENTS.join(" / ") });
      if (!participantsOfTopic(item.topicId).includes(agent)) return json(res, 400, { error: `${NAMES[agent]} はこの成果物のトピックの参加者ではありません` });
      if (agent === "grok" && state.agents.grok.authed !== true) return json(res, 400, { error: "Grok が未認証（または確認中）です", reason: "unauthed", agent: "grok" });
      if (!item.file) return json(res, 400, { error: "ファイル実体のない旧形式アイテムは修正できません" });
      if (fixPending[item.id]) return json(res, 409, { error: "このアイテムは修正実行中です" });
      if (reviewPending[item.id]) return json(res, 409, { error: "このアイテムはレビュー実行中です（完了後に修正してください）" });
      runFix(item.id, agent, { offline: body.offline === true });
      return json(res, 202, { ok: true });
    }

    if (req.method === "PATCH" && parts.length === 3) {
      const body = await readBody(req);
      if (body.status && POOL_STATUSES.includes(body.status)) item.status = body.status;
      touch();
      return json(res, 200, item);
    }

    if (req.method === "DELETE" && parts.length === 3) {
      if (fixPending[item.id] || reviewPending[item.id]) return json(res, 409, { error: "実行中（修正／レビュー）のアイテムは削除できません" });
      // 実ファイルは消さず .trash へ退避（誤削除からの復元用）。.versions/<itemId>/ は残す（manifest が索引を保持）
      if (item.file) {
        try {
          fs.renameSync(poolFilePath(item.file), path.join(POOL_TRASH, Date.now() + "-" + item.file.replaceAll("/", "__")));
        } catch {
          // ファイルが既にない場合はそのまま
        }
      }
      state.pool = state.pool.filter((p) => p.id !== item.id);
      touch();
      return json(res, 200, { ok: true });
    }
  }

  // 質疑モード開始: 先手エージェントへ発言し、以後は応答完了ごとに相手へ自動中継
  if (req.method === "POST" && url.pathname === "/api/qa/start") {
    const body = await readBody(req);
    const first = AGENTS.includes(body.first) ? body.first : null;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const hops = Math.min(20, Math.max(1, Number(body.hops) || 6));
    if (!first || !text) return json(res, 400, { error: "first と text は必須です" });
    const qaTopic = findTopic(body.topicId) || state.topics[0];
    if (!qaTopic) return json(res, 400, { error: "トピックがありません" });
    // 参加者（順序付き）: 省略時はトピック参加者全員を first から始まる順に。指定時は first を先頭に置く
    const tparts = qaTopic.participants || LEGACY_AGENTS;
    const order = Array.isArray(body.participants) && body.participants.length ? [...new Set(body.participants)] : tparts.slice();
    const opened = openRelay(qaTopic, { first, order, hops, agenda: typeof body.agenda === "string" ? body.agenda : "", text });
    if (opened.error) return json(res, 400, { error: opened.error, ...(opened.reason ? { reason: opened.reason, agent: opened.agent } : {}) });
    touch();
    agentLoop(qaTopic.id, first);
    return json(res, 201, { relay: qaTopic.relay });
  }

  if (req.method === "POST" && url.pathname === "/api/qa/agenda") {
    const body = await readBody(req);
    const t = findTopic(body.topicId) || state.topics[0];
    if (t && t.relay.active) {
      t.relay.agenda = typeof body.agenda === "string" ? body.agenda.trim().slice(0, 120) : "";
      touch();
    }
    return json(res, 200, { agenda: t ? t.relay.agenda : "" });
  }

  if (req.method === "POST" && url.pathname === "/api/qa/stop") {
    const body = await readBody(req);
    const qaTopic = findTopic(body.topicId) || state.topics[0];
    if (qaTopic) stopRelay(qaTopic, "manual");
    touch();
    return json(res, 200, { relay: qaTopic ? qaTopic.relay : defaultRelay() });
  }

  if (req.method === "PATCH" && parts[0] === "api" && parts[1] === "agents" && AGENTS.includes(parts[2])) {
    const body = await readBody(req);
    const a = state.agents[parts[2]];
    if (typeof body.auto === "boolean") {
      a.auto = body.auto;
      // ON にした時点から先の新着のみ拾う。参加しているトピックだけ（旧トピックには grok のセッション状態がない）
      if (body.auto) for (const t of state.topics) if (t.agents[parts[2]]) t.agents[parts[2]].lastSeenTs = Date.now();
      a.lastError = "";
    }
    if (typeof body.model === "string") {
      a.modelOverride = body.model.trim();
      a.lastError = "";
    }
    // 可用性の手動リセット（契約-不在可視化 §4 の後続・指摘#3）: unknown に落ちた席を「未評価」へ戻す。
    // 復帰手段が「次の成功」しかないと、自動応答 OFF の席は不明表示を消せない。
    // available へ直接は上げない（証拠なしに利用可能を示さない）——null は従来表示に戻るだけ。lastError は残す
    if (body.resetAvailability === true) {
      a.availability = null;
      logEvent("cli", `${NAMES[parts[2]]} の可用性表示を手動で未評価に戻しました（次の実行または再確認で再評価）`, "info");
    }
    touch();
    return json(res, 200, a);
  }

  // Grok の認証再判定（~/.grok/auth.json の存在＋軽量プローブ）
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "agents" && parts[2] === "grok" && parts[3] === "check-auth") {
    const ok = await checkGrokAuth();
    const g = state.agents.grok;
    return json(res, 200, { authed: ok, checkedTs: g ? g.authCheckedTs : 0, message: ok ? "" : (g && g.lastError) || "未認証" });
  }

  if (req.method === "POST" && url.pathname === "/api/tasks") {
    const body = await readBody(req);
    const agent = AGENTS.includes(body.agent) ? body.agent : null;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!agent || !title) return json(res, 400, { error: "agent と title は必須です" });
    const task = {
      id: id(),
      agent,
      topicId: (findTopic(body.topicId) || state.topics[0] || {}).id || null,
      title,
      detail: typeof body.detail === "string" ? body.detail.trim() : "",
      status: "queued",
      fromMessageId: typeof body.fromMessageId === "string" ? body.fromMessageId : null,
      result: "",
      ts: Date.now(),
    };
    state.tasks.push(task);
    touch();
    return json(res, 201, task);
  }

  if (parts[0] === "api" && parts[1] === "tasks" && parts[2]) {
    const task = state.tasks.find((t) => t.id === parts[2]);
    if (!task) return json(res, 404, { error: "task not found" });

    if (req.method === "PATCH" && parts.length === 3) {
      const body = await readBody(req);
      if (body.status && TASK_STATUSES.includes(body.status)) task.status = body.status;
      // done になった前提タスクの後続を、承認済み計画から送る（追加承認は求めない・契約 §10.2）
      trayAdvancePlans(task.topicId);
      touch();
      return json(res, 200, task);
    }

    // 結果の再入力: タスクを returned にし、担当エージェントの発言としてスレッドへ戻す
    if (req.method === "POST" && parts[3] === "result") {
      const body = await readBody(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return json(res, 400, { error: "text は必須です" });
      task.status = "returned";
      task.result = text;
      state.messages.push({
        id: id(),
        topicId: task.topicId || (state.topics[0] || {}).id,
        thread: task.agent,
        author: task.agent,
        text,
        taskId: task.id,
        provenance: { ingress: "ui", delivery: "direct", trigger: "manual", source: null },
        ts: Date.now(),
      });
      touch();
      return json(res, 200, task);
    }

    if (req.method === "DELETE" && parts.length === 3) {
      state.tasks = state.tasks.filter((t) => t.id !== task.id);
      touch();
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: "not found" });
}

// ---- アバター配信（仕様: SPEC-アバター状態.md §7）----
// 対象は AGENTS の id だけ。pet.json は読むだけで書き換えない
const AVATAR_DIR = path.join(POOL_DIR, "avatars");
const avatarHashCache = new Map(); // 絶対パス -> { mtimeMs, size, sha256 }。変わったときだけ読み直す

function avatarFileInfo(abs) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const c = avatarHashCache.get(abs);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c;
  const info = { mtimeMs: st.mtimeMs, size: st.size, sha256: sha256Hex(fs.readFileSync(abs)) };
  avatarHashCache.set(abs, info);
  return info;
}

const avatarUrl = (agent, which, info) => `/api/avatars/${agent}/${which}.${info.sha256.slice(0, 16)}.webp`;

// 画像の実体。sprite は pet.json の spritesheetPath（同じフォルダの basename.webp のみ）、still は固定名
function avatarAsset(agent, which) {
  const dir = path.join(AVATAR_DIR, agent);
  if (which === "still") return { abs: path.join(dir, "still-r0c0.webp"), pet: null, error: null };
  let pet;
  try {
    pet = JSON.parse(fs.readFileSync(path.join(dir, "pet.json"), "utf8"));
  } catch (e) {
    return e && e.code === "ENOENT" ? { abs: null, pet: null, missing: true } : { abs: null, pet: null, error: "pet.json を読めません" };
  }
  if (!pet || typeof pet !== "object" || Array.isArray(pet)) return { abs: null, pet: null, error: "pet.json がオブジェクトではありません" };
  if (pet.spriteVersionNumber !== 2) return { abs: null, pet, error: "spriteVersionNumber が 2 ではありません" };
  if (!isSafeSpriteName(pet.spritesheetPath)) return { abs: null, pet, error: "spritesheetPath が不正です" };
  return { abs: path.join(dir, pet.spritesheetPath), pet, error: null };
}

function avatarManifest() {
  let format = null;
  let formatError = null;
  try {
    format = JSON.parse(fs.readFileSync(path.join(AVATAR_DIR, "v2-format.json"), "utf8"));
    formatError = validateV2Format(format);
    if (formatError) format = null;
  } catch (e) {
    format = null;
    formatError = e && e.code === "ENOENT" ? null : "v2-format.json を読めません";
  }
  const agents = {};
  for (const agent of AGENTS) {
    const sp = avatarAsset(agent, "sprite");
    if (sp.missing) {
      agents[agent] = null;
      continue;
    }
    const pet = sp.pet || {};
    const spInfo = sp.abs ? avatarFileInfo(sp.abs) : null;
    const stillInfo = avatarFileInfo(avatarAsset(agent, "still").abs);
    agents[agent] = {
      id: typeof pet.id === "string" ? pet.id : agent,
      displayName: typeof pet.displayName === "string" ? pet.displayName : null,
      description: typeof pet.description === "string" ? pet.description : null,
      spriteVersionNumber: pet.spriteVersionNumber ?? null,
      sprite: spInfo ? { url: avatarUrl(agent, "sprite", spInfo), sha256: spInfo.sha256, bytes: spInfo.size } : null,
      still: stillInfo ? { url: avatarUrl(agent, "still", stillInfo), sha256: stillInfo.sha256, bytes: stillInfo.size } : null,
      error: sp.error || (sp.abs && !spInfo ? "スプライトシートがありません" : null),
    };
  }
  return { version: 1, format, formatError, agents };
}

function etagMatches(req, etag) {
  const h = req.headers["if-none-match"];
  if (!h) return false;
  return h.split(",").map((s) => s.trim().replace(/^W\//, "")).some((t) => t === etag || t === "*");
}

function serveAvatarManifest(req, res) {
  const body = JSON.stringify(avatarManifest());
  const headers = { "Cache-Control": "no-cache", ETag: '"' + sha256Hex(body).slice(0, 32) + '"' };
  if (etagMatches(req, headers.ETag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

// 同じ URL に別の内容を返さない（RFC 8246）。hash が古ければ 404 で現在の URL を知らせる
function serveAvatarImage(req, res, pathname) {
  const m = /^\/api\/avatars\/([a-z]+)\/(sprite|still)\.([0-9a-f]{16})\.webp$/.exec(pathname);
  if (!m || !AGENTS.includes(m[1])) return json(res, 404, { error: "not found" });
  const [, agent, which, hash] = m;
  const asset = avatarAsset(agent, which);
  const info = asset.abs ? avatarFileInfo(asset.abs) : null;
  if (!info) return json(res, 404, { error: "not found" });
  if (info.sha256.slice(0, 16) !== hash) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ error: "stale", current: avatarUrl(agent, which, info) }));
    return;
  }
  const headers = { "Cache-Control": "public, max-age=31536000, immutable", ETag: '"' + hash + '"' };
  if (etagMatches(req, headers.ETag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "Content-Type": "image/webp", "Content-Length": info.size });
  const stream = fs.createReadStream(asset.abs);
  stream.on("error", () => res.destroy()); // 読み中の消失等でプロセスを落とさない
  stream.pipe(res);
}

// ---- 成果物の版と必須検証（仕様: SPEC-成果物検証.md／契約: 契約-成果物検証API.md 契約版 2）----
// スキーマ・ハッシュ・分類・判定はすべて verification.mjs。ここはファイルの読み書き、基点の確認、受付の直列化だけを行う。
// data/checks.jsonl はアプリの追記専用実装であり、OS 上の削除・改ざんを防ぐものではない（SPEC §4）
const CHECKS_LOG = path.join(DATA_DIR, "checks.jsonl");
const verifLog = { ok: true, errors: [], lastSeq: 0, records: [], manifestHashes: new Set() };
const verifBaseCache = new Set(); // "<repo>\0<commit>"。確認できたものだけ覚える（存在しない・確認できないは毎回確かめ直す）
const VERIF_REJECT_MESSAGES = {
  "manifest-invalid": "manifest.json がスキーマに合わないため取り込めません",
  "subject-unavailable": "現行版を計算できません",
  "subject-mismatch": "申告の対象版が現行版と違います",
  "policy-unsupported": "未対応の policyVersion です",
  "requirements-mismatch": "申告の必須集合が現行と違います",
  "evidence-missing": "証跡のファイルがありません",
  "evidence-mismatch": "証跡の SHA-256 が違います",
  "evidence-unreadable": "証跡を読めません",
  "evidence-outside": "証跡の実体が impl フォルダの外にあります",
};
const VERIF_SHA_RE = /^[0-9a-f]{64}$/;
const VERIF_COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const verifProjectKey = (item) => (item.projectId ? "project:" + item.projectId : "default");
const verifHealth = () => ({ ok: verifLog.ok, errors: verifLog.errors, lastSeq: verifLog.lastSeq });
const verifUnavailable = () => ({ status: 503, body: { error: "追記ログが不健全なため受け付けられません（修復は API の外で行ってください）", code: "log-unavailable", log: verifHealth() } });
const verifNotApplicable = () => ({ status: 400, body: { error: "impl フォルダ（manifest.json を持つフォルダ）に属していません", code: "not-applicable" } });

// 本文を使わない POST でも読み切ってから応答する（JSON として解釈しないので、不正な本文でも拒否しない）
function verifDrainBody(req) {
  if (req.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    req.on("end", resolve);
    req.on("error", resolve);
    req.on("close", resolve);
    req.resume();
  });
}

// 起動時の復元。読めない行があれば以後の書込を止め、評価は必ず未充足にする（読み落とした失敗がありうるため）
function verifLoadLog() {
  let text = "";
  try {
    text = fs.readFileSync(CHECKS_LOG, "utf8");
  } catch (e) {
    if (!(e && e.code === "ENOENT")) {
      Object.assign(verifLog, { ok: false, errors: [{ line: 0, code: "log-unreadable", message: String(e.message || e).slice(0, 200) }], lastSeq: 0, records: [], manifestHashes: new Set() });
      logEvent("verification", "checks.jsonl を読めません。検証の受付を止めます: " + (e.message || e));
      return;
    }
  }
  const r = verif.parseChecksLog(text);
  Object.assign(verifLog, {
    ok: r.ok,
    errors: r.errors,
    lastSeq: r.lastSeq,
    records: r.records,
    manifestHashes: new Set(r.records.filter((x) => x.source === "manifest").map((x) => x.recordSha256)),
  });
  if (!r.ok) logEvent("verification", `checks.jsonl に検査を通らない行があります（${r.errors.length} 件）。検証の受付を止めます`);
}

// 受理連番の採番から fsync までを同期で行う（間に await を挟まないので、同時の受付と連番・重複判定が混ざらない）。
// 永続化できてから索引を更新する。書き込みの途中で失敗したら、壊れた行に続けて書かないよう受付を止める
function verifAppend(entries, receivedAt = new Date().toISOString()) {
  let seq = verifLog.lastSeq;
  const recs = entries.map((e) => verif.buildLogRecord({ ...e, seq: ++seq, receivedAt }));
  const buf = Buffer.from(recs.map(verif.formatChecksLogLine).join(""), "utf8");
  let fd = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fd = fs.openSync(CHECKS_LOG, "a");
    for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
  } catch (e) {
    if (fd !== null) {
      verifLog.ok = false;
      verifLog.errors = [...verifLog.errors, { line: 0, code: "log-unreadable", message: "追記に失敗しました: " + String(e.message || e).slice(0, 200) }];
    }
    logEvent("verification", "checks.jsonl への追記に失敗しました: " + (e.message || e));
    throw e;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // close の失敗は書込結果に影響しない
      }
    }
  }
  for (const r of recs) {
    verifLog.records.push(r);
    if (r.source === "manifest") verifLog.manifestHashes.add(r.recordSha256);
  }
  verifLog.lastSeq = seq;
  return recs;
}

// 基点コミットの確認（契約 §4）。manifest の argv は使わず、固定の git cat-file だけを実行する
async function verifCheckBase(item, baseCommit) {
  if (typeof baseCommit !== "string" || !VERIF_COMMIT_RE.test(baseCommit)) {
    return { value: typeof baseCommit === "string" ? baseCommit : null, status: "invalid", detail: "形式が不正です" };
  }
  const repo = item.projectId ? (findProject(item.projectId) || {}).path : REPO_ROOT;
  if (!repo) return { value: baseCommit, status: "unverifiable", detail: "対象プロジェクトが登録されていません" };
  const key = repo + "\0" + baseCommit;
  if (verifBaseCache.has(key)) return { value: baseCommit, status: "verified", detail: "" };
  const r = await gitExec(repo, ["cat-file", "-e", baseCommit + "^{commit}"]);
  if (r.ok) {
    verifBaseCache.add(key);
    return { value: baseCommit, status: "verified", detail: "" };
  }
  // 「コミットが無い」と「git を使えない・リポジトリでない」を分ける
  const probe = await gitExec(repo, ["rev-parse", "--git-dir"]);
  return probe.ok
    ? { value: baseCommit, status: "not-found", detail: "対象リポジトリにこのコミットがありません" }
    : { value: baseCommit, status: "unverifiable", detail: probe.err || r.err || "" };
}

function verifContext(item) {
  const implDir = item && item.file ? verif.resolveImplDir(POOL_DIR, item.file) : null;
  if (!implDir) return null;
  return { implDir, abs: path.join(POOL_DIR, ...implDir.split("/")), projectKey: verifProjectKey(item) };
}

// 非同期の基点確認。受付では、この後の verifSnapshot から追記までを同期で行う
async function verifBase(ctx, item) {
  const folder = verif.readImplFolder(ctx.abs);
  return folder.manifest.ok ? verifCheckBase(item, folder.manifest.manifest.baseCommit) : { value: null, status: "invalid", detail: "manifest を読めません" };
}

function verifSnapshot(ctx, item, base) {
  const folder = verif.readImplFolder(ctx.abs);
  let baseCommit = base;
  if (folder.manifest.ok && base.value !== folder.manifest.manifest.baseCommit) {
    baseCommit = { value: folder.manifest.manifest.baseCommit, status: "unverifiable", detail: "確認中に基点が変わりました。再読込してください" };
  }
  const current = folder.currentSubjectSha256;
  const records = verifLog.records.filter((r) => r.projectKey === ctx.projectKey);
  const evidenceStatus = {};
  for (const r of records) {
    if (r.type === "check" && r.subjectSha256 === current && r.payload.evidence) evidenceStatus[r.seq] = verif.evidenceStatusOf(ctx.abs, r.payload.evidence);
  }
  const manifestEvidenceStatus = {};
  if (folder.manifest.ok) folder.manifest.manifest.checks.forEach((c, i) => (manifestEvidenceStatus[i] = verif.evidenceStatusOf(ctx.abs, c.evidence)));
  const evaluation = verif.evaluateVerification({ itemId: item.id, implDir: ctx.implDir, projectKey: ctx.projectKey, folder, baseCommit, records, log: verifHealth(), evidenceStatus, manifestEvidenceStatus });
  return { folder, evaluation, manifestEvidenceStatus };
}

async function verifEvaluate(item) {
  const ctx = verifContext(item);
  if (!ctx) return { applicable: false, itemId: item.id, implDir: null };
  const base = await verifBase(ctx, item);
  return verifSnapshot(ctx, item, base).evaluation;
}

// 申告取込（§4.2）。現行版に合う行だけを source:manifest で追記し、同じ正規化済み申告は重複として数えるだけにする
async function verifImport(item) {
  const ctx = verifContext(item);
  if (!ctx) return verifNotApplicable();
  if (!verifLog.ok) return verifUnavailable();
  const base = await verifBase(ctx, item);
  if (!verifLog.ok) return verifUnavailable();
  const snap = verifSnapshot(ctx, item, base);
  const { folder, evaluation } = snap;
  if (!folder.manifest.ok) {
    return { status: 200, body: { added: 0, duplicates: 0, rejected: [{ index: null, id: null, code: "manifest-invalid", message: VERIF_REJECT_MESSAGES["manifest-invalid"] }], records: [], evaluation } };
  }
  const entries = [];
  const rejected = [];
  const batch = new Set();
  let duplicates = 0;
  folder.manifest.manifest.checks.forEach((payload, index) => {
    const hash = verif.recordSha256({ type: "check", source: "manifest", projectKey: ctx.projectKey, payload });
    if (verifLog.manifestHashes.has(hash) || batch.has(hash)) {
      duplicates++;
      return;
    }
    const code = verif.importRejection(payload, { currentSubjectSha256: folder.currentSubjectSha256, requirementsSha256: evaluation.requirements.sha256, evidenceStatus: snap.manifestEvidenceStatus[index] });
    if (code) {
      rejected.push({ index, id: payload.id, code, message: VERIF_REJECT_MESSAGES[code] || code });
      return;
    }
    batch.add(hash);
    entries.push({ source: "manifest", type: "check", projectKey: ctx.projectKey, subjectSha256: payload.subjectSha256, policyVersion: payload.policyVersion, implDir: ctx.implDir, itemId: item.id, payload });
  });
  let records = [];
  if (entries.length) {
    try {
      records = verifAppend(entries);
    } catch (e) {
      return { status: 500, body: { error: "追記ログへの書き込みに失敗しました: " + (e.message || e), code: "log-write-failed" } };
    }
    broadcast();
  }
  return { status: 200, body: { added: records.length, duplicates, rejected, records, evaluation: verifSnapshot(ctx, item, base).evaluation } };
}

// 自動取込（契約 §4.2）: manifest.json がプール項目として新規登録された時点で 1 回だけ
const verifAutoQueue = [];
function verifQueueAutoImport(item) {
  if (!item || !item.file || path.posix.basename(item.file) !== "manifest.json") return;
  verifAutoQueue.push(item.id);
  if (verifAutoQueue.length === 1) setImmediate(verifDrainAutoImports);
}

async function verifDrainAutoImports() {
  while (verifAutoQueue.length) {
    const item = state.pool.find((p) => p.id === verifAutoQueue[0]);
    try {
      if (item) {
        const r = await verifImport(item);
        if (r.status >= 400 && r.body.code !== "not-applicable") logEvent("verification", `manifest の自動取込に失敗しました（${item.file}）: ${r.body.error}`, "warn");
      }
    } catch (e) {
      logEvent("verification", `manifest の自動取込に失敗しました（${item && item.file}）: ` + (e.message || e), "warn");
    }
    verifAutoQueue.shift();
  }
}

// 確認記録（§4.3）。受付直前に現行版・必須集合を再照合し、各項目を別々の source:ui 記録として保存する（重複排除しない）
async function verifConfirm(item, body) {
  const ctx = verifContext(item);
  if (!ctx) return verifNotApplicable();
  const errors = verif.validateConfirmRequest(body);
  if (errors.length) return { status: 400, body: { error: "要求の形式が不正です", code: "invalid-request", errors } };
  if (!verifLog.ok) return verifUnavailable();
  const base = await verifBase(ctx, item);
  if (!verifLog.ok) return verifUnavailable();
  // ここから追記まで await を挟まない
  const snap = verifSnapshot(ctx, item, base);
  const current = { subjectSha256: snap.folder.currentSubjectSha256, requirementsSha256: snap.evaluation.requirements.sha256, policyVersion: verif.POLICY_VERSION };
  if (body.subjectSha256 !== current.subjectSha256 || body.requirementsSha256 !== current.requirementsSha256 || body.policyVersion !== current.policyVersion) {
    return { status: 409, body: { error: "表示した版または必須集合が現在と違います。再読込してください", code: "version-conflict", current, evaluation: snap.evaluation } };
  }
  for (const [index, c] of body.checks.entries()) {
    if (c.evidence == null) continue;
    const st = verif.evidenceStatusOf(ctx.abs, c.evidence);
    if (st !== "ok") return { status: 422, body: { error: "証跡を照合できません", code: "evidence-" + (st === "none" ? "missing" : st), index } };
  }
  const receivedAt = new Date().toISOString();
  const entries = body.checks.map((c) => ({
    source: "ui",
    type: "check",
    projectKey: ctx.projectKey,
    subjectSha256: current.subjectSha256,
    policyVersion: current.policyVersion,
    implDir: ctx.implDir,
    itemId: item.id,
    payload: verif.normalizeCheck({
      id: c.id,
      subjectSha256: current.subjectSha256,
      policyVersion: current.policyVersion,
      requirementsSha256: current.requirementsSha256,
      actor: body.actor ?? "user",
      method: c.method,
      result: c.result,
      executedAt: c.result === "not_run" ? null : c.executedAt || receivedAt,
      evidence: c.evidence ?? null,
      reason: c.reason ?? null,
    }),
  }));
  let records;
  try {
    records = verifAppend(entries, receivedAt);
  } catch (e) {
    return { status: 500, body: { error: "追記ログへの書き込みに失敗しました: " + (e.message || e), code: "log-write-failed" } };
  }
  broadcast();
  return { status: 201, body: { records, evaluation: verifSnapshot(ctx, item, base).evaluation } };
}

// 分類記録（§4.4）。解除できるのは現行版の保留候補だけ。分類だけではテストの成功にならない
async function verifClassify(item, body) {
  const ctx = verifContext(item);
  if (!ctx) return verifNotApplicable();
  const errors = verif.validateClassifyRequest(body);
  if (errors.length) return { status: 400, body: { error: "要求の形式が不正です", code: "invalid-request", errors } };
  if (!verifLog.ok) return verifUnavailable();
  const base = await verifBase(ctx, item);
  if (!verifLog.ok) return verifUnavailable();
  // ここから追記まで await を挟まない
  const snap = verifSnapshot(ctx, item, base);
  const req = snap.evaluation.requirements;
  if (body.subjectSha256 !== snap.folder.currentSubjectSha256 || body.policyVersion !== verif.POLICY_VERSION) {
    const current = { subjectSha256: snap.folder.currentSubjectSha256, requirementsSha256: req.sha256, policyVersion: verif.POLICY_VERSION };
    return { status: 409, body: { error: "表示した版が現在と違います。再読込してください", code: "version-conflict", current, evaluation: snap.evaluation } };
  }
  if (![...req.pending, ...req.resolved].some((x) => x.path === body.path)) {
    return { status: 409, body: { error: "このパスは現行版の保留候補ではありません", code: "not-classifiable", pending: req.pending, resolved: req.resolved } };
  }
  // 解決済みのパスの再分類も許すため、分類を適用しない導出から許される分類を取る
  const parsed = verif.parseUnifiedDiff(snap.folder.patchText);
  const allowedDecisions = parsed.ok
    ? [...new Set(verif.deriveRequirements({ files: parsed.files }).pending.filter((x) => x.path === body.path).flatMap((x) => x.allowedDecisions))]
    : [];
  if (!allowedDecisions.includes(body.decision)) {
    return { status: 422, body: { error: "この保留には指定できない分類です", code: "decision-not-allowed", allowedDecisions } };
  }
  const entry = {
    source: "ui",
    type: "classification",
    projectKey: ctx.projectKey,
    subjectSha256: snap.folder.currentSubjectSha256,
    policyVersion: verif.POLICY_VERSION,
    implDir: ctx.implDir,
    itemId: item.id,
    payload: verif.normalizeClassification({ path: body.path, decision: body.decision, reason: body.reason, method: body.method ?? null }),
  };
  let records;
  try {
    records = verifAppend([entry]);
  } catch (e) {
    return { status: 500, body: { error: "追記ログへの書き込みに失敗しました: " + (e.message || e), code: "log-write-failed" } };
  }
  broadcast();
  const evaluation = verifSnapshot(ctx, item, base).evaluation;
  return { status: 201, body: { record: records[0], requirements: evaluation.requirements, evaluation } };
}

// 履歴取得（§4.5）。プール項目に依存しないので、項目を削除しても引ける。ログが不健全でも読めた行は返す
function verifHistory(url) {
  const q = url.searchParams;
  const bad = (message) => ({ status: 400, body: { error: message, code: "invalid-request" } });
  const projectKey = q.get("projectKey");
  if (!projectKey || !/^(?:default|project:[A-Za-z0-9_-]{1,80})$/.test(projectKey)) return bad("projectKey は default か project:<id> です");
  const subject = q.get("subjectSha256");
  if (subject !== null && !VERIF_SHA_RE.test(subject)) return bad("subjectSha256 は 64 桁の小文字 hex です");
  const int = (name, def, min, max) => {
    const v = q.get(name);
    if (v === null) return def;
    if (!/^\d+$/.test(v)) return NaN;
    const n = Number(v);
    return n >= min && n <= max ? n : NaN;
  };
  const afterSeq = int("afterSeq", 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = int("limit", 200, 1, 1000);
  if (Number.isNaN(afterSeq)) return bad("afterSeq は 0 以上の整数です");
  if (Number.isNaN(limit)) return bad("limit は 1〜1000 の整数です");
  const all = verifLog.records.filter((r) => r.projectKey === projectKey && (subject === null || r.subjectSha256 === subject) && r.seq > afterSeq);
  const page = all.slice(0, limit);
  return { status: 200, body: { log: verifHealth(), records: page, nextAfterSeq: all.length > limit ? page[page.length - 1].seq : null } };
}

// ---- static ----
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// 画面のコードは「更新が必ず届く」ことを優先する。ヘッダを付けないとブラウザの
// ヒューリスティックキャッシュで古い JS が残り、直したはずの挙動が反映されない（実測）。
// no-cache は毎回再検証する指示で、内容が同じなら 304 で本体の転送は省ける
function serveStatic(req, res, url) {
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.join(PUBLIC_DIR, path.normalize(file));
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const headers = { "Cache-Control": "no-cache", ETag: '"' + crypto.createHash("sha256").update(data).digest("hex").slice(0, 32) + '"' };
    if (etagMatches(req, headers.ETag)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, { ...headers, "Content-Type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(data);
  });
}

// ---- 判断トレイ（契約: 契約-判断トレイAPI.md）----
// 依頼の解析・被覆・実行可否は tray.mjs（純関数）が持ち、ここは永続化と副作用だけを持つ。
// 正本は data/tray.jsonl（1 行 = その時点の依頼レコード全体。同じ id は後の行が勝つ）

const TRAY_LOG_VERSION = 1;
const trayLog = { ok: true, lastSeq: 0, error: null, skipped: 0 };
const trayBaseCache = new Set();

// 継続予約の復元（§12.3）。armed は保存しない —— 再起動直後に勝手に CLI が動かないようにする
function sanitizeContinuation(c) {
  if (!c || typeof c !== "object" || !AGENTS.includes(c.agent) || typeof c.requestId !== "string") return null;
  return { agent: c.agent, requestId: c.requestId, reason: c.reason === "revision" ? "revision" : "answer", ts: Number(c.ts) || Date.now(), armed: false };
}

function trayLoadLog() {
  let text = "";
  try {
    text = fs.readFileSync(TRAY_FILE, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return; // 初回は空
    trayLog.ok = false;
    trayLog.error = String(e.message || e).slice(0, 200);
    logEvent("tray", "tray.jsonl を読めません。トレイの受付を止めます: " + trayLog.error);
    return;
  }
  const byId = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (!rec || rec.v !== TRAY_LOG_VERSION || !rec.request || typeof rec.request.id !== "string") throw new Error("形が不正");
      trayLog.lastSeq = Math.max(trayLog.lastSeq, Number(rec.seq) || 0);
      byId.set(rec.request.id, rec.request); // 同じ id は後の行が勝つ（状態遷移のたびに 1 行足す）
    } catch {
      trayLog.skipped++; // 壊れた 1 行で全部を失わない。件数は運用ログに出す
    }
  }
  state.trayRequests = [...byId.values()].sort((a, b) => (a.ts || 0) - (b.ts || 0) || String(a.id).localeCompare(String(b.id)));
  if (trayLog.skipped) logEvent("tray", `tray.jsonl に読めない行が ${trayLog.skipped} 件ありました（その依頼の最新状態を取り逃している可能性があります）`, "warn");
}

// 依頼 1 件を追記する。書けなければ false（呼び出し側が 500 を返し、メモリ上の状態も戻す）
function trayWrite(request) {
  if (!trayLog.ok) return false;
  request.updatedTs = Date.now();
  // checks（基点・メモの確認結果）は派生値なので残さない。再起動直後は「未確認」から始め、
  // 取得時と承認直前の再評価で取り直す（§8）。古い "verified" を蘇らせない
  const { checks, ...persisted } = request;
  const line = JSON.stringify({ v: TRAY_LOG_VERSION, seq: trayLog.lastSeq + 1, ts: request.updatedTs, request: persisted }) + "\n";
  let fd = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fd = fs.openSync(TRAY_FILE, "a");
    const buf = Buffer.from(line, "utf8");
    for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    trayLog.lastSeq++;
    return true;
  } catch (e) {
    trayLog.ok = false;
    trayLog.error = String(e.message || e).slice(0, 200);
    logEvent("tray", "tray.jsonl への追記に失敗しました: " + trayLog.error);
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // close の失敗は書込結果に影響しない
      }
    }
  }
}

const trayFind = (id) => state.trayRequests.find((r) => r.id === id) || null;
const trayOfTopic = (topicId) => state.trayRequests.filter((r) => r.topicId === topicId);
const trayActivePending = (topicId) => trayOfTopic(topicId).find((r) => r.status === "pending") || null;

function trayPoolSha(rel) {
  const abs = poolFilePath(rel);
  if (!abs) return null;
  try {
    return verif.sha256Hex(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

// §8 の再評価に要る「今のファイル・今の基点」を取り直す。SSE は同期で作るので、結果は依頼に持たせる
async function trayRefresh(request) {
  const block = request.block || {};
  const checks = { basisStatus: "ok", detailsStatus: {}, baseCommitStatus: "verified", head: null, ts: Date.now() };
  if (request.kind === "start-task") {
    if (request.basisDigest && request.basisDigest.kind === "memo") {
      const now = trayPoolSha(request.basisDigest.path);
      checks.basisStatus = now === null ? "missing" : now === request.basisDigest.sha256 ? "ok" : "changed";
    }
    for (const [p, sha] of request.detailsDigests || []) {
      const now = trayPoolSha(p);
      checks.detailsStatus[p] = now === null ? "missing" : now === sha ? "ok" : "changed";
    }
    const repo = REPO_ROOT;
    const key = repo + "\0" + block.baseCommit;
    if (trayBaseCache.has(key)) checks.baseCommitStatus = "verified";
    else {
      const r = await gitExec(repo, ["cat-file", "-e", block.baseCommit + "^{commit}"]);
      if (r.ok) {
        trayBaseCache.add(key);
        checks.baseCommitStatus = "verified";
      } else {
        const probe = await gitExec(repo, ["rev-parse", "--git-dir"]);
        checks.baseCommitStatus = probe.ok ? "not-found" : "unverifiable";
      }
    }
    const head = await gitExec(repo, ["rev-parse", "HEAD"]);
    checks.head = head.ok ? String(head.out || "").trim() : null;
  }
  request.checks = checks;
  return checks;
}

async function trayRefreshAll(topicId = null) {
  for (const r of state.trayRequests) {
    if (topicId && r.topicId !== topicId) continue;
    if (!tray.ACTIVE_STATES.includes(r.status)) continue;
    await trayRefresh(r);
  }
}

// 1 件の評価（§8・§9.1）。checks がまだ無ければ基点・メモの理由は出さない
// （承認・回答の直前は必ず trayRefresh してから呼ぶので、押す瞬間の判定は取りこぼさない）
function trayEvaluateOne(request) {
  const topic = findTopic(request.topicId);
  const participants = topic ? topic.participants || LEGACY_AGENTS : [];
  const c = request.checks;
  const blockers = tray.evaluateBlockers({
    request,
    requests: state.trayRequests,
    participants,
    agents: state.agents,
    budgetHalt: state.budgetHalt,
    basisStatus: c ? c.basisStatus : "ok",
    detailsStatus: c ? c.detailsStatus : {},
    baseCommitStatus: c ? c.baseCommitStatus : "verified",
    head: c ? c.head : null,
  });
  const titleOf = (id) => {
    const r = trayFind(id);
    return r ? (r.block || {}).title || "" : "（見つかりません）";
  };
  const statusOf = (id) => (trayFind(id) || {}).status || "missing";
  return {
    proposerName: NAMES[request.proposer] || request.proposer,
    blockers,
    basis: request.basisDigest ? { ...request.basisDigest, status: c ? c.basisStatus : "unchecked" } : null,
    details: (request.detailsDigests || []).map(([p, sha]) => ({ path: p, sha256: sha, status: c ? c.detailsStatus[p] || "ok" : "unchecked" })),
    baseCommit: (request.block || {}).baseCommit
      ? { value: request.block.baseCommit, status: c ? c.baseCommitStatus : "unchecked", headMatches: c && c.head ? c.head === request.block.baseCommit : null }
      : null,
    dependencies: {
      waiting: (request.acceptedDependsOn || []).map((id) => ({ id, title: titleOf(id), status: statusOf(id) })),
      excluded: (request.acceptedExclude || []).map((e) => ({ id: e.id, title: titleOf(e.id), reason: e.reason, status: statusOf(e.id) })),
      coverage: blockers.some((b) => b.code === "dependency-coverage-changed") ? "changed" : "ok",
    },
  };
}

function trayViewNow() {
  const evaluations = {};
  for (const r of state.trayRequests) evaluations[r.id] = trayEvaluateOne(r);
  return { ...tray.buildTrayView({ requests: state.trayRequests, topics: state.topics.map((t) => t.id), now: Date.now(), evaluations }), log: { ok: trayLog.ok, error: trayLog.error, skipped: trayLog.skipped } };
}

// 受付の拒否は黙って捨てない（§6.3）。提案者の発言として印付きで 1 件残す
function trayReject(topic, agent, codes, detail) {
  state.messages.push({
    id: id(),
    topicId: topic.id,
    thread: agent,
    author: agent,
    text: "⚠ 判断トレイの依頼を受け付けませんでした: " + String(detail || codes.join(" / ")).slice(0, 500),
    tray: { kind: "rejected", codes, requestId: null },
    provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null },
    ts: Date.now(),
  });
  logEvent("tray", `${NAMES[agent]} の依頼を受け付けませんでした（${codes.join(" / ")}）`, "warn");
  touch();
  return null;
}

// 応答 1 件からの受付（§6.1。qaHop の後に呼ぶ ＝ 終了宣言が受理されたかを見てから判定する）
function trayIntake(topic, agent, text, msgId) {
  if (!trayLog.ok) return null;
  const blocks = tray.extractRequestBlocks(text);
  if (!blocks.length) return null;
  if (blocks.length > 1) return trayReject(topic, agent, ["block-multiple"], tray.SHAPE_CODES["block-multiple"]);

  const v = tray.validateRequestBlock(blocks[0].raw, { agents: AGENTS });
  if (!v.ok) return trayReject(topic, agent, [...new Set(v.errors.map((e) => e.code))], v.errors.slice(0, 5).map((e) => `${e.path || "（全体）"}: ${e.message}`).join(" / "));
  const block = v.block;
  const parts = topic.participants || LEGACY_AGENTS;
  const bad = (code, detail) => trayReject(topic, agent, [code], detail || tray.ACCEPT_CODES[code]);

  if (!parts.includes(agent)) return bad("not-participant");
  if (block.continueAgent && !parts.includes(block.continueAgent)) return bad("continue-agent-not-participant");

  let basisDigest = null;
  const detailsDigests = [];
  if (v.kind === "start-task") {
    if (topic.relay.active) return bad("start-task-during-relay");
    for (const t of block.tasks) if (!parts.includes(t.agent)) return bad("task-agent-not-participant", `${NAMES[t.agent] || t.agent} はこのトピックの参加者ではありません`);
    if (block.basis.relayId !== undefined) {
      const rec = (topic.relayHistory || []).find((h) => h && h.id === block.basis.relayId);
      if (!rec) return bad("basis-not-found");
      // 合意で終わった質疑だけが着手の根拠になる（hops / error / cancelled では足りない）
      if (rec.stopReason !== "agreed") return bad("basis-not-agreed", `この質疑は「${rec.stopReason || "不明"}」で終わっています`);
      basisDigest = { kind: "relay", relayId: block.basis.relayId };
    } else {
      const sha = trayPoolSha(block.basis.memo);
      if (sha === null) return bad("basis-not-found", `${block.basis.memo} を読めません`);
      basisDigest = { kind: "memo", path: block.basis.memo, sha256: sha };
    }
    for (const p of block.details || []) {
      const sha = trayPoolSha(p);
      if (sha === null) return bad("details-not-found", `${p} を読めません`);
      detailsDigests.push([p, sha]);
    }
  }

  // 置換は明示したときだけ（§4.3）。issueId 一致も明示のうち
  let replaced = null;
  if (block.replaces) {
    replaced = trayOfTopic(topic.id).find((r) => r.id === block.replaces && tray.ACTIVE_STATES.includes(r.status)) || null;
    if (!replaced) return bad("replaces-not-found");
  } else if (block.issueId) {
    replaced = trayOfTopic(topic.id).find((r) => (r.block || {}).issueId === block.issueId && tray.ACTIVE_STATES.includes(r.status)) || null;
  }
  const pending = trayActivePending(topic.id);
  if (pending && (!replaced || replaced.id !== pending.id)) return bad("pending-conflict", `「${(pending.block || {}).title || ""}」がまだ未回答です`);

  // 依存の候補と被覆（§5）。質問の dependsOn は任意で被覆を求めないが、書かれていれば保持する
  let accepted = { dependsOn: block.dependsOn || [], exclude: block.exclude || [] };
  if (v.kind === "start-task") {
    const others = state.trayRequests.filter((r) => !replaced || r.id !== replaced.id);
    const candidates = tray.dependencyCandidates({ basis: block.basis, requests: others, topicId: topic.id, relayId: topic.relay.id || null });
    const r = tray.resolveDependencies({ block, candidates, requests: others, topicId: topic.id });
    if (!r.ok) return trayReject(topic, agent, [...new Set(r.errors.map((e) => e.code))], r.errors.slice(0, 5).map((e) => `${e.path}: ${e.message}`).join(" / "));
    accepted = r;
  }

  // 展開した集合をブロックへ書き戻してから版を決める（§5.2。後から無言で依存先が変わらない）
  const finalBlock = tray.normalizeRequestBlock({ ...block, dependsOn: accepted.dependsOn, exclude: accepted.exclude });
  const request = {
    id: "req_" + id(),
    topicId: topic.id,
    proposer: agent,
    relayId: topic.relay.id || null,
    fromMessageId: msgId || null,
    kind: v.kind,
    status: "pending",
    block: finalBlock,
    acceptedDependsOn: accepted.dependsOn,
    acceptedExclude: accepted.exclude,
    basisDigest,
    detailsDigests,
    proposalSha256: tray.computeProposalSha256({ topicId: topic.id, proposer: agent, block: finalBlock, basisDigest, detailsDigests }),
    answer: null,
    decision: null,
    plan: null,
    supersededBy: null,
    ts: Date.now(),
    updatedTs: Date.now(),
    checks: null,
  };
  if (replaced) {
    replaced.status = "superseded";
    replaced.supersededBy = request.id;
    if (!trayWrite(replaced)) return trayReject(topic, agent, ["log-write-failed"], "tray.jsonl へ書けませんでした");
  }
  if (!trayWrite(request)) return trayReject(topic, agent, ["log-write-failed"], "tray.jsonl へ書けませんでした");
  state.trayRequests.push(request);
  logEvent("tray", `${NAMES[agent]} の${v.kind === "question" ? "質問" : "着手提案"}を受け付けました: ${finalBlock.title}`, "info");
  trayRefresh(request).then(touch, () => {});
  touch();
  return request;
}

// 回答・修正・見送りは参加者全員へ 1 件ずつ届ける。maybeTrigger は呼ばない（全員同時起動を避ける・§9.2）
function trayShare(topic, text, meta) {
  const created = (topic.participants || LEGACY_AGENTS).map((t) => ({
    id: id(),
    topicId: topic.id,
    thread: t,
    author: "user",
    text,
    tray: meta,
    provenance: { ingress: "ui", delivery: "direct", trigger: "manual", source: null },
    ts: Date.now(),
  }));
  state.messages.push(...created);
  return created;
}

const trayThreadRunning = (topicId) => Object.values(runs).some((r) => r.kind === "thread" && r.topicId === topicId);

// 継続予約（§10.3）。リレー進行中は次の手番に任せる。予約は 1 件だけで、新しい予約が古い予約を上書きする
function trayReserveContinuation(topic, agent, requestId, reason) {
  if (!agent || !(topic.participants || LEGACY_AGENTS).includes(agent)) return null;
  if (topic.relay.active) return null;
  const reservation = { agent, requestId, reason, ts: Date.now(), armed: true };
  topic.trayContinuation = reservation;
  // すぐ起動できる場合 trayFireContinuation が topic.trayContinuation を null にするので、
  // 呼び出し側へは「何を予約したか」を返す（topic 側を読み直すと null になる）
  trayFireContinuation(topic);
  return { ...reservation, fired: topic.trayContinuation === null };
}

function trayFireContinuation(topic) {
  const c = topic && topic.trayContinuation;
  if (!c || !c.armed) return; // 再起動で復元した予約は armed でない ＝ 勝手には走らない（§12.3）
  if (topic.relay.active || trayThreadRunning(topic.id)) return; // 実行中なら完了後に改めて
  if (!agentAutoOn(c.agent)) return; // 自動応答 OFF・上限停止のときは予約を残して理由を見せる
  if (c.agent === "grok" && state.agents.grok.authed !== true) return;
  topic.trayContinuation = null;
  agentLoop(topic.id, c.agent);
}

// 「3 人で再検討」（§9.4 の mode: "rediscuss"）。同じトピックで質疑リレーを 1 本開始する。
// 旧依頼は revision-requested のまま履歴に残し、旧合意（relayHistory）には手を触れない。
// check: true なら始められるかだけ確かめる（押した後に「やっぱり無理でした」にしないため）
function trayRediscuss(topic, request, targets, note, { check = false } = {}) {
  if (topic.relay.active) return { error: "このトピックでは質疑が進行中です。終わってから再検討を始めてください" };
  const order = (topic.participants || LEGACY_AGENTS).slice();
  const first = request.proposer; // 修正を受ける当人から始める
  const labels = targets.map((t) => tray.REVISION_TARGET_LABELS[t] || t);
  const title = (request.block || {}).title || "";
  if (check) return openRelay(topic, { first, order, check: true });
  const text = [
    `【判断トレイ】「${title}」の進め方を、3 人で再検討してください。`,
    `直してほしいところ: ${labels.join(" / ")}`,
    note ? `補足: ${note}` : "",
    `元の提案: ${request.id}（${NAMES[request.proposer] || request.proposer}の提案）`,
    (request.block || {}).outcome ? `元の狙い: ${request.block.outcome}` : "",
    (request.block || {}).baseCommit ? `元の基点: ${request.block.baseCommit}` : "",
    "元の提案と合意はそのまま履歴に残してあります。結論が出たら、新しい依頼ブロックとして出し直してください。",
  ]
    .filter(Boolean)
    .join("\n");
  return openRelay(topic, { first, order, agenda: `${title} の再検討（${labels.join("・")}）`, text });
}

// ---- 承認計画の実行（§10）----

function trayTaskFor(request, t) {
  const b = request.block;
  const detail = [
    `目的: ${b.outcome}`,
    `範囲: ${(t.scope || []).join(" / ")}`,
    b.outOfScope && b.outOfScope.length ? `範囲外: ${b.outOfScope.join(" / ")}` : "",
    `基点: ${b.baseCommit}`,
    (b.details || []).length ? `参照: ${b.details.join(" / ")}` : "",
    `判断トレイの承認: ${request.id}`,
  ]
    .filter(Boolean)
    .join("\n");
  const task = {
    id: id(),
    agent: t.agent,
    topicId: request.topicId,
    title: t.title,
    detail,
    status: "queued",
    fromMessageId: request.fromMessageId || null,
    result: "",
    ts: Date.now(),
  };
  state.tasks.push(task);
  return task;
}

function traySendEntry(request, entry) {
  const topic = findTopic(request.topicId);
  if (!topic) return;
  const participants = topic.participants || LEGACY_AGENTS;
  const blocked = tray.sendBlockers(entry.agent, { agents: state.agents, budgetHalt: state.budgetHalt, participants });
  if (blocked.length) {
    entry.send = blocked.some((b) => b.severity === "block") ? "blocked" : "ready";
    entry.error = blocked.map((b) => b.message).join(" / ");
    return;
  }
  const task = state.tasks.find((t) => t.id === entry.taskId);
  const msg = {
    id: id(),
    topicId: topic.id,
    thread: entry.agent,
    author: "user",
    text: `▶ 着手をお願いします（タスク: ${task ? task.title : entry.key}）\n${task ? task.detail : ""}`,
    tray: { kind: "start", requestId: request.id, taskKey: entry.key, taskId: entry.taskId },
    provenance: { ingress: "ui", delivery: "direct", trigger: "manual", source: null },
    ts: Date.now(),
  };
  try {
    state.messages.push(msg);
    entry.send = "sent";
    entry.messageId = msg.id;
    entry.sentTs = msg.ts;
    entry.error = null;
    agentLoop(topic.id, entry.agent); // 担当 1 名だけを起こす
  } catch (e) {
    entry.send = "failed";
    entry.error = String(e.message || e).slice(0, 200);
  }
}

// 前提が done になった計画の後続を送る（追加承認は求めない・§10.2）
function trayAdvancePlans(topicId = null) {
  let changed = false;
  for (const r of state.trayRequests) {
    if (r.status !== "approved" || !r.plan) continue;
    if (topicId && r.topicId !== topicId) continue;
    const topic = findTopic(r.topicId);
    if (!topic) continue;
    const participants = topic.participants || LEGACY_AGENTS;
    let touched = false;
    for (const e of r.plan.entries) {
      if (e.send === "sent") continue;
      const next = tray.planSendState(e, { entries: r.plan.entries, tasks: state.tasks, participants });
      if (next !== "ready") {
        if (e.send !== next && e.send !== "failed") {
          e.send = next;
          touched = true;
        }
        continue;
      }
      if (!e.taskId) {
        const spec = (r.block.tasks || []).find((t) => t.key === e.key);
        if (spec) e.taskId = trayTaskFor(r, spec).id;
        touched = true;
      }
      const before = e.send + "\0" + (e.error || "");
      traySendEntry(r, e);
      if (before !== e.send + "\0" + (e.error || "")) touched = true; // 変化が無ければログ行を増やさない
    }
    if (touched) {
      trayWrite(r);
      changed = true;
    }
  }
  return changed;
}

// ---- トレイ API の本体（§9.2〜§9.7）----

const ACTION_TRANSITION = { answer: "answer", approve: "approve", revision: "revision", reject: "reject", park: "park", unpark: "unpark" };

async function trayAction(req, res, requestId, action) {
  if (!trayLog.ok) return json(res, 503, { error: "tray.jsonl を読み書きできません", code: "log-unavailable", detail: trayLog.error });
  const request = trayFind(requestId);
  if (!request) return json(res, 404, { error: "依頼が見つかりません", code: "request-not-found" });
  let body;
  try {
    body = await readBody(req);
  } catch {
    return json(res, 400, { error: "本文が JSON ではありません", code: "invalid-json" });
  }
  const topic = findTopic(request.topicId);
  if (!topic) return json(res, 404, { error: "トピックが見つかりません", code: "topic-not-found" });

  const view = () => trayViewNow().requests[request.id];
  const stale = () => json(res, 409, { error: "提案の内容が変わっています。表示し直してください", code: "stale-proposal", current: view() });

  // 再送は承認済みの計画に対する操作なので、版だけを見る（状態遷移はしない）
  if (action === "retry") {
    if (body.proposalSha256 !== request.proposalSha256) return stale();
    if (request.status !== "approved" || !request.plan) return json(res, 409, { error: "承認済みの計画がありません", code: "no-plan" });
    const keys = typeof body.taskKey === "string" ? [body.taskKey] : request.plan.entries.map((e) => e.key);
    for (const e of request.plan.entries) {
      if (!keys.includes(e.key) || e.send === "sent") continue;
      if (e.send === "failed" || e.send === "ready" || e.send === "blocked") e.send = "ready";
      e.error = null;
    }
    trayAdvancePlans(request.topicId);
    trayWrite(request);
    touch();
    return json(res, 200, { request: view(), plan: request.plan });
  }

  if (typeof body.proposalSha256 !== "string") return json(res, 400, { error: "proposalSha256 は必須です", code: "invalid-request", errors: [{ code: "missing", path: "proposalSha256", message: "押した版を明示してください" }] });
  // 承認の冪等（§9.3）: 同じ提案・同じ版の 2 回目は新規作成せず最初の結果を返す
  if (action === "approve" && request.status === "approved" && request.plan && tray.idempotencyKey(request.id, body.proposalSha256) === tray.idempotencyKey(request.id, request.plan.proposalSha256)) {
    return json(res, 200, { request: view(), plan: request.plan, idempotent: true });
  }
  if (body.proposalSha256 !== request.proposalSha256) return stale();
  if (!tray.canTransition(request.status, ACTION_TRANSITION[action])) {
    return json(res, 409, { error: `この依頼は「${request.status}」なのでこの操作はできません`, code: tray.TERMINAL_STATES.includes(request.status) ? "already-final" : "invalid-transition", status: request.status });
  }

  // 退避・復帰は評価を要しない（依存は解除されないが、押せない理由とは無関係）
  if (action === "park" || action === "unpark") {
    if (action === "unpark" && trayActivePending(topic.id)) return json(res, 409, { error: "このトピックには未回答の依頼がすでにあります", code: "pending-conflict" });
    request.status = action === "park" ? "parked" : "pending";
    if (!trayWrite(request)) return json(res, 500, { error: "tray.jsonl へ書けませんでした", code: "log-write-failed" });
    touch();
    return json(res, 200, { request: view() });
  }

  await trayRefresh(request); // 押す直前にもう一度調べる（§8）
  const blockers = trayEvaluateOne(request).blockers;
  const hard = blockers.filter((b) => b.severity === "block");
  if (hard.length && (action === "answer" || action === "approve")) return json(res, 409, { error: hard[0].message, code: "not-actionable", blockers });

  if (action === "answer") {
    if (request.kind !== "question") return json(res, 400, { error: "これは質問ではありません", code: "not-a-question" });
    const qs = request.block.questions || [];
    const answers = Array.isArray(body.answers) ? body.answers : null;
    const errors = [];
    if (!answers || answers.length !== qs.length) errors.push({ code: "answers-incomplete", path: "answers", message: "全問に 1 件ずつ答えてください" });
    else {
      for (const q of qs) {
        const hit = answers.filter((a) => a && a.questionId === q.id);
        if (hit.length !== 1) {
          errors.push({ code: "answers-incomplete", path: "answers", message: `「${q.text}」への回答が ${hit.length} 件です` });
          continue;
        }
        const a = hit[0];
        const known = [...q.options.map((o) => o.id), ...tray.SYSTEM_OPTIONS];
        if (!known.includes(a.optionId)) errors.push({ code: "answers-unknown-option", path: "answers", message: `「${a.optionId}」はこの問の選択肢ではありません` });
        if (a.optionId === "__other" && !(typeof a.text === "string" && a.text.trim() && Array.from(a.text.trim()).length <= tray.LIMITS.note)) {
          errors.push({ code: "answers-text-required", path: "answers", message: "「その他」には内容を書いてください" });
        }
        if (a.optionId === "__defer" && a.text !== undefined) errors.push({ code: "answers-text-forbidden", path: "answers", message: "「あとで答える」に内容は付けられません" });
      }
      for (const a of answers) if (!qs.some((q) => q.id === (a || {}).questionId)) errors.push({ code: "answers-unknown-question", path: "answers", message: `${(a || {}).questionId} という問はありません` });
    }
    if (errors.length) return json(res, 400, { error: errors[0].message, code: "invalid-request", errors });

    // 全問「あとで答える」は回答ではなく退避（§9.2。回答済みにすると依存する着手が押せてしまう）
    if (answers.every((a) => a.optionId === "__defer")) {
      request.status = "parked";
      if (!trayWrite(request)) return json(res, 500, { error: "tray.jsonl へ書けませんでした", code: "log-write-failed" });
      touch();
      return json(res, 200, { request: view(), parked: true });
    }
    const answerId = id();
    request.status = "answered";
    request.answer = { answerId, answers, proposalSha256: request.proposalSha256, ts: Date.now() };
    if (!trayWrite(request)) return json(res, 500, { error: "tray.jsonl へ書けませんでした", code: "log-write-failed" });
    const messages = trayShare(topic, tray.answerSummaryText(request, answers), { kind: "answer", requestId: request.id, proposalSha256: request.proposalSha256, answerId });
    const cont = trayReserveContinuation(topic, request.block.continueAgent || request.proposer, request.id, "answer");
    trayAdvancePlans(topic.id); // 依存が解けた計画があれば進める
    touch();
    return json(res, 200, { request: view(), messages, continuation: cont });
  }

  if (action === "approve") {
    if (request.kind !== "start-task") return json(res, 400, { error: "これは着手提案ではありません", code: "not-a-proposal" });
    const prevStatus = request.status;
    const created = request.block.tasks.map((t) => trayTaskFor(request, t));
    const taskIds = Object.fromEntries(created.map((task, i) => [request.block.tasks[i].key, task.id]));
    request.status = "approved";
    request.plan = { approvedTs: Date.now(), proposalSha256: request.proposalSha256, entries: tray.planFromTasks({ tasks: request.block.tasks, taskIds }) };
    if (!trayWrite(request)) {
      // 記録できなければ承認は無かったことにする（タスクだけ残って「承認していないのに作業依頼が来る」を避ける）
      for (const task of created) state.tasks.splice(state.tasks.indexOf(task), 1);
      request.status = prevStatus;
      request.plan = null;
      return json(res, 500, { error: "tray.jsonl へ書けませんでした", code: "log-write-failed" });
    }
    const lines = request.plan.entries.map((e) => `・${NAMES[e.agent]}: ${(request.block.tasks.find((t) => t.key === e.key) || {}).title || e.key}` + (e.after.length ? `（${e.after.join(" / ")} の完了後に指示）` : "（承認後に指示）"));
    const messages = trayShare(topic, `【判断トレイ】「${request.block.title}」を承認しました。${request.plan.entries.length} 件のタスクを登録します。\n${lines.join("\n")}`, {
      kind: "approved",
      requestId: request.id,
      proposalSha256: request.proposalSha256,
    });
    trayAdvancePlans(topic.id); // after の無い要素をここで送る
    touch();
    return json(res, 200, { request: view(), plan: request.plan, messages });
  }

  if (action === "revision" || action === "reject") {
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (Array.from(note).length > tray.LIMITS.note) return json(res, 400, { error: "note が長すぎます", code: "invalid-request", errors: [{ code: "note-too-long", path: "note", message: "2000 文字までです" }] });
    let targets = [];
    let mode = "proposer";
    if (action === "revision") {
      targets = Array.isArray(body.targets) ? [...new Set(body.targets)] : [];
      if (!targets.length || targets.some((t) => !tray.REVISION_TARGETS.includes(t))) {
        return json(res, 400, { error: "どこを直してほしいかを 1 つ以上選んでください", code: "invalid-request", errors: [{ code: "targets-invalid", path: "targets", message: tray.REVISION_TARGETS.join(" / ") }] });
      }
      if (targets.includes("other") && !note) return json(res, 400, { error: "「その他」を選んだときは内容を書いてください", code: "invalid-request", errors: [{ code: "note-required", path: "note", message: "内容が要ります" }] });
      mode = body.mode === undefined ? "proposer" : body.mode;
      if (!tray.REVISION_MODES.includes(mode)) {
        return json(res, 400, { error: "mode は proposer か rediscuss です", code: "invalid-request", errors: [{ code: "mode-invalid", path: "mode", message: tray.REVISION_MODES.join(" / ") }] });
      }
      // 始められないなら、押す前に断る（状態は変えない）。合意メモ §11「結果が明記された最後のボタンで確定」
      if (mode === "rediscuss") {
        const can = trayRediscuss(topic, request, targets, note, { check: true });
        if (can.error) return json(res, 409, { error: can.error, code: "rediscuss-unavailable", ...(can.reason ? { reason: can.reason, agent: can.agent } : {}) });
      }
    }
    request.status = action === "revision" ? "revision-requested" : "rejected";
    request.decision = { kind: action, targets, note, mode: action === "revision" ? mode : undefined, ts: Date.now() };
    if (!trayWrite(request)) return json(res, 500, { error: "tray.jsonl へ書けませんでした", code: "log-write-failed" });
    const LABEL = tray.REVISION_TARGET_LABELS;
    const where = targets.map((t) => LABEL[t] || t).join(" / ");
    const text =
      action === "revision"
        ? `【判断トレイ】「${request.block.title}」に修正を依頼しました（${where}${mode === "rediscuss" ? "／3 人で再検討" : ""}）${note ? "\n" + note : ""}`
        : `【判断トレイ】「${request.block.title}」は見送りにしました${note ? "\n" + note : ""}`;
    const messages = trayShare(topic, text, { kind: action, requestId: request.id, proposalSha256: request.proposalSha256, mode: action === "revision" ? mode : undefined });
    // 送り先は 2 通り（§9.4）。rediscuss は質疑に手番があるので継続予約はしない。
    // 見送りは続きを求めていないので、どちらもしない
    let cont = null;
    let relay = null;
    if (action === "revision" && mode === "rediscuss") {
      const started = trayRediscuss(topic, request, targets, note);
      if (started.error) {
        // 直前の検査は通っているので、ここに来るのは競合したときだけ。依頼は修正待ちのまま残す
        logEvent("tray", "3 人での再検討を開始できませんでした: " + started.error, "warn");
        touch();
        return json(res, 409, { error: started.error, code: "rediscuss-unavailable", request: view() });
      }
      relay = started.relay;
      agentLoop(topic.id, started.first); // 先手の 1 名だけ
    } else if (action === "revision") {
      cont = trayReserveContinuation(topic, request.proposer, request.id, "revision");
    }
    touch();
    return json(res, 200, { request: view(), messages, continuation: cont, relay, mode: action === "revision" ? mode : undefined });
  }
  return json(res, 400, { error: "不明な操作です", code: "invalid-request", errors: [] });
}

// 判断トレイの依頼は data/tray.jsonl が正本（契約 §12.1）。
// 読み込みは logEvent / events が初期化された後で行う。継続予約は復元するが armed でないので、
// ここで CLI が動き出すことはない（§12.3）
trayLoadLog();

// ---- 出所の検査（ローカル専用アプリの最低限の防御）----
// Host: DNS リバインディング対策。GET も含めて全要求で見る。
// Origin: CSRF 対策。GET / HEAD 以外で見る。enctype="text/plain" のフォームは
//   プリフライト無しで本文全体を妥当な JSON にできるので、Content-Type や JSON.parse を防御の根拠にしない。
// Origin 欠席（curl・テスト・他のローカルツール）は Host が正しければ通す。
// "null"（file:// や sandbox の iframe）は拒否する。正規の画面は必ず http://127.0.0.1:<PORT> から開く。
// 待ち受けは 127.0.0.1 だけ（末尾の listen）。localhost / [::1] を許可しているのはヘッダの綴りの話で、
// 到達性は別問題 — localhost が ::1 に解決される環境では、この検査より前に TCP 接続が失敗する
const ALLOWED_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];
const ALLOWED_ORIGINS = ALLOWED_HOSTS.map((h) => "http://" + h);

function checkRequestOrigin(req) {
  if (!ALLOWED_HOSTS.includes(req.headers.host || "")) return "host";
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return null;
  const origin = req.headers.origin;
  if (origin === undefined) return null; // ブラウザ以外からの要求
  return ALLOWED_ORIGINS.includes(origin) ? null : "origin";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  // 本文を読む前に拒否する（読んでしまうと、拒否しても副作用の判断材料が増えるだけで意味がない）
  const denied = checkRequestOrigin(req);
  if (denied) {
    logEvent("security", `ローカル以外からの要求を拒否しました（${denied}）: ${req.method} ${url.pathname}`, "warn");
    return json(res, 403, { error: "このアプリはローカル（127.0.0.1 / localhost / [::1]）からのアクセスだけを受け付けます", code: "forbidden-origin", reason: denied });
  }
  // 403（出所）と 401（資格）は別の事象として記録する（契約 §4.4）。ここも本文を読む前
  const unauth = checkApiCredential(req, url);
  if (unauth) {
    logEvent("security", `管理資格が無い要求を拒否しました（${unauth.code}）: ${req.method} ${url.pathname}`, "warn");
    return json(res, unauth.status, { error: unauth.error, code: unauth.code });
  }
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

fs.mkdirSync(POOL_TRASH, { recursive: true });
fs.mkdirSync(POOL_VERSIONS, { recursive: true });
verifLoadLog(); // 検証の追記ログを先に復元する（起動時の走査で登録された manifest.json の自動取込が使う）
migratePoolItems();
syncVersionsFromManifests();
scanPoolDir();
try {
  writeThreadMirrors();
} catch {
  // 起動時のミラー生成失敗は無視（次の保存時に再試行される）
}
initIsolation(); // state を読んだ後（前回の検証記録を見るため）、待ち受けを開く前
sweepRunRedirects(); // 調査用に残した退避ファイルの期限掃除（P1-2）
saveState();

server.listen(PORT, "127.0.0.1", () => {
  printCredentialBanner(); // 資格は端末にだけ出す。ファイルにもログにも残さない（§4.1）
  logEvent("system", "サーバー起動（schemaVersion 10）", "info");
  logEvent("isolation", sandbox.describeIsolation(isolation), isolation.mode === "enforced" ? "info" : "warn");
  if (state.agents.grok) checkGrokAuth().catch((e) => logEvent("cli", "Grok の認証確認に失敗: " + (e.message || e), "warn"));
});
