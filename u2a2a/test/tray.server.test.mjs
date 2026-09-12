// 判断トレイ — サーバ統合テスト（契約: 契約-判断トレイAPI.md §6・§9・§10・§12）
// server.mjs を一時ディレクトリへ複製して起動する。REPO_ROOT（appDir の親）を git リポジトリにして
// 基点コミットを作り、基点確認（git cat-file）を実際に通す。
// 偽 CLI は制御ファイルの text をそのまま応答として返すので、依頼ブロックを応答に載せられる。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// 偽 claude / codex。呼ばれた回数を数えられるよう 1 行ずつログへ足す
const FAKE_CLI = (kind) => `#!/usr/bin/env node
const fs = require("fs");
const kind = ${JSON.stringify(kind)};
let ctl = {};
try { ctl = JSON.parse(fs.readFileSync(process.env.U2A2A_FAKE_CTL, "utf8")); } catch (e) {}
const c = ctl[kind] || {};
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { prompt += d; });
process.stdin.on("end", () => {
  fs.appendFileSync(ctl.logFile, JSON.stringify({ kind, ts: Date.now(), prompt: prompt.slice(-400) }) + "\\n");
  const text = c.text || "了解";
  if (kind === "codex") { const i = process.argv.indexOf("-o"); if (i > 0) fs.writeFileSync(process.argv[i + 1], text); }
  const line = kind === "claude"
    ? JSON.stringify({ type: "result", result: text, session_id: "fake-" + Math.random().toString(16).slice(2, 8), usage: { input_tokens: 1, output_tokens: 1 } })
    : JSON.stringify({ type: "thread.started", thread_id: "fake-thread" });
  process.stdout.write(line + "\\n", () => process.exit(0));
});
`;

let tmp, appDir, poolDir, home, fakeBin, ctlFile, logFile, port, server, baseCommit, topicId;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = () => "http://127.0.0.1:" + port;

