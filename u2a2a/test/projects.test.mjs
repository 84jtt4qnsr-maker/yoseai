// ローカルプロジェクト登録とトピック紐付け — lib.mjs の純関数テスト（仕様: SPEC-プロジェクト紐付け.md）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isInsidePath,
  normalizeProbe,
  topicHasRunLegacy,
  projectDigest,
  projectPromptLine,
  projectChangeNote,
  summaryOriginNote,
  PROJECT_DIGEST_MAX,
  PROJECT_README_MAX_BYTES,
  PROJECT_ENTRIES_MAX,
  PROJECT_DIRTY_LIST_MAX,
} from "../lib.mjs";

test("isInsidePath: 同一・配下は真、兄弟・前方一致だけは偽", () => {
  assert.equal(isInsidePath("/a/pool", "/a/pool"), true);
  assert.equal(isInsidePath("/a/pool/x/y", "/a/pool"), true);
  assert.equal(isInsidePath("/a/pool/", "/a/pool"), true);
  assert.equal(isInsidePath("/a/pool2", "/a/pool"), false);
  assert.equal(isInsidePath("/a", "/a/pool"), false);
  assert.equal(isInsidePath("/a/pool", ""), false);
});

test("normalizeProbe: 状態ごとの正規化", () => {
  assert.equal(normalizeProbe(null).status, "unregistered");
  assert.equal(normalizeProbe({ unregistered: true }).status, "unregistered");
  assert.equal(normalizeProbe({ exists: false }).status, "missing");
  assert.equal(normalizeProbe({ exists: true, readable: false }).status, "unreadable");
  const ng = normalizeProbe({ exists: true, readable: true, isGit: false });
  assert.equal(ng.status, "not-git");
  assert.equal(ng.branch, null);
  const ok = normalizeProbe({
    exists: true,
    readable: true,
    isGit: true,
    git: { branch: { ok: true, out: "main\n" }, head: { ok: true, out: "73e4496\n" }, status: { ok: true, out: " M a.js\n?? new.txt\n" } },
  });
  assert.deepEqual(ok, { status: "ok", branch: "main", head: "73e4496", dirty: 2, dirtyPaths: ["a.js", "new.txt"], note: null });
  const clean = normalizeProbe({ exists: true, readable: true, isGit: true, git: { branch: { ok: true, out: "main" }, head: { ok: true, out: "abc" }, status: { ok: true, out: "" } } });
  assert.equal(clean.dirty, 0);
  assert.deepEqual(clean.dirtyPaths, []);
});

test("normalizeProbe: git の失敗・タイムアウトは unavailable（エラーにしない）", () => {
  const u = normalizeProbe({
    exists: true,
    readable: true,
    isGit: true,
    git: { branch: { ok: true, out: "main" }, head: { ok: false, err: "タイムアウト（3秒）" }, status: { ok: true, out: "" } },
  });
  assert.equal(u.status, "unavailable");
  assert.equal(u.branch, null);
  assert.match(u.note, /^確認不可: タイムアウト/);
  const noGit = normalizeProbe({ exists: true, readable: true, isGit: true, git: { branch: { ok: false, err: "git が見つかりません" }, head: { ok: false, err: "x" }, status: { ok: false, err: "y" } } });
  assert.match(noGit.note, /git が見つかりません/);
});

test("normalizeProbe: 未コミット変更のパスは上限で切り、件数は全体", () => {
  const lines = Array.from({ length: 20 }, (_, i) => " M f" + i + ".js").join("\n") + "\n";
  const p = normalizeProbe({ exists: true, readable: true, isGit: true, git: { branch: { ok: true, out: "b" }, head: { ok: true, out: "h" }, status: { ok: true, out: lines } } });
  assert.equal(p.dirty, 20);
  assert.equal(p.dirtyPaths.length, PROJECT_DIRTY_LIST_MAX);
  const note = projectChangeNote(p);
  assert.match(note, /未コミット変更: f0\.js, /);
  assert.match(note, /他 8 件/);
  assert.equal(projectChangeNote(normalizeProbe({ exists: true, readable: true, isGit: false })), "");
  assert.equal(projectChangeNote(null), "");
});

test("topicHasRunLegacy: sessionId かエージェント発言があれば実行済み", () => {
  const t = { id: "t1", agents: { claude: { sessionId: null }, codex: { sessionId: null } } };
  assert.equal(topicHasRunLegacy(t, [{ topicId: "t1", author: "user" }]), false);
  assert.equal(topicHasRunLegacy(t, [{ topicId: "t1", author: "claude" }]), true);
  assert.equal(topicHasRunLegacy(t, [{ topicId: "other", author: "claude" }]), false);
  assert.equal(topicHasRunLegacy({ id: "t2", agents: { claude: { sessionId: "s" }, codex: {} } }, []), true);
  assert.equal(topicHasRunLegacy({ id: "t3" }, []), false);
});

