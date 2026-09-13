// 強制層 — エージェント CLI を OS の制限下で起こすための変換（契約: 契約-資格隔離API.md §2・§3）
//
// この場所は I/O を持たない。プロファイル → 起動コマンドへの変換と、状態の判定だけを行う。
// 実行ファイルの有無の確認（availability）は、呼び出し側が調べた結果を引数で渡す。
//
// 設計の要:
//   - 「ラッパーが入っていない（unprotected）」と「ラッパーはあるが初期化に失敗した（blocked）」を分ける。
//     前者は起動してよい（未保護と表示する）。後者は起動しない。黙って未保護へ落ちないことが肝（§8-1）
//   - runtime が表現できない指定は blocked。無視して起動すると「指定したのに効いていない」状態になる（§8-13）

export const SANDBOX_SCHEMA_VERSION = 1;
export const ISOLATION_MODES = ["enforced", "unprotected", "blocked"];
export const PHASES = ["thread", "review", "fix", "summary"];
export const UNVERIFIED_KEYS = ["cliCredentials", "cliSessionStore", "controlSocket", "mcp", "execFiles"];
// プロファイルで使える変数。未知の変数は「空文字に展開」ではなく不正として扱う（§8-8）
// <systemTmp> は symlink を解決したシステム共有の一時領域（macOS では /private/tmp）。
// <tmpDir>（os.tmpdir()）とは別物で、Claude Code は TMPDIR を渡しても無視してこちらへ
// 作業ファイルを作る（uid 付き claude-<uid> と、毎回名前が変わる claude-<hex>-cwd の両方）。
// srt は実パスで判定し glob もファイル単体指定も受け付けないため、ここは丸ごと許可するしかない（実測）
export const PROFILE_VARS = ["<repoRoot>", "<poolDir>", "<poolTopicDir>", "<dataDir>", "<home>", "<projectPath>", "<tmpDir>", "<systemTmp>", "<profilesPath>"];
export const DEFAULT_RUNTIME = "sandbox-runtime";

const VAR_RE = /<[a-zA-Z]+>/g;
const isStr = (v) => typeof v === "string";
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const strList = (v) => (Array.isArray(v) && v.every(isStr) ? v : null);

// ---- §3 プロファイル ----

export function validateProfiles(raw) {
  const errors = [];
  const err = (code, path, message) => errors.push({ code, path, message });
  if (!isObj(raw)) {
    err("invalid-json", "", "プロファイルはオブジェクトです");
    return { ok: false, errors, profiles: [] };
  }
  if (raw.schemaVersion !== SANDBOX_SCHEMA_VERSION) err("version-unsupported", "schemaVersion", `対応は ${SANDBOX_SCHEMA_VERSION} です`);
  const list = Array.isArray(raw.profiles) ? raw.profiles : null;
  if (!list || !list.length) err("profiles-empty", "profiles", "1 件以上必要です");
  (list || []).forEach((p, i) => {
    const at = `profiles[${i}]`;
    if (!isObj(p)) return err("profile-invalid", at, "オブジェクトです");
    if (!isStr(p.agent)) err("profile-invalid", `${at}.agent`, "エージェント ID か \"*\"");
    if (!isStr(p.phase) || (p.phase !== "*" && !PHASES.includes(p.phase))) err("profile-invalid", `${at}.phase`, PHASES.join(" / ") + " / *");
    const fs = p.fs;
    if (!isObj(fs)) return err("profile-invalid", `${at}.fs`, "fs が必要です");
    for (const key of ["write", "denyRead", "denyWrite"]) {
      if (fs[key] !== undefined && !strList(fs[key])) err("profile-invalid", `${at}.fs.${key}`, "文字列の配列です");
    }
    const net = p.net;
    if (net !== undefined) {
      if (!isObj(net)) err("profile-invalid", `${at}.net`, "オブジェクトです");
      else {
        if (net.allowDomains !== undefined && !strList(net.allowDomains)) err("profile-invalid", `${at}.net.allowDomains`, "文字列の配列です");
        if (net.loopback !== undefined && !Array.isArray(net.loopback)) err("profile-invalid", `${at}.net.loopback`, "配列です");
      }
    }
    if (p.unverified !== undefined && !strList(p.unverified)) err("profile-invalid", `${at}.unverified`, "文字列の配列です");
    // 未知のキーは表示に落ちず「保護範囲を広く見せる」ので、綴りごと弾く（修正リスト-確定 P2-⑤）
    if (strList(p.unverified)) for (const k of p.unverified) if (!UNVERIFIED_KEYS.includes(k)) err("profile-invalid", `${at}.unverified`, `未知のキー ${k}（使えるのは ${UNVERIFIED_KEYS.join(" / ")}）`);
    // §5: CLI ごとに要る環境変数はここで明示する。既定は空（spawnEnv の ENV_ALLOW だけ）
    if (p.envAllow !== undefined && !strList(p.envAllow)) err("profile-invalid", `${at}.envAllow`, "文字列の配列です");
    // 変数の綴り間違いを、展開時ではなくここで捕まえる
    for (const s of [...(fs.write || []), ...(fs.denyRead || []), ...(fs.denyWrite || [])]) {
      for (const v of s.match(VAR_RE) || []) if (!PROFILE_VARS.includes(v)) err("unknown-var", at, `未知の変数 ${v}`);
    }
  });
  return { ok: errors.length === 0, errors, profiles: errors.length === 0 ? list : [] };
}

