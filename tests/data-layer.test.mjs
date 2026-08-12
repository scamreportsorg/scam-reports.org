import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  applyNumberedMigrations,
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
} from "./helpers/runtime.mjs";

let runtime;
let database;

before(async () => {
  ({ runtime, database } = await createTestRuntime());
});

after(async () => runtime?.dispose());

test("numbered migrations are idempotent", async () => {
  await applyNumberedMigrations(database);
  const applied = await database.prepare("SELECT COUNT(*) AS count FROM d1_migrations").first();
  assert.equal(applied.count, 22);
  const tables = await database
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
    .all();
  const names = new Set(tables.results.map((row) => row.name));
  for (const required of [
    "accounts",
    "auth_sessions",
    "evidence_assets",
    "report_evidence",
    "review_revisions",
    "rate_events",
    "notification_outbox",
    "reports_fts",
    "report_family_metrics",
    "moderator_applications",
    "public_member_activity",
    "discord_rank_sync",
    "discord_rank_sync_control",
    "discord_status_messages",
    "security_observations",
    "security_incidents",
    "security_monitor_state",
  ]) {
    assert.ok(names.has(required), required);
  }
});

test("FTS follows report writes", async () => {
  await insertReportFixture(database, {
    id: "SR-FTS-0001",
    username: "OriginalNeedle",
    discordId: "100000000000009901",
  });
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM reports_fts WHERE reports_fts MATCH ?")
        .bind('"OriginalNeedle"')
        .first()
    ).count,
    1,
  );
  await database
    .prepare("UPDATE reports SET username = 'ReplacementNeedle' WHERE id = 'SR-FTS-0001'")
    .run();
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM reports_fts WHERE reports_fts MATCH ?")
        .bind('"OriginalNeedle"')
        .first()
    ).count,
    0,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM reports_fts WHERE reports_fts MATCH ?")
        .bind('"ReplacementNeedle"')
        .first()
    ).count,
    1,
  );
  await database.prepare("DELETE FROM reports WHERE id = 'SR-FTS-0001'").run();
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM reports_fts WHERE reports_fts MATCH ?")
        .bind('"ReplacementNeedle"')
        .first()
    ).count,
    0,
  );
});

test("report aggregates follow reviews and evidence", async () => {
  await insertReportFixture(database, {
    id: "SR-AGG-0001",
    username: "AggregateFixture",
    discordId: "100000000000009902",
  });
  const now = "2026-08-09T00:00:00.000Z";
  await database
    .prepare(
      `INSERT INTO reviews (
      id, report_id, display_name, rating, relationship, title, body, status,
      moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES
      ('REV-AGG-0001', 'SR-AGG-0001', 'Fixture A', 5, 'Player', 'Approved fixture',
       'Synthetic approved review body for aggregate testing.', 'Approved', '', 'fp-a', 0, ?, ?),
      ('REV-AGG-0002', 'SR-AGG-0001', 'Fixture B', 1, 'Player', 'Pending fixture',
       'Synthetic pending review body for aggregate testing.', 'Pending', '', 'fp-b', 0, ?, ?)`,
    )
    .bind(now, now, now, now)
    .run();
  let aggregate = await database
    .prepare(
      "SELECT approved_review_count, approved_rating_sum FROM reports WHERE id = 'SR-AGG-0001'",
    )
    .first();
  assert.deepEqual(aggregate, { approved_review_count: 1, approved_rating_sum: 5 });
  await database
    .prepare("UPDATE reviews SET status = 'Approved', rating = 3 WHERE id = 'REV-AGG-0002'")
    .run();
  aggregate = await database
    .prepare(
      "SELECT approved_review_count, approved_rating_sum FROM reports WHERE id = 'SR-AGG-0001'",
    )
    .first();
  assert.deepEqual(aggregate, { approved_review_count: 2, approved_rating_sum: 8 });
  await database.prepare("DELETE FROM reviews WHERE id = 'REV-AGG-0001'").run();
  aggregate = await database
    .prepare(
      "SELECT approved_review_count, approved_rating_sum FROM reports WHERE id = 'SR-AGG-0001'",
    )
    .first();
  assert.deepEqual(aggregate, { approved_review_count: 1, approved_rating_sum: 3 });

  await database
    .prepare(
      `INSERT INTO evidence_assets (
      id, intake_kind, state, original_key, original_filename,
      original_content_type, original_size, original_sha256, visible_pii_reviewed,
      legal_hold, processing_error, created_by, created_at, updated_at
    ) VALUES ('EVA-AGG-00000000-0000-4000-8000-000000000001', 'moderator_upload',
      'private_ready', 'originals/agg', 'agg.png', 'image/png', 8, 'hash', 1, 0, '',
      'test', ?, ?)`,
    )
    .bind(now, now)
    .run();
  await database
    .prepare(
      `INSERT INTO report_evidence
      (report_id, evidence_id, caption, display_order, created_at)
    VALUES ('SR-AGG-0001', 'EVA-AGG-00000000-0000-4000-8000-000000000001',
      'Synthetic evidence', 0, ?)`,
    )
    .bind(now)
    .run();
  assert.equal(
    (await database.prepare("SELECT evidence_count FROM reports WHERE id = 'SR-AGG-0001'").first())
      .evidence_count,
    0,
  );
  await database
    .prepare("UPDATE evidence_assets SET state = 'public' WHERE original_key = 'originals/agg'")
    .run();
  assert.equal(
    (await database.prepare("SELECT evidence_count FROM reports WHERE id = 'SR-AGG-0001'").first())
      .evidence_count,
    1,
  );
});

