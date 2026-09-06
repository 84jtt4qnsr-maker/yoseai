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
const PORT = Number(process.env.U2A2A_PORT || 4742);

const AGENTS = ["claude", "codex"];
const AUTHORS = ["user", "claude", "codex"];
const TASK_STATUSES = ["queued", "working", "returned", "done"];
const AGENT_TIMEOUT_MS = 15 * 60 * 1000; // 大きな成果物のレビューは5分では足りない
const MAX_BACKLOG = 10;

function defaultAgent() {
  return {
    auto: true,
    sessionId: null,
    lastSeenTs: Date.now(),
    lastError: "",
    model: "",
    modelOverride: "",
    transcriptOffset: null,
  };
}

function defaultRelay() {
  return { active: false, remaining: 0, hopsDone: 0 };
}

function emptyState() {
  return {
    messages: [],
    tasks: [],
    pool: [],
    agents: { claude: defaultAgent(), codex: defaultAgent() },
    relay: defaultRelay(),
  };
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.messages) && Array.isArray(parsed.tasks)) {
      parsed.agents = parsed.agents || {};
      for (const a of AGENTS) parsed.agents[a] = { ...defaultAgent(), ...parsed.agents[a] };
      parsed.relay = defaultRelay(); // 再起動後にリレーが勝手に再開しないよう常に解除
      if (!Array.isArray(parsed.pool)) parsed.pool = [];
      return parsed;
    }
  } catch {
    // first run or unreadable file — start fresh
  }
  return emptyState();
}

let state = loadState();
let saveTimer = null;

// 実行中フラグは永続化しない（クラッシュ後に張り付くのを防ぐ）
const running = { claude: false, codex: false };
const needsRun = { claude: false, codex: false };

function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  }, 100);
}

// ---- SSE ----
const sseClients = new Set();

// itemId -> 実行中レビュアー名の配列（永続化しない）
const reviewPending = {};

// itemId -> 修正中エージェント名（1件につき同時1修正。永続化しない）
const fixPending = {};

// 実行中 CLI の進捗実況（永続化しない）。key: "thread:claude" / "review:<itemId>:<reviewer>"
const activity = {};

