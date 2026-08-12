import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
} from "./helpers/runtime.mjs";

let runtime;
let database;
let rankedMember;

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  rankedMember = await insertAccountFixture(database, {
    id: "account_ranked_member",
    handle: "RankedMember",
    role: "member",
  });
  await insertAccountFixture(database, {
    id: "account_ranked_admin",
    handle: "RankedAdmin",
    role: "admin",
  });

  for (const [id, published] of [
    ["SR-RANK-CANONICAL", true],
    ["SR-RANK-DUPLICATE", true],
    ["SR-RANK-HIDDEN", false],
  ]) {
    await insertReportFixture(database, {
      id,
      username: `Fixture-${id}`,
      discordId: `1000000000000${id.endsWith("CANONICAL") ? "10101" : id.endsWith("DUPLICATE") ? "10102" : "10103"}`,
      isPublished: published,
    });
  }
  await database
    .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
    .bind("SR-RANK-CANONICAL", "SR-RANK-DUPLICATE")
    .run();

  const submittedAt = "2026-08-01T09:00:00.000Z";
  await database
    .prepare(
      `INSERT INTO report_submissions (
        id, account_id, related_report_id, submitter_name, contact_email, username,
        discord_id, game, category, reason, description, evidence_json, status,
        moderator_notes, author_fingerprint, submitter_verified, result_report_id,
        created_at, updated_at
      ) VALUES
        ('SUB-RANK-CANONICAL', ?, NULL, 'RankedMember', '', 'Canonical subject',
         '100000000000010101', 'Test Arena', 'Cheating', 'Synthetic accepted report.',
         'Synthetic accepted report context for activity testing.', '[]', 'Accepted', '',
         'rank-sub-one', 1, 'SR-RANK-CANONICAL', ?, ?),
        ('SUB-RANK-DUPLICATE', ?, NULL, 'RankedMember', '', 'Duplicate subject',
         '100000000000010102', 'Test Arena', 'Cheating', 'Synthetic duplicate report.',
         'Synthetic duplicate report context for activity testing.', '[]', 'Accepted', '',
         'rank-sub-two', 1, 'SR-RANK-DUPLICATE', ?, ?),
        ('SUB-RANK-HIDDEN', ?, NULL, 'RankedMember', '', 'Hidden subject',
         '100000000000010103', 'Test Arena', 'Cheating', 'Synthetic hidden report.',
         'Synthetic unpublished report context for activity testing.', '[]', 'Accepted', '',
         'rank-sub-three', 1, 'SR-RANK-HIDDEN', ?, ?)`,
    )
    .bind(
      rankedMember.id,
      submittedAt,
      submittedAt,
      rankedMember.id,
      submittedAt,
      submittedAt,
      rankedMember.id,
      submittedAt,
      submittedAt,
    )
    .run();

  await database
    .prepare(
      `INSERT INTO reviews (
        id, report_id, account_id, display_name, rating, relationship, title, body,
        status, moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
      ) VALUES
        ('REV-RANK-OLD', 'SR-RANK-CANONICAL', ?, 'RankedMember', 4, 'Player',
         'Older family review', 'Synthetic older family review for rank integration testing.',
         'Approved', '', 'rank-review-old', 1, '2026-08-01T10:00:00.000Z', '2026-08-01T10:00:00.000Z'),
        ('REV-RANK-NEW', 'SR-RANK-DUPLICATE', ?, 'RankedMember', 5, 'Player',
         'Visible ranked review', 'Synthetic visible family review for rank integration testing.',
         'Approved', '', 'rank-review-new', 1, '2026-08-02T10:00:00.000Z', '2026-08-02T10:00:00.000Z'),
        ('REV-RANK-HIDDEN', 'SR-RANK-HIDDEN', ?, 'RankedMember', 5, 'Player',
         'Hidden ranked review', 'Synthetic unpublished review for rank integration testing.',
         'Approved', '', 'rank-review-hidden', 1, '2026-08-03T10:00:00.000Z', '2026-08-03T10:00:00.000Z')`,
    )
    .bind(rankedMember.id, rankedMember.id, rankedMember.id)
    .run();

  const comments = [
    ["COM-RANK-1", "SR-RANK-CANONICAL", "2026-08-03T09:00:00.000Z", "Approved"],
    ["COM-RANK-2", "SR-RANK-DUPLICATE", "2026-08-03T10:00:00.000Z", "Approved"],
    ["COM-RANK-3", "SR-RANK-CANONICAL", "2026-08-03T11:00:00.000Z", "Approved"],
    ["COM-RANK-4", "SR-RANK-DUPLICATE", "2026-08-03T12:00:00.000Z", "Approved"],
    ["COM-RANK-5", "SR-RANK-CANONICAL", "2026-08-04T09:00:00.000Z", "Approved"],
    ["COM-RANK-HIDDEN", "SR-RANK-HIDDEN", "2026-08-04T10:00:00.000Z", "Approved"],
    ["COM-RANK-PENDING", "SR-RANK-CANONICAL", "2026-08-04T11:00:00.000Z", "Pending"],
  ];
  for (const [id, reportId, createdAt, status] of comments) {
    await database
      .prepare(
        `INSERT INTO comments (
          id, report_id, parent_id, account_id, display_name, body, status,
          moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, 'RankedMember', ?, ?, '', ?, 1, ?, ?)`,
      )
      .bind(
        id,
        reportId,
        rankedMember.id,
        `Synthetic approved forum reply ${id} with sufficient detail.`,
        status,
        `rank-comment-${id}`,
        createdAt,
        createdAt,
      )
      .run();
  }
});

