// U2A2A Orchestration — zero-dependency local server
// User <-> Claude Code <-> Codex message hub + task queue.
// State persists to data/state.json; clients sync over SSE.
// Agent auto-reply: spawns `claude -p` / `codex exec` CLIs (read-only) when available.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const REPO_ROOT = path.resolve(__dirname, "..");
// 共有タスクプールの実体はリポジトリ内のフォルダ（DAS）。
// エージェント CLI（cwd=リポジトリ・読み取り可）からパスでそのまま読める。
const POOL_DIR = path.join(__dirname, "pool");
const POOL_TRASH = path.join(POOL_DIR, ".trash");
// スレッド履歴の自動ミラー置き場（成果物アイテムとしては登録しないシステム領域）
const POOL_THREADS = path.join(POOL_DIR, "threads");
const PORT = Number(process.env.U2A2A_PORT || 4742);

const AGENTS = ["claude", "codex"];
const AUTHORS = ["user", "claude", "codex"];
const TASK_STATUSES = ["queued", "working", "returned", "done"];
const AGENT_TIMEOUT_MS = 15 * 60 * 1000; // 大きな成果物のレビューは5分では足りない
const MAX_BACKLOG = 10;

// エージェントのグローバル設定（トピック横断）
function defaultAgent() {
  return { auto: true, lastError: "", model: "", modelOverride: "" };
}

// トピック内のエージェント別セッション状態
function topicAgent() {
  return { sessionId: null, lastSeenTs: Date.now(), transcriptOffset: null };
}

function defaultRelay() {
  return { active: false, remaining: 0, hopsDone: 0 };
}

function defaultTopic(title) {
  return {
    id: crypto.randomBytes(8).toString("hex"),
    title,
    ts: Date.now(),
    relay: defaultRelay(),
    agents: { claude: topicAgent(), codex: topicAgent() },
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
    agents: { claude: defaultAgent(), codex: defaultAgent() },
    budgets: defaultBudgets(),
    usageDay: null,
    budgetHalt: null,
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

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.messages) && Array.isArray(parsed.tasks)) {
      parsed.agents = parsed.agents || {};
      if (!Array.isArray(parsed.pool)) parsed.pool = [];
      // 旧形式（単一スレッド）→ トピック制へ移行
      if (!Array.isArray(parsed.topics) || !parsed.topics.length) {
        const main = defaultTopic("メイン");
        for (const a of AGENTS) {
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
        const old = parsed.agents[a] || {};
        parsed.agents[a] = { ...defaultAgent(), auto: old.auto !== false, lastError: "", model: old.model || "", modelOverride: old.modelOverride || "" };
      }
      for (const t of parsed.topics) {
        t.relay = defaultRelay(); // 再起動後にリレーが勝手に再開しないよう常に解除
        for (const a of AGENTS) t.agents[a] = { ...topicAgent(), ...t.agents[a] };
      }
      delete parsed.relay;
      parsed.budgets = { ...defaultBudgets(), ...(parsed.budgets || {}) };
      parsed.usageDay = parsed.usageDay || null;
      parsed.budgetHalt = parsed.budgetHalt || null;
      for (const m of parsed.messages) migrateMeta(m);
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
      return parsed;
    }
  } catch {
    // first run or unreadable file — start fresh
  }
  return emptyState();
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
    state.schemaVersion = 3;
    const jsonStr = JSON.stringify(state, null, 2);
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
    `claudeSession: ${t.agents.claude.sessionId || "(未開始)"}\n` +
    `codexSession: ${t.agents.codex.sessionId || "(未開始)"}\n` +
    (t.branchedFrom
      ? `branchedFrom: ${(findTopic(t.branchedFrom.topicId) || {}).title || t.branchedFrom.topicId}（message ${t.branchedFrom.messageId}）\n`
      : "") +
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
      if (pv.source) {
        // 受信側の中継コピーは冒頭のみ（原文は送信元レーンに全文が残る）
        const headLine = m.text.split("\n").find((l) => l.trim()) || "";
        return `${head}\n\n> ↪ ${NAMES[pv.source.agent]} 側から中継: ${headLine.slice(0, 100)}${m.text.length > 100 ? "…（全文は中継元を参照）" : ""}\n`;
      }
      return `${head}\n\n${m.text}\n`;
    })
    .join("\n");

  return (
    fm +
    `# ${t.title}\n\n` +
    `（U2A2A スレッド履歴 — 自動生成ミラー。編集しても会話には反映されません）\n\n` +
    summarySec + artifactSec + taskSec +
    `## 💬 履歴\n\n` + history
  );
}

