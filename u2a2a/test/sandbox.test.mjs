// 強制層 — 純関数テスト（契約: 契約-資格隔離API.md §2・§3）
// sandbox.mjs は I/O を持たないので、実際に srt を起動せずに判定と変換を固定できる。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateProfiles,
  resolveProfile,
  toRuntimeSettings,
  shellQuote,
  wrapArgv,
  planIsolation,
  describeIsolation,
  PROFILE_VARS,
  SANDBOX_SCHEMA_VERSION,
} from "../sandbox.mjs";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VARS = {
  repoRoot: "/repo",
  poolDir: "/repo/u2a2a/pool",
  poolTopicDir: "/repo/u2a2a/pool/topics/t1",
  dataDir: "/repo/u2a2a/data",
  home: "/home/u",
  tmpDir: "/tmp",
  systemTmp: "/private/tmp", // symlink 解決後の共有 tmp（os.tmpdir() とは別物）
  profilesPath: "/repo/u2a2a/sandbox-profiles.json",
  projectPath: "/proj",
};
const AVAIL = { available: true, reason: "", version: "1.0.0" };
const base = (over = {}) => ({
  availability: AVAIL,
  profiles: PROFILES.profiles,
  agent: "claude",
  phase: "thread",
  vars: VARS,
  runtimeCmd: "srt",
  settingsPath: "/tmp/s.json",
  cmd: "claude",
  args: ["-p", "--model", "haiku"],
  ...over,
});

const PROFILES = JSON.parse(fs.readFileSync(path.join(SRC, "sandbox-profiles.json"), "utf8"));

// ---- 同梱プロファイル ----

test("同梱の sandbox-profiles.json は検査を通り、3 エージェント分そろっている", () => {
  const v = validateProfiles(PROFILES);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  assert.equal(PROFILES.schemaVersion, SANDBOX_SCHEMA_VERSION);
  for (const a of ["claude", "codex", "grok"]) {
    assert.ok(PROFILES.profiles.some((p) => p.agent === a), a);
  }
});

test("プロファイルの検査: 版・形・未知の変数を落とす", () => {
  const codes = (raw) => validateProfiles(raw).errors.map((e) => e.code);
  assert.deepEqual(codes("x"), ["invalid-json"]);
  assert.ok(codes({ schemaVersion: 2, profiles: [] }).includes("version-unsupported"));
  assert.ok(codes({ schemaVersion: 1, profiles: [] }).includes("profiles-empty"));
  const one = (fsPart) => ({ schemaVersion: 1, profiles: [{ agent: "claude", phase: "thread", fs: fsPart }] });
  assert.ok(codes(one({ write: "not-array" })).includes("profile-invalid"));
  assert.ok(codes(one({ write: ["<nope>/x"] })).includes("unknown-var"), "綴り間違いは展開時ではなく検査で捕まえる");
  assert.deepEqual(codes(one({ write: ["<poolTopicDir>"] })), []);
});

// ---- §3 プロファイルの選択と展開 ----

test("具体度: agent+phase > agent+* > *+phase。review は phase:* より優先される", () => {
  const pick = (agent, phase) => resolveProfile(PROFILES.profiles, { agent, phase, vars: VARS }).profile;
  // claude/review は claude+review（具体度 3）が勝ち、pool へ書けない
  const rev = pick("claude", "review");
  assert.equal(rev.phase, "review");
  assert.ok(!rev.fs.write.includes(VARS.poolTopicDir), "レビューはトピックへ書かない");
  assert.ok(rev.fs.denyWrite.includes(VARS.poolDir));
  // claude/thread は claude+*（具体度 2）
  const th = pick("claude", "thread");
  assert.equal(th.phase, "*");
  assert.ok(th.fs.write.includes(VARS.poolTopicDir));
  // codex/fix は pool 全体（修正は成果物をまたぐ）
  assert.ok(pick("codex", "fix").fs.write.includes(VARS.poolDir));
});

