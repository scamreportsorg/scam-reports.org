import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  authHeaders,
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
  TURNSTILE_BYPASS,
} from "./helpers/runtime.mjs";

let runtime;
let database;
let member;
let moderator;
let administrator;
let staleAdministrator;

const now = "2026-08-09T10:00:00.000Z";

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  member = await insertAccountFixture(database, {
    id: `account_${"1".repeat(32)}`,
    handle: "CommunityMember",
    providers: ["discord", "email"],
  });
  moderator = await insertAccountFixture(database, {
    id: `account_${"2".repeat(32)}`,
    handle: "CommunityModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  administrator = await insertAccountFixture(database, {
    id: `account_${"3".repeat(32)}`,
    handle: "CommunityAdmin",
    role: "admin",
    providers: ["discord", "email"],
  });
  staleAdministrator = await insertAccountFixture(database, {
    id: `account_${"4".repeat(32)}`,
    handle: "StaleCommunityAdmin",
    role: "admin",
    providers: ["discord", "email"],
    authenticatedAt: "2020-01-01T00:00:00.000Z",
  });

  for (const report of [
    { id: "SR-COMM-PUBLIC", published: true },
    { id: "SR-COMM-PRIVATE", published: false },
    { id: "SR-COMM-GOOD-ALIAS", published: false },
    { id: "SR-COMM-WITHDRAWN", published: false },
    { id: "SR-COMM-BAD-ALIAS", published: true },
  ]) {
    await insertReportFixture(database, {
      id: report.id,
      username: report.id,
      discordId: `8000000000000000${String(report.id.length).padStart(2, "0")}`,
      isPublished: report.published,
    });
  }
  await database
    .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
    .bind("SR-COMM-PUBLIC", "SR-COMM-GOOD-ALIAS")
    .run();
  await database
    .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
    .bind("SR-COMM-WITHDRAWN", "SR-COMM-BAD-ALIAS")
    .run();

  for (const [suffix, reportId] of [
    ["PUBLIC", "SR-COMM-PUBLIC"],
    ["PRIVATE", "SR-COMM-PRIVATE"],
    ["GOOD-ALIAS", "SR-COMM-GOOD-ALIAS"],
    ["BAD-ALIAS", "SR-COMM-BAD-ALIAS"],
  ]) {
    await database
      .prepare(
        `INSERT INTO reviews (
        id, report_id, display_name, rating, relationship, title, body, status,
        moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
      ) VALUES (?, ?, 'Fixture Reviewer', 4, 'Player', 'Approved fixture review',
        'Synthetic approved review body used only for route isolation tests.',
        'Approved', 'PRIVATE REVIEW NOTE', ?, 1, ?, ?)`,
      )
      .bind(`REV-${suffix}-0001`, reportId, `SECRET-REVIEW-FP-${suffix}`, now, now)
      .run();
    await database
      .prepare(
        `INSERT INTO comments (
        id, report_id, parent_id, display_name, body, status, moderator_notes,
        author_fingerprint, reviewer_verified, created_at, updated_at
      ) VALUES (?, ?, NULL, 'Fixture Commenter', 'Synthetic approved discussion reply.',
        'Approved', 'PRIVATE COMMENT NOTE', ?, 1, ?, ?)`,
      )
      .bind(`COM-${suffix}-0001`, reportId, `SECRET-COMMENT-FP-${suffix}`, now, now)
      .run();
  }

  await database
    .prepare(
      `INSERT INTO comments (
      id, report_id, parent_id, display_name, body, status, moderator_notes,
      author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES ('COM-PENDING-0001', 'SR-COMM-PUBLIC', NULL, 'Pending Commenter',
      'Synthetic pending discussion reply.', 'Pending', '', 'pending-comment-fp', 1, ?, ?)`,
    )
    .bind(now, now)
    .run();
  await database
    .prepare(
      `INSERT INTO reviews (
      id, report_id, display_name, rating, relationship, title, body, status,
      moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES ('REV-DELETE-0001', 'SR-COMM-PUBLIC', 'Delete Reviewer', 3, 'Player',
      'Delete fixture review', 'Synthetic review scheduled for an administrator deletion test.',
      'Approved', '', 'delete-review-fp', 1, ?, ?)`,
    )
    .bind(now, now)
    .run();
  await database
    .prepare(
      `INSERT INTO comments (
      id, report_id, parent_id, display_name, body, status, moderator_notes,
      author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES ('COM-DELETE-0001', 'SR-COMM-PUBLIC', NULL, 'Delete Commenter',
      'Synthetic comment scheduled for deletion.', 'Pending', '', 'delete-comment-fp', 1, ?, ?)`,
    )
    .bind(now, now)
    .run();

  for (const id of ["SUB-QUEUE-0001", "SUB-DELETE-0001"]) {
    await database
      .prepare(
        `INSERT INTO report_submissions (
        id, account_id, related_report_id, submitter_name, contact_email, username,
        discord_id, game, category, reason, description, evidence_json, status,
        moderator_notes, author_fingerprint, submitter_verified, result_report_id,
        created_at, updated_at
      ) VALUES (?, ?, 'SR-COMM-PUBLIC', 'Private Submitter', 'private@example.test',
        'Synthetic Subject', '800000000000000001', 'Synthetic Arena', 'Cheating',
        'Synthetic queue reason.', 'Synthetic private intake description used only by tests.',
        '[]', 'Pending', 'PRIVATE SUBMISSION NOTE', 'SECRET-SUBMISSION-FP', 1, NULL, ?, ?)`,
      )
      .bind(id, member.id, now, now)
      .run();
  }

  for (const [id, reportId, status, publicResolution] of [
    ["APL-QUEUE-0001", "SR-COMM-PUBLIC", "Accepted", "Public synthetic resolution."],
    ["APL-PRIVATE-0001", "SR-COMM-PRIVATE", "Accepted", "Must remain private."],
    ["APL-DELETE-0001", "SR-COMM-PUBLIC", "Pending", ""],
  ]) {
    await database
      .prepare(
        `INSERT INTO appeals (
        id, account_id, report_id, request_type, submitter_name, relationship,
        contact_email, body, evidence_json, status, moderator_notes, public_resolution,
        author_fingerprint, submitter_verified, created_at, updated_at
      ) VALUES (?, NULL, ?, 'Correction', 'Private Appellant', 'Named person',
        'appeal-private@example.test', 'Synthetic private appeal body used only by tests.',
        '[]', ?, 'PRIVATE APPEAL NOTE', ?, 'SECRET-APPEAL-FP', 0, ?, ?)`,
      )
      .bind(id, reportId, status, publicResolution, now, now)
      .run();
  }
});