async function api(method, p, body) {
  const r = await fetch(base() + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try {
    json = await r.json();
  } catch {
    // 本文なし
  }
  return { status: r.status, body: json };
}
const getState = async () => (await api("GET", "/api/state")).body;
const getTray = async () => (await api("GET", "/api/tray?topicId=" + topicId)).body;
const writeCtl = (obj) => fs.writeFileSync(ctlFile, JSON.stringify({ logFile, ...obj }));
const cliCount = () => fs.readFileSync(logFile, "utf8").split("\n").filter(Boolean).length;
const trayFile = () => path.join(appDir, "data", "tray.jsonl");
const trayLines = () => fs.readFileSync(trayFile(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function waitFor(fn, label, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("timeout: " + label);
    await sleep(80);
  }
}

// ユーザー発言 → claude の応答（＝ ctl の text）が返るまで待つ
async function drive(text = "お願いします") {
  const before = (await getState()).messages.length;
  await api("POST", "/api/messages", { author: "user", thread: "claude", text, topicId });
  await waitFor(async () => (await getState()).messages.length > before + 1, "claude の応答: " + text);
  await sleep(150); // 受付・拒否通知が書かれるまで
}

const block = (obj) => "検討した結果です。\n\n```u2a2a-request\n" + JSON.stringify(obj, null, 2) + "\n```\n";

const QUESTION = (over = {}) => ({
  v: 1,
  kind: "question",
  to: "user",
  title: "通知方式を決めたい",
  questions: [
    {
      id: "notify",
      text: "新着依頼の知らせ方は",
      options: [
        { id: "badge", label: "バッジだけ", effect: "タブに件数を出す" },
        { id: "toast", label: "トースト", effect: "右下に数秒出す" },
      ],
    },
  ],
  ...over,
});

const START = (over = {}) => ({
  v: 1,
  kind: "start-task",
  to: "user",
  title: "トレイの実装に着手したい",
  outcome: "承認をボタンでできるようになる",
  scope: ["サーバ", "UI"],
  tasks: [
    { key: "api", agent: "claude", title: "API を作る", scope: ["server.mjs"] },
    { key: "ui", agent: "codex", title: "UI を作る", scope: ["index.html"], after: ["api"] },
  ],
  baseCommit,
  basis: { memo: "topics/" + topicId + "/合意メモ.md" },
  ...over,
});

async function startServer() {
  port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: appDir,
    env: { ...process.env, HOME: home, U2A2A_PORT: String(port), PATH: fakeBin + ":" + process.env.PATH, U2A2A_FAKE_CTL: ctlFile },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  server.stderr.on("data", (d) => (err += d));
  server.stdout.on("data", () => {});
  await waitFor(async () => {
    try {
      return (await fetch(base() + "/api/state")).ok;
    } catch {
      return false;
    }
  }, "server start: " + err, 15000);
  // 新規環境の既定は自動応答 OFF。このファイルは応答から依頼を拾うので ON にする
  for (const a of ["claude", "codex"]) await api("PATCH", "/api/agents/" + a, { auto: true });
}

async function stopServer() {
  if (!server) return;
  const p = server;
  server = null;
  await new Promise((resolve) => {
    p.on("exit", resolve);
    p.kill("SIGTERM");
    setTimeout(resolve, 3000);
  });
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "u2a2a-tray-"));
  execFileSync("git", ["init", "-q"], { cwd: tmp });
  fs.writeFileSync(path.join(tmp, "BASE.txt"), "base\n");
  execFileSync("git", ["add", "BASE.txt"], { cwd: tmp });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "base"], { cwd: tmp });
  baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();

  appDir = path.join(tmp, "u2a2a");
  fs.mkdirSync(path.join(appDir, "public"), { recursive: true });
  for (const f of ["server.mjs", "lib.mjs", "verification.mjs", "tray.mjs", "package.json", "public/flow-graph.js", "public/usage.js"]) fs.copyFileSync(path.join(SRC, f), path.join(appDir, f));
  fs.writeFileSync(path.join(appDir, "public", "index.html"), "<html></html>");
  poolDir = path.join(appDir, "pool");
  fs.mkdirSync(poolDir, { recursive: true });
  home = path.join(tmp, "home");
  fs.mkdirSync(home, { recursive: true });
  fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(fakeBin);
  for (const k of ["claude", "codex"]) fs.writeFileSync(path.join(fakeBin, k), FAKE_CLI(k), { mode: 0o755 });
  ctlFile = path.join(tmp, "ctl.json");
  logFile = path.join(tmp, "cli.log");
  fs.writeFileSync(logFile, "");
  writeCtl({});
  await startServer();
  topicId = (await getState()).topics[0].id;
  fs.mkdirSync(path.join(poolDir, "topics", topicId), { recursive: true });
  fs.writeFileSync(path.join(poolDir, "topics", topicId, "合意メモ.md"), "# 合意\n三者で決めました。\n");
});