function actStart(key, label) {
  activity[key] = { label, step: "CLI 起動中…", startedAt: Date.now(), steps: [] };
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
  return { ...state, running, reviewPending, fixPending, activity };
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

function runCli(cmd, args, stdinData, timeoutMs = AGENT_TIMEOUT_MS, onLine = null, cwd = REPO_ROOT) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: spawnEnv(), stdio: ["pipe", "pipe", "pipe"] });
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
      child.kill("SIGKILL");
      err += `\n(タイムアウト: ${timeoutMs / 1000}秒)`;
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: String(e.message || e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

function buildPrompt(agent, msgs, isFirst) {
  const other = agent === "claude" ? "codex" : "claude";
  const lines = msgs.map((m) => `[${NAMES[m.author]}] ${m.text}`).join("\n\n");
  const preamble = isFirst
    ? `あなたは「U2A2Aオーケストレーション」アプリの ${NAMES[agent]} 側スレッドの担当エージェントです。` +
      `参加者はユーザー・${NAMES[agent]}（あなた）・${NAMES[other]} の三者です。` +
      `作業ディレクトリは Kometa リポジトリ（閲覧のみ、変更は不可）。` +
      `新着メッセージに ${NAMES[agent]} として日本語で簡潔に返答してください。` +
      `実装作業が必要な場合は作業内容を提案し、タスク化はユーザーに委ねてください。\n\n--- 新着メッセージ ---\n`
    : "--- 新着メッセージ ---\n";
  const qaNote = state.relay.active
    ? `\n\n（現在 ${NAMES[other]} との質疑応答モードです。議論が浅いうちは結論に飛びつかず、質問・反論・検討を返してください。` +
      `${QA_END_MARK} は、相手の見解を少なくとも一度聞いた上で合意・結論に達した場合のみ、応答の末尾に書いてください。` +
      `相手がまだ発言していない段階での終了宣言は無効です。残り自動中継 ${state.relay.remaining} 手）`
    : "";
  return preamble + lines + qaNote;
}

// 質疑モード: エージェントの応答完了を待って相手スレッドへ中継する
function qaHop(agent, replyText) {
  const r = state.relay;
  if (!r.active) return;
  // 終了宣言は相手が一度でも発言した後（=中継が1回以上済み）のみ有効。
  // 先手が初手で終了宣言しても、相手に見せるまではリレーを続ける。
  if (replyText.includes(QA_END_MARK) && r.hopsDone > 0) {
    r.active = false;
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
    id: id(),
    thread: other,
    author: agent,
    text: replyText,
    relayedFrom: agent,
    qa: true,
    ts: Date.now(),
  });
  if (r.remaining <= 0) r.active = false; // 最終手: 相手は応答するがそれ以上は中継しない
  if (state.agents[other].auto) agentLoop(other);
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
    if (ev.type === "result") result = ev;
    else if (onStep) {
      const s = claudeStepFrom(ev);
      if (s) onStep(s);
    }
  };
  const { code, err, out } = await runCli("claude", args, prompt, AGENT_TIMEOUT_MS, onLine, opts.cwd);
  if (!result && code !== 0) throw new Error((err || out || "claude CLI エラー").trim().slice(0, 500));
  if (!result) throw new Error("claude: 結果イベントを受信できませんでした");
  if (result.is_error) throw new Error(String(result.result || "claude エラー").slice(0, 500));
  // modelUsage のキーがモデルID（"claude-opus-5[1m]" の [1m] はfastモード印なので除く）
  const model = Object.keys(result.modelUsage || {})[0]?.replace(/\[.*\]$/, "") || "";
  return { text: result.result || "(空の応答)", sessionId: result.session_id || sessionId, model };
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
  const outFile = path.join(os.tmpdir(), `u2a2a-codex-${id()}.txt`);
  const base = ["--json", "-o", outFile, "--skip-git-repo-check"];
  // resume は -s / -C を受け付けない（元セッションから継承）。config 経由で read-only を明示する
  const args = sessionId
    ? ["exec", "resume", sessionId, "-", ...base, "-c", 'sandbox_mode="read-only"']
    : opts.writeDir
      ? ["exec", "-", ...base, "-s", "workspace-write", "-C", opts.writeDir]
      : ["exec", "-", ...base, "-s", "read-only", "-C", REPO_ROOT];
  if (modelOverride) args.push("-m", modelOverride);
  const onLine = onStep
    ? (line) => {
        if (!line.trim()) return;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        const s = codexStepFrom(ev);
        if (s) onStep(s);
      }
    : null;
  const { code, out, err } = await runCli("codex", args, prompt, AGENT_TIMEOUT_MS, onLine);
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
  return { text: text || "(空の応答)", sessionId: newSessionId, model: codexModelFromRollout(newSessionId) };
}

// ---- 共有タスクプール: 相互レビュー ----
// レビューはスレッドとは独立した使い捨てセッションで実行する
// （スレッド文脈を汚さず、進行中の会話と並列でも衝突しない）

const POOL_STATUSES = ["submitted", "reviewing", "approved", "rejected"];

const TEXT_EXTS = new Set([".md", ".txt", ".log", ".json", ".js", ".mjs", ".ts", ".tsx", ".jsx", ".py", ".rs", ".html", ".css", ".csv", ".yaml", ".yml", ".toml", ".sh", ".diff", ".patch"]);
const IMAGE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp" };

function poolFilePath(name) {
  const resolved = path.join(POOL_DIR, path.basename(name));
  return resolved.startsWith(POOL_DIR) ? resolved : null;
}

// タイトル/ファイル名から安全な一意のプール内ファイル名を作る
function uniquePoolName(base) {
  const ext = path.extname(base) || ".md";
  let stem = path.basename(base, path.extname(base)).replace(/[^\w\-぀-ヿ一-鿿]+/g, "_").slice(0, 60) || "item";
  let name = stem + ext;
  let n = 2;
  while (fs.existsSync(path.join(POOL_DIR, name))) name = `${stem}-${n++}${ext}`;
  return name;
}

