import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  TURNSTILE_BYPASS,
  authHeaders,
  createTestRuntime,
  dispatchForm,
  insertAccountFixture,
  insertReportFixture,
} from "./helpers/runtime.mjs";

let runtime;
let database;
let member;

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  member = await insertAccountFixture(database, {
    id: "account_outbox_member",
    handle: "OutboxMember",
    providers: ["email"],
  });
  await insertReportFixture(database, {
    id: "SR-OUTBOX-0001",
    username: "OutboxFixture",
    discordId: "100000000000000091",
  });
});

after(async () => runtime?.dispose());

function commentBody(suffix) {
  return {
    reportId: "SR-OUTBOX-0001",
    parentId: null,
    displayName: "IgnoredName",
    body: `Synthetic comment ${suffix} contains enough detail for moderation review.`,
    website: "",
    turnstileToken: TURNSTILE_BYPASS,
  };
}

async function postComment(body) {
  return runtime.dispatchFetch("http://localhost/api/comments", {
    method: "POST",
    headers: authHeaders(member, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

function reportForm() {
  const form = new FormData();
  form.set("csrfToken", member.csrf);
  form.set("submitterName", member.handle);
  form.set("contactEmail", "");
  form.set("username", "AtomicReportSubject");
  form.set("discordId", "100000000000000093");
  form.set("game", "Synthetic Arena");
  form.set("category", "Cheating");
  form.set("reason", "A detailed synthetic reason for the atomicity test.");
  form.set(
    "description",
    "A sufficiently long synthetic timeline used only to verify an atomic database batch.",
  );
  form.set("relatedReportId", "");
  form.set("consent", "true");
  form.set("website", "");
  form.set("cf-turnstile-response", TURNSTILE_BYPASS);
  return form;
}

function appealForm() {
  const form = new FormData();
  form.set("csrfToken", member.csrf);
  form.set("reportId", "SR-OUTBOX-0001");
  form.set("requestType", "Correction");
  form.set("submitterName", "Atomic Appellant");
  form.set("relationship", "Named person");
  form.set("contactEmail", "atomic-appellant@example.invalid");
  form.set(
    "body",
    "A sufficiently long synthetic appeal statement used only to verify an atomic database batch.",
  );
  form.set("consent", "true");
  form.set("website", "");
  form.set("cf-turnstile-response", TURNSTILE_BYPASS);
  return form;
}

function reviewBody() {
  return {
    reportId: "SR-OUTBOX-0001",
    displayName: "IgnoredName",
    rating: 3,
    relationship: "Buyer",
    title: "Synthetic review title",
    body: "Synthetic review content contains enough detail for private moderation review.",
    website: "",
    turnstileToken: TURNSTILE_BYPASS,
  };
}

async function postReview(body = reviewBody()) {
  return runtime.dispatchFetch("http://localhost/api/reviews", {
    method: "POST",
    headers: authHeaders(member, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
}

test("moderation intake rolls back as one transaction", async () => {
  const cases = [
    {
      name: "report",
      tables: ["report_submissions"],
      post: () =>
        dispatchForm(runtime, "/api/report-submissions", reportForm(), authHeaders(member)),
    },
    {
      name: "appeal",
      tables: ["appeals"],
      post: () => dispatchForm(runtime, "/api/appeals", appealForm(), authHeaders(member)),
    },
    {
      name: "comment",
      tables: ["comments"],
      post: () => postComment(commentBody("all-kinds-rollback")),
    },
    {
      name: "review",
      tables: ["reviews", "review_revisions"],
      post: () => postReview(),
    },
  ];

  for (const entry of cases) {
    const before = Object.fromEntries(
      await Promise.all(
        [...entry.tables, "audit_logs", "notification_outbox"].map(async (table) => [
          table,
          await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count"),
        ]),
      ),
    );
    const trigger = `test_reject_outbox_${entry.name}`;
    await database
      .prepare(
        `CREATE TRIGGER ${trigger}
      BEFORE INSERT ON notification_outbox
      BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END`,
      )
      .run();
    let response;
    try {
      response = await entry.post();
    } finally {
      await database.prepare(`DROP TRIGGER ${trigger}`).run();
    }
    assert.equal(response.status, 500, `${entry.name}: ${await response.text()}`);
    for (const [table, expected] of Object.entries(before)) {
      assert.equal(
        await database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first("count"),
        expected,
        `${entry.name} left a partial ${table} write`,
      );
    }
  }
});

test("outbox failure rolls back moderation and audit", async () => {
  await database
    .prepare(
      `CREATE TRIGGER test_reject_outbox
    BEFORE INSERT ON notification_outbox
    BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END`,
    )
    .run();

  const response = await postComment(commentBody("rollback"));
  assert.equal(response.status, 500);
  assert.equal(await database.prepare("SELECT COUNT(*) AS count FROM comments").first("count"), 0);
  assert.equal(
    await database
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'comment-submitted'")
      .first("count"),
    0,
  );
  assert.equal(
    await database.prepare("SELECT COUNT(*) AS count FROM notification_outbox").first("count"),
    0,
  );

  await database.prepare("DROP TRIGGER test_reject_outbox").run();
});

test("moderation queues email and Discord together", async () => {
  const response = await postComment(commentBody("success"));
  assert.equal(response.status, 201, await response.text());
  const comment = await database.prepare("SELECT id FROM comments LIMIT 1").first();
  assert.ok(comment?.id);
  const rows = await database
    .prepare("SELECT event_key, channel, case_id, status FROM notification_outbox ORDER BY channel")
    .all();
  assert.deepEqual(rows.results, [
    {
      event_key: `comment:${comment.id}:discord`,
      channel: "discord",
      case_id: comment.id,
      status: "pending",
    },
    {
      event_key: `comment:${comment.id}:email`,
      channel: "email",
      case_id: comment.id,
      status: "pending",
    },
  ]);

  await database
    .prepare(
      `INSERT OR IGNORE INTO notification_outbox
    (id, event_key, channel, case_id, event_type, queue_path, status,
     attempts, next_attempt_at, last_error, created_at)
    SELECT 'duplicate-attempt', event_key, channel, case_id, event_type, queue_path,
      'pending', 0, next_attempt_at, '', created_at
    FROM notification_outbox WHERE event_key = ?`,
    )
    .bind(`comment:${comment.id}:email`)
    .run();
  assert.equal(
    await database.prepare("SELECT COUNT(*) AS count FROM notification_outbox").first("count"),
    2,
  );
});

test("review revisions get their own notification pair", async () => {
  const payload = reviewBody();
  const first = await postReview(payload);
  assert.equal(first.status, 201, await first.text());
  const second = await postReview({ ...payload, body: `${payload.body} Updated once.` });
  assert.equal(second.status, 201, await second.text());

  const reviewId = await database.prepare("SELECT id FROM reviews LIMIT 1").first("id");
  const outboxCount = await database
    .prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE case_id = ?")
    .bind(reviewId)
    .first("count");
  assert.equal(outboxCount, 4);
  const eventKeys = await database
    .prepare(
      `SELECT event_key FROM notification_outbox
    WHERE case_id = ? ORDER BY event_key`,
    )
    .bind(reviewId)
    .all("event_key");
  assert.equal(new Set(eventKeys.results).size, 4);
});
