import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  authHeaders,
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
} from "./helpers/runtime.mjs";

let runtime;
let database;
let authorModerator;
let authorAdministrator;
let independentModerator;

const reportId = "SR-SELF-RECUSAL";
const submissionId = "SUB-SELF-RECUSAL";
const reviewId = "REV-SELF-RECUSAL";
const revisionId = "REVR-SELF-RECUSAL";
const commentId = "COM-SELF-RECUSAL";
const administratorCommentId = "COM-SELF-ADMIN";
const appealId = "APL-SELF-RECUSAL";
const administratorAppealId = "APL-SELF-ADMIN";
const timestamp = "2026-08-11T08:00:00.000Z";

async function row(sql, ...bindings) {
  return database
    .prepare(sql)
    .bind(...bindings)
    .first();
}

async function moderationState() {
  return {
    submission: await row(
      `SELECT status, moderator_notes, result_report_id, updated_at
       FROM report_submissions WHERE id = ?`,
      submissionId,
    ),
    review: await row(
      `SELECT status, moderator_notes, approved_revision_id, pending_revision_id, updated_at
       FROM reviews WHERE id = ?`,
      reviewId,
    ),
    revision: await row(
      `SELECT status, moderator_notes, moderated_at, moderated_by_account_id, updated_at
       FROM review_revisions WHERE id = ?`,
      revisionId,
    ),
    comment: await row(
      `SELECT status, moderator_notes, updated_at FROM comments WHERE id = ?`,
      commentId,
    ),
    administratorComment: await row(
      `SELECT status, moderator_notes, updated_at FROM comments WHERE id = ?`,
      administratorCommentId,
    ),
    appeal: await row(
      `SELECT status, moderator_notes, public_resolution, updated_at FROM appeals WHERE id = ?`,
      appealId,
    ),
    administratorAppeal: await row(
      `SELECT status, moderator_notes, public_resolution, updated_at FROM appeals WHERE id = ?`,
      administratorAppealId,
    ),
    report: await row(
      `SELECT approved_review_count, approved_rating_sum FROM reports WHERE id = ?`,
      reportId,
    ),
    auditCount: await row("SELECT COUNT(*) AS count FROM audit_logs"),
    outboxCount: await row("SELECT COUNT(*) AS count FROM notification_outbox"),
  };
}

async function moderate(route, account, body) {
  return runtime.dispatchFetch(`http://localhost/api/admin/${route}`, {
    method: "PATCH",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: JSON.stringify({ ...body, csrfToken: account.csrf }),
  });
}

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  authorModerator = await insertAccountFixture(database, {
    id: `account_${"7".repeat(32)}`,
    handle: "AuthorModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  authorAdministrator = await insertAccountFixture(database, {
    id: `account_${"9".repeat(32)}`,
    handle: "AuthorAdministrator",
    role: "admin",
    providers: ["discord", "email"],
  });
  independentModerator = await insertAccountFixture(database, {
    id: `account_${"8".repeat(32)}`,
    handle: "IndependentModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  await insertReportFixture(database, {
    id: reportId,
    username: "SyntheticRecusalSubject",
    discordId: "800000000000000011",
    isPublished: true,
  });

  await database
    .prepare(
      `INSERT INTO report_submissions (
        id, account_id, related_report_id, submitter_name, contact_email, username,
        discord_id, game, category, reason, description, evidence_json, status,
        moderator_notes, author_fingerprint, submitter_verified, result_report_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'Author Moderator', 'author@example.test',
        'SyntheticRecusalSubject', '800000000000000011', 'Test Arena', 'Cheating',
        'Synthetic report-submission reason for the recusal regression.',
        'Synthetic report-submission description used only by automated tests.',
        '[]', 'Pending', '', 'self-submission-fingerprint', 1, NULL, ?, ?)`,
    )
    .bind(submissionId, authorModerator.id, reportId, timestamp, timestamp)
    .run();
  await database
    .prepare(
      `INSERT INTO reviews (
        id, report_id, account_id, display_name, rating, relationship, title, body,
        status, moderator_notes, author_fingerprint, reviewer_verified,
        approved_revision_id, pending_revision_id, created_at, updated_at
      ) VALUES (?, ?, ?, 'Author Moderator', 4, 'Player',
        'Synthetic pending review',
        'Synthetic pending review body used only by the self-recusal regression.',
        'Pending', '', 'self-review-fingerprint', 1, NULL, ?, ?, ?)`,
    )
    .bind(reviewId, reportId, authorModerator.id, revisionId, timestamp, timestamp)
    .run();
  await database
    .prepare(
      `INSERT INTO review_revisions (
        id, review_id, account_id, rating, relationship, title, body, status,
        moderator_notes, created_at, updated_at, moderated_at, moderated_by_account_id
      ) VALUES (?, ?, ?, 4, 'Player', 'Synthetic pending review',
        'Synthetic pending review body used only by the self-recusal regression.',
        'Pending', '', ?, ?, NULL, NULL)`,
    )
    .bind(revisionId, reviewId, authorModerator.id, timestamp, timestamp)
    .run();
  await database
    .prepare(
      `INSERT INTO comments (
        id, report_id, parent_id, account_id, display_name, body, status,
        moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 'Author Moderator',
        'Synthetic pending reply used only by the self-recusal regression.',
        'Pending', '', 'self-comment-fingerprint', 1, ?, ?)`,
    )
    .bind(commentId, reportId, authorModerator.id, timestamp, timestamp)
    .run();
  await database
    .prepare(
      `INSERT INTO comments (
        id, report_id, parent_id, account_id, display_name, body, status,
        moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, 'Author Administrator',
        'Synthetic administrator-owned reply used only by the self-recusal regression.',
        'Pending', '', 'self-admin-comment-fingerprint', 1, ?, ?)`,
    )
    .bind(administratorCommentId, reportId, authorAdministrator.id, timestamp, timestamp)
    .run();
  for (const [id, accountId, name] of [
    [appealId, authorModerator.id, "Author Moderator"],
    [administratorAppealId, authorAdministrator.id, "Author Administrator"],
  ]) {
    await database
      .prepare(
        `INSERT INTO appeals (
          id, account_id, report_id, request_type, submitter_name, relationship,
          contact_email, body, evidence_json, status, moderator_notes, public_resolution,
          author_fingerprint, submitter_verified, created_at, updated_at
        ) VALUES (?, ?, ?, 'Correction', ?, 'Named person', 'author@example.test',
          'Synthetic appeal used only by the self-recusal regression.', '[]', 'Pending', '', '',
          'self-appeal-fingerprint', 1, ?, ?)`,
      )
      .bind(id, accountId, reportId, name, timestamp, timestamp)
      .run();
  }
});