after(async () => {
  await stopServer();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("1. 形の違反・複数ブロックはトレイに出ず、拒否理由がスレッドに 1 件残る", async () => {
  writeCtl({ claude: { text: block({ ...QUESTION(), title: "" }) } });
  await drive("形が不正な依頼");
  let s = await getState();
  assert.equal((await getTray()).topics[topicId].waiting.length, 0, "トレイには出ない");
  const rejects = s.messages.filter((m) => m.tray && m.tray.kind === "rejected");
  assert.equal(rejects.length, 1);
  assert.ok(rejects[0].tray.codes.includes("title-invalid"), JSON.stringify(rejects[0].tray.codes));
  assert.equal(rejects[0].author, "claude", "提案者の発言として残す");

  writeCtl({ claude: { text: block(QUESTION()) + "\n" + block(QUESTION({ title: "もう 1 件" })) } });
  await drive("2 件入りの依頼");
  s = await getState();
  assert.equal((await getTray()).topics[topicId].waiting.length, 0, "1 件も受け付けない");
  const multi = s.messages.filter((m) => m.tray && m.tray.kind === "rejected");
  assert.equal(multi.length, 2);
  assert.deepEqual(multi[1].tray.codes, ["block-multiple"]);
});

test("2. 正しい質問は pending に入り、pending があるあいだ次の依頼は受け付けない", async () => {
  writeCtl({ claude: { text: block(QUESTION()) } });
  await drive("質問を出して");
  const t = await getTray();
  assert.equal(t.topics[topicId].waiting.length, 1);
  const req = t.requests[t.topics[topicId].waiting[0]];
  assert.equal(req.kind, "question");
  assert.equal(req.proposer, "claude");
  assert.match(req.proposalSha256, /^[0-9a-f]{64}$/);
  assert.equal(req.actionable.answer, true);
  assert.equal(t.topics[topicId].pendingSlotTaken, true);

  writeCtl({ claude: { text: block(QUESTION({ title: "割り込み", issueId: "other" })) } });
  await drive("もう 1 件");
  const t2 = await getTray();
  assert.equal(t2.topics[topicId].waiting.length, 1, "枠は 1 件のまま");
  const last = (await getState()).messages.filter((m) => m.tray && m.tray.kind === "rejected").pop();
  assert.deepEqual(last.tray.codes, ["pending-conflict"]);
});

test("3. 回答は参加者全員へ 1 件ずつ届き、起動する CLI は 1 件だけ", async () => {
  const t = await getTray();
  const id = t.topics[topicId].waiting[0];
  const sha = t.requests[id].proposalSha256;
  writeCtl({ claude: { text: "続きを検討します" } }); // 継続で依頼を出し直さないよう本文を戻す
  const before = await getState();
  const callsBefore = cliCount();

  const stale = await api("POST", "/api/tray/" + id + "/answer", { proposalSha256: "0".repeat(64), answers: [{ questionId: "notify", optionId: "badge" }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "stale-proposal");

  const r = await api("POST", "/api/tray/" + id + "/answer", { proposalSha256: sha, answers: [{ questionId: "notify", optionId: "badge" }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, "answered");
  const parts = before.topics.find((x) => x.id === topicId).participants;
  const shared = (await getState()).messages.filter((m) => m.tray && m.tray.kind === "answer");
  assert.equal(shared.length, parts.length, "参加者ごとに 1 件");
  assert.deepEqual(shared.map((m) => m.thread).sort(), parts.slice().sort());
  assert.equal(new Set(shared.map((m) => m.text)).size, 1, "本文は同じ 1 通");
  assert.match(shared[0].text, /→ バッジだけ（タブに件数を出す）/);
  assert.ok(r.body.continuation, "何を予約したかを返す（その場で起動した場合も内容は返る）");
  assert.equal(r.body.continuation.agent, "claude", "継続は continueAgent 省略時は提案者へ");
  await waitFor(async () => cliCount() > callsBefore, "継続で 1 件だけ起動する");
  await sleep(400);
  assert.equal(cliCount(), callsBefore + 1, "全員を同時に起動しない");
  assert.equal((await getTray()).topics[topicId].history[0], id);
});

test("4. 全問「あとで答える」は回答ではなく退避", async () => {
  writeCtl({ claude: { text: block(QUESTION({ title: "あとで答える用" })) } });
  await drive("質問をもう 1 件");
  const t = await getTray();
  const id = t.topics[topicId].waiting[0];
  const r = await api("POST", "/api/tray/" + id + "/answer", { proposalSha256: t.requests[id].proposalSha256, answers: [{ questionId: "notify", optionId: "__defer" }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.parked, true);
  assert.equal(r.body.request.status, "parked");
  const t2 = await getTray();
  assert.deepEqual(t2.topics[topicId].waiting, [], "pending 枠は空く");
  assert.ok(t2.topics[topicId].later.includes(id));
  writeCtl({ claude: { text: "了解" } });
  // 退避したままだと、その回答に依存する着手は押せない（§8）
  writeCtl({ claude: { text: block(START()) } });
  await drive("着手提案");
  const t3 = await getTray();
  const pid = t3.topics[topicId].waiting[0];
  assert.ok(pid, "着手提案は受け付ける（退避は pending 枠を空ける）");
  const p = t3.requests[pid];
  assert.equal(p.actionable.approve, false);
  assert.ok(p.blockers.some((b) => b.code === "dependency-unresolved"), JSON.stringify(p.blockers));
  // 退避を解いて回答すれば押せるようになる
  await api("POST", "/api/tray/" + id + "/unpark", { proposalSha256: t2.requests[id].proposalSha256 });
  await api("POST", "/api/tray/" + id + "/answer", { proposalSha256: t2.requests[id].proposalSha256, answers: [{ questionId: "notify", optionId: "toast" }] });
  const t4 = await getTray();
  assert.equal(t4.requests[pid].actionable.approve, true, JSON.stringify(t4.requests[pid].blockers));
});

test("5. 承認で tasks の件数だけタスクができ、同じ版の 2 回目では増えない。after 付きは待つ", async () => {
  const t = await getTray();
  const id = t.topics[topicId].waiting[0];
  const sha = t.requests[id].proposalSha256;
  const before = (await getState()).tasks.length;
  writeCtl({ claude: { text: "着手します" } });

  const r = await api("POST", "/api/tray/" + id + "/approve", { proposalSha256: sha });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, "approved");
  const s = await getState();
  assert.equal(s.tasks.length, before + 2, "1 要素 1 タスク");
  const plan = r.body.plan;
  assert.deepEqual(plan.entries.map((e) => e.key), ["api", "ui"]);
  assert.equal(plan.entries[0].send, "sent", "after が無い要素は承認直後に送る");
  assert.equal(plan.entries[1].send, "waiting", "after 付きは前提待ち");
  const starts = s.messages.filter((m) => m.tray && m.tray.kind === "start");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].thread, "claude", "着手指示は担当 1 名だけ");

  const again = await api("POST", "/api/tray/" + id + "/approve", { proposalSha256: sha });
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true);
  assert.equal((await getState()).tasks.length, before + 2, "2 回目でタスクは増えない");

  const old = await api("POST", "/api/tray/" + id + "/approve", { proposalSha256: "1".repeat(64) });
  assert.equal(old.status, 409);
  assert.equal(old.body.code, "stale-proposal");
});

test("6. 前提タスクが returned では後続を送らず、done で送る", async () => {
  const t = await getTray();
  const id = t.topics[topicId].history.find((x) => (t.requests[x] || {}).status === "approved");
  const plan = t.requests[id].plan;
  const apiTaskId = plan.entries[0].taskId;
  const startsBefore = (await getState()).messages.filter((m) => m.tray && m.tray.kind === "start").length;

  await api("POST", "/api/tasks/" + apiTaskId + "/result", { text: "できました" }); // returned になる
  assert.equal((await getState()).tasks.find((x) => x.id === apiTaskId).status, "returned");
  await sleep(200);
  assert.equal((await getState()).messages.filter((m) => m.tray && m.tray.kind === "start").length, startsBefore, "結果到着では後続を開始しない");

  await api("PATCH", "/api/tasks/" + apiTaskId, { status: "done" });
  await waitFor(async () => (await getState()).messages.filter((m) => m.tray && m.tray.kind === "start").length > startsBefore, "done で後続を送る");
  const starts = (await getState()).messages.filter((m) => m.tray && m.tray.kind === "start");
  assert.equal(starts[starts.length - 1].thread, "codex");
  const after = (await getTray()).requests[id].plan;
  assert.equal(after.entries[1].send, "sent");
});

test("7. 送信できないときは ready のまま理由が出る。再送でタスクは二重にならない", async () => {
  writeCtl({ claude: { text: block(START({ title: "2 本目の着手", issueId: "second", tasks: [{ key: "solo", agent: "codex", title: "単発", scope: ["x"] }] })) } });
  await drive("もう 1 件の着手提案");
  const t = await getTray();
  const id = t.topics[topicId].waiting[0];
  assert.ok(id, "着手提案が受け付けられている");
  await api("PATCH", "/api/agents/codex", { auto: false }); // 送信条件を落とす
  const tasksBefore = (await getState()).tasks.length;

  const r = await api("POST", "/api/tray/" + id + "/approve", { proposalSha256: t.requests[id].proposalSha256 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.plan.entries[0].send, "ready", "承認はできるが送信は保留");
  assert.match(r.body.plan.entries[0].error || "", /自動応答/);
  assert.equal((await getState()).tasks.length, tasksBefore + 1, "タスクは作られる");
  assert.equal((await getState()).messages.filter((m) => m.tray && m.tray.kind === "start" && m.thread === "codex").length, 1, "送信はされていない（6 で送った 1 件のみ）");

  await api("PATCH", "/api/agents/codex", { auto: true });
  const retry = await api("POST", "/api/tray/" + id + "/plan/retry", { proposalSha256: t.requests[id].proposalSha256 });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.plan.entries[0].send, "sent");
  assert.equal((await getState()).tasks.length, tasksBefore + 1, "再送でタスクは増えない");
});

test("8. 修正依頼は rejected と区別され、提案者へ 1 回だけ継続を予約する", async () => {
  writeCtl({ claude: { text: block(QUESTION({ title: "修正してもらう質問", issueId: "rev" })) } });
  await drive("質問");
  const t = await getTray();
  const id = t.topics[topicId].waiting[0];
  const sha = t.requests[id].proposalSha256;
  writeCtl({ claude: { text: "直します" } });

  const bad = await api("POST", "/api/tray/" + id + "/revision", { proposalSha256: sha, targets: ["other"] });
  assert.equal(bad.status, 400, "「その他」は内容が必須");
  const r = await api("POST", "/api/tray/" + id + "/revision", { proposalSha256: sha, targets: ["scope"], note: "範囲が広すぎます" });
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, "revision-requested");
  assert.ok(r.body.continuation, "修正依頼でも継続予約の内容を返す");
  assert.equal(r.body.continuation.agent, "claude", "修正は提案者へ 1 回返す");
  assert.equal((await getState()).messages.filter((m) => m.tray && m.tray.kind === "revision").length, (await getState()).topics.find((x) => x.id === topicId).participants.length);
  const t2 = await getTray();
  assert.ok(t2.topics[topicId].later.includes(id), "「あとで」に置く");
  assert.deepEqual(t2.topics[topicId].waiting, [], "pending 枠は空く（提案者の作業待ちなので）");
  assert.equal(t2.requests[id].actionable.approve, false);
});

test("9. tray.jsonl が正本。再起動で復元し、継続予約は自動では走らない", async () => {
  const lines = trayLines();
  assert.ok(lines.length >= 6, "状態が変わるたびに 1 行増える: " + lines.length);
  assert.equal(lines[0].v, 1);
  assert.ok(lines.every((l, i) => l.seq === i + 1), "seq は 1 から連番");
  const saved = JSON.parse(fs.readFileSync(path.join(appDir, "data", "state.json"), "utf8"));
  assert.equal(saved.schemaVersion, 11);
  assert.equal(saved.trayRequests, undefined, "依頼は state.json に二重で持たない");

  const beforeView = await getTray();
  writeCtl({ claude: { text: "再起動後は黙っている" } });
  // 実行中の応答が残ったまま止めると、その CLI の記録が停止後に届いて数がずれる。
  // 走行が空になり、記録が落ち着いてから止める（「増えたか」を意味のある比較にするため）
  await waitFor(async () => ((await getState()).runs || []).length === 0, "実行中の応答が無くなる");
  for (let n = -1; n !== cliCount(); ) {
    n = cliCount();
    await sleep(300);
  }
  const agentSaid = async () => (await getState()).messages.filter((m) => m.topicId === topicId && m.author !== "user").length;
  const saidBefore = await agentSaid();
  await stopServer();
  const callsBefore = cliCount();
  await startServer();
  await sleep(800); // 復元した継続予約で CLI が動き出さないことを見る
  assert.equal(cliCount(), callsBefore, "再起動直後に予約が勝手に走らない");
  assert.equal(await agentSaid(), saidBefore, "エージェントの発言も増えない");

  const afterView = await getTray();
  assert.deepEqual(Object.keys(afterView.requests).sort(), Object.keys(beforeView.requests).sort(), "依頼が復元される");
  for (const id of Object.keys(beforeView.requests)) {
    assert.equal(afterView.requests[id].status, beforeView.requests[id].status, id);
    assert.equal(afterView.requests[id].proposalSha256, beforeView.requests[id].proposalSha256, id);
  }
  const cont = (await getState()).topics.find((x) => x.id === topicId).trayContinuation;
  if (cont) assert.equal(cont.armed, false, "復元した予約は armed でない");
});