test("family metrics follow merge and unmerge", async () => {
  const now = "2099-01-01T00:00:00.000Z";
  const sharedReviewer = await insertAccountFixture(database, {
    id: `account_${"f".repeat(32)}`,
    handle: "FamilySharedReviewer",
  });
  await insertReportFixture(database, {
    id: "SR-FAMILY-CANONICAL",
    username: "FamilyCanonical",
    discordId: "100000000000009903",
    updatedAt: now,
  });
  await insertReportFixture(database, {
    id: "SR-FAMILY-DUPLICATE",
    username: "FamilyDuplicate",
    discordId: "100000000000009903",
    updatedAt: now,
  });
  await database
    .prepare(
      `INSERT INTO reviews (
      id, report_id, account_id, display_name, rating, relationship, title, body, status,
      moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES
      ('REV-FAMILY-CANONICAL', 'SR-FAMILY-CANONICAL', NULL, 'Canonical Reviewer', 5,
       'Player', 'Canonical family review', 'Synthetic canonical review body.',
       'Approved', '', 'fp-family-canonical', 0,
       '2098-12-31T00:00:00.000Z', '2098-12-31T00:00:00.000Z'),
      ('REV-FAMILY-DUPLICATE', 'SR-FAMILY-DUPLICATE', NULL, 'Duplicate Reviewer', 2,
       'Player', 'Family duplicate latest review', 'Synthetic duplicate review body.',
       'Approved', '', 'fp-family-duplicate', 0,
       '2099-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z'),
      ('REV-FAMILY-SHARED-OLD', 'SR-FAMILY-CANONICAL', ?, 'Shared Reviewer', 1,
       'Player', 'Superseded family account review', 'Synthetic older account review.',
       'Approved', '', 'fp-family-shared-old', 1,
       '2098-12-30T00:00:00.000Z', '2098-12-30T00:00:00.000Z'),
      ('REV-FAMILY-SHARED-NEW', 'SR-FAMILY-DUPLICATE', ?, 'Shared Reviewer', 4,
       'Player', 'Family account winner', 'Synthetic newer account review.',
       'Approved', '', 'fp-family-shared-new', 1,
       '2099-01-02T00:00:00.000Z', '2099-01-02T00:00:00.000Z')`,
    )
    .bind(sharedReviewer.id, sharedReviewer.id)
    .run();
  await database
    .prepare(
      `INSERT INTO evidence_assets (
      id, intake_kind, state, original_key, original_filename,
      original_content_type, original_size, original_sha256, visible_pii_reviewed,
      legal_hold, processing_error, created_by, created_at, updated_at
    ) VALUES ('EVA-FAMILY-00000000-0000-4000-8000-000000000001', 'moderator_upload',
      'public', 'originals/family-shared', 'family.png', 'image/png', 8,
      'family-hash', 1, 0, '', 'test', ?, ?)`,
    )
    .bind(now, now)
    .run();
  await database
    .prepare(
      `INSERT INTO report_evidence
      (report_id, evidence_id, caption, display_order, created_at) VALUES
      ('SR-FAMILY-CANONICAL', 'EVA-FAMILY-00000000-0000-4000-8000-000000000001',
       'Shared synthetic evidence', 0, ?),
      ('SR-FAMILY-DUPLICATE', 'EVA-FAMILY-00000000-0000-4000-8000-000000000001',
       'Shared synthetic evidence', 0, ?)`,
    )
    .bind(now, now)
    .run();

  const before = await database
    .prepare(
      `SELECT * FROM report_family_metrics
    WHERE report_id IN ('SR-FAMILY-CANONICAL', 'SR-FAMILY-DUPLICATE') ORDER BY report_id`,
    )
    .all();
  assert.deepEqual(
    before.results.map((row) => ({
      id: row.report_id,
      reviews: Number(row.approved_review_count),
      rating: Number(row.approved_rating_sum),
      evidence: Number(row.public_evidence_count),
    })),
    [
      { id: "SR-FAMILY-CANONICAL", reviews: 2, rating: 6, evidence: 1 },
      { id: "SR-FAMILY-DUPLICATE", reviews: 2, rating: 6, evidence: 1 },
    ],
  );

  await database
    .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
    .bind("SR-FAMILY-CANONICAL", "SR-FAMILY-DUPLICATE")
    .run();
  const merged = await database
    .prepare(
      `SELECT * FROM report_family_metrics
    WHERE report_id IN ('SR-FAMILY-CANONICAL', 'SR-FAMILY-DUPLICATE')`,
    )
    .all();
  assert.deepEqual(merged.results, [
    {
      report_id: "SR-FAMILY-CANONICAL",
      approved_review_count: 3,
      approved_rating_sum: 11,
      public_evidence_count: 1,
    },
  ]);

  const directoryResponse = await runtime.dispatchFetch(
    "http://localhost/api/reports?q=FamilyCanonical&sort=reviews",
  );
  assert.equal(directoryResponse.status, 200);
  const directory = await directoryResponse.json();
  assert.equal(directory.items[0].id, "SR-FAMILY-CANONICAL");
  assert.equal(directory.items[0].reputation.reviewCount, 3);
  assert.equal(directory.items[0].evidenceCount, 1);

  const home = await runtime.dispatchFetch("http://localhost/");
  const homeHtml = await home.text();
  assert.equal(home.status, 200);
  assert.match(homeHtml, /Family account winner/u);
  assert.match(homeHtml, /FamilyCanonical/u);

  const familyReviewsResponse = await runtime.dispatchFetch(
    "http://localhost/api/reviews?reportId=SR-FAMILY-CANONICAL",
  );
  assert.equal(familyReviewsResponse.status, 200);
  const familyReviews = await familyReviewsResponse.json();
  assert.equal(familyReviews.pagination.totalItems, 3);
  assert.ok(familyReviews.reviews.some((review) => review.title === "Family account winner"));
  assert.ok(
    !familyReviews.reviews.some((review) => review.title === "Superseded family account review"),
  );

  await database
    .prepare("UPDATE reports SET merged_into_report_id = NULL WHERE id = ?")
    .bind("SR-FAMILY-DUPLICATE")
    .run();
  const after = await database
    .prepare(
      `SELECT * FROM report_family_metrics
    WHERE report_id IN ('SR-FAMILY-CANONICAL', 'SR-FAMILY-DUPLICATE') ORDER BY report_id`,
    )
    .all();
  assert.deepEqual(after.results, before.results);
});