// Claude Code は TMPDIR を渡しても無視して共有 tmp 直下に作業ファイルを作る。
// ここを許可し損ねると Bash が丸ごと EPERM で落ちるので、os.tmpdir() とは別枠で持つ
test("claude は共有 tmp も書ける（<tmpDir> とは別物）", () => {
  for (const phase of ["thread", "review"]) {
    const r = resolveProfile(PROFILES.profiles, { agent: "claude", phase, vars: VARS });
    assert.equal(r.ok, true, phase);
    assert.ok(r.profile.fs.write.includes(VARS.systemTmp), `${phase}: 共有 tmp`);
    assert.ok(r.profile.fs.write.includes(VARS.tmpDir), `${phase}: os.tmpdir() も従来どおり`);
  }
  // 共有 tmp を開けても、リポジトリや pool 外への書き込み許可は増えない
  const claude = resolveProfile(PROFILES.profiles, { agent: "claude", phase: "thread", vars: VARS }).profile;
  assert.ok(!claude.fs.write.includes(VARS.repoRoot), "リポジトリ直下は書けないまま");
  assert.ok(claude.fs.denyRead.includes(VARS.dataDir), "資格を含む data は読めないまま");
  // 値が無ければ空文字に化けさせず、プロファイルごと不成立にする
  const { systemTmp, ...missing } = VARS;
  const ng = resolveProfile(PROFILES.profiles, { agent: "claude", phase: "thread", vars: missing });
  assert.equal(ng.ok, false);
  assert.ok(ng.errors.some((e) => e.code === "var-unset"));
});

test("変数は展開され、値が無ければ失敗する（空文字にしない）", () => {
  const ok = resolveProfile(PROFILES.profiles, { agent: "grok", phase: "thread", vars: VARS });
  assert.equal(ok.ok, true);
  assert.ok(ok.profile.fs.write.includes("/repo/u2a2a/pool/topics/t1"));
  assert.ok(ok.profile.fs.denyRead.includes("/repo/u2a2a/data"));

  // poolTopicDir を落とすと、そのプロファイルは成立しない。空文字で "/..." に化けさせない
  const { poolTopicDir, ...missing } = VARS;
  const ng = resolveProfile(PROFILES.profiles, { agent: "grok", phase: "thread", vars: missing });
  assert.equal(ng.ok, false);
  assert.equal(ng.profile, null);
  assert.ok(ng.errors.some((e) => e.code === "var-unset"));
});

test("一致するプロファイルが無ければ失敗する", () => {
  const r = resolveProfile([], { agent: "claude", phase: "thread", vars: VARS });
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, "profile-not-found");
});

test("エージェント間の資格分離: 自分のは write、他人のは denyRead", () => {
  const p = (a) => resolveProfile(PROFILES.profiles, { agent: a, phase: "thread", vars: VARS }).profile;
  assert.ok(p("claude").fs.write.some((x) => x.endsWith("/.claude")), "自分の資格は書ける（無いと動かない実測）");
  assert.ok(p("claude").fs.denyRead.includes("/home/u/.grok"), "他人の資格は読めない");
  assert.ok(p("claude").fs.denyRead.includes("/home/u/.codex"));
  assert.ok(p("grok").fs.denyRead.includes("/home/u/.claude"));
  assert.ok(p("codex").fs.denyRead.includes("/home/u/.grok"));
  for (const a of ["claude", "codex", "grok"]) assert.ok(p(a).fs.denyRead.includes("/repo/u2a2a/data"), a + ": 段1 の本体");
});

// ---- runtime への変換 ----

test("sandbox-runtime の設定形式へ移す。allowRead は無いので読みは denyRead だけ", () => {
  const p = resolveProfile(PROFILES.profiles, { agent: "codex", phase: "thread", vars: VARS }).profile;
  const t = toRuntimeSettings(p);
  assert.equal(t.ok, true);
  assert.deepEqual(Object.keys(t.settings).sort(), ["filesystem", "network"]);
  assert.deepEqual(Object.keys(t.settings.filesystem).sort(), ["allowWrite", "denyRead", "denyWrite"]);
  assert.equal("allowRead" in t.settings.filesystem, false, "この runtime は読みの allowlist を表現できない");
  assert.ok(t.settings.network.allowedDomains.includes("*.openai.com"));
});