after(async () => runtime?.dispose());

test("public discussion needs a published report", async () => {
  const reviewResponse = await runtime.dispatchFetch(
    "http://localhost/api/reviews?includeUnpublished=1",
  );
  assert.equal(reviewResponse.status, 200);
  const reviewPayload = await reviewResponse.json();
  const reviewIds = new Set(reviewPayload.reviews.map((review) => review.id));
  assert.equal(reviewIds.has("REV-PUBLIC-0001"), true);
  assert.equal(reviewIds.has("REV-GOOD-ALIAS-0001"), true);
  assert.equal(reviewIds.has("REV-PRIVATE-0001"), false);
  assert.equal(reviewIds.has("REV-BAD-ALIAS-0001"), false);
  assert.equal(reviewIds.has("REV-DELETE-0001"), true);
  assert.doesNotMatch(JSON.stringify(reviewPayload), /PRIVATE REVIEW NOTE|SECRET-REVIEW-FP/u);

  const commentResponse = await runtime.dispatchFetch(
    "http://localhost/api/comments?includeUnpublished=1",
  );
  assert.equal(commentResponse.status, 200);
  const commentPayload = await commentResponse.json();
  const commentIds = new Set(commentPayload.comments.map((comment) => comment.id));
  assert.equal(commentIds.has("COM-PUBLIC-0001"), true);
  assert.equal(commentIds.has("COM-GOOD-ALIAS-0001"), true);
  assert.equal(commentIds.has("COM-PRIVATE-0001"), false);
  assert.equal(commentIds.has("COM-BAD-ALIAS-0001"), false);
  assert.equal(commentIds.has("COM-PENDING-0001"), false);
  assert.doesNotMatch(JSON.stringify(commentPayload), /PRIVATE COMMENT NOTE|SECRET-COMMENT-FP/u);
});