test("large report lists stay paginated and indexed", async () => {
  const reviewsBeforeScaleFixture = Number(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM reviews WHERE status = 'Approved'")
        .first()
    ).count,
  );
  await database
    .prepare(
      `WITH digit(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9))
      INSERT INTO accounts (
        id, handle, handle_normalized, role, status, role_version,
        created_at, updated_at, last_authenticated_at
      ) SELECT printf('account_perf_%02d', d), printf('PerfReviewer%02d', d),
        lower(printf('PerfReviewer%02d', d)), 'member', 'active', 1,
        '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z', NULL
      FROM digit`,
    )
    .run();
  await database
    .prepare(
      `WITH digit(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
    sequence(n) AS (
      SELECT hundreds.d * 100 + tens.d * 10 + ones.d + 1
      FROM digit hundreds CROSS JOIN digit tens CROSS JOIN digit ones
    )
    INSERT INTO reports (
      id, username, discord_id, game, category, reason, description, status,
      notes, moderator_notes, evidence_json, status_history_json, date_added,
      updated_at, views, is_published
    ) SELECT printf('SR-PERF-%04d', n), printf('PerfUser%04d', n),
      printf('900000000000%06d', n), 'Performance Arena',
      CASE WHEN n % 2 = 0 THEN 'Cheating' ELSE 'Marketplace Scam' END,
      'Synthetic performance report reason.', 'Synthetic performance description.',
      CASE WHEN n % 3 = 0 THEN 'Confirmed' ELSE 'Reported' END,
      '', '', '[]', '[]', printf('2026-06-%02d', (n % 28) + 1),
      '2026-08-09T00:00:00.000Z', n, 1 FROM sequence`,
    )
    .run();
  await database
    .prepare(
      `WITH digit(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
    sequence(n) AS (
      SELECT a.d * 1000 + b.d * 100 + c.d * 10 + d.d + 1
      FROM digit a CROSS JOIN digit b CROSS JOIN digit c CROSS JOIN digit d
    )
    INSERT INTO reviews (
      id, report_id, account_id, display_name, rating, relationship, title, body, status,
      moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
    ) SELECT printf('REV-PERF-%05d', n), printf('SR-PERF-%04d', ((n - 1) % 1000) + 1),
      printf('account_perf_%02d', ((n - 1) / 1000)), printf('Reviewer%05d', n),
      (n % 5) + 1, 'Player', 'Synthetic scale review',
      'Synthetic scale review body with no real-world allegation.', 'Approved', '',
      printf('fingerprint-%05d', n), 0, '2026-08-09T00:00:00.000Z',
      '2026-08-09T00:00:00.000Z' FROM sequence`,
    )
    .run();

  const response = await runtime.dispatchFetch(
    "http://localhost/api/reports?status=Confirmed&category=Cheating&sort=reviews&page=2",
  );
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(body.length < 200_000);
  const payload = JSON.parse(body);
  assert.equal(payload.items.length, 25);
  assert.equal(payload.pagination.pageSize, 25);
  assert.ok(payload.pagination.totalItems > 100);
  assert.ok(payload.items.every((item) => item.reputation.reviewCount === 10));

  const reviewResponse = await runtime.dispatchFetch("http://localhost/api/reviews?page=2");
  assert.equal(reviewResponse.status, 200);
  const reviewPayload = await reviewResponse.json();
  assert.equal(reviewPayload.reviews.length, 25);
  assert.equal(reviewPayload.pagination.page, 2);
  assert.equal(reviewPayload.pagination.totalItems, reviewsBeforeScaleFixture + 10_000);
  assert.doesNotMatch(JSON.stringify(reviewPayload), /author_fingerprint|moderator_notes/u);
  assert.doesNotMatch(JSON.stringify(reviewPayload), /authorAccountId|account_perf_/u);

  await database
    .prepare(
      `WITH RECURSIVE sequence(n) AS (
    SELECT 1 UNION ALL SELECT n + 1 FROM sequence WHERE n < 35
  ) INSERT INTO comments (
    id, report_id, parent_id, display_name, body, status, moderator_notes,
    author_fingerprint, reviewer_verified, created_at, updated_at
  ) SELECT printf('COM-PERF-%04d', n), 'SR-PERF-0001', NULL,
    printf('Commenter%04d', n), 'Synthetic approved discussion reply.', 'Approved', '',
    printf('comment-fingerprint-%04d', n), 0,
    printf('2026-08-09T00:%02d:00.000Z', n),
    printf('2026-08-09T00:%02d:00.000Z', n) FROM sequence`,
    )
    .run();
  await database
    .prepare(
      `UPDATE comments SET parent_id = 'COM-PERF-0001'
    WHERE id = 'COM-PERF-0026'`,
    )
    .run();
  const commentResponse = await runtime.dispatchFetch(
    "http://localhost/api/comments?reportId=SR-PERF-0001&page=2",
  );
  assert.equal(commentResponse.status, 200);
  const commentPayload = await commentResponse.json();
  assert.equal(commentPayload.comments.length, 10);
  assert.equal(commentPayload.pagination.totalItems, 35);
  const crossPageReply = commentPayload.comments.find((comment) => comment.id === "COM-PERF-0026");
  assert.equal(crossPageReply.parentDisplayName, "Commenter0001");
  assert.doesNotMatch(JSON.stringify(commentPayload), /author_fingerprint|moderator_notes/u);

  const reportPage = await runtime.dispatchFetch(
    "http://localhost/reports/SR-PERF-0001?commentPage=2",
  );
  assert.equal(reportPage.status, 200);
  assert.match(await reportPage.text(), /Reply to Commenter0001/u);

  const plan = await database
    .prepare(
      `EXPLAIN QUERY PLAN SELECT id FROM reports
      WHERE is_published = 1 AND status = 'Confirmed'
      ORDER BY date_added DESC, id DESC LIMIT 25`,
    )
    .all();
  assert.match(
    plan.results.map((row) => String(row.detail)).join("\n"),
    /idx_reports_public_status_date/u,
  );

  const activityPlan = await database
    .prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM public_member_activity
       WHERE account_id = 'account_perf_00'`,
    )
    .all();
  const activityPlanText = activityPlan.results.map((row) => String(row.detail)).join("\n");
  assert.match(activityPlanText, /idx_report_submissions_status_account_result/u);
  assert.match(activityPlanText, /idx_reviews_status_account_report_updated/u);
  assert.match(activityPlanText, /idx_comments_account_status_report_created/u);

  const activityTimings = [];
  let activity;
  for (let sample = 0; sample < 5; sample += 1) {
    const startedAt = performance.now();
    activity = await database
      .prepare("SELECT * FROM public_member_activity WHERE account_id = 'account_perf_00'")
      .first();
    activityTimings.push(performance.now() - startedAt);
  }
  activityTimings.sort((left, right) => left - right);
  const activityP95 = activityTimings[Math.ceil(activityTimings.length * 0.95) - 1];
  assert.ok(activityP95 < 500, `member activity p95 was ${activityP95.toFixed(1)}ms`);
  assert.equal(activity.approved_review_count, 1000);
  assert.equal(activity.approved_report_count, 0);
});
