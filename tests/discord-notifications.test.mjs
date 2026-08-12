import assert from "node:assert/strict";
import test from "node:test";
import { createTestRuntime } from "./helpers/runtime.mjs";

const WEBHOOK_URL = `https://discord.com/api/webhooks/123456789012345678/${"C".repeat(68)}`;
const DELIVERED_MESSAGE_ID = "923456789012345678";
const EVIDENCE_MESSAGE_ID = "823456789012345678";
const EVIDENCE_CASE_ID = "EVA-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

test("webhook failures stay private and stop retrying", async (t) => {
  const requests = [];
  const { runtime, database } = await createTestRuntime({
    bindings: {
      MODERATOR_DISCORD_WEBHOOK_URL: WEBHOOK_URL,
      AUTH_APP_ORIGIN: "https://scam-reports.org",
    },
    unsafeTriggerHandlers: true,
    outboundService: async (request) => {
      const payload = await request.json();
      requests.push({ url: request.url, method: request.method, payload });
      if (String(payload.content).includes("SR-WEBHOOK-GONE")) {
        return new Response("private Discord diagnostic token=gone-secret", { status: 404 });
      }
      if (String(payload.content).includes("SR-WEBHOOK-RATE")) {
        return Response.json({ retry_after: 1.25 }, { status: 429 });
      }
      if (String(payload.content).includes("SR-WEBHOOK-SUCCESS")) {
        return Response.json({ id: DELIVERED_MESSAGE_ID });
      }
      if (String(payload.content).includes(EVIDENCE_CASE_ID)) {
        return Response.json({ id: EVIDENCE_MESSAGE_ID });
      }
      return new Response("private Discord diagnostic token=retry-secret", { status: 500 });
    },
  });
  t.after(() => runtime.dispose());

  await database.batch([
    database.prepare(
      `INSERT INTO notification_outbox
        (id, event_key, channel, case_id, event_type, queue_path, status,
         attempts, next_attempt_at, last_error, created_at)
        VALUES ('44444444-4444-4444-8444-444444444444',
          'report:SR-WEBHOOK-MAX:discord', 'discord', 'SR-WEBHOOK-MAX', 'report',
          '/admin?queue=reports', 'failed', 7, '2000-01-01T00:00:00.000Z', '',
          '2000-01-01T00:00:00.000Z')`,
    ),
    database.prepare(
      `INSERT INTO notification_outbox
        (id, event_key, channel, case_id, event_type, queue_path, status,
         attempts, next_attempt_at, last_error, created_at)
        VALUES ('55555555-5555-4555-8555-555555555555',
          'appeal:SR-WEBHOOK-GONE:discord', 'discord', 'SR-WEBHOOK-GONE', 'appeal',
          '/admin?queue=appeals', 'pending', 0, '2000-01-01T00:00:00.000Z', '',
          '2000-01-01T00:00:01.000Z')`,
    ),
    database.prepare(
      `INSERT INTO notification_outbox
        (id, event_key, channel, case_id, event_type, queue_path, status,
         attempts, next_attempt_at, last_error, created_at)
        VALUES ('66666666-6666-4666-8666-666666666666',
          'report:SR-WEBHOOK-PRIVATE:discord', 'discord', 'SR-WEBHOOK-PRIVATE',
          'report @everyone person@example.invalid', '/admin?queue=reports',
          'pending', 0, '2000-01-01T00:00:00.000Z', '',
          '2000-01-01T00:00:02.000Z')`,
    ),
    database.prepare(
      `INSERT INTO notification_outbox
        (id, event_key, channel, case_id, event_type, queue_path, status,
         attempts, next_attempt_at, last_error, created_at)
        VALUES ('77777777-7777-4777-8777-777777777777',
          'review:SR-WEBHOOK-RATE:discord', 'discord', 'SR-WEBHOOK-RATE', 'review',
          '/admin?queue=reviews', 'pending', 0, '2000-01-01T00:00:00.000Z', '',
          '2000-01-01T00:00:03.000Z')`,
    ),
    database.prepare(
      `INSERT INTO notification_outbox
        (id, event_key, channel, case_id, event_type, queue_path, status,
         attempts, next_attempt_at, last_error, created_at)
        VALUES ('88888888-8888-4888-8888-888888888888',
          'comment:SR-WEBHOOK-SUCCESS:discord', 'discord', 'SR-WEBHOOK-SUCCESS', 'comment',
          '/admin?queue=comments', 'pending', 0, '2000-01-01T00:00:00.000Z', '',
          '2000-01-01T00:00:04.000Z')`,
    ),
    database
      .prepare(
        `INSERT INTO notification_outbox
        (id, event_key, channel, case_id, event_type, queue_path, status,
         attempts, next_attempt_at, last_error, created_at)
        VALUES ('99999999-9999-4999-8999-999999999999', ?, 'discord', ?, 'evidence',
          '/admin?queue=evidence', 'pending', 0, '2000-01-01T00:00:00.000Z', '',
          '2000-01-01T00:00:05.000Z')`,
      )
      .bind(`evidence:${EVIDENCE_CASE_ID}:discord`, EVIDENCE_CASE_ID),
  ]);

  const startedAt = Date.now();
  const scheduledUrl = new URL("/cdn-cgi/local/scheduled", await runtime.ready);
  scheduledUrl.searchParams.set("cron", "* * * * *");
  scheduledUrl.searchParams.set("time", String(Date.now()));
  const response = await fetch(scheduledUrl);
  const completedAt = Date.now();
  assert.equal(response.status, 200, await response.text());

  const rows = await database
    .prepare(
      `SELECT case_id, status, attempts, next_attempt_at, last_error, provider_message_id
       FROM notification_outbox
       ORDER BY case_id`,
    )
    .all();
  assert.deepEqual(
    rows.results.map((row) => ({
      caseId: row.case_id,
      status: row.status,
      attempts: row.attempts,
    })),
    [
      { caseId: EVIDENCE_CASE_ID, status: "delivered", attempts: 1 },
      { caseId: "SR-WEBHOOK-GONE", status: "dead", attempts: 1 },
      { caseId: "SR-WEBHOOK-MAX", status: "dead", attempts: 8 },
      { caseId: "SR-WEBHOOK-PRIVATE", status: "dead", attempts: 1 },
      { caseId: "SR-WEBHOOK-RATE", status: "failed", attempts: 1 },
      { caseId: "SR-WEBHOOK-SUCCESS", status: "delivered", attempts: 1 },
    ],
  );
  const rateLimited = rows.results.find((row) => row.case_id === "SR-WEBHOOK-RATE");
  assert.ok(rateLimited);
  const retryAt = Date.parse(rateLimited.next_attempt_at);
  assert.ok(retryAt >= startedAt + 1250);
  assert.ok(retryAt < completedAt + 1500);
  assert.equal(
    rows.results.find((row) => row.case_id === "SR-WEBHOOK-SUCCESS")?.provider_message_id,
    DELIVERED_MESSAGE_ID,
  );
  assert.equal(
    rows.results.find((row) => row.case_id === EVIDENCE_CASE_ID)?.provider_message_id,
    EVIDENCE_MESSAGE_ID,
  );
  assert.doesNotMatch(
    JSON.stringify(rows.results),
    /gone-secret|retry-secret|discord\.com|CCCCCCCC/iu,
  );
  assert.equal(requests.length, 5);
  for (const request of requests) {
    assert.equal(request.url, `${WEBHOOK_URL}?wait=true`);
    assert.equal(request.method, "POST");
    assert.deepEqual(request.payload.allowed_mentions, { parse: [] });
    assert.doesNotMatch(
      JSON.stringify(request.payload),
      /reporter|contact|evidence contents?|moderator note|@everyone|@here/iu,
    );
  }
});