test("public appeals show accepted resolutions only", async () => {
  const missingId = await runtime.dispatchFetch("http://localhost/api/appeals");
  assert.equal(missingId.status, 400);
  const privateReport = await runtime.dispatchFetch(
    "http://localhost/api/appeals?reportId=SR-COMM-PRIVATE",
  );
  assert.equal(privateReport.status, 404);
  const accepted = await runtime.dispatchFetch(
    "http://localhost/api/appeals?reportId=SR-COMM-PUBLIC",
  );
  assert.equal(accepted.status, 200);
  const payload = await accepted.json();
  assert.deepEqual(payload.resolutions, [
    {
      id: "APL-QUEUE-0001",
      reportId: "SR-COMM-PUBLIC",
      requestType: "Correction",
      publicResolution: "Public synthetic resolution.",
      updatedAt: now,
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /appeal-private@example\.test|PRIVATE APPEAL NOTE|SECRET-APPEAL-FP/u,
  );
});

test("canonical replies can use a parent from an alias", async () => {
  const response = await runtime.dispatchFetch("http://localhost/api/comments", {
    method: "POST",
    headers: authHeaders(member, { "content-type": "application/json" }),
    body: JSON.stringify({
      reportId: "SR-COMM-PUBLIC",
      parentId: "COM-GOOD-ALIAS-0001",
      displayName: member.handle,
      body: "This synthetic reply verifies parent lookup across a canonical report family.",
      website: "",
      turnstileToken: TURNSTILE_BYPASS,
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const payload = await response.json();
  const stored = await database
    .prepare("SELECT report_id, parent_id FROM comments WHERE id = ?")
    .bind(payload.comment.id)
    .first();
  assert.deepEqual(stored, {
    report_id: "SR-COMM-PUBLIC",
    parent_id: "COM-GOOD-ALIAS-0001",
  });
});

test("moderation queues require staff access and paginate", async () => {
  for (const route of ["reviews", "comments", "report-submissions", "appeals"]) {
    const anonymous = await runtime.dispatchFetch(`http://localhost/api/admin/${route}`);
    assert.equal(anonymous.status, 401, route);
    const memberAttempt = await runtime.dispatchFetch(`http://localhost/api/admin/${route}`, {
      headers: authHeaders(member),
    });
    assert.equal(memberAttempt.status, 403, route);
    const accepted = await runtime.dispatchFetch(`http://localhost/api/admin/${route}?page=1`, {
      headers: authHeaders(moderator),
    });
    assert.equal(accepted.status, 200, `${route}: ${await accepted.clone().text()}`);
    const payload = await accepted.json();
    assert.equal(payload.pagination.pageSize, 25, route);
    assert.doesNotMatch(JSON.stringify(payload), /SECRET-(?:REVIEW|COMMENT|SUBMISSION|APPEAL)-FP/u);
  }

  for (const [pathname, method] of [
    ["/api/reviews", "PATCH"],
    ["/api/comments", "DELETE"],
    ["/api/report-submissions", "GET"],
    ["/api/report-submissions", "PATCH"],
    ["/api/appeals", "PATCH"],
    ["/api/appeals", "DELETE"],
  ]) {
    const response = await runtime.dispatchFetch(`http://localhost${pathname}`, {
      method,
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: method === "GET" ? undefined : "{}",
    });
    assert.equal(response.status, 405, `${method} ${pathname}`);
  }
});

test("moderation writes require CSRF", async () => {
  const body = {
    id: "COM-PENDING-0001",
    status: "Approved",
    moderatorNotes: "Synthetic moderation note.",
  };
  const missingCsrf = await runtime.dispatchFetch("http://localhost/api/admin/comments", {
    method: "PATCH",
    headers: {
      origin: "http://localhost",
      cookie: moderator.cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(missingCsrf.status, 403);

  const accepted = await runtime.dispatchFetch("http://localhost/api/admin/comments", {
    method: "PATCH",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(
    await database
      .prepare("SELECT status FROM comments WHERE id = ?")
      .bind(body.id)
      .first("status"),
    "Approved",
  );
});

test("community deletion needs fresh dual-confirmed admin auth", async () => {
  const staleSession = await runtime.dispatchFetch(
    "http://localhost/api/admin/reviews?id=REV-DELETE-0001",
    { method: "DELETE", headers: authHeaders(staleAdministrator) },
  );
  assert.equal(staleSession.status, 401);
  assert.equal((await staleSession.json()).code, "fresh_auth_required");

  await database
    .prepare(
      `UPDATE auth_sessions SET email_confirmed_at = ?
    WHERE account_id = ?`,
    )
    .bind("2020-01-01T00:00:00.000Z", administrator.id)
    .run();
  const staleProvider = await runtime.dispatchFetch(
    "http://localhost/api/admin/reviews?id=REV-DELETE-0001",
    { method: "DELETE", headers: authHeaders(administrator) },
  );
  assert.equal(staleProvider.status, 401);
  assert.equal((await staleProvider.json()).code, "dual_confirmation_required");
  await database
    .prepare(
      `UPDATE auth_sessions
    SET discord_confirmed_at = ?, email_confirmed_at = ? WHERE account_id = ?`,
    )
    .bind(new Date().toISOString(), new Date().toISOString(), administrator.id)
    .run();

  const moderatorAttempt = await runtime.dispatchFetch(
    "http://localhost/api/admin/reviews?id=REV-DELETE-0001",
    { method: "DELETE", headers: authHeaders(moderator) },
  );
  assert.equal(moderatorAttempt.status, 403);

  for (const [route, id, table] of [
    ["reviews", "REV-DELETE-0001", "reviews"],
    ["comments", "COM-DELETE-0001", "comments"],
    ["report-submissions", "SUB-DELETE-0001", "report_submissions"],
    ["appeals", "APL-DELETE-0001", "appeals"],
  ]) {
    const response = await runtime.dispatchFetch(
      `http://localhost/api/admin/${route}?id=${encodeURIComponent(id)}`,
      { method: "DELETE", headers: authHeaders(administrator) },
    );
    assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
    assert.equal(
      await database.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first(),
      null,
      route,
    );
  }
});