function writeThreadMirrors() {
  fs.mkdirSync(POOL_THREADS, { recursive: true });
  const valid = new Set();
  for (const t of state.topics) {
    const rel = threadMirrorName(t);
    valid.add(rel);
    t.mirrorFile = rel;
    const msgs = state.messages.filter((m) => m.topicId === t.id);
    const body = buildThreadMirror(t, msgs);
    if (mirrorCache[rel] === body) continue;
    fs.writeFileSync(path.join(POOL_DIR, rel), body);
    mirrorCache[rel] = body;
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
  if (r) bumpUsageDay(Date.now() - r.startedAt);
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
  return state.messages.reduce(
    (a, m) => a + (m.topicId === topicId && m.meta && m.meta.billing && m.meta.billing.mode === "metered" ? m.meta.billing.usd : 0),
    0
  );
}

// 上限超過なら理由文字列を返す。走行中の経過時間も含めて判定する
function budgetStatus(topicId) {
  const b = state.budgets || {};
  const day = todayStr();
  const ud = state.usageDay && state.usageDay.date === day ? state.usageDay : { runs: 0, ms: 0 };
  const inflightMs = Object.values(runs).reduce((a, r) => a + (Date.now() - r.startedAt), 0);
  if (b.runCount && ud.runs >= b.runCount) return `本日の実行回数上限（${b.runCount}回）に到達`;
  if (b.runMinutes && ud.ms + inflightMs >= b.runMinutes * 60000)
    return `本日の累計実行時間上限（${b.runMinutes}分）に到達`;
  if (b.topicUsd && topicId) {
    const usd = topicCostUsd(topicId);
    if (usd >= b.topicUsd) return `このトピックのコスト上限（$${b.topicUsd}）に到達（累計 $${usd.toFixed(2)}）`;
  }
  return null;
}

// 上限到達: 自動実行・全質疑リレーを停止し、理由を記録して UI に明示する
function triggerBudgetHalt(topicId, agent, reason) {
  if (state.budgetHalt) return;
  state.budgetHalt = { reason, ts: Date.now() }; // 安全ラッチ（ユーザーの auto 設定には触れない）
  for (const t of state.topics) t.relay = defaultRelay();
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

function publicState() {
  // running / reviewPending / fixPending は互換用の派生値。正は runs レジストリ
  return { ...state, running, reviewPending, fixPending, activity, poolDirs, runs: publicRuns(), events, storageMetrics };
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

// ---- agent CLI runners ----
const NAMES = { user: "ユーザー", claude: "Claude Code", codex: "Codex" };
const OTHER = { claude: "codex", codex: "claude" };
const QA_END_MARK = "【質疑終了】";

function spawnEnv() {
  const extra = [path.join(os.homedir(), ".homebrew/bin"), path.join(os.homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  return { ...process.env, PATH: [process.env.PATH, ...extra].filter(Boolean).join(":") };
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

function runCli(cmd, args, stdinData, timeoutMs = AGENT_TIMEOUT_MS, onLine = null, cwd = REPO_ROOT, ctl = null) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: spawnEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
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
    if (onLine) {
      child.stdout.on("data", (d) => {
        lineBuf += d;
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
      });
    }
    const timer = setTimeout(() => {
      killTree(child, "SIGKILL");
      err += `\n(タイムアウト: ${timeoutMs / 1000}秒)`;
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      closed = true;
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e.message || e), cancelled: !!(ctl && ctl.cancelled) });
    });
    child.on("close", (code) => {
      closed = true;
      clearTimeout(timer);
      resolve({ code, out, err, cancelled: !!(ctl && ctl.cancelled) });
    });
  });
}

function buildPrompt(topic, agent, msgs, isFirst) {
  const other = agent === "claude" ? "codex" : "claude";
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
      return `[${NAMES[m.author]}] ${m.text}`;
    })
    .join("\n\n");
  const preamble = isFirst
    ? `あなたは「U2A2Aオーケストレーション」アプリの ${NAMES[agent]} 側スレッドの担当エージェントです。` +
      `このスレッドのトピックは「${topic.title}」です。` +
      `参加者はユーザー・${NAMES[agent]}（あなた）・${NAMES[other]} の三者です。` +
      (agent === "claude"
        ? `作業ディレクトリは Kometa リポジトリ（閲覧のみ、変更は不可）。`
        : `作業ディレクトリは u2a2a/pool（成果物置き場・書き込み可）。Kometa リポジトリ本体（${REPO_ROOT}）は閲覧のみ。`) +
      `新着メッセージに ${NAMES[agent]} として日本語で簡潔に返答してください。` +
      `実装作業が必要な場合は作業内容を提案し、タスク化はユーザーに委ねてください。\n\n--- 新着メッセージ ---\n`
    : "--- 新着メッセージ ---\n";
  const qaNote = topic.relay.active
    ? `\n\n（現在 ${NAMES[other]} との質疑応答モードです。議論が浅いうちは結論に飛びつかず、質問・反論・検討を返してください。` +
      `${QA_END_MARK} は、相手の見解を少なくとも一度聞いた上で合意・結論に達した場合のみ、応答の末尾に書いてください。` +
      `相手がまだ発言していない段階での終了宣言は無効です。残り自動中継 ${topic.relay.remaining} 手）`
    : "";
  const artifactNote =
    agent === "claude"
      ? `\n\n（成果物ファイルは u2a2a/pool/ 配下にのみ保存できます（他への書き込みは不許可）。` +
        `画像・音声・動画は python3 / ffmpeg を実行して生成できます（PNG/GIF/MP4/WAV 等。保存先は必ず u2a2a/pool/ 配下）。` +
        `保存したら本文にそのパスを書いてください — アプリが画像・動画・音声をインライン表示します）`
      : `\n\n（カレントディレクトリ（u2a2a/pool/ = 成果物置き場）にのみファイルを保存できます。` +
        `python3 / ffmpeg を実行して画像・音声・動画（PNG/GIF/MP4/WAV 等）を生成できます。` +
        `リポジトリ本体は ${REPO_ROOT} を絶対パスで参照（閲覧のみ）。` +
        `保存したら本文に u2a2a/pool/〜 のパスを書いてください — アプリがインライン表示します。` +
        `短い SVG 等は本文のコードブロックでも構いません）`;
  // キャンセル等で新セッションになった場合、保存済み要約で文脈を再注入する
  const contextNote =
    isFirst && topic.summaryText && state.messages.some((m) => m.topicId === topic.id)
      ? `\n\n--- これまでのスレッドの要約（新しいセッションのための文脈） ---\n${topic.summaryText}\n`
      : "";
  return preamble + contextNote + lines + qaNote + artifactNote;
}

