import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Miniflare } from "miniflare";
import {
  TEST_BINDINGS,
  TURNSTILE_BYPASS,
  applyNumberedMigrations,
  authHeaders,
  createTestRuntime,
  dispatchForm,
  getWorkerModules,
  insertAccountFixture,
  insertReportFixture,
  projectRoot,
} from "./helpers/runtime.mjs";

let runtime;
let database;
let member;
let moderator;

const CANONICAL_ID = "SR-INTAKE-CANONICAL";
const ALIAS_ID = "SR-INTAKE-ALIAS";

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  member = await insertAccountFixture(database, {
    id: `account_${"5".repeat(32)}`,
    handle: "FamilyIntakeMember",
    providers: ["email"],
  });
  moderator = await insertAccountFixture(database, {
    id: `account_${"6".repeat(32)}`,
    handle: "FamilyIntakeModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  for (const [id, username] of [
    [CANONICAL_ID, "IntakeCanonical"],
    [ALIAS_ID, "IntakeAlias"],
    ["SR-MERGE-CANONICAL", "MergeCanonical"],
    ["SR-MERGE-DUPLICATE", "MergeDuplicate"],
  ]) {
    await insertReportFixture(database, {
      id,
      username,
      discordId: id.includes("INTAKE") ? "700000000000000001" : "700000000000000002",
    });
  }
  await database
    .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
    .bind(CANONICAL_ID, ALIAS_ID)
    .run();
  await database
    .prepare(
      `INSERT INTO comments (
      id, report_id, parent_id, display_name, body, status, moderator_notes,
      author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES ('COM-ALIAS-PARENT', ?, NULL, 'Alias Parent',
      'Synthetic approved parent stored before the records were merged.',
      'Approved', '', 'alias-parent-fingerprint', 0, ?, ?)`,
    )
    .bind(ALIAS_ID, "2026-08-09T00:00:00.000Z", "2026-08-09T00:00:00.000Z")
    .run();
});

after(async () => runtime?.dispose());

function appealForm() {
  const form = new FormData();
  form.set("csrfToken", member.csrf);
  form.set("cf-turnstile-response", TURNSTILE_BYPASS);
  form.set("reportId", ALIAS_ID);
  form.set("requestType", "Correction");
  form.set("submitterName", "Synthetic Appellant");
  form.set("relationship", "Named person");
  form.set("contactEmail", "appellant@example.test");
  form.set(
    "body",
    "This synthetic correction request is long enough for validation and contains no real allegation.",
  );
  form.set("consent", "true");
  form.set("website", "");
  return form;
}

function reportForm() {
  const form = new FormData();
  form.set("csrfToken", member.csrf);
  form.set("cf-turnstile-response", TURNSTILE_BYPASS);
  form.set("submitterName", "Ignored Member Name");
  form.set("contactEmail", "member@example.test");
  form.set("username", "Synthetic Related Subject");
  form.set("discordId", "700000000000000003");
  form.set("game", "Synthetic Arena");
  form.set("category", "Cheating");
  form.set("reason", "Synthetic additional evidence requires review.");
  form.set(
    "description",
    "This synthetic related submission verifies canonical family persistence without naming any real person.",
  );
  form.set("relatedReportId", ALIAS_ID);
  form.set("consent", "true");
  form.set("website", "");
  return form;
}

test("public intake resolves merged report aliases", async () => {
  const reviewResponse = await runtime.dispatchFetch("http://localhost/api/reviews", {
    method: "POST",
    headers: authHeaders(member, { "content-type": "application/json" }),
    body: JSON.stringify({
      reportId: ALIAS_ID,
      displayName: "Ignored Name",
      rating: 4,
      relationship: "Player",
      title: "Synthetic canonical persistence",
      body: "This synthetic review verifies canonical report persistence across a merged alias.",
      website: "",
      csrfToken: member.csrf,
      turnstileToken: TURNSTILE_BYPASS,
    }),
  });
  const reviewPayload = await reviewResponse.json();
  assert.equal(reviewResponse.status, 201, JSON.stringify(reviewPayload));

  const commentResponse = await runtime.dispatchFetch("http://localhost/api/comments", {
    method: "POST",
    headers: authHeaders(member, { "content-type": "application/json" }),
    body: JSON.stringify({
      reportId: ALIAS_ID,
      parentId: "COM-ALIAS-PARENT",
      displayName: "Ignored Name",
      body: "This synthetic reply verifies canonical persistence and alias-family parent context.",
      website: "",
      csrfToken: member.csrf,
      turnstileToken: TURNSTILE_BYPASS,
    }),
  });
  const commentPayload = await commentResponse.json();
  assert.equal(commentResponse.status, 201, JSON.stringify(commentPayload));

  const appealResponse = await dispatchForm(
    runtime,
    "/api/appeals",
    appealForm(),
    authHeaders(member),
  );
  const appealPayload = await appealResponse.json();
  assert.equal(appealResponse.status, 201, JSON.stringify(appealPayload));

  const reportResponse = await dispatchForm(
    runtime,
    "/api/report-submissions",
    reportForm(),
    authHeaders(member),
  );
  const reportPayload = await reportResponse.json();
  assert.equal(reportResponse.status, 201, JSON.stringify(reportPayload));

  const [review, comment, appeal, appealAudit, submission] = await Promise.all([
    database
      .prepare("SELECT report_id FROM reviews WHERE id = ?")
      .bind(reviewPayload.review.id)
      .first(),
    database
      .prepare("SELECT report_id, parent_id FROM comments WHERE id = ?")
      .bind(commentPayload.comment.id)
      .first(),
    database
      .prepare("SELECT report_id FROM appeals WHERE id = ?")
      .bind(appealPayload.appeal.id)
      .first(),
    database
      .prepare(
        `SELECT actor, actor_account_id FROM audit_logs
         WHERE action = 'appeal-submitted' AND detail = ?`,
      )
      .bind(appealPayload.appeal.id)
      .first(),
    database
      .prepare("SELECT related_report_id FROM report_submissions WHERE id = ?")
      .bind(reportPayload.submission.id)
      .first(),
  ]);
  assert.equal(review.report_id, CANONICAL_ID);
  assert.deepEqual(comment, { report_id: CANONICAL_ID, parent_id: "COM-ALIAS-PARENT" });
  assert.equal(appeal.report_id, CANONICAL_ID);
  assert.deepEqual(appealAudit, {
    actor: member.handle,
    actor_account_id: member.id,
  });
  assert.equal(submission.related_report_id, CANONICAL_ID);

  await database
    .prepare("UPDATE comments SET status = 'Approved' WHERE id = ?")
    .bind(commentPayload.comment.id)
    .run();
  const familyCommentsResponse = await runtime.dispatchFetch(
    `http://localhost/api/comments?reportId=${encodeURIComponent(ALIAS_ID)}`,
  );
  assert.equal(familyCommentsResponse.status, 200);
  const familyComments = await familyCommentsResponse.json();
  const reply = familyComments.comments.find((entry) => entry.id === commentPayload.comment.id);
  assert.equal(reply.parentDisplayName, "Alias Parent");
});