after(async () => runtime?.dispose());

test("staff cannot moderate their own content", async () => {
  const beforeState = await moderationState();
  const attempts = [
    [
      "report-submissions",
      {
        id: submissionId,
        status: "Accepted",
        moderatorNotes: "This must not be stored.",
        resultReportId: reportId,
      },
    ],
    [
      "report-submissions",
      {
        id: submissionId,
        status: "Rejected",
        moderatorNotes: "This must not be stored either.",
        resultReportId: "",
      },
    ],
    ["reviews", { id: reviewId, status: "Approved", moderatorNotes: "Must not persist." }],
    ["reviews", { id: reviewId, status: "Rejected", moderatorNotes: "Must not persist." }],
    ["comments", { id: commentId, status: "Approved", moderatorNotes: "Must not persist." }],
    ["comments", { id: commentId, status: "Rejected", moderatorNotes: "Must not persist." }],
    [
      "appeals",
      {
        id: appealId,
        status: "Accepted",
        moderatorNotes: "Must not persist.",
        publicResolution: "Must not become public.",
      },
    ],
    [
      "appeals",
      {
        id: appealId,
        status: "Rejected",
        moderatorNotes: "Must not persist.",
        publicResolution: "",
      },
    ],
  ];

  for (const [route, body] of attempts) {
    const response = await moderate(route, authorModerator, body);
    assert.equal(response.status, 409, `${route} ${body.status}`);
    assert.deepEqual(await response.json(), {
      error: "A different moderator must review content submitted by this account.",
      code: "self_moderation_forbidden",
    });
  }

  for (const status of ["Approved", "Rejected"]) {
    const response = await moderate("comments", authorAdministrator, {
      id: administratorCommentId,
      status,
      moderatorNotes: "Administrator privileges must not bypass recusal.",
    });
    assert.equal(response.status, 409, `administrator ${status}`);
    assert.equal((await response.json()).code, "self_moderation_forbidden");
  }
  for (const status of ["Accepted", "Rejected"]) {
    const response = await moderate("appeals", authorAdministrator, {
      id: administratorAppealId,
      status,
      moderatorNotes: "Administrator privileges must not bypass recusal.",
      publicResolution: status === "Accepted" ? "Must not become public." : "",
    });
    assert.equal(response.status, 409, `administrator appeal ${status}`);
    assert.equal((await response.json()).code, "self_moderation_forbidden");
  }

  assert.deepEqual(await moderationState(), beforeState);
});

test("another moderator can handle the content", async () => {
  const submissionResponse = await moderate("report-submissions", independentModerator, {
    id: submissionId,
    status: "Accepted",
    moderatorNotes: "Independently reviewed.",
    resultReportId: reportId,
  });
  assert.equal(submissionResponse.status, 200, await submissionResponse.clone().text());

  const reviewResponse = await moderate("reviews", independentModerator, {
    id: reviewId,
    status: "Approved",
    moderatorNotes: "Independently reviewed.",
  });
  assert.equal(reviewResponse.status, 200, await reviewResponse.clone().text());

  const commentResponse = await moderate("comments", independentModerator, {
    id: commentId,
    status: "Approved",
    moderatorNotes: "Independently reviewed.",
  });
  assert.equal(commentResponse.status, 200, await commentResponse.clone().text());

  const administratorCommentResponse = await moderate("comments", independentModerator, {
    id: administratorCommentId,
    status: "Approved",
    moderatorNotes: "Independently reviewed.",
  });
  assert.equal(
    administratorCommentResponse.status,
    200,
    await administratorCommentResponse.clone().text(),
  );
  for (const id of [appealId, administratorAppealId]) {
    const appealResponse = await moderate("appeals", independentModerator, {
      id,
      status: "Accepted",
      moderatorNotes: "Independently reviewed.",
      publicResolution: "Synthetic independent resolution.",
    });
    assert.equal(appealResponse.status, 200, await appealResponse.clone().text());
  }

  const state = await moderationState();
  assert.equal(state.submission.status, "Accepted");
  assert.equal(state.submission.result_report_id, reportId);
  assert.equal(state.review.status, "Approved");
  assert.equal(state.review.pending_revision_id, null);
  assert.equal(state.review.approved_revision_id, revisionId);
  assert.equal(state.revision.status, "Approved");
  assert.equal(state.revision.moderated_by_account_id, independentModerator.id);
  assert.equal(state.comment.status, "Approved");
  assert.equal(state.administratorComment.status, "Approved");
  assert.equal(state.appeal.status, "Accepted");
  assert.equal(state.administratorAppeal.status, "Accepted");
  assert.equal(state.report.approved_review_count, 1);
  assert.equal(state.report.approved_rating_sum, 4);
  assert.equal(state.auditCount.count, 6);
  assert.equal(state.outboxCount.count, 0);
});
