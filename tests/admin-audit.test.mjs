import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { authHeaders, createTestRuntime, insertAccountFixture } from "./helpers/runtime.mjs";

let runtime;
let database;
let member;
let moderator;
let staleModerator;

const staleAuthenticatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();

async function insertAuditLog({ id, reportId, action, createdAt, detail }) {
  await database
    .prepare(
      `INSERT INTO audit_logs
      (id, report_id, action, actor, actor_account_id, created_at, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      reportId,
      action,
      "AuditModerator (account_audit_moderator)",
      moderator.id,
      createdAt,
      detail,
    )
    .run();
}

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  member = await insertAccountFixture(database, {
    id: "account_audit_member",
    handle: "AuditMember",
    providers: ["discord", "email"],
  });
  moderator = await insertAccountFixture(database, {
    id: "account_audit_moderator",
    handle: "AuditModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  staleModerator = await insertAccountFixture(database, {
    id: "account_audit_stale_moderator",
    handle: "AuditStaleModerator",
    role: "moderator",
    providers: ["discord", "email"],
    authenticatedAt: staleAuthenticatedAt,
  });

  for (let index = 1; index <= 27; index += 1) {
    await insertAuditLog({
      id: index,
      reportId: index <= 2 ? "SR-AUDIT-FILTER" : `SR-AUDIT-${String(index).padStart(4, "0")}`,
      action: index <= 2 ? "evidence.published" : "report.updated",
      createdAt: new Date(Date.UTC(2026, 7, 10, 0, 0, index)).toISOString(),
      detail: `private@example.invalid originals/opaque-r2-key-${index}`,
    });
  }
});

after(async () => runtime?.dispose());

test("audit queue needs fresh moderator auth", async () => {
  const anonymous = await runtime.dispatchFetch("http://localhost/api/admin/audit");
  assert.equal(anonymous.status, 401);

  const denied = await runtime.dispatchFetch("http://localhost/api/admin/audit", {
    headers: authHeaders(member),
  });
  assert.equal(denied.status, 403);

  const stale = await runtime.dispatchFetch("http://localhost/api/admin/audit", {
    headers: authHeaders(staleModerator),
  });
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).code, "fresh_auth_required");
});

test("audit queue clamps pages and returns a small DTO", async () => {
  const response = await runtime.dispatchFetch(
    "http://localhost/api/admin/audit?page=99&pageSize=25",
    { headers: authHeaders(moderator) },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.deepEqual(payload.pagination, {
    page: 2,
    pageSize: 25,
    totalItems: 27,
    totalPages: 2,
  });
  assert.equal(payload.items.length, 2);
  assert.deepEqual(Object.keys(payload.items[0]).sort(), [
    "action",
    "actor",
    "actorVerified",
    "createdAt",
    "id",
    "reportId",
  ]);
  assert.equal(payload.items[0].actor, "AuditModerator");
  assert.equal(payload.items[0].actorVerified, true);
  assert.equal(JSON.stringify(payload).includes("private@example.invalid"), false);
  assert.equal(JSON.stringify(payload).includes("opaque-r2-key"), false);
  assert.equal(JSON.stringify(payload).includes("account_audit_moderator"), false);
});

test("anonymous appeal names stay unverified", async () => {
  await database
    .prepare(
      `INSERT INTO audit_logs
       (id, report_id, action, actor, actor_account_id, created_at, detail)
       VALUES (100, 'APL-2026-LEGACY01', 'appeal-submitted',
         'Claimed Staff Name', NULL, '2026-08-10T01:00:00.000Z', 'legacy fixture')`,
    )
    .run();
  const response = await runtime.dispatchFetch(
    "http://localhost/api/admin/audit?action=appeal-submitted",
    { headers: authHeaders(moderator) },
  );
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].actor, "Anonymous appellant");
  assert.equal(payload.items[0].actorVerified, false);
  assert.doesNotMatch(JSON.stringify(payload), /Claimed Staff Name/u);
});

test("audit queue filters by report, action, and text", async () => {
  const filtered = await runtime.dispatchFetch(
    "http://localhost/api/admin/audit?report=SR-AUDIT-FILTER&action=evidence.published&pageSize=100",
    { headers: authHeaders(moderator) },
  );
  assert.equal(filtered.status, 200, await filtered.clone().text());
  const payload = await filtered.json();
  assert.equal(payload.pagination.totalItems, 2);
  assert.ok(payload.items.every((entry) => entry.reportId === "SR-AUDIT-FILTER"));
  assert.ok(payload.items.every((entry) => entry.action === "evidence.published"));

  const textFiltered = await runtime.dispatchFetch("http://localhost/api/admin/audit?q=published", {
    headers: authHeaders(moderator),
  });
  assert.equal(textFiltered.status, 200, await textFiltered.clone().text());
  assert.equal((await textFiltered.json()).pagination.totalItems, 2);
});
