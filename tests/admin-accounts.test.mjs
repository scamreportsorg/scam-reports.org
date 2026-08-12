import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { authHeaders, createTestRuntime, insertAccountFixture } from "./helpers/runtime.mjs";

let runtime;
let database;
let admin;
let moderator;
let promotable;
let member;

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  admin = await insertAccountFixture(database, {
    id: `account_${"a".repeat(32)}`,
    handle: "AccountAdmin",
    role: "admin",
    providers: ["discord", "email"],
  });
  moderator = await insertAccountFixture(database, {
    id: `account_${"b".repeat(32)}`,
    handle: "AccountModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  promotable = await insertAccountFixture(database, {
    id: `account_${"c".repeat(32)}`,
    handle: "PromotableMember",
    providers: ["discord", "email"],
  });
  member = await insertAccountFixture(database, {
    id: `account_${"d".repeat(32)}`,
    handle: "SingleProviderMember",
    providers: ["email"],
  });
});

after(async () => runtime?.dispose());

test("admin-only account queue hides provider contacts", async () => {
  const anonymous = await runtime.dispatchFetch("http://localhost/api/admin/accounts");
  assert.equal(anonymous.status, 401);
  const denied = await runtime.dispatchFetch("http://localhost/api/admin/accounts", {
    headers: authHeaders(moderator),
  });
  assert.equal(denied.status, 403);
  const accepted = await runtime.dispatchFetch("http://localhost/api/admin/accounts", {
    headers: authHeaders(admin),
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const payload = await accepted.json();
  assert.equal(payload.pagination.pageSize, 25);
  assert.equal(
    payload.items.some((item) => item.id === member.id),
    true,
  );
  assert.doesNotMatch(JSON.stringify(payload), /display_hint|subject_encrypted|encrypted-/u);
});

test("staff promotion needs both providers", async () => {
  const response = await runtime.dispatchFetch("http://localhost/api/admin/accounts", {
    method: "PATCH",
    headers: authHeaders(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ id: member.id, role: "moderator", status: "active" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "staff_identity_required");
});

test("last active admin cannot be demoted", async () => {
  const response = await runtime.dispatchFetch("http://localhost/api/admin/accounts", {
    method: "PATCH",
    headers: authHeaders(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ id: admin.id, role: "moderator", status: "active" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "last_admin");

  const deletion = await runtime.dispatchFetch(
    `http://localhost/api/admin/accounts?id=${encodeURIComponent(admin.id)}`,
    { method: "DELETE", headers: authHeaders(admin) },
  );
  assert.equal(deletion.status, 409);
  assert.equal((await deletion.json()).code, "last_admin");
});

test("access changes need fresh dual confirmation", async () => {
  await database
    .prepare("UPDATE auth_sessions SET email_confirmed_at = ? WHERE account_id = ?")
    .bind("2020-01-01T00:00:00.000Z", admin.id)
    .run();
  const missingCsrf = await runtime.dispatchFetch("http://localhost/api/admin/accounts", {
    method: "PATCH",
    headers: {
      origin: "http://localhost",
      cookie: admin.cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify({ id: promotable.id, role: "moderator", status: "active" }),
  });
  assert.equal(missingCsrf.status, 403);
  assert.equal((await missingCsrf.json()).code, "invalid_csrf");

  const denied = await runtime.dispatchFetch("http://localhost/api/admin/accounts", {
    method: "PATCH",
    headers: authHeaders(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ id: promotable.id, role: "moderator", status: "active" }),
  });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, "dual_confirmation_required");
  assert.equal(
    await database
      .prepare("SELECT role FROM accounts WHERE id = ?")
      .bind(promotable.id)
      .first("role"),
    "member",
  );

  const now = new Date().toISOString();
  await database
    .prepare(
      `UPDATE auth_sessions SET discord_confirmed_at = ?, email_confirmed_at = ? WHERE account_id = ?`,
    )
    .bind(now, now, admin.id)
    .run();
  const accepted = await runtime.dispatchFetch("http://localhost/api/admin/accounts", {
    method: "PATCH",
    headers: authHeaders(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ id: promotable.id, role: "moderator", status: "active" }),
  });
  assert.equal(accepted.status, 200, await accepted.text());
  const row = await database
    .prepare("SELECT role, role_version FROM accounts WHERE id = ?")
    .bind(promotable.id)
    .first();
  assert.equal(row.role, "moderator");
  assert.equal(row.role_version, 2);
  assert.ok(
    await database
      .prepare(
        "SELECT id FROM auth_security_events WHERE account_id = ? AND event_type = 'account.access_changed'",
      )
      .bind(promotable.id)
      .first(),
  );
});

test("status changes invalidate the account session", async () => {
  const response = await runtime.dispatchFetch("http://localhost/api/admin/accounts", {
    method: "PATCH",
    headers: authHeaders(admin, { "content-type": "application/json" }),
    body: JSON.stringify({ id: moderator.id, role: "moderator", status: "suspended" }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    await database
      .prepare("SELECT role, status, role_version FROM accounts WHERE id = ?")
      .bind(moderator.id)
      .first(),
    { role: "moderator", status: "suspended", role_version: 2 },
  );

  const formerSession = await runtime.dispatchFetch("http://localhost/api/auth/session", {
    headers: authHeaders(moderator),
  });
  assert.equal(formerSession.status, 200);
  assert.equal((await formerSession.json()).authenticated, false);
});