test("projectDigest: 直下エントリ（.git / node_modules 除外・50 件まで）＋ README 冒頭、4,000 文字で打ち切り", () => {
  const entries = [
    { name: ".git", dir: true },
    { name: "node_modules", dir: true },
    { name: "src", dir: true },
    { name: "README.md", dir: false },
    { name: "package.json", dir: false },
  ];
  const d = projectDigest({ readmeName: "README.md", readmeText: "# Hello\nworld\n", entries });
  assert.match(d, /^直下のエントリ（3 件）: package\.json, README\.md, src\/\n/);
  assert.ok(d.includes("--- README.md 冒頭 ---\n# Hello\nworld\n"));
  assert.ok(!d.includes(".git"));
  // README なし
  assert.ok(projectDigest({ readmeName: null, readmeText: "", entries }).includes("（README は見つかりませんでした）"));
  // 件数上限
  const many = Array.from({ length: 80 }, (_, i) => ({ name: "f" + String(i).padStart(3, "0"), dir: false }));
  const m = projectDigest({ readmeName: null, readmeText: "", entries: many });
  assert.match(m, /直下のエントリ（80 件）/);
  assert.match(m, /他 30 件/);
  assert.equal((m.match(/f\d{3}/g) || []).length, PROJECT_ENTRIES_MAX);
  // 文字数上限
  const big = projectDigest({ readmeName: "README", readmeText: "x".repeat(10000), entries: [] });
  assert.ok(big.length <= PROJECT_DIGEST_MAX + 40);
  assert.match(big, /打ち切り/);
  // エラー
  assert.equal(projectDigest({ error: "EACCES" }), "（プロジェクト要約は取得できませんでした: EACCES）");
});

test("projectPromptLine: ok / not-git / unavailable の文言", () => {
  const pj = { name: "sample", path: "/x/sample" };
  assert.equal(
    projectPromptLine(pj, { status: "ok", branch: "main", head: "abc1234", dirty: 2 }),
    "対象プロジェクトは「sample」（/x/sample、閲覧のみ・変更不可）。Git: main@abc1234、未コミット変更 2 件。"
  );
  assert.match(projectPromptLine(pj, { status: "not-git" }), /Git 管理外のフォルダ。$/);
  assert.match(projectPromptLine(pj, { status: "unavailable", note: "確認不可: タイムアウト（3秒）" }), /Git 情報は確認不可: タイムアウト（3秒）。$/);
  assert.match(projectPromptLine(pj, null), /確認不可/);
});

test("PROJECT_README_MAX_BYTES: 4,000 文字ぶんの UTF-8 最大長（読み取り自体の上限）", () => {
  assert.equal(PROJECT_README_MAX_BYTES, PROJECT_DIGEST_MAX * 4);
});

test("summaryOriginNote: 要約の出所が現在の対象と違うときだけ注記する", () => {
  const label = (pid) => (pid ? "P:" + pid : "アプリのリポジトリ（既定）");
  // 要約なし → なし
  assert.equal(summaryOriginNote({ summaryText: "", summaryProjectId: "a", projectId: "b" }, label), "");
  // 同じ対象（null 同士・id 同士・undefined は null 扱い）→ なし
  assert.equal(summaryOriginNote({ summaryText: "s", summaryProjectId: null, projectId: null }, label), "");
  assert.equal(summaryOriginNote({ summaryText: "s", summaryProjectId: "a", projectId: "a" }, label), "");
  assert.equal(summaryOriginNote({ summaryText: "s", projectId: null }, label), "");
  // 別対象へ分岐／分岐後に対象を変更 → 注記（出所は要約側が持つので、分岐元の現在の対象とは無関係）
  assert.equal(
    summaryOriginNote({ summaryText: "s", summaryProjectId: "a", projectId: "b" }, label),
    "（注意: 以下の要約は対象「P:a」の時点のものです。現在の対象は「P:b」です）\n"
  );
  assert.match(summaryOriginNote({ summaryText: "s", summaryProjectId: "a", projectId: null }, label), /現在の対象は「アプリのリポジトリ（既定）」/);
  assert.match(summaryOriginNote({ summaryText: "s", summaryProjectId: null, projectId: "b" }, label), /対象「アプリのリポジトリ（既定）」の時点/);
});
