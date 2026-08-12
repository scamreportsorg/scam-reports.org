import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { authHeaders, createTestRuntime, insertAccountFixture } from "./helpers/runtime.mjs";

const FAILED_ID = "11111111-1111-4111-8111-111111111111";
const PENDING_ID = "22222222-2222-4222-8222-222222222222";
const DELIVERED_ID = "33333333-3333-4333-8333-333333333333";
const APPLICATION_ID = "44444444-4444-4444-8444-444444444444";
const DEAD_ID = "55555555-5555-4555-8555-555555555555";

let runtime;
let database;
let admin;
let moderator;
let staleAdmin;

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  admin = await insertAccountFixture(database, {
    id: `account_${"a".repeat(32)}`,
    handle: "OperationsAdmin",
    role: "admin",
    providers: ["discord", "email"],
  });
  moderator = await insertAccountFixture(database, {
    id: `account_${"b".repeat(32)}`,
    handle: "OperationsModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  staleAdmin = await insertAccountFixture(database, {
    id: `account_${"c".repeat(32)}`,
    handle: "StaleOperationsAdmin",
    role: "admin",
    providers: ["discord", "email"],
    authenticatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  });

  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `INSERT INTO notification_outbox
      (id, event_key, channel, case_id, event_type, queue_path, status,
       attempts, next_attempt_at, last_error, created_at)
      VALUES (?, ?, 'email', 'SR-2026-FAILED', 'report', '/admin?queue=reports',
       'failed', 3, ?, ?, ?)`,
      )
      .bind(
        FAILED_ID,
        "report:SR-2026-FAILED:email",
        now,
        [
          "Provider failed at https://private-webhook.invalid/send?token",
          "test-redaction-token-placeholder",
        ].join("="),
        now,
      ),
    database
      .prepare(
        `INSERT INTO notification_outbox
      (id, event_key, channel, case_id, event_type, queue_path, status,
       attempts, next_attempt_at, last_error, created_at)
      VALUES (?, ?, 'discord', 'SR-2026-PENDING', 'appeal', '/admin?queue=appeals',
       'pending', 0, ?, '', ?)`,
      )
      .bind(PENDING_ID, "appeal:SR-2026-PENDING:discord", now, now),
    database
      .prepare(
        `INSERT INTO notification_outbox
      (id, event_key, channel, case_id, event_type, queue_path, status,
       attempts, next_attempt_at, last_error, created_at, delivered_at)
      VALUES (?, ?, 'email', 'SR-2026-DONE', 'comment', '/admin?queue=comments',
       'delivered', 1, ?, '', ?, ?)`,
      )
      .bind(DELIVERED_ID, "comment:SR-2026-DONE:email", now, now, now),
    database
      .prepare(
        `INSERT INTO notification_outbox
      (id, event_key, channel, case_id, event_type, queue_path, status,
       attempts, next_attempt_at, last_error, created_at)
      VALUES (?, ?, 'discord', 'MODAPP-2026-PENDING', 'application', '/admin?queue=applications',
       'pending', 0, ?, '', ?)`,
      )
      .bind(APPLICATION_ID, "application:MODAPP-2026-PENDING:discord", now, now),
    database
      .prepare(
        `INSERT INTO backup_runs
      (id, kind, status, object_key, sha256, size, bookmark, error, started_at, completed_at)
      VALUES ('backup_weekly_001', 'weekly', 'completed', ?, ?, 2048, ?, '', ?, ?)`,
      )
      .bind(
        "private/backups/database-export.sql",
        "private-sha256-value",
        "private-time-travel-bookmark",
        now,
        now,
      ),
    database
      .prepare(
        `INSERT INTO backup_runs
      (id, kind, status, object_key, sha256, size, bookmark, error, started_at)
      VALUES ('backup_monthly_002', 'monthly', 'failed', ?, NULL, NULL, NULL, ?, ?)`,
      )
      .bind("private/backups/failed.sql", "secret operator failure token=abcd", now),
    database
      .prepare(
        `INSERT INTO notification_outbox
      (id, event_key, channel, case_id, event_type, queue_path, status,
       attempts, next_attempt_at, last_error, provider_message_id, created_at)
      VALUES (?, ?, 'discord', 'SR-2026-DEAD', 'review', '/admin?queue=reviews',
       'dead', 8, ?, 'Delivery stopped after repeated failures.', '923456789012345678', ?)`,
      )
      .bind(DEAD_ID, "review:SR-2026-DEAD:discord", now, now),
  ]);

  const securityStatements = [];
  for (let index = 0; index < 28; index += 1) {
    const suffix = index.toString(16).padStart(32, "0");
    securityStatements.push(
      database
        .prepare(
          `INSERT INTO auth_security_events
        (id, account_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          `security_${suffix}`,
          index === 0 ? admin.id : null,
          index === 0 ? "account.access_changed" : "auth.synthetic",
          JSON.stringify({
            actorAccountId: admin.id,
            targetAccountId: moderator.id,
            fromRole: "member",
            toRole: "moderator",
            fromStatus: "active",
            toStatus: "active",
            contactEmail: "private@example.invalid",
            requestFingerprint: "private-fingerprint-value",
          }),
          new Date(Date.now() - index * 1000).toISOString(),
        ),
    );
  }
  await database.batch(securityStatements);
});

after(async () => runtime?.dispose());

test("admin is required for operation data", async () => {
  const paths = [
    "/api/admin/operations/notifications",
    "/api/admin/operations/backups",
    "/api/admin/operations/security-events",
  ];
  for (const path of paths) {
    const anonymous = await runtime.dispatchFetch(`http://localhost${path}`);
    assert.equal(anonymous.status, 401);
    const denied = await runtime.dispatchFetch(`http://localhost${path}`, {
      headers: authHeaders(moderator),
    });
    assert.equal(denied.status, 403);
  }
});