// agent/phase に一致する最も具体的な 1 件を選び、変数を展開して返す。
// 具体度は「agent 一致 + phase 一致」＞「agent 一致 + *」＞「* + phase 一致」＞「* + *」
export function resolveProfile(profiles, { agent, phase, vars }) {
  const score = (p) => (p.agent === agent ? 2 : p.agent === "*" ? 0 : -1) + (p.phase === phase ? 1 : p.phase === "*" ? 0 : -1);
  const hit = (profiles || [])
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s >= 0 && (x.p.agent === agent || x.p.agent === "*") && (x.p.phase === phase || x.p.phase === "*"))
    .sort((a, b) => b.s - a.s)[0];
  if (!hit) return { ok: false, errors: [{ code: "profile-not-found", path: `${agent}/${phase}`, message: "一致するプロファイルがありません" }], profile: null };

  const errors = [];
  const expand = (s) =>
    s.replace(VAR_RE, (v) => {
      if (!PROFILE_VARS.includes(v)) {
        errors.push({ code: "unknown-var", path: s, message: `未知の変数 ${v}` });
        return v;
      }
      const key = v.slice(1, -1);
      const val = vars ? vars[key] : undefined;
      // 値が無い変数は空文字にしない。空文字にするとパスが "/" 起点に化けて全許可になりうる
      if (!isStr(val) || !val) {
        errors.push({ code: "var-unset", path: s, message: `${v} の値がありません` });
        return v;
      }
      return val;
    });
  const src = hit.p;
  const profile = {
    agent: src.agent,
    phase: src.phase,
    fs: {
      write: (src.fs.write || []).map(expand),
      denyRead: (src.fs.denyRead || []).map(expand),
      denyWrite: (src.fs.denyWrite || []).map(expand),
    },
    net: { allowDomains: (src.net && src.net.allowDomains) || [], loopback: (src.net && src.net.loopback) || [] },
    envAllow: src.envAllow || [],
    unverified: src.unverified || [],
  };
  return { ok: errors.length === 0, errors, profile: errors.length === 0 ? profile : null };
}