// 質疑モード: エージェントの応答完了を待って相手スレッドへ中継する（トピック単位）
function qaHop(topic, agent, replyText, sourceMsgId) {
  const r = topic.relay;
  if (!r.active) return;
  // 終了宣言は相手が一度でも発言した後（=中継が1回以上済み）のみ有効。
  // 先手が初手で終了宣言しても、相手に見せるまではリレーを続ける。
  if (replyText.includes(QA_END_MARK) && r.hopsDone > 0) {
    r.active = false;
    summarizeTopic(topic.id); // 質疑の決着は要約の節目
    return;
  }
  if (r.remaining <= 0) {
    r.active = false;
    return;
  }
  r.remaining--;
  r.hopsDone++;
  const other = OTHER[agent];
  state.messages.push({
    topicId: topic.id,
    id: id(),
    thread: other,
    author: agent,
    text: replyText,
    provenance: {
      ingress: "agent-loop",
      delivery: "qa-relay",
      trigger: "auto",
      source: { topicId: topic.id, messageId: sourceMsgId || null, agent },
    },
    ts: Date.now(),
  });
  if (r.remaining <= 0) r.active = false; // 最終手: 相手は応答するがそれ以上は中継しない
  if (agentAutoOn(other)) agentLoop(topic.id, other);
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
  const { code, err, out, cancelled } = await runCli("claude", args, prompt, AGENT_TIMEOUT_MS, onLine, opts.cwd, opts.ctl);
  if (cancelled)
    throw Object.assign(new Error("キャンセルされました"), {
      cancelled: true,
      meta: {
        status: "cancelled",
        model: modelOverride || "",
        durationMs: Date.now() - t0,
        usage: { inTok: 0, outTok: 0, cacheTok: 0 },
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
  const args = sessionId
    ? ["exec", "resume", sessionId, "-", ...base, "-c", `sandbox_mode="${opts.resumeWritable ? "workspace-write" : "read-only"}"`]
    : opts.writeDir
      ? ["exec", "-", ...base, "-s", "workspace-write", "-C", opts.writeDir]
      : ["exec", "-", ...base, "-s", "read-only", "-C", REPO_ROOT];
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
  const { code, out, err, cancelled } = await runCli("codex", args, prompt, AGENT_TIMEOUT_MS, onLine, REPO_ROOT, opts.ctl);
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

// レビュー用にファイル内容を読む（テキストのみ・先頭8000文字）
function readPoolTextForReview(item) {
  if (!item.file) return item.body || null; // 旧形式フォールバック
  if (!isTextPoolFile(item.file)) return null;
  try {
    const full = fs.readFileSync(poolFilePath(item.file), "utf8");
    if (full.includes("\0")) return null;
    return full.length > 8000 ? full.slice(0, 8000) + `\n…（先頭8000文字のみ。全文は u2a2a/pool/${item.file} を参照）` : full;
  } catch {
    return null;
  }
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
      state.pool.push({
        id: id(),
        title: name,
        file: name,
        origin: "user",
        via: "folder",
        status: "submitted",
        reviews: [],
        ...statPoolFile(name),
        ts: Date.now(),
      });
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

function buildReviewPrompt(item, reviewer) {
  const rel = item.file ? `u2a2a/pool/${item.file}` : null;
  const text = readPoolTextForReview(item);
  const contentPart =
    text != null
      ? `--- 成果物「${item.title}」（持ち込み: ${NAMES[item.origin]}${rel ? `／ファイル: ${rel}` : ""}） ---\n${text}`
      : `成果物「${item.title}」（持ち込み: ${NAMES[item.origin]}）はリポジトリ内のファイル ${rel} にあります。` +
        `内容を読み取ってレビューしてください（読み取れない形式ならその旨を書いてください）。`;
  return (
    `あなたは「U2A2Aオーケストレーション」の共有タスクプール（u2a2a/pool/ = アプリ専用の成果物置き場）のレビュアー（${NAMES[reviewer]}）です。` +
    `以下の成果物を、Kometa リポジトリ（閲覧のみ可）の実態と照らして、忖度なく具体的にレビューしてください。\n` +
    `- 問題点・リスク・改善案を挙げる\n` +
    `- 既存の実装や他タスク・プール内の他成果物との重複、不要な作業の兆候があれば指摘する\n` +
    `- 良い点は簡潔に認める\n` +
    `- 最後に必ず1行、次の形式で判定を書く: 【判定】承認 / 条件付き承認 / 差し戻し\n\n` +
    contentPart
  );
}

async function runReview(itemId, reviewer) {
  const item = state.pool.find((p) => p.id === itemId);
  if (!item) return;
  if ((reviewPending[itemId] || []).includes(reviewer)) return; // 同一レビュアーの多重起動防止
  const overBudget = budgetStatus(null); // レビューは回数/時間の全体枠で判定
  if (overBudget) {
    item.reviews.push({ id: id(), reviewer, text: "（上限到達のためスキップ: " + overBudget + "）", verdict: "", error: true, ts: Date.now() });
    touch();
    return;
  }
  (reviewPending[itemId] ||= []).push(reviewer);
  if (item.status === "submitted") item.status = "reviewing";
  touch();
  const actKey = "review:" + itemId + ":" + reviewer;
  const run = startRun("review", reviewer, { itemId });
  actStart(actKey, NAMES[reviewer] + " レビュー", run.runId);
  try {
    const call = reviewer === "claude" ? callClaude : callCodex;
    const { text, meta } = await call(buildReviewPrompt(item, reviewer), null, state.agents[reviewer].modelOverride, (s) => actStep(actKey, s));
    item.reviews.push({ id: id(), reviewer, text, verdict: verdictFrom(text), meta, ts: Date.now() });
  } catch (e) {
    item.reviews.push({
      id: id(),
      reviewer,
      text: "（レビュー失敗: " + String(e.message || e).slice(0, 300) + "）",
      verdict: "",
      error: true,
      ts: Date.now(),
    });
  } finally {
    endRun(run.runId);
    actEnd(actKey);
    reviewPending[itemId] = (reviewPending[itemId] || []).filter((r) => r !== reviewer);
    if (!reviewPending[itemId].length) delete reviewPending[itemId];
    touch();
  }
}

// ---- レビュー後の修正: 担当エージェントがプールフォルダ限定の書き込み権限でファイルを直す ----

function buildFixPrompt(item, agent) {
  const reviews = (item.reviews || [])
    .filter((r) => !r.error)
    .map((r) => `--- ${NAMES[r.reviewer]} のレビュー（判定: ${r.verdict || "なし"}） ---\n${r.text}`)
    .join("\n\n");
  return (
    `あなたは U2A2A 共有タスクプールの成果物を修正する担当（${NAMES[agent]}）です。` +
    `カレントディレクトリにある成果物ファイル「${item.file}」を、以下のレビューを踏まえて修正し、` +
    `**同じファイル名で上書き保存**してください。新しいファイルは作らないこと。\n` +
    `- 妥当な指摘には対応する\n` +
    `- 誤っている・過剰な指摘には従わず、応答で理由を述べる\n` +
    `- ファイル保存を済ませてから、応答として「何をどう直したか／直さなかったか」の要約を簡潔に書く\n\n` +
    (reviews || "（レビューはまだありません。成果物の品質を自己点検して改善してください）")
  );
}

async function runFix(itemId, agent) {
  const item = state.pool.find((p) => p.id === itemId);
  if (!item || !item.file || fixPending[itemId]) return;
  const overBudget = budgetStatus(null);
  if (overBudget) {
    item.fixes = item.fixes || [];
    item.fixes.push({ id: id(), agent, text: "（上限到達のためスキップ: " + overBudget + "）", error: true, ts: Date.now() });
    touch();
    return;
  }
  fixPending[itemId] = agent;
  const actKey = "fix:" + itemId;
  const run = startRun("fix", agent, { itemId });
  actStart(actKey, NAMES[agent] + " 修正", run.runId);
  // 修正前の版を .trash に世代バックアップ
  try {
    fs.copyFileSync(poolFilePath(item.file), path.join(POOL_TRASH, Date.now() + "-prefix-" + item.file.replaceAll("/", "__")));
  } catch {
    // バックアップ失敗でも修正は続行
  }
  try {
    const prompt = buildFixPrompt(item, agent);
    const onStep = (s) => actStep(actKey, s);
    const override = state.agents[agent].modelOverride;
    const { text, meta } =
      agent === "claude"
        ? await callClaude(prompt, null, override, onStep, {
            cwd: POOL_DIR,
            extraArgs: ["--permission-mode", "acceptEdits"], // 書き込みは cwd=pool/ 内のみ
          })
        : await callCodex(prompt, null, override, onStep, { writeDir: POOL_DIR });
    item.fixes = item.fixes || [];
    item.fixes.push({ id: id(), agent, text, meta, ts: Date.now() });
    const st = statPoolFile(item.file);
    if (st) Object.assign(item, st);
    item.status = "submitted";
    touch();
    // 元レビュアー（修正者以外）が自動で再レビュー
    const reviewers = [...new Set((item.reviews || []).filter((r) => !r.error).map((r) => r.reviewer))].filter((r) => r !== agent);
    for (const r of reviewers.length ? reviewers : [OTHER[agent]]) runReview(item.id, r);
  } catch (e) {
    item.fixes = item.fixes || [];
    item.fixes.push({
      id: id(),
      agent,
      text: "（修正失敗: " + String(e.message || e).slice(0, 300) + "）",
      error: true,
      ts: Date.now(),
    });
  } finally {
    endRun(run.runId);
    actEnd(actKey);
    delete fixPending[itemId];
    touch();
  }
}

// ---- スレッド自動要約 ----
// 節目（12メッセージごと・質疑終了時）に haiku で増分要約し、ミラー冒頭の 📌概要 を更新する
const SUMMARY_EVERY = 12;
const summaryPending = new Set();

async function summarizeTopic(topicId) {
  const topic = findTopic(topicId);
  if (!topic || summaryPending.has(topicId)) return;
  const msgs = state.messages.filter((m) => m.topicId === topicId);
  if (!msgs.length) return;
  summaryPending.add(topicId);
  try {
    const recent = msgs.filter((m) => !(m.provenance && m.provenance.source)).slice(-40);
    const lines = recent
      .map((m) => `[${NAMES[m.author]}→${NAMES[m.thread]}側] ${m.text.slice(0, 500)}`)
      .join("\n\n");
    const prompt =
      `以下は「U2A2Aオーケストレーション」のスレッド「${topic.title}」の会話です。` +
      (topic.summaryText ? `\n\n--- 前回までの要約 ---\n${topic.summaryText}\n` : "") +
      `\n--- 会話（直近・抜粋） ---\n${lines}\n\n--- 指示 ---\n` +
      `このスレッドの現況要約を日本語・最大10行の箇条書きで書いてください。` +
      `決定事項・未決の論点・生成された成果物（u2a2a/pool/ パス）を優先。前置きなしで要約本文のみを出力。`;
    const { text } = await callClaude(prompt, null, "haiku");
    topic.summaryText = text.trim();
    topic.summaryAt = msgs.length;
    topic.summaryTs = Date.now();
    touch();
  } catch (e) {
    logEvent("summary", `スレッド要約の生成に失敗（${topic.title}）: ` + (e.message || e), "warn");
  } finally {
    summaryPending.delete(topicId);
  }
}

function checkSummaries() {
  for (const t of state.topics) {
    const n = state.messages.filter((m) => m.topicId === t.id).length;
    if (n && n - (t.summaryAt || 0) >= SUMMARY_EVERY) summarizeTopic(t.id);
  }
}

function unseenFor(topic, agent) {
  const ta = topic.agents[agent];
  return state.messages
    .filter((m) => m.topicId === topic.id && m.thread === agent && m.author !== agent && !(m.provenance && m.provenance.ingress === "cli-sync") && m.ts > ta.lastSeenTs)
    .slice(-MAX_BACKLOG);
}

// ---- 外部セッション同期 ----
// デスクトップ版/ターミナルで同じセッションを続けた分を、記録ファイルの増分から取り込む

function transcriptPath(agent, sessionId) {
  if (!sessionId) return null;
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
    added = true;
  }
  return added;
}

// 外部での続きを受動的にも読めるよう定期チェック（全トピック）
setInterval(() => {
  let changed = false;
  for (const topic of state.topics) {
    for (const agent of AGENTS) {
      if (running[runKey(topic.id, agent)]) continue; // 自分の応答書き込み中は増分を読まない
      try {
        if (syncExternal(topic, agent)) changed = true;
      } catch (e) {
        logEvent("sync", `外部セッション同期に失敗（${topic.title}/${agent}）: ` + (e.message || e), "warn");
      }
    }
  }
  if (changed) touch();
  checkSummaries();
}, 30_000);

async function agentLoop(topicId, agent) {
  const key = runKey(topicId, agent);
  if (running[key]) {
    needsRun[key] = true;
    return;
  }
  running[key] = true;
  broadcast();
  try {
    while (true) {
      needsRun[key] = false;
      const topic = findTopic(topicId);
      if (!topic) break;
      const a = state.agents[agent];
      const ta = topic.agents[agent];
      try {
        if (syncExternal(topic, agent)) touch(); // 外部での続きを取り込んでから応答する
      } catch {
        // 同期失敗しても応答は続行
      }
      const msgs = unseenFor(topic, agent);
      if (!agentAutoOn(agent) || !msgs.length) break;
      const overBudget = budgetStatus(topicId);
      if (overBudget) {
        triggerBudgetHalt(topicId, agent, overBudget);
        break;
      }
      const prompt = buildPrompt(topic, agent, msgs, !ta.sessionId);
      const actKey = "thread:" + topicId + ":" + agent;
      const run = startRun("thread", agent, { topicId });
      run.sessionId = ta.sessionId || null;
      actStart(actKey, NAMES[agent] + " 応答", run.runId);
      try {
        const call = agent === "claude" ? callClaude : callCodex;
        // claude はプール配下のファイル保存に加え、メディア生成用に python3 / ffmpeg の実行を許可。
        // codex は cwd=pool の workspace-write で起動（書き込みはプール限定・リポジトリは閲覧のみ）
        const hadSession = !!ta.sessionId;
        const opts =
          agent === "claude"
            ? { extraArgs: ["--allowedTools", "Write(u2a2a/pool/**)", "Edit(u2a2a/pool/**)", "Bash(python3:*)", "Bash(ffmpeg:*)"] }
            : { writeDir: POOL_DIR, resumeWritable: !!ta.codexPoolCwd };
        opts.ctl = run.ctl;
        opts.onSessionId = (sid) => (run.sessionId = sid); // 早期捕捉（キャンセル時に interrupted として保持）
        const { text, sessionId, model, meta } = await call(prompt, ta.sessionId, a.modelOverride, (s) => actStep(actKey, s), opts);
        ta.sessionId = sessionId;
        if (agent === "codex" && !hadSession) ta.codexPoolCwd = true; // 新方式（cwd=pool）で作られた印
        if (model) a.model = model;
        ta.lastSeenTs = msgs[msgs.length - 1].ts;
        a.lastError = "";
        const replyMsg = {
          id: id(),
          topicId,
          thread: agent,
          author: agent,
          text,
          provenance: { ingress: "agent-loop", delivery: "direct", trigger: "auto", source: null },
          meta,
          ts: Date.now(),
        };
        state.messages.push(replyMsg);
        markTranscriptSynced(topic, agent); // 自分の応答分は外部同期の対象外にする
        qaHop(topic, agent, text, replyMsg.id);
      } catch (e) {
        topic.relay.active = false; // エラー/キャンセルで質疑が空回りしないよう停止
        ta.lastSeenTs = msgs[msgs.length - 1].ts; // 同じメッセージで無限リトライしない
        if (e.cancelled) {
          // キャンセル: エラーではなく cancelled として記録し、セッションは interrupted 扱いに
          needsRun[key] = false;
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
          a.lastError = String(e.message || e);
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
    touch();
  }
}

function maybeTrigger(messages) {
  for (const m of messages) {
    if (!AGENTS.includes(m.thread) || m.author === m.thread) continue;
    if (agentAutoOn(m.thread) && findTopic(m.topicId)) agentLoop(m.topicId, m.thread);
  }
}

// ---- API ----
async function handleApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

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

  if (req.method === "POST" && url.pathname === "/api/messages") {
    const body = await readBody(req);
    const author = AUTHORS.includes(body.author) ? body.author : null;
    const thread = AGENTS.includes(body.thread) ? body.thread : null;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const topic = findTopic(body.topicId) || state.topics[0];
    if (!author || !text) return json(res, 400, { error: "author と text は必須です" });
    if (!topic) return json(res, 400, { error: "トピックがありません" });
    // user は thread:"both" で両スレッドに同報できる
    const threads = thread ? [thread] : body.thread === "both" && author === "user" ? AGENTS : null;
    if (!threads) return json(res, 400, { error: "thread は claude / codex / both(userのみ)" });
    const created = threads.map((t) => ({
      id: id(),
      topicId: topic.id,
      thread: t,
      author,
      text,
      provenance: { ingress: "ui", delivery: "direct", trigger: "manual", source: null },
      ts: Date.now(),
    }));
    state.messages.push(...created);
    touch();
    maybeTrigger(created);
    return json(res, 201, created);
  }

  // 実行のキャンセル（初版は thread 実行のみ。SIGTERM→3秒→SIGKILL・プロセスグループ停止）
  if (req.method === "POST" && parts[0] === "api" && parts[1] === "runs" && parts[2] && parts[3] === "cancel") {
    const run = runs[parts[2]];
    if (!run) return json(res, 404, { error: "run not found（既に終了しています）" });
    if (run.kind !== "thread") return json(res, 400, { error: "初版でキャンセルできるのはスレッド応答のみです" });
    const topic = findTopic(run.topicId);
    if (topic) topic.relay = defaultRelay(); // 質疑リレーも止める
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
    const copy = {
      id: id(),
      topicId: src.topicId,
      thread: OTHER[src.thread],
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
    const copy = {
      id: id(),
      topicId: src.topicId,
      thread: OTHER[src.thread],
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
  if (req.method === "POST" && url.pathname === "/api/topics") {
    const body = await readBody(req);
    const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 60) : "新しいスレッド";
    const topic = defaultTopic(title);
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
      summarizeTopic(topic.id);
      return json(res, 202, { ok: true });
    }

    // 分岐: 指定メッセージ地点までの履歴を新トピックへコピーする
    // （合意事項: コピーの provenance は不変。CLI セッションは継承せず新規 topicAgent で開始）
    if (req.method === "POST" && parts[3] === "branch") {
      const body = await readBody(req);
      const at = state.messages.find((m) => m.id === body.messageId && m.topicId === topic.id);
      if (!at) return json(res, 404, { error: "分岐点のメッセージが見つかりません" });
      const branched = defaultTopic(topic.title.slice(0, 50) + "＃分岐");
      branched.branchedFrom = { topicId: topic.id, messageId: at.id };
      // 分岐元の要約を持ち込む（新セッションの初回応答で文脈として再注入される）
      branched.summaryText = topic.summaryText || "";
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
      // 分岐直後に旧履歴へ自動応答が走らないよう、既読位置を分岐時点に合わせる
      for (const a of AGENTS) branched.agents[a].lastSeenTs = Date.now();
      state.topics.push(branched);
      state.messages.push(...copies);
      touch();
      return json(res, 201, branched);
    }
    if (req.method === "PATCH") {
      const body = await readBody(req);
      if (typeof body.title === "string" && body.title.trim()) topic.title = body.title.trim().slice(0, 60);
      // CLI セッションのリセット（次の応答から新セッション。codex は新方式 cwd=pool で始まる）
      if (AGENTS.includes(body.resetAgent)) {
        const ta = topic.agents[body.resetAgent];
        ta.sessionId = null;
        ta.transcriptOffset = null;
        delete ta.codexPoolCwd;
        delete ta.interruptedSessionId;
        delete ta.interruptedPoolCwd;
      }
      // 中断（キャンセル）したセッションの明示的な再開
      if (AGENTS.includes(body.resumeInterrupted)) {
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
    const src = typeof body.src === "string" ? body.src.replace(/\/+$/, "") : "";
    const destDir = typeof body.destDir === "string" ? body.destDir.replace(/\/+$/, "") : "";
    const srcAbs = poolFilePath(src);
    const destDirAbs = destDir ? poolFilePath(destDir) : POOL_DIR;
    if (!srcAbs || !fs.existsSync(srcAbs)) return json(res, 400, { error: "src が見つかりません" });
    if (!destDirAbs || !fs.existsSync(destDirAbs) || !fs.statSync(destDirAbs).isDirectory())
      return json(res, 400, { error: "destDir が不正です" });
    const isDir = fs.statSync(srcAbs).isDirectory();
    if (isDir && (destDir === src || destDir.startsWith(src + "/")))
      return json(res, 400, { error: "フォルダを自分自身の中へは移動/コピーできません" });
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
    const dir = typeof body.dir === "string" ? body.dir : "";
    if (!origin || !title || !text) return json(res, 400, { error: "origin / title / body は必須です" });
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
      status: "submitted",
      reviews: [],
      fromMessageId: typeof body.fromMessageId === "string" ? body.fromMessageId : null,
      ...statPoolFile(name),
      ts: Date.now(),
    };
    state.pool.push(item);
    touch();
    // 持ち込み元でない側が自動レビュー（ユーザー持ち込みは両エージェント）
    const reviewers = origin === "user" ? AGENTS : [OTHER[origin]];
    if (body.autoReview !== false) for (const r of reviewers) runReview(item.id, r);
    return json(res, 201, item);
  }

  // ファイルアップロード（base64）
  if (req.method === "POST" && url.pathname === "/api/pool/upload") {
    const body = await readBody(req, 16_000_000);
    const origin = AUTHORS.includes(body.origin) ? body.origin : "user";
    const rawName = typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : "file";
    if (typeof body.dataBase64 !== "string") return json(res, 400, { error: "dataBase64 は必須です" });
    const data = Buffer.from(body.dataBase64, "base64");
    const name = uniquePoolName(rawName, typeof body.dir === "string" ? body.dir : "");
    const absUp = poolFilePath(name);
    if (!absUp) return json(res, 400, { error: "不正な保存先です" });
    fs.mkdirSync(path.dirname(absUp), { recursive: true });
    fs.writeFileSync(absUp, data);
    const item = {
      id: id(),
      title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : rawName,
      file: name,
      origin,
      via: "upload",
      status: "submitted",
      reviews: [],
      ...statPoolFile(name),
      ts: Date.now(),
    };
    state.pool.push(item);
    touch();
    if (body.autoReview === true) {
      for (const r of origin === "user" ? AGENTS : [OTHER[origin]]) runReview(item.id, r);
    }
    return json(res, 201, item);
  }

  // プールファイルの取得（プレビュー・ダウンロード用。サブフォルダのパスにも対応）
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "pool" && parts[2] === "file" && parts[3]) {
    const file = poolFilePath(decodeURIComponent(parts.slice(3).join("/")));
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: "file not found" });
    const ext = path.extname(file).toLowerCase();
    const mime =
      ext === ".html" || ext === ".htm"
        ? "text/html; charset=utf-8" // HTML 成果物（ゲーム等）はそのまま実行できる形で配信
        : IMAGE_MIME[ext] || MEDIA_MIME[ext] || (isTextPoolFile(file) ? "text/plain; charset=utf-8" : "application/octet-stream");
    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (parts[0] === "api" && parts[1] === "pool" && parts[2]) {
    const item = state.pool.find((p) => p.id === parts[2]);
    if (!item) return json(res, 404, { error: "pool item not found" });

    if (req.method === "POST" && parts[3] === "review") {
      const body = await readBody(req);
      const reviewer = AGENTS.includes(body.reviewer) ? body.reviewer : null;
      if (!reviewer) return json(res, 400, { error: "reviewer は claude / codex" });
      runReview(item.id, reviewer);
      return json(res, 202, { ok: true });
    }

    // レビューを踏まえた修正（書き込みは pool/ 限定。完了後は元レビュアーが自動再レビュー）
    if (req.method === "POST" && parts[3] === "fix") {
      const body = await readBody(req);
      const agent = AGENTS.includes(body.agent) ? body.agent : null;
      if (!agent) return json(res, 400, { error: "agent は claude / codex" });
      if (!item.file) return json(res, 400, { error: "ファイル実体のない旧形式アイテムは修正できません" });
      if (fixPending[item.id]) return json(res, 409, { error: "このアイテムは修正実行中です" });
      runFix(item.id, agent);
      return json(res, 202, { ok: true });
    }

    if (req.method === "PATCH" && parts.length === 3) {
      const body = await readBody(req);
      if (body.status && POOL_STATUSES.includes(body.status)) item.status = body.status;
      touch();
      return json(res, 200, item);
    }

    if (req.method === "DELETE" && parts.length === 3) {
      // 実ファイルは消さず .trash へ退避（誤削除からの復元用）
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
    if (state.budgetHalt) return json(res, 400, { error: "上限停止中です（バナーから解除してください）" });
    if (!state.agents.claude.auto || !state.agents.codex.auto)
      return json(res, 400, { error: "質疑モードには両スレッドの自動応答をONにしてください" });
    const qaTopic = findTopic(body.topicId) || state.topics[0];
    if (!qaTopic) return json(res, 400, { error: "トピックがありません" });
    qaTopic.relay = { active: true, remaining: hops, hopsDone: 0 };
    qaTopic.qaCount = (qaTopic.qaCount || 0) + 1;
    const msg = {
      id: id(),
      topicId: qaTopic.id,
      thread: first,
      author: "user",
      text,
      provenance: { ingress: "ui", delivery: "direct", trigger: "manual", source: null },
      ts: Date.now(),
    };
    state.messages.push(msg);
    touch();
    agentLoop(qaTopic.id, first);
    return json(res, 201, { relay: qaTopic.relay });
  }

  if (req.method === "POST" && url.pathname === "/api/qa/stop") {
    const body = await readBody(req);
    const qaTopic = findTopic(body.topicId) || state.topics[0];
    if (qaTopic) qaTopic.relay = defaultRelay();
    touch();
    return json(res, 200, { relay: qaTopic ? qaTopic.relay : defaultRelay() });
  }

  if (req.method === "PATCH" && parts[0] === "api" && parts[1] === "agents" && AGENTS.includes(parts[2])) {
    const body = await readBody(req);
    const a = state.agents[parts[2]];
    if (typeof body.auto === "boolean") {
      a.auto = body.auto;
      if (body.auto) for (const t of state.topics) t.agents[parts[2]].lastSeenTs = Date.now(); // ON にした時点から先の新着のみ拾う
      a.lastError = "";
    }
    if (typeof body.model === "string") {
      a.modelOverride = body.model.trim();
      a.lastError = "";
    }
    touch();
    return json(res, 200, a);
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

// ---- static ----
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serveStatic(res, url) {
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
    res.writeHead(200, { "Content-Type": MIME[path.extname(resolved)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(res, url);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

fs.mkdirSync(POOL_TRASH, { recursive: true });
migratePoolItems();
scanPoolDir();
try {
  writeThreadMirrors();
} catch {
  // 起動時のミラー生成失敗は無視（次の保存時に再試行される）
}
saveState();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`U2A2A Orchestration: http://127.0.0.1:${PORT}`);
  logEvent("system", "サーバー起動（schemaVersion 3）", "info");
});
