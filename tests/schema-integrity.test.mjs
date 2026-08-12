import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyNumberedMigrations,
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
  MIGRATION_FILES,
} from "./helpers/runtime.mjs";

const beforeIntegrityMigration = MIGRATION_FILES.slice(
  0,
  MIGRATION_FILES.indexOf("0007_restore_legacy_integrity.sql"),
);
const now = "2026-08-09T12:00:00.000Z";
const schemaSnapshot = JSON.parse(
  await readFile(new URL("../drizzle/meta/0010_snapshot.json", import.meta.url), "utf8"),
);

async function createLegacyRuntime() {
  const state = await createTestRuntime({ migrate: false });
  await applyNumberedMigrations(state.database, beforeIntegrityMigration);
  return state;
}

async function insertIntakeFamily(database, accountId, reportId, suffix) {
  await database
    .prepare(
      `INSERT INTO reviews (
      id, report_id, account_id, display_name, rating, relationship, title, body,
      status, moderator_notes, author_fingerprint, reviewer_verified,
      approved_revision_id, pending_revision_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'Schema Reviewer', 4, 'Customer', 'Synthetic schema review',
      'Synthetic test-only review body.', 'Approved', 'private moderator note',
      'schema-review-fingerprint', 1, NULL, NULL, ?, ?)`,
    )
    .bind(`REV-SCHEMA-${suffix}`, reportId, accountId, now, now)
    .run();
  await database
    .prepare(
      `INSERT INTO review_revisions (
      id, review_id, account_id, rating, relationship, title, body, status,
      moderator_notes, created_at, updated_at, moderated_at, moderated_by_account_id
    ) VALUES (?, ?, ?, 4, 'Customer', 'Synthetic schema revision',
      'Synthetic test-only revision body.', 'Approved', 'private revision note',
      ?, ?, ?, ?)`,
    )
    .bind(`RVR-SCHEMA-${suffix}`, `REV-SCHEMA-${suffix}`, accountId, now, now, now, accountId)
    .run();
  await database
    .prepare(
      `INSERT INTO appeals (
      id, account_id, report_id, request_type, submitter_name, relationship,
      contact_email, body, evidence_json, status, moderator_notes, public_resolution,
      author_fingerprint, submitter_verified, created_at, updated_at
    ) VALUES (?, ?, ?, 'Correction', 'Schema Appellant', 'Subject',
      'private@example.invalid', 'Synthetic test-only appeal body.', '[]', 'Pending',
      'private appeal note', '', 'schema-appeal-fingerprint', 1, ?, ?)`,
    )
    .bind(`APL-SCHEMA-${suffix}`, accountId, reportId, now, now)
    .run();
  await database
    .prepare(
      `INSERT INTO comments (
      id, report_id, parent_id, account_id, display_name, body, status,
      moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, 'Schema Commenter', 'Synthetic test-only comment.',
      'Approved', 'private comment note', 'schema-comment-fingerprint', 1, ?, ?)`,
    )
    .bind(`COM-SCHEMA-${suffix}`, reportId, accountId, now, now)
    .run();
  await database
    .prepare(
      `INSERT INTO report_submissions (
      id, account_id, related_report_id, submitter_name, contact_email, username,
      discord_id, game, category, reason, description, evidence_json, status,
      moderator_notes, author_fingerprint, submitter_verified, result_report_id,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'Schema Reporter', 'private@example.invalid', 'SyntheticTarget',
      '100000000000008888', 'Test Arena', 'Cheating', 'Synthetic reason.',
      'Synthetic test-only submission.', '[]', 'Accepted', 'private submission note',
      'schema-submission-fingerprint', 1, ?, ?, ?)`,
    )
    .bind(`SUB-SCHEMA-${suffix}`, accountId, reportId, reportId, now, now)
    .run();
}

async function foreignKeys(database, table) {
  const result = await database.prepare(`PRAGMA foreign_key_list(${table})`).all();
  return result.results
    .map((row) => [row.from, row.table, row.to, row.on_delete])
    .sort((left, right) => String(left[0]).localeCompare(String(right[0])));
}

