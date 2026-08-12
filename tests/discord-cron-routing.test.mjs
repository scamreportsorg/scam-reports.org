import assert from "node:assert/strict";
import test from "node:test";
import { createTestRuntime } from "./helpers/runtime.mjs";

const WEBHOOK_URL = `https://discord.com/api/webhooks/123456789012345678/${"M".repeat(68)}`;
const MESSAGE_ID = "923456789012345678";
const OUTBOX_ID = "12121212-1212-4212-8212-121212121212";

async function dispatchCron(runtime, cron) {
  const scheduledUrl = new URL("/cdn-cgi/local/scheduled", await runtime.ready);
  scheduledUrl.searchParams.set("cron", cron);
  scheduledUrl.searchParams.set("time", String(Date.parse("2026-08-11T12:34:56.000Z")));
  return fetch(scheduledUrl);
}

test("only the minute cron runs Discord jobs", async (t) => {
  const requests = [];
  const { runtime, database } = await createTestRuntime({
    bindings: {
      MODERATOR_DISCORD_WEBHOOK_URL: WEBHOOK_URL,
      AUTH_APP_ORIGIN: "https://scam-reports.org",
    },
    unsafeTriggerHandlers: true,
    outboundService: async (request) => {
      requests.push({ url: request.url, method: request.method, payload: await request.json() });
      return Response.json({ id: MESSAGE_ID });
    },
  });
  t.after(() => runtime.dispose());

  await database
    .prepare(
      `INSERT INTO notification_outbox
        (id, event_key, channel, case_id, event_type, queue_path, status,
         attempts, next_attempt_at, last_error, created_at)
       VALUES (?, 'report:SR-CRON-MINUTE:discord', 'discord', 'SR-CRON-MINUTE',
         'report', '/admin?queue=reports', 'pending', 0,
         '2000-01-01T00:00:00.000Z', '', '2000-01-01T00:00:00.000Z')`,
    )
    .bind(OUTBOX_ID)
    .run();

  const unknown = await dispatchCron(runtime, "23 4 * * MON");
  assert.equal(unknown.status, 200, await unknown.text());
  assert.equal(
    await database
      .prepare("SELECT status FROM notification_outbox WHERE id = ?")
      .bind(OUTBOX_ID)
      .first("status"),
    "pending",
  );
  assert.equal(await database.prepare("SELECT COUNT(*) FROM backup_runs").first("COUNT(*)"), 0);
  assert.equal(requests.length, 0);

  const minute = await dispatchCron(runtime, "* * * * *");
  assert.equal(minute.status, 200, await minute.text());
  const delivered = await database
    .prepare(
      `SELECT status, attempts, provider_message_id
       FROM notification_outbox WHERE id = ?`,
    )
    .bind(OUTBOX_ID)
    .first();
  assert.deepEqual(delivered, {
    status: "delivered",
    attempts: 1,
    provider_message_id: MESSAGE_ID,
  });
  assert.equal(await database.prepare("SELECT COUNT(*) FROM backup_runs").first("COUNT(*)"), 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${WEBHOOK_URL}?wait=true`);
  assert.equal(requests[0].method, "POST");
  assert.deepEqual(requests[0].payload.allowed_mentions, { parse: [] });
});