function statPoolFile(name) {
  try {
    const st = fs.statSync(path.join(POOL_DIR, name));
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
    const full = fs.readFileSync(path.join(POOL_DIR, item.file), "utf8");
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

// フォルダ監視: pool/ に直接置かれたファイル（エージェントの書き込みや Finder 投入）を自動登録
function scanPoolDir() {
  let changed = false;
  let names;
  try {
    names = fs.readdirSync(POOL_DIR);
  } catch {
    return false;
  }
  const known = new Set(state.pool.map((p) => p.file).filter(Boolean));
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const st = statPoolFile(name);
    if (!st || !fs.statSync(path.join(POOL_DIR, name)).isFile()) continue;
    if (!known.has(name)) {
      state.pool.push({
        id: id(),
        title: name,
        file: name,
        origin: "user",
        via: "folder",
        status: "submitted",
        reviews: [],
        ...st,
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
  } catch {
    // 次回スキャンに持ち越し
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
  (reviewPending[itemId] ||= []).push(reviewer);
  if (item.status === "submitted") item.status = "reviewing";
  touch();
  const actKey = "review:" + itemId + ":" + reviewer;
  actStart(actKey, NAMES[reviewer] + " レビュー");
  try {
    const call = reviewer === "claude" ? callClaude : callCodex;
    const { text } = await call(buildReviewPrompt(item, reviewer), null, state.agents[reviewer].modelOverride, (s) => actStep(actKey, s));
    item.reviews.push({ id: id(), reviewer, text, verdict: verdictFrom(text), ts: Date.now() });
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
  fixPending[itemId] = agent;
  const actKey = "fix:" + itemId;
  actStart(actKey, NAMES[agent] + " 修正");
  // 修正前の版を .trash に世代バックアップ
  try {
    fs.copyFileSync(path.join(POOL_DIR, item.file), path.join(POOL_TRASH, Date.now() + "-prefix-" + item.file));
  } catch {
    // バックアップ失敗でも修正は続行
  }
  try {
    const prompt = buildFixPrompt(item, agent);
    const onStep = (s) => actStep(actKey, s);
    const override = state.agents[agent].modelOverride;
    const { text } =
      agent === "claude"
        ? await callClaude(prompt, null, override, onStep, {
            cwd: POOL_DIR,
            extraArgs: ["--permission-mode", "acceptEdits"], // 書き込みは cwd=pool/ 内のみ
          })
        : await callCodex(prompt, null, override, onStep, { writeDir: POOL_DIR });
    item.fixes = item.fixes || [];
    item.fixes.push({ id: id(), agent, text, ts: Date.now() });
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
    actEnd(actKey);
    delete fixPending[itemId];
    touch();
  }
}

function unseenFor(agent) {
  const a = state.agents[agent];
  return state.messages
    .filter((m) => m.thread === agent && m.author !== agent && !m.external && m.ts > a.lastSeenTs)
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
function markTranscriptSynced(agent) {
  const a = state.agents[agent];
  const file = transcriptPath(agent, a.sessionId);
  if (file) {
    try {
      a.transcriptOffset = fs.statSync(file).size;
    } catch {
      a.transcriptOffset = null;
    }
  } else {
    a.transcriptOffset = null;
  }
}

function syncExternal(agent) {
  const a = state.agents[agent];
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
    state.messages.push({ id: id(), thread: agent, author: m.author, text: m.text, external: true, ts: Date.now() });
    added = true;
  }
  return added;
}

// 外部での続きを受動的にも読めるよう定期チェック
setInterval(() => {
  let changed = false;
  for (const agent of AGENTS) {
    if (running[agent]) continue; // 自分の応答書き込み中は増分を読まない
    try {
      if (syncExternal(agent)) changed = true;
    } catch {
      // 同期失敗は次回に持ち越し
    }
  }
  if (changed) touch();
}, 30_000);

async function agentLoop(agent) {
  if (running[agent]) {
    needsRun[agent] = true;
    return;
  }
  running[agent] = true;
  broadcast();
  try {
    while (true) {
      needsRun[agent] = false;
      const a = state.agents[agent];
      try {
        if (syncExternal(agent)) touch(); // 外部での続きを取り込んでから応答する
      } catch {
        // 同期失敗しても応答は続行
      }
      const msgs = unseenFor(agent);
      if (!a.auto || !msgs.length) break;
      const prompt = buildPrompt(agent, msgs, !a.sessionId);
      const actKey = "thread:" + agent;
      actStart(actKey, NAMES[agent] + " 応答");
      try {
        const call = agent === "claude" ? callClaude : callCodex;
        const { text, sessionId, model } = await call(prompt, a.sessionId, a.modelOverride, (s) => actStep(actKey, s));
        a.sessionId = sessionId;
        if (model) a.model = model;
        a.lastSeenTs = msgs[msgs.length - 1].ts;
        a.lastError = "";
        state.messages.push({ id: id(), thread: agent, author: agent, text, auto: true, ts: Date.now() });
        markTranscriptSynced(agent); // 自分の応答分は外部同期の対象外にする
        qaHop(agent, text);
      } catch (e) {
        state.relay.active = false; // エラーで質疑が空回りしないよう停止
        a.lastError = String(e.message || e);
        a.lastSeenTs = msgs[msgs.length - 1].ts; // 同じメッセージで無限リトライしない
      } finally {
        actEnd(actKey);
      }
      touch();
      if (!needsRun[agent]) break;
    }
  } finally {
    running[agent] = false;
    touch();
  }
}

function maybeTrigger(messages) {
  for (const agent of AGENTS) {
    if (!state.agents[agent].auto) continue;
    if (messages.some((m) => m.thread === agent && m.author !== agent)) agentLoop(agent);
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
    if (!author || !text) return json(res, 400, { error: "author と text は必須です" });
    // user は thread:"both" で両スレッドに同報できる
    const threads = thread ? [thread] : body.thread === "both" && author === "user" ? AGENTS : null;
    if (!threads) return json(res, 400, { error: "thread は claude / codex / both(userのみ)" });
    const created = threads.map((t) => ({
      id: id(),
      thread: t,
      author,
      text,
      relayedFrom: typeof body.relayedFrom === "string" ? body.relayedFrom : null,
      ts: Date.now(),
    }));
    state.messages.push(...created);
    touch();
    maybeTrigger(created);
    return json(res, 201, created);
  }

  // 共有タスクプール: テキスト持ち込み（pool/ に .md として保存。相手エージェントが自動レビュー）
  if (req.method === "POST" && url.pathname === "/api/pool") {
    const body = await readBody(req);
    const origin = AUTHORS.includes(body.origin) ? body.origin : null;
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!origin || !title || !text) return json(res, 400, { error: "origin / title / body は必須です" });
    const name = uniquePoolName(title + ".md");
    fs.writeFileSync(path.join(POOL_DIR, name), text);
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
    const name = uniquePoolName(rawName);
    fs.writeFileSync(path.join(POOL_DIR, name), data);
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

  // プールファイルの取得（プレビュー・ダウンロード用）
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "pool" && parts[2] === "file" && parts[3]) {
    const file = poolFilePath(decodeURIComponent(parts[3]));
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: "file not found" });
    const ext = path.extname(file).toLowerCase();
    const mime =
      ext === ".html" || ext === ".htm"
        ? "text/html; charset=utf-8" // HTML 成果物（ゲーム等）はそのまま実行できる形で配信
        : IMAGE_MIME[ext] || (isTextPoolFile(file) ? "text/plain; charset=utf-8" : "application/octet-stream");
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
          fs.renameSync(path.join(POOL_DIR, item.file), path.join(POOL_TRASH, Date.now() + "-" + item.file));
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
    if (!state.agents.claude.auto || !state.agents.codex.auto)
      return json(res, 400, { error: "質疑モードには両スレッドの自動応答をONにしてください" });
    state.relay = { active: true, remaining: hops, hopsDone: 0 };
    const msg = { id: id(), thread: first, author: "user", text, qa: true, ts: Date.now() };
    state.messages.push(msg);
    touch();
    agentLoop(first);
    return json(res, 201, { relay: state.relay });
  }

  if (req.method === "POST" && url.pathname === "/api/qa/stop") {
    state.relay = defaultRelay();
    touch();
    return json(res, 200, { relay: state.relay });
  }

  if (req.method === "PATCH" && parts[0] === "api" && parts[1] === "agents" && AGENTS.includes(parts[2])) {
    const body = await readBody(req);
    const a = state.agents[parts[2]];
    if (typeof body.auto === "boolean") {
      a.auto = body.auto;
      if (body.auto) a.lastSeenTs = Date.now(); // ON にした時点から先の新着のみ拾う
      a.lastError = "";
    }
    if (typeof body.model === "string") {
      a.modelOverride = body.model.trim();
      a.lastError = "";
    }
    if (body.resetSession) a.sessionId = null;
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
        thread: task.agent,
        author: task.agent,
        text,
        taskId: task.id,
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
saveState();

server.listen(PORT, "127.0.0.1", () => {
  console.log(`U2A2A Orchestration: http://127.0.0.1:${PORT}`);
});