test("表現できない指定は blocked へ倒す（黙って落とさない）", () => {
  const p = resolveProfile(PROFILES.profiles, { agent: "claude", phase: "thread", vars: VARS }).profile;
  const withLoopback = { ...p, net: { ...p.net, loopback: [4742] } };
  const t = toRuntimeSettings(withLoopback);
  assert.equal(t.ok, false);
  assert.equal(t.unsupported[0].key, "net.loopback");
  assert.equal(planIsolation(base({ profiles: [{ ...PROFILES.profiles[0], net: { allowDomains: [], loopback: [4742] } }] })).mode, "blocked");
  assert.equal(toRuntimeSettings(p, "他の runtime").ok, false, "未知の runtime も blocked");
});

// ---- 起動コマンド ----

test("argv は 1 要素ずつ単一引用で包む（-c のシェル文字列に埋めるため）", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("with space"), "'with space'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`, "単一引用そのものを閉じて足して開き直す");
  assert.equal(shellQuote("日本語/パス"), "'日本語/パス'");
  const w = wrapArgv({ runtimeCmd: "srt", settingsPath: "/tmp/s.json", cmd: "claude", args: ["-p", "--add-dir", "/a b/c"] });
  assert.equal(w.cmd, "srt");
  assert.deepEqual(w.args.slice(0, 3), ["--settings", "/tmp/s.json", "-c"]);
  assert.equal(w.args[3], `'claude' '-p' '--add-dir' '/a b/c'`);
});

// ---- §2.3 3 状態 ----

test("ラッパーが無ければ unprotected（起動する）。あるが失敗なら blocked（起動しない）", () => {
  const missing = planIsolation(base({ availability: { available: false, reason: "runtime-missing" } }));
  assert.equal(missing.mode, "unprotected");
  assert.equal(missing.cmd, "claude", "包まずに、そのまま起動する");
  assert.deepEqual(missing.args, ["-p", "--model", "haiku"]);

  const bad = planIsolation(base({ profiles: [{ agent: "claude", phase: "thread", fs: { write: ["<nope>"] } }] }));
  assert.equal(bad.mode, "blocked");
  assert.match(bad.reason, /profile-invalid/);

  const noPath = planIsolation(base({ settingsPath: "" }));
  assert.equal(noPath.mode, "blocked");
  assert.equal(noPath.reason, "settings-path-missing");
});

test("そろえば enforced。包んだコマンドとプロファイルを返す", () => {
  const p = planIsolation(base());
  assert.equal(p.mode, "enforced");
  assert.equal(p.cmd, "srt");
  assert.ok(p.args.includes("--settings"));
  assert.ok(p.settings.filesystem.denyRead.includes("/repo/u2a2a/data"));
  assert.equal(p.profile.agent, "claude");
});

// ---- §2.4 表示 ----

test("「保護成立」は verified のときだけ。未検証は必ずそう書く", () => {
  assert.equal(describeIsolation({ mode: "unprotected" }), "未保護（OS の隔離なし）");
  assert.match(describeIsolation({ mode: "blocked", reason: "x" }), /実行しません/);
  assert.equal(describeIsolation({ mode: "enforced", verified: false }), "隔離あり（未検証）");
  const ok = describeIsolation({ mode: "enforced", verified: true, verifiedAt: "2026-09-13T00:00:00Z" });
  assert.match(ok, /保護成立（検証済み 2026-09-13）/);
  assert.match(ok, /CLI 自身の資格は対象外/, "段2 の除外を必ず添える");
  assert.equal(describeIsolation({}), "状態不明");
});

test("PROFILE_VARS に挙げた変数だけが使える", () => {
  assert.ok(PROFILE_VARS.includes("<poolTopicDir>"));
  assert.ok(PROFILE_VARS.includes("<dataDir>"));
  const used = new Set();
  for (const p of PROFILES.profiles) {
    for (const s of [...(p.fs.write || []), ...(p.fs.denyRead || []), ...(p.fs.denyWrite || [])]) {
      for (const v of s.match(/<[a-zA-Z]+>/g) || []) used.add(v);
    }
  }
  for (const v of used) assert.ok(PROFILE_VARS.includes(v), "同梱プロファイルが未知の変数を使っている: " + v);
});