after(async () => runtime?.dispose());

test("public activity does not double-count cases or replies", async () => {
  const activity = await database
    .prepare("SELECT * FROM public_member_activity WHERE account_id = ?")
    .bind(rankedMember.id)
    .first();
  assert.deepEqual(activity, {
    account_id: rankedMember.id,
    approved_report_count: 1,
    approved_review_count: 1,
    approved_comment_count: 5,
    score_eligible_comment_count: 4,
  });

  const adminActivity = await database
    .prepare("SELECT * FROM public_member_activity WHERE account_id = 'account_ranked_admin'")
    .first();
  assert.deepEqual(adminActivity, {
    account_id: "account_ranked_admin",
    approved_report_count: 0,
    approved_review_count: 0,
    approved_comment_count: 0,
    score_eligible_comment_count: 0,
  });
});

test("member profiles separate rank from staff access", async () => {
  const response = await runtime.dispatchFetch("http://localhost/members/RankedMember", {
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 200);
  const html = (await response.text()).replaceAll("<!-- -->", "");
  assert.match(html, /Lv\. 2/u);
  assert.match(html, /Contributor/u);
  assert.match(html, /16 contribution points/u);
  assert.match(html, /7 approved contributions/u);
  assert.match(html, /Staff access/u);
  assert.match(html, />None</u);
  assert.doesNotMatch(html, /account_ranked_member|role_version|subject_hash/iu);

  const adminResponse = await runtime.dispatchFetch("http://localhost/members/RankedAdmin", {
    headers: { accept: "text/html" },
  });
  assert.equal(adminResponse.status, 200);
  const adminHtml = (await adminResponse.text()).replaceAll("<!-- -->", "");
  assert.match(adminHtml, /Lv\. 1/u);
  assert.match(adminHtml, /Newcomer/u);
  assert.match(adminHtml, /0 contribution points/u);
  assert.match(adminHtml, /Staff access/u);
  assert.match(adminHtml, />Administrator</u);
});

test("approved content shows rank without account IDs", async () => {
  const response = await runtime.dispatchFetch("http://localhost/reports/SR-RANK-CANONICAL", {
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 200);
  const html = (await response.text()).replaceAll("<!-- -->", "");
  assert.match(html, /Visible ranked review/u);
  assert.match(html, /href="\/members\/RankedMember"/u);
  assert.match(html, /Lv\. 2/u);
  assert.match(html, /7 approved contributions/u);
  assert.doesNotMatch(html, /account_ranked_member|rank-review-new|rank-comment-COM/iu);

  const reviewsResponse = await runtime.dispatchFetch(
    "http://localhost/api/reviews?reportId=SR-RANK-CANONICAL",
  );
  const reviewsPayload = await reviewsResponse.json();
  assert.equal(reviewsResponse.status, 200);
  assert.equal(reviewsPayload.reviews[0].authorHandle, "RankedMember");
  assert.equal(reviewsPayload.reviews[0].authorActivity.rank.name, "Contributor");
  assert.equal("authorAccountId" in reviewsPayload.reviews[0], false);

  const commentsResponse = await runtime.dispatchFetch(
    "http://localhost/api/comments?reportId=SR-RANK-CANONICAL",
  );
  const commentsPayload = await commentsResponse.json();
  assert.equal(commentsResponse.status, 200);
  assert.equal(commentsPayload.comments[0].authorHandle, "RankedMember");
  assert.equal(commentsPayload.comments[0].authorActivity.rank.name, "Contributor");
  assert.equal("authorAccountId" in commentsPayload.comments[0], false);
});