test("operation queues paginate without private values", async () => {
  const notificationResponse = await runtime.dispatchFetch(
    "http://localhost/api/admin/operations/notifications",
    { headers: authHeaders(admin) },
  );
  assert.equal(notificationResponse.status, 200, await notificationResponse.clone().text());
  const notifications = await notificationResponse.json();
  assert.equal(notifications.pagination.pageSize, 25);
  assert.equal(notifications.pagination.totalItems, 4);
  assert.deepEqual(
    new Set(notifications.items.map((item) => item.status)),
    new Set(["dead", "failed", "pending"]),
  );
  assert.doesNotMatch(
    JSON.stringify(notifications),
    /private-webhook|test-redaction-token-placeholder/iu,
  );
  assert.equal(
    notifications.items.find((item) => item.id === APPLICATION_ID)?.queuePath,
    "/admin?queue=applications",
  );

  const backupResponse = await runtime.dispatchFetch(
    "http://localhost/api/admin/operations/backups",
    { headers: authHeaders(admin) },
  );
  assert.equal(backupResponse.status, 200, await backupResponse.clone().text());
  const backups = await backupResponse.json();
  assert.equal(backups.pagination.pageSize, 25);
  assert.equal(backups.items.length, 2);
  assert.doesNotMatch(
    JSON.stringify(backups),
    /object_key|private\/backups|private-sha256|private-time-travel|operator failure token/iu,
  );

  const firstSecurityResponse = await runtime.dispatchFetch(
    "http://localhost/api/admin/operations/security-events?page=1",
    { headers: authHeaders(admin) },
  );
  const firstSecurityPage = await firstSecurityResponse.json();
  assert.equal(firstSecurityResponse.status, 200);
  assert.equal(firstSecurityPage.pagination.pageSize, 25);
  assert.equal(firstSecurityPage.pagination.totalItems, 28);
  assert.equal(firstSecurityPage.items.length, 25);
  assert.doesNotMatch(
    JSON.stringify(firstSecurityPage),
    /private@example|private-fingerprint|contactEmail|requestFingerprint/iu,
  );

  const secondSecurityResponse = await runtime.dispatchFetch(
    "http://localhost/api/admin/operations/security-events?page=2",
    { headers: authHeaders(admin) },
  );
  const secondSecurityPage = await secondSecurityResponse.json();
  assert.equal(secondSecurityPage.items.length, 3);
});

test("notification retry checks fresh auth and CSRF", async () => {
  const retryUrl = `http://localhost/api/admin/operations/notifications/${FAILED_ID}/retry`;
  const missingCsrf = await runtime.dispatchFetch(retryUrl, {
    method: "POST",
    headers: { origin: "http://localhost", cookie: admin.cookie },
  });
  assert.equal(missingCsrf.status, 403);

  const stale = await runtime.dispatchFetch(retryUrl, {
    method: "POST",
    headers: authHeaders(staleAdmin),
  });
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).code, "fresh_auth_required");

  const [first, second] = await Promise.all([
    runtime.dispatchFetch(retryUrl, { method: "POST", headers: authHeaders(admin) }),
    runtime.dispatchFetch(retryUrl, { method: "POST", headers: authHeaders(admin) }),
  ]);
  assert.equal(first.status, 200, await first.clone().text());
  assert.equal(second.status, 200, await second.clone().text());
  const results = [await first.json(), await second.json()];
  assert.deepEqual(results.map((result) => result.changed).sort(), [false, true]);

  const row = await database
    .prepare("SELECT status, attempts, last_error FROM notification_outbox WHERE id = ?")
    .bind(FAILED_ID)
    .first();
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
  assert.equal(row.last_error, "");
  const auditCount = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM auth_security_events
      WHERE event_type = 'notification.retry_requested'`,
    )
    .first();
  assert.equal(auditCount.count, 1);

  const deadRetry = await runtime.dispatchFetch(
    `http://localhost/api/admin/operations/notifications/${DEAD_ID}/retry`,
    { method: "POST", headers: authHeaders(admin) },
  );
  assert.equal(deadRetry.status, 200, await deadRetry.clone().text());
  assert.equal((await deadRetry.json()).changed, true);
  const retriedDead = await database
    .prepare(
      `SELECT status, attempts, last_error, provider_message_id
       FROM notification_outbox WHERE id = ?`,
    )
    .bind(DEAD_ID)
    .first();
  assert.deepEqual(retriedDead, {
    status: "pending",
    attempts: 0,
    last_error: "",
    provider_message_id: null,
  });

  const delivered = await runtime.dispatchFetch(
    `http://localhost/api/admin/operations/notifications/${DELIVERED_ID}/retry`,
    { method: "POST", headers: authHeaders(admin) },
  );
  assert.equal(delivered.status, 409);
  assert.equal((await delivered.json()).code, "notification_not_retryable");
});