// ---- runtime（sandbox-runtime）への変換 ----
// 実測した設定形式（probes/integrator/settings-*.json）:
//   { filesystem: { denyRead, allowWrite, denyWrite }, network: { allowedDomains, deniedDomains } }
// allowRead が無いので「読める場所の allowlist」は表現できない。読みは既定で許可され、denyRead だけが効く
export function toRuntimeSettings(profile, runtime = DEFAULT_RUNTIME) {
  const unsupported = [];
  if (runtime !== DEFAULT_RUNTIME) unsupported.push({ key: "runtime", detail: `未知の runtime: ${runtime}` });
  // ポート単位のループバック許可は sandbox-runtime に無い。空でなければ表現できない → blocked へ倒す
  if ((profile.net.loopback || []).length) unsupported.push({ key: "net.loopback", detail: "ポート単位の許可を表現できません" });
  const settings = {
    filesystem: {
      denyRead: [...profile.fs.denyRead],
      allowWrite: [...profile.fs.write],
      denyWrite: [...profile.fs.denyWrite],
    },
    network: { allowedDomains: [...profile.net.allowDomains], deniedDomains: [] },
  };
  return { ok: unsupported.length === 0, unsupported, settings };
}

// ---- 起動コマンドの組み立て ----

// POSIX の単一引用で 1 要素を包む。srt の呼び出しが -c のシェル文字列なので、argv を安全に埋める（§8-16）
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, `'\\''`) + "'";
}

export function wrapArgv({ runtimeCmd, settingsPath, cmd, args }) {
  const line = [cmd, ...args].map(shellQuote).join(" ");
  return { cmd: runtimeCmd, args: ["--settings", settingsPath, "-c", line] };
}

// ---- §2.3 3 状態の判定 ----
// availability: { available, reason, version }（呼び出し側が実行ファイルを調べた結果）
export function planIsolation({ availability, profiles, agent, phase, vars, runtimeCmd, settingsPath, cmd, args, runtime = DEFAULT_RUNTIME }) {
  const raw = { mode: null, cmd, args, reason: "", profile: null, settings: null, envAllow: [] };
  if (!availability || availability.available !== true) {
    // 入っていないのは故障ではない。起動はするが、未保護であることを常時表示する
    return { ...raw, mode: "unprotected", reason: (availability && availability.reason) || "runtime-missing" };
  }
  const r = resolveProfile(profiles, { agent, phase, vars });
  if (!r.ok) return { ...raw, mode: "blocked", reason: "profile-invalid: " + r.errors.map((e) => `${e.path}: ${e.message}`).join(" / ") };
  const t = toRuntimeSettings(r.profile, runtime);
  if (!t.ok) return { ...raw, mode: "blocked", reason: "unsupported: " + t.unsupported.map((u) => `${u.key}（${u.detail}）`).join(" / ") };
  if (!isStr(settingsPath) || !settingsPath) return { ...raw, mode: "blocked", reason: "settings-path-missing" };
  const wrapped = wrapArgv({ runtimeCmd, settingsPath, cmd, args });
  return { mode: "enforced", cmd: wrapped.cmd, args: wrapped.args, reason: "", profile: r.profile, settings: t.settings, envAllow: r.profile.envAllow };
}

// ---- §2.4 表示 ----
// 「保護成立」は verified が立っているときだけ。立てるのは probe 記録の取り込み（§7.3）
export function describeIsolation(state) {
  const s = state || {};
  if (s.mode === "blocked") return `隔離を初期化できないため実行しません（${s.reason || "理由不明"}）`;
  if (s.mode === "unprotected") return "未保護（OS の隔離なし）";
  if (s.mode === "enforced" && s.verified) {
    const when = s.verifiedAt ? String(s.verifiedAt).slice(0, 10) : "";
    // 被覆を点灯と一緒に示す（P1-1）。「何が検証されたのか」を読める形で持ち歩く
    const cov = s.coverage && Array.isArray(s.coverage.agents) && s.coverage.agents.length
      ? `／被覆: ${s.coverage.agents.join("・")} 全${s.coverage.rows}行` : "";
    return `保護成立（検証済み${when ? " " + when : ""}${cov}）※ CLI 自身の資格は対象外`;
  }
  if (s.mode === "enforced") return "隔離あり（未検証）";
  return "状態不明";
}
