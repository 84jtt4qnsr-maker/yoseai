// 資格層 — 管理資格の発行・検証・失効（契約: 契約-資格隔離API.md §4）
//
// この場所は I/O を持たない。乱数と時刻は引数で受け取る（テストから固定できるように）。
// 資格は **ファイルに書かない**。呼び出し側もディスクへ落とさないこと（§4.1）
//
// 強制層（sandbox.mjs）が届かない領域を作ったうえで、その上に載る層。
// これ単独では「保護成立」にならない（合意メモ §3・C の依存の向き）

import crypto from "node:crypto";

export const CREDENTIAL_KINDS = ["admin", "agent"];
export const SCOPES = ["read", "write", "admin"];
export const TICKET_TTL_MS = 10_000;
export const ROUTE_CLASSES = ["public", "admin-read", "admin-write"];

// 資格なしで通す経路。貼り付け先の画面を出せないと資格を渡せないので、静的資産だけ開ける。
// /api/access は「資格検査が有効か」だけを返す唯一の public API（修正リスト-確定 P0-3）。
// これが無いと U2A2A_CREDENTIALS=off の画面が state を取りに行けず空のままになる
const PUBLIC_EXACT = new Set(["/", "/index.html", "/favicon.ico", "/api/access"]);
const PUBLIC_PREFIX = ["/public/"];
const PUBLIC_SUFFIX = [".js", ".css", ".map", ".png", ".svg", ".woff2"];

export function newAdminCredential(now = Date.now(), randomHex = null) {
  const value = randomHex || crypto.randomBytes(32).toString("hex");
  return { kind: "admin", value, createdAt: now };
}

// 端末へ印字する 1 行。フラグメントに置くのは、クエリと違いサーバへ送られないから（§8-2）
export function credentialUrl(port, value, host = "127.0.0.1") {
  return `http://${host}:${port}/#t=${value}`;
}

export function credentialBanner(port, value) {
  return [
    "",
    "  Yoseai を開くには、この URL を使ってください（この行は端末にだけ出ます）",
    "    " + credentialUrl(port, value),
    "  ・資格は起動のたびに変わります。ファイルには保存していません",
    "  ・#（フラグメント）はサーバへ送られないので、ログには残りません",
    "",
  ].join("\n");
}

// 比較は長さを先に見てから timingSafeEqual（長さが違うと例外になるため）
export function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function classifyRoute(method, pathname) {
  const p = String(pathname || "");
  if (PUBLIC_EXACT.has(p) || PUBLIC_PREFIX.some((x) => p.startsWith(x)) || (!p.startsWith("/api/") && PUBLIC_SUFFIX.some((x) => p.endsWith(x)))) {
    return "public";
  }
  const m = String(method || "GET").toUpperCase();
  return m === "GET" || m === "HEAD" ? "admin-read" : "admin-write";
}

export function bearerFrom(headers) {
  const h = (headers && (headers.authorization || headers.Authorization)) || "";
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(String(h).trim());
  return m ? m[1] : null;
}

// 資格の検査。通れば null、落ちれば { status, code, error } を返す（呼び出し側が本文を読む前に使う）
export function checkCredential({ method, pathname, headers, admin, enabled = true }) {
  if (!enabled) return null; // 段階 1 を入れる前の互換動作
  const cls = classifyRoute(method, pathname);
  if (cls === "public") return null;
  const token = bearerFrom(headers);
  if (!token) return { status: 401, code: "credential-required", error: "管理資格が必要です（起動時に端末へ出た URL で開いてください）" };
  if (!admin || !sameSecret(token, admin.value)) return { status: 401, code: "credential-invalid", error: "管理資格が一致しません（サーバを再起動した場合は新しい URL で開き直してください）" };
  return null;
}

// ---- SSE の使い捨て切符（EventSource はヘッダを付けられない・§4.2）----

export function createTicketStore({ now = () => Date.now(), ttlMs = TICKET_TTL_MS, randomHex = null } = {}) {
  const tickets = new Map(); // value -> expiresAt
  const sweep = () => {
    const t = now();
    for (const [k, exp] of tickets) if (exp <= t) tickets.delete(k);
  };
  return {
    issue() {
      sweep();
      const value = randomHex ? randomHex() : crypto.randomBytes(16).toString("hex");
      const expiresAt = now() + ttlMs;
      tickets.set(value, expiresAt);
      return { ticket: value, expiresAt: new Date(expiresAt).toISOString() };
    },
    // 1 回限り。使ったら消す
    consume(value) {
      sweep();
      if (!value || !tickets.has(value)) return false;
      tickets.delete(value);
      return true;
    },
    get size() {
      sweep();
      return tickets.size;
    },
    // 失効（/api/credentials/revoke）で呼ぶ。旧資格で取った切符を最大 TTL ぶん生かさない（P2-②）
    clear() {
      tickets.clear();
    },
  };
}

// ---- エージェント資格（§4.3。初版では発行しない）----
// 形だけ定義する。強制層が loopback を閉じている間、エージェントは API に届かないので、
// 配ると攻撃面が増えるだけになる（§8-4）。発行経路は既定で無効
export function newAgentCredential({ topicId, scopes, runId, now = Date.now(), ttlMs = 15 * 60_000, enabled = false }) {
  if (!enabled) return { ok: false, reason: "agent-credentials-disabled" };
  if (!topicId || !Array.isArray(scopes) || scopes.some((s) => !SCOPES.includes(s))) return { ok: false, reason: "invalid-request" };
  return {
    ok: true,
    credential: { kind: "agent", value: crypto.randomBytes(32).toString("hex"), topicId, scopes: [...scopes], runId: runId || null, expiresAt: new Date(now + ttlMs).toISOString() },
  };
}