async function indexNames(database, table) {
  const result = await database.prepare(`PRAGMA index_list(${table})`).all();
  return new Set(result.results.map((row) => row.name));
}

test("migrations match the declared schema", async (t) => {
  const { runtime, database } = await createTestRuntime();
  t.after(() => runtime.dispose());

  for (const [table, definition] of Object.entries(schemaSnapshot.tables)) {
    const actualForeignKeys = (await foreignKeys(database, table)).map((entry) => entry.join(":"));
    const expectedForeignKeys = Object.values(definition.foreignKeys ?? {})
      .map((foreignKey) =>
        [
          foreignKey.columnsFrom.join(","),
          foreignKey.tableTo,
          foreignKey.columnsTo.join(","),
          (foreignKey.onDelete ?? "no action").toUpperCase(),
        ].join(":"),
      )
      .sort();
    assert.deepEqual(actualForeignKeys, expectedForeignKeys, `${table} foreign keys`);

    const tableSql = await database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .bind(table)
      .first("sql");
    for (const checkName of Object.keys(definition.checkConstraints ?? {})) {
      if (table === "reports" && checkName === "reports_status_check") continue;
      assert.match(tableSql ?? "", new RegExp(`\\b${checkName}\\b`, "u"), `${table}.${checkName}`);
    }

    const actualIndexes = await indexNames(database, table);
    for (const indexName of Object.keys(definition.indexes ?? {})) {
      assert.ok(actualIndexes.has(indexName), `${table}.${indexName}`);
    }
  }

  const reportStatusTriggers = await database
    .prepare(
      `SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name IN ('reports_status_check_insert', 'reports_status_check_update')
    ORDER BY name`,
    )
    .all();
  assert.deepEqual(
    reportStatusTriggers.results.map((row) => row.name),
    ["reports_status_check_insert", "reports_status_check_update"],
  );
  for (const trigger of reportStatusTriggers.results) {
    assert.match(trigger.sql, /RAISE\(ABORT, 'reports_status_check'\)/u);
  }
  assert.deepEqual((await database.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("schema rebuild keeps legacy data and constraints", async (t) => {
  const { runtime, database } = await createLegacyRuntime();
  t.after(() => runtime.dispose());
  const account = await insertAccountFixture(database, {
    id: "account_schema_upgrade",
    handle: "SchemaUpgrade",
    legacyAuthSession: true,
  });
  await insertReportFixture(database, {
    id: "SR-SCHEMA-UPGRADE",
    username: "SchemaUpgradeTarget",
  });
  await insertIntakeFamily(database, account.id, "SR-SCHEMA-UPGRADE", "UPGRADE");
  await database
    .prepare(
      `INSERT INTO evidence_assets (
      id, intake_kind, state, original_key, original_filename, original_content_type,
      original_size, original_sha256, visible_pii_reviewed, legal_hold, processing_error,
      created_by, created_at, updated_at
    ) VALUES ('EVA-SCHEMA-UPGRADE', 'moderator_upload', 'private_ready',
      'originals/schema-upgrade', 'schema.png', 'image/png', 8, 'schema-upgrade-hash',
      1, 0, '', 'test', ?, ?)`,
    )
    .bind(now, now)
    .run();
  await database
    .prepare(
      `INSERT INTO report_evidence
      (report_id, evidence_id, caption, display_order, created_at)
    VALUES ('SR-SCHEMA-UPGRADE', 'EVA-SCHEMA-UPGRADE', 'Synthetic evidence', 0, ?)`,
    )
    .bind(now)
    .run();
  await database
    .prepare(
      `INSERT INTO report_status_events
      (id, report_id, status, public_note, actor_account_id, created_at)
    VALUES ('RSE-SCHEMA-UPGRADE', 'SR-SCHEMA-UPGRADE', 'Reported',
      'Synthetic status event.', ?, ?)`,
    )
    .bind(account.id, now)
    .run();
  await database
    .prepare(
      `INSERT INTO report_merge_events
      (id, duplicate_report_id, canonical_report_id, actor_account_id, action, created_at)
    VALUES ('RME-SCHEMA-UPGRADE', 'SR-SCHEMA-UPGRADE', 'SR-SCHEMA-UPGRADE',
      ?, 'merge', ?)`,
    )
    .bind(account.id, now)
    .run();

  const tables = [
    "reports",
    "reviews",
    "review_revisions",
    "appeals",
    "comments",
    "report_submissions",
    "evidence_assets",
    "report_evidence",
    "report_status_events",
    "report_merge_events",
  ];
  const before = Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        (await database.prepare(`SELECT * FROM ${table}`).all()).results,
      ]),
    ),
  );

  await applyNumberedMigrations(database);

  for (const table of tables) {
    const after = (await database.prepare(`SELECT * FROM ${table}`).all()).results;
    const existingColumns = Object.keys(before[table][0] ?? {});
    assert.deepEqual(
      after.map((row) =>
        Object.fromEntries(existingColumns.map((column) => [column, row[column]])),
      ),
      before[table],
      table,
    );
  }
  assert.deepEqual(await foreignKeys(database, "reviews"), [
    ["account_id", "accounts", "id", "SET NULL"],
    ["report_id", "reports", "id", "CASCADE"],
  ]);
  assert.deepEqual(await foreignKeys(database, "appeals"), [
    ["account_id", "accounts", "id", "SET NULL"],
    ["report_id", "reports", "id", "CASCADE"],
  ]);
  assert.deepEqual(await foreignKeys(database, "comments"), [
    ["account_id", "accounts", "id", "SET NULL"],
    ["report_id", "reports", "id", "CASCADE"],
  ]);
  assert.deepEqual(await foreignKeys(database, "report_submissions"), [
    ["account_id", "accounts", "id", "SET NULL"],
    ["related_report_id", "reports", "id", "SET NULL"],
    ["result_report_id", "reports", "id", "SET NULL"],
  ]);
  assert.deepEqual(await foreignKeys(database, "report_evidence"), [
    ["evidence_id", "evidence_assets", "id", "RESTRICT"],
    ["report_id", "reports", "id", "CASCADE"],
  ]);
  assert.deepEqual(await foreignKeys(database, "report_status_events"), [
    ["actor_account_id", "accounts", "id", "SET NULL"],
    ["report_id", "reports", "id", "CASCADE"],
  ]);
  assert.deepEqual(await foreignKeys(database, "report_merge_events"), [
    ["actor_account_id", "accounts", "id", "SET NULL"],
    ["canonical_report_id", "reports", "id", "CASCADE"],
    ["duplicate_report_id", "reports", "id", "CASCADE"],
  ]);

  const expectedIndexes = {
    reviews: [
      "idx_reviews_account_report",
      "idx_reviews_created_at",
      "idx_reviews_fingerprint_created",
      "idx_reviews_report_status",
      "idx_reviews_report_status_created",
      "idx_reviews_status_created",
    ],
    review_revisions: [
      "idx_review_revisions_review_created",
      "idx_review_revisions_status_created",
    ],
    appeals: [
      "idx_appeals_account_created",
      "idx_appeals_fingerprint_created",
      "idx_appeals_report_status",
      "idx_appeals_status_created",
    ],
    comments: [
      "idx_comments_account_created",
      "idx_comments_fingerprint_created",
      "idx_comments_parent_id",
      "idx_comments_report_status_created",
    ],
    report_submissions: [
      "idx_report_submissions_account_created",
      "idx_report_submissions_discord_id",
      "idx_report_submissions_fingerprint_created",
      "idx_report_submissions_status_created",
    ],
  };
  for (const [table, expected] of Object.entries(expectedIndexes)) {
    const actual = await indexNames(database, table);
    for (const name of expected) assert.ok(actual.has(name), `${table}.${name}`);
  }
  const triggers = await database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'reviews' ORDER BY name",
    )
    .all();
  assert.deepEqual(
    triggers.results.map((row) => row.name),
    [
      "discord_rank_sync_review_delete",
      "discord_rank_sync_review_insert",
      "discord_rank_sync_review_update",
      "reviews_report_aggregate_delete",
      "reviews_report_aggregate_insert",
      "reviews_report_aggregate_update",
    ],
  );
  assert.equal(
    await database.prepare("SELECT COUNT(*) FROM report_family_metrics").first("COUNT(*)"),
    1,
  );
  const aggregateTriggerSql = await database
    .prepare(
      `SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name IN (
      'report_evidence_count_insert', 'report_evidence_count_delete', 'evidence_asset_count_update'
    ) ORDER BY name`,
    )
    .all();
  assert.deepEqual(
    aggregateTriggerSql.results.map((row) => row.name),
    ["evidence_asset_count_update", "report_evidence_count_delete", "report_evidence_count_insert"],
  );
  assert.doesNotMatch(JSON.stringify(aggregateTriggerSql.results), /__old_reports/u);

  await database
    .prepare("UPDATE evidence_assets SET state = 'public' WHERE id = 'EVA-SCHEMA-UPGRADE'")
    .run();
  assert.equal(
    await database
      .prepare("SELECT evidence_count FROM reports WHERE id = 'SR-SCHEMA-UPGRADE'")
      .first("evidence_count"),
    1,
  );
  await database
    .prepare(
      "DELETE FROM report_evidence WHERE report_id = 'SR-SCHEMA-UPGRADE' AND evidence_id = 'EVA-SCHEMA-UPGRADE'",
    )
    .run();
  assert.equal(
    await database
      .prepare("SELECT evidence_count FROM reports WHERE id = 'SR-SCHEMA-UPGRADE'")
      .first("evidence_count"),
    0,
  );
  await database
    .prepare(
      `INSERT INTO report_evidence
      (report_id, evidence_id, caption, display_order, created_at)
    VALUES ('SR-SCHEMA-UPGRADE', 'EVA-SCHEMA-UPGRADE', 'Synthetic evidence', 0, ?)`,
    )
    .bind(now)
    .run();
  assert.equal(
    await database
      .prepare("SELECT evidence_count FROM reports WHERE id = 'SR-SCHEMA-UPGRADE'")
      .first("evidence_count"),
    1,
  );
  assert.deepEqual((await database.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("report and review constraints reject bad values", async (t) => {
  const { runtime, database } = await createTestRuntime();
  t.after(() => runtime.dispose());
  await insertReportFixture(database, {
    id: "SR-SCHEMA-CHECK",
    username: "SchemaCheckTarget",
  });
  const insert = (id, rating, status) =>
    database
      .prepare(
        `INSERT INTO reviews (
      id, report_id, display_name, rating, relationship, title, body, status,
      moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES (?, 'SR-SCHEMA-CHECK', 'Check Reviewer', ?, 'Player', 'Check title',
      'Synthetic test-only check body.', ?, '', ?, 0, ?, ?)`,
      )
      .bind(id, rating, status, `fingerprint-${id}`, now, now)
      .run();

  await assert.rejects(insert("REV-SCHEMA-BAD-RATING", 0, "Pending"), /reviews_rating_check/u);
  await assert.rejects(insert("REV-SCHEMA-BAD-STATUS", 3, "Published"), /reviews_status_check/u);
  await assert.rejects(
    database.prepare("UPDATE reports SET status = 'Published' WHERE id = 'SR-SCHEMA-CHECK'").run(),
    /reports_status_check/u,
  );
  await assert.rejects(
    insertReportFixture(database, {
      id: "SR-SCHEMA-BAD-STATUS",
      username: "BadStatusTarget",
      status: "Published",
    }),
    /reports_status_check/u,
  );
  await database
    .prepare(
      "UPDATE reports SET category = 'Synthetic Custom Category' WHERE id = 'SR-SCHEMA-CHECK'",
    )
    .run();
  assert.equal(
    await database
      .prepare("SELECT category FROM reports WHERE id = 'SR-SCHEMA-CHECK'")
      .first("category"),
    "Synthetic Custom Category",
  );
  await insert("REV-SCHEMA-VALID", 5, "Approved");
  assert.equal(await database.prepare("SELECT COUNT(*) FROM reviews").first("COUNT(*)"), 1);
});

test("deletion follows the declared foreign keys", async (t) => {
  const { runtime, database } = await createTestRuntime();
  t.after(() => runtime.dispose());
  const account = await insertAccountFixture(database, {
    id: "account_schema_deletes",
    handle: "SchemaDeletes",
  });
  await insertReportFixture(database, {
    id: "SR-SCHEMA-DELETES",
    username: "SchemaDeleteTarget",
  });
  await insertIntakeFamily(database, account.id, "SR-SCHEMA-DELETES", "DELETES");

  await database.prepare("DELETE FROM accounts WHERE id = ?").bind(account.id).run();
  for (const table of [
    "reviews",
    "review_revisions",
    "appeals",
    "comments",
    "report_submissions",
  ]) {
    assert.equal(
      await database.prepare(`SELECT account_id FROM ${table}`).first("account_id"),
      null,
      table,
    );
  }
  assert.equal(
    await database
      .prepare("SELECT moderated_by_account_id FROM review_revisions")
      .first("moderated_by_account_id"),
    null,
  );

  await database.prepare("DELETE FROM reports WHERE id = 'SR-SCHEMA-DELETES'").run();
  for (const table of ["reviews", "review_revisions", "appeals", "comments"]) {
    assert.equal(
      await database.prepare(`SELECT COUNT(*) FROM ${table}`).first("COUNT(*)"),
      0,
      table,
    );
  }
  assert.deepEqual(
    await database
      .prepare(
        "SELECT related_report_id, result_report_id FROM report_submissions WHERE id = 'SUB-SCHEMA-DELETES'",
      )
      .first(),
    { related_report_id: null, result_report_id: null },
  );
  assert.deepEqual((await database.prepare("PRAGMA foreign_key_check").all()).results, []);
});

test("runtime rejects an incomplete schema", async (t) => {
  const { runtime, database } = await createLegacyRuntime();
  t.after(() => runtime.dispose());

  const outdated = await runtime.dispatchFetch("http://localhost/api/reports");
  assert.equal(outdated.status, 500);
  assert.doesNotMatch(await outdated.text(), /private|contact_email|moderator_notes/iu);

  await applyNumberedMigrations(database);
  const current = await runtime.dispatchFetch("http://localhost/api/reports");
  assert.equal(current.status, 200, await current.clone().text());
});

test("legacy orphans stop migration without data loss", async (t) => {
  const { runtime, database } = await createLegacyRuntime();
  t.after(() => runtime.dispose());
  await database
    .prepare(
      `INSERT INTO reviews (
      id, report_id, display_name, rating, relationship, title, body, status,
      moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES ('REV-SCHEMA-ORPHAN', 'SR-SCHEMA-MISSING', 'Orphan Reviewer', 3,
      'Player', 'Synthetic orphan', 'Synthetic test-only orphan body.', 'Pending',
      'private orphan note', 'schema-orphan-fingerprint', 0, ?, ?)`,
    )
    .bind(now, now)
    .run();

  await assert.rejects(applyNumberedMigrations(database), /migration_0007_reviews_report_orphans/u);
  assert.equal(await database.prepare("SELECT COUNT(*) FROM d1_migrations").first("COUNT(*)"), 7);
  assert.equal(
    await database
      .prepare("SELECT report_id FROM reviews WHERE id = 'REV-SCHEMA-ORPHAN'")
      .first("report_id"),
    "SR-SCHEMA-MISSING",
  );
  assert.deepEqual(await foreignKeys(database, "reviews"), [
    ["account_id", "accounts", "id", "SET NULL"],
  ]);

  await insertReportFixture(database, {
    id: "SR-SCHEMA-MISSING",
    username: "RestoredMissingParent",
  });
  await applyNumberedMigrations(database);
  assert.equal(
    await database.prepare("SELECT COUNT(*) FROM d1_migrations").first("COUNT(*)"),
    MIGRATION_FILES.length,
  );
  assert.equal(
    await database
      .prepare("SELECT report_id FROM reviews WHERE id = 'REV-SCHEMA-ORPHAN'")
      .first("report_id"),
    "SR-SCHEMA-MISSING",
  );
  assert.deepEqual(await foreignKeys(database, "reviews"), [
    ["account_id", "accounts", "id", "SET NULL"],
    ["report_id", "reports", "id", "CASCADE"],
  ]);
});
