// 資格層 — 純関数テスト（契約: 契約-資格隔離API.md §4）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newAdminCredential,
  credentialUrl,
  credentialBanner,
  sameSecret,
  classifyRoute,
  bearerFrom,
  checkCredential,
  createTicketStore,
  newAgentCredential,
  TICKET_TTL_MS,
} from "../credentials.mjs";

const ADMIN = newAdminCredential(1000, "a".repeat(64));

// ---- §4.1 管理資格 ----

test("管理資格は 64 桁の 16 進。URL はフラグメントに置く（サーバへ送られない）", () => {
  const c = newAdminCredential();
  assert.match(c.value, /^[0-9a-f]{64}$/);
  assert.equal(c.kind, "admin");
  const url = credentialUrl(4742, c.value);
  assert.equal(url, `http://127.0.0.1:4742/#t=${c.value}`);
  assert.ok(!url.includes("?"), "クエリにしない — ログと Referer に載るため");
  const banner = credentialBanner(4742, c.value);
  assert.ok(banner.includes(url));
  assert.match(banner, /ファイルには保存していません/);
});

test("秘密の比較は長さ違いでも例外にならず false", () => {
  assert.equal(sameSecret("abc", "abc"), true);
  assert.equal(sameSecret("abc", "abd"), false);
  assert.equal(sameSecret("abc", "abcd"), false, "長さが違っても投げない");
  assert.equal(sameSecret("", ""), false);
  assert.equal(sameSecret(null, "abc"), false);
});

// ---- §4.4 操作権限 ----

test("経路の分類: 静的資産だけ public。API は読みも admin", () => {
  assert.equal(classifyRoute("GET", "/"), "public");
  assert.equal(classifyRoute("GET", "/index.html"), "public");
  assert.equal(classifyRoute("GET", "/tray-ui.js"), "public");
  assert.equal(classifyRoute("GET", "/public/flow-graph.js"), "public");
  // 読み取り API も守る（会話とプロジェクト情報が出るため）
  assert.equal(classifyRoute("GET", "/api/state"), "admin-read");
  assert.equal(classifyRoute("GET", "/api/tray"), "admin-read");
  assert.equal(classifyRoute("GET", "/api/events"), "admin-read");
  assert.equal(classifyRoute("POST", "/api/messages"), "admin-write");
  assert.equal(classifyRoute("PATCH", "/api/agents/claude"), "admin-write");
  assert.equal(classifyRoute("DELETE", "/api/topics/x"), "admin-write");
  assert.equal(classifyRoute("POST", "/api/state.js"), "admin-write", "API 配下は拡張子で public にしない");
});

test("Bearer の取り出し", () => {
  assert.equal(bearerFrom({ authorization: "Bearer abc123" }), "abc123");
  // RFC 9110 §11.4 の credentials は auth-scheme のあと 1*SP（空白 1 個以上）。
  // 空白が 2 つでも妥当な形なので受ける。前後の空白も同様
  assert.equal(bearerFrom({ Authorization: "Bearer  abc123  " }), "abc123");
  assert.equal(bearerFrom({ authorization: "Basic abc" }), null);
  assert.equal(bearerFrom({ authorization: "Bearerabc123" }), null, "空白が無ければ別のスキーム名");
  assert.equal(bearerFrom({ authorization: "Bearer" }), null, "値が無い");
  assert.equal(bearerFrom({ authorization: "Bearer abc 123" }), null, "値の中に空白は入らない");
  assert.equal(bearerFrom({}), null);
  assert.equal(bearerFrom(null), null);
});

test("資格の検査: 無ければ 401、違えば 401、合えば通す", () => {
  const call = (over) => checkCredential({ method: "POST", pathname: "/api/messages", headers: {}, admin: ADMIN, ...over });
  assert.equal(call({ headers: { authorization: "Bearer " + ADMIN.value } }), null);
  assert.equal(call({}).status, 401);
  assert.equal(call({}).code, "credential-required");
  assert.equal(call({ headers: { authorization: "Bearer " + "b".repeat(64) } }).code, "credential-invalid");
  assert.match(call({ headers: { authorization: "Bearer " + "b".repeat(64) } }).error, /再起動/, "再起動で失効することを伝える");
  // 静的資産は資格なしで通す（貼り付け先の画面を出せないと資格を渡せない）
  assert.equal(checkCredential({ method: "GET", pathname: "/", headers: {}, admin: ADMIN }), null);
  // 読み取り API は守る
  assert.equal(checkCredential({ method: "GET", pathname: "/api/state", headers: {}, admin: ADMIN }).status, 401);
  // 段階 1 を入れる前の互換動作
  assert.equal(checkCredential({ method: "POST", pathname: "/api/messages", headers: {}, admin: ADMIN, enabled: false }), null);
  // サーバ側に資格が無い状態でも、黙って通さない
  assert.equal(call({ admin: null, headers: { authorization: "Bearer " + ADMIN.value } }).code, "credential-invalid");
});

// ---- §4.2 SSE の切符 ----

test("切符は 1 回限りで、期限が切れる", () => {
  let now = 1000;
  const store = createTicketStore({ now: () => now });
  const { ticket, expiresAt } = store.issue();
  assert.match(ticket, /^[0-9a-f]{32}$/);
  assert.equal(new Date(expiresAt).getTime(), 1000 + TICKET_TTL_MS);
  assert.equal(store.consume(ticket), true);
  assert.equal(store.consume(ticket), false, "2 回目は通らない");

  const t2 = store.issue().ticket;
  now += TICKET_TTL_MS + 1;
  assert.equal(store.consume(t2), false, "期限切れ");
  assert.equal(store.size, 0, "掃除される");
  assert.equal(store.consume(""), false);
  assert.equal(store.consume(null), false);
});

// ---- §4.3 エージェント資格（初版では発行しない）----

test("エージェント資格は既定で発行されない", () => {
  const off = newAgentCredential({ topicId: "t1", scopes: ["write"] });
  assert.equal(off.ok, false);
  assert.equal(off.reason, "agent-credentials-disabled");
  // 明示的に有効化したときだけ形を返す（初版では有効化しない）
  const on = newAgentCredential({ topicId: "t1", scopes: ["write"], enabled: true, now: 0 });
  assert.equal(on.ok, true);
  assert.equal(on.credential.kind, "agent");
  assert.equal(on.credential.topicId, "t1");
  assert.deepEqual(on.credential.scopes, ["write"]);
  assert.ok(on.credential.expiresAt.endsWith("Z"), "期限を必ず持つ");
  assert.equal(newAgentCredential({ topicId: "t1", scopes: ["nope"], enabled: true }).ok, false);
  assert.equal(newAgentCredential({ scopes: ["read"], enabled: true }).ok, false, "トピック限定が要る");
});
