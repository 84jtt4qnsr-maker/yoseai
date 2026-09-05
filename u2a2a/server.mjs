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
const PORT = Number(process.env.U2A2A_PORT || 4742);

const AGENTS = ["claude", "codex"];
const AUTHORS = ["user", "claude", "codex"];
const TASK_STATUSES = ["queued", "working", "returned", "done"];
const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_BACKLOG = 10;

function defaultAgent() {
  return { auto: true, sessionId: null, lastSeenTs: Date.now(), lastError: "", model: "" };
}

function defaultRelay() {
  return { active: false, remaining: 0 };
}

function emptyState() {
  return {
    messages: [],
    tasks: [],
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

function publicState() {
  return { ...state, running };
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += c;
      if (buf.length > 1_000_000) reject(new Error("body too large"));
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

function runCli(cmd, args, stdinData, timeoutMs = AGENT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, env: spawnEnv(), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.on("error", () => {});
    child.stdin.end(stdinData);
    let out = "", err = "";
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
    ? `\n\n（現在 ${NAMES[other]} との質疑応答モードです。質問には簡潔に答え、確認したいことがあれば質問してください。` +
      `質疑が尽きて結論に達したら、応答の末尾に ${QA_END_MARK} と書いてください。残り自動中継 ${state.relay.remaining} 手）`
    : "";
  return preamble + lines + qaNote;
}

// 質疑モード: エージェントの応答完了を待って相手スレッドへ中継する
function qaHop(agent, replyText) {
  const r = state.relay;
  if (!r.active) return;
  if (replyText.includes(QA_END_MARK)) {
    r.active = false;
    return;
  }
  if (r.remaining <= 0) {
    r.active = false;
    return;
  }
  r.remaining--;
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

async function callClaude(prompt, sessionId) {
  // プロンプトは stdin 渡し（"---" 等で始まってもオプションと誤認されないように）
  const args = ["-p", "--output-format", "json"];
  if (sessionId) args.push("--resume", sessionId);
  const { code, out, err } = await runCli("claude", args, prompt);
  if (code !== 0) throw new Error((err || out || "claude CLI エラー").trim().slice(0, 500));
  const parsed = JSON.parse(out);
  if (parsed.is_error) throw new Error(String(parsed.result || "claude エラー").slice(0, 500));
  // modelUsage のキーがモデルID（"claude-opus-5[1m]" の [1m] はfastモード印なので除く）
  const model = Object.keys(parsed.modelUsage || {})[0]?.replace(/\[.*\]$/, "") || "";
  return { text: parsed.result || "(空の応答)", sessionId: parsed.session_id || sessionId, model };
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

async function callCodex(prompt, sessionId) {
  const outFile = path.join(os.tmpdir(), `u2a2a-codex-${id()}.txt`);
  const base = ["--json", "-o", outFile, "--skip-git-repo-check"];
  // resume は -s / -C を受け付けない（元セッションから継承）。config 経由で read-only を明示する
  const args = sessionId
    ? ["exec", "resume", sessionId, "-", ...base, "-c", 'sandbox_mode="read-only"']
    : ["exec", "-", ...base, "-s", "read-only", "-C", REPO_ROOT];
  const { code, out, err } = await runCli("codex", args, prompt);
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

function unseenFor(agent) {
  const a = state.agents[agent];
  return state.messages
    .filter((m) => m.thread === agent && m.author !== agent && m.ts > a.lastSeenTs)
    .slice(-MAX_BACKLOG);
}

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
      const msgs = unseenFor(agent);
      if (!a.auto || !msgs.length) break;
      const prompt = buildPrompt(agent, msgs, !a.sessionId);
      try {
        const call = agent === "claude" ? callClaude : callCodex;
        const { text, sessionId, model } = await call(prompt, a.sessionId);
        a.sessionId = sessionId;
        if (model) a.model = model;
        a.lastSeenTs = msgs[msgs.length - 1].ts;
        a.lastError = "";
        state.messages.push({ id: id(), thread: agent, author: agent, text, auto: true, ts: Date.now() });
        qaHop(agent, text);
      } catch (e) {
        state.relay.active = false; // エラーで質疑が空回りしないよう停止
        a.lastError = String(e.message || e);
        a.lastSeenTs = msgs[msgs.length - 1].ts; // 同じメッセージで無限リトライしない
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

  // 質疑モード開始: 先手エージェントへ発言し、以後は応答完了ごとに相手へ自動中継
  if (req.method === "POST" && url.pathname === "/api/qa/start") {
    const body = await readBody(req);
    const first = AGENTS.includes(body.first) ? body.first : null;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const hops = Math.min(20, Math.max(1, Number(body.hops) || 6));
    if (!first || !text) return json(res, 400, { error: "first と text は必須です" });
    if (!state.agents.claude.auto || !state.agents.codex.auto)
      return json(res, 400, { error: "質疑モードには両スレッドの自動応答をONにしてください" });
    state.relay = { active: true, remaining: hops };
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`U2A2A Orchestration: http://127.0.0.1:${PORT}`);
});