test("merge preflight catches duplicate reviewers", async () => {
  const now = "2026-08-09T00:00:00.000Z";
  await database
    .prepare(
      `INSERT INTO reviews (
      id, report_id, account_id, display_name, rating, relationship, title, body,
      status, moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES
      ('REV-MERGE-CANONICAL', 'SR-MERGE-CANONICAL', ?, 'Shared Reviewer', 4,
       'Player', 'Canonical review', 'Synthetic canonical review for merge preflight.',
       'Approved', '', 'merge-review-canonical', 1, ?, ?),
      ('REV-MERGE-DUPLICATE', 'SR-MERGE-DUPLICATE', ?, 'Shared Reviewer', 2,
       'Player', 'Duplicate review', 'Synthetic duplicate review for merge preflight.',
       'Approved', '', 'merge-review-duplicate', 1, ?, ?)`,
    )
    .bind(member.id, now, now, member.id, now, now)
    .run();

  const query = new URLSearchParams({
    duplicateId: "SR-MERGE-DUPLICATE",
    canonicalId: "SR-MERGE-CANONICAL",
  });
  const preflightResponse = await runtime.dispatchFetch(
    `http://localhost/api/admin/merge?${query}`,
    { headers: authHeaders(moderator) },
  );
  assert.equal(preflightResponse.status, 200, await preflightResponse.clone().text());
  const preflight = await preflightResponse.json();
  assert.ok(
    preflight.preflight.conflicts.some((conflict) => /reviewed both records/iu.test(conflict)),
  );

  const mergeResponse = await runtime.dispatchFetch("http://localhost/api/admin/merge", {
    method: "POST",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify({
      duplicateId: "SR-MERGE-DUPLICATE",
      canonicalId: "SR-MERGE-CANONICAL",
    }),
  });
  assert.equal(mergeResponse.status, 409);
  assert.equal(
    await database
      .prepare("SELECT merged_into_report_id FROM reports WHERE id = ?")
      .bind("SR-MERGE-DUPLICATE")
      .first("merged_into_report_id"),
    null,
  );
});

test("notification worker reclaims expired leases", async () => {
  const cronRuntime = new Miniflare({
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    modules: await getWorkerModules(),
    modulesRoot: projectRoot,
    bindings: TEST_BINDINGS,
    d1Databases: ["DB"],
    r2Buckets: ["EVIDENCE_ORIGINALS", "EVIDENCE_DERIVATIVES", "BACKUPS"],
    unsafeTriggerHandlers: true,
  });
  await cronRuntime.ready;
  const cronDatabase = await cronRuntime.getD1Database("DB");
  await applyNumberedMigrations(cronDatabase);
  const id = "77777777-7777-4777-8777-777777777777";
  await cronDatabase
    .prepare(
      `INSERT INTO notification_outbox (
      id, event_key, channel, case_id, event_type, queue_path, status,
      attempts, next_attempt_at, last_error, created_at
    ) VALUES (?, 'report:SR-STALE-LEASE:email', 'email', 'SR-STALE-LEASE',
      'report', '/admin?queue=reports', 'sending', 4,
      '2000-01-01T00:00:00.000Z', '', '2000-01-01T00:00:00.000Z')`,
    )
    .bind(id)
    .run();

  try {
    const scheduledUrl = new URL("/cdn-cgi/local/scheduled", await cronRuntime.ready);
    scheduledUrl.searchParams.set("cron", "* * * * *");
    scheduledUrl.searchParams.set("time", String(Date.now()));
    const scheduled = await fetch(scheduledUrl);
    assert.equal(scheduled.status, 200, await scheduled.text());

    const recovered = await cronDatabase
      .prepare(
        `SELECT status, attempts, next_attempt_at, last_error
      FROM notification_outbox WHERE id = ?`,
      )
      .bind(id)
      .first();
    assert.equal(recovered.status, "failed");
    assert.equal(recovered.attempts, 5);
    assert.ok(new Date(recovered.next_attempt_at).getTime() > Date.now());
    assert.match(recovered.last_error, /not configured/iu);
  } finally {
    await cronRuntime.dispose();
  }
});
