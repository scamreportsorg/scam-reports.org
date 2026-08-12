import assert from "node:assert/strict";
import test from "node:test";
import {
  MIGRATION_FILES,
  applyNumberedMigrations,
  authHeaders,
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
} from "./helpers/runtime.mjs";

async function mergeTarget(database, duplicateId) {
  return database
    .prepare("SELECT merged_into_report_id FROM reports WHERE id = ?")
    .bind(duplicateId)
    .first("merged_into_report_id");
}

test("D1 keeps report families flat", async () => {
  const { runtime, database } = await createTestRuntime();
  try {
    const triggers = await database
      .prepare(
        `SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'reports_merge_integrity_%'
        ORDER BY name`,
      )
      .all();
    assert.deepEqual(
      triggers.results.map((row) => row.name),
      [
        "reports_merge_integrity_delete",
        "reports_merge_integrity_id_update",
        "reports_merge_integrity_insert",
        "reports_merge_integrity_update",
      ],
    );

    for (const id of ["SR-GRAPH-0001", "SR-GRAPH-0002", "SR-GRAPH-0003"]) {
      await insertReportFixture(database, { id, discordId: "100000000000000071" });
    }

    await assert.rejects(
      database
        .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
        .bind("SR-GRAPH-0001", "SR-GRAPH-0001")
        .run(),
      /report_merge_integrity_same_report/u,
    );
    await assert.rejects(
      database
        .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
        .bind("SR-GRAPH-MISSING", "SR-GRAPH-0001")
        .run(),
      /report_merge_integrity_target_missing/u,
    );

    await database
      .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
      .bind("SR-GRAPH-0002", "SR-GRAPH-0001")
      .run();

    await assert.rejects(
      database.prepare("DELETE FROM reports WHERE id = ?").bind("SR-GRAPH-0002").run(),
      /report_merge_integrity_canonical_has_children/u,
    );

    await assert.rejects(
      database
        .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
        .bind("SR-GRAPH-0003", "SR-GRAPH-0001")
        .run(),
      /report_merge_integrity_source_already_merged/u,
    );
    await assert.rejects(
      database
        .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
        .bind("SR-GRAPH-0001", "SR-GRAPH-0003")
        .run(),
      /report_merge_integrity_target_not_canonical/u,
    );
    await assert.rejects(
      database
        .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
        .bind("SR-GRAPH-0003", "SR-GRAPH-0002")
        .run(),
      /report_merge_integrity_source_has_children/u,
    );

    await database
      .prepare("UPDATE reports SET merged_into_report_id = NULL WHERE id = ?")
      .bind("SR-GRAPH-0001")
      .run();
    assert.equal(await mergeTarget(database, "SR-GRAPH-0001"), null);

    await database
      .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
      .bind("SR-GRAPH-0003", "SR-GRAPH-0002")
      .run();
    assert.equal(await mergeTarget(database, "SR-GRAPH-0002"), "SR-GRAPH-0003");
  } finally {
    await runtime.dispose();
  }
});

test("concurrent merges cannot create a cycle", async () => {
  const { runtime, database } = await createTestRuntime();
  try {
    const moderator = await insertAccountFixture(database, {
      id: "account_merge_race_moderator",
      handle: "MergeRaceModerator",
      role: "moderator",
      providers: ["discord", "email"],
    });
    for (const id of ["SR-RACE-0001", "SR-RACE-0002"]) {
      await insertReportFixture(database, { id, discordId: "100000000000000072" });
    }

    const request = (duplicateId, canonicalId) =>
      runtime.dispatchFetch("http://localhost/api/admin/merge", {
        method: "POST",
        headers: authHeaders(moderator, { "content-type": "application/json" }),
        body: JSON.stringify({ duplicateId, canonicalId }),
      });
    const responses = await Promise.all([
      request("SR-RACE-0001", "SR-RACE-0002"),
      request("SR-RACE-0002", "SR-RACE-0001"),
    ]);
    assert.deepEqual(
      responses.map((response) => response.status).sort((left, right) => left - right),
      [200, 409],
    );
    const rejected = responses.find((response) => response.status === 409);
    const rejection = await rejected.json();
    assert.ok(["merge_conflict", "merge_state_changed"].includes(rejection.code));
    assert.doesNotMatch(rejection.error, /report_merge_integrity|D1_ERROR|SQLITE/iu);

    const rows = await database
      .prepare(
        `SELECT id, merged_into_report_id
        FROM reports WHERE id IN ('SR-RACE-0001', 'SR-RACE-0002') ORDER BY id`,
      )
      .all();
    assert.equal(rows.results.filter((row) => row.merged_into_report_id !== null).length, 1);
    const alias = rows.results.find((row) => row.merged_into_report_id !== null);
    const canonical = rows.results.find((row) => row.id === alias.merged_into_report_id);
    assert.equal(canonical.merged_into_report_id, null);

    const events = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM report_merge_events
        WHERE duplicate_report_id IN ('SR-RACE-0001', 'SR-RACE-0002') AND action = 'merged'`,
      )
      .first("count");
    const audits = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_logs
        WHERE report_id IN ('SR-RACE-0001', 'SR-RACE-0002') AND action = 'report.merged'`,
      )
      .first("count");
    assert.equal(events, 1);
    assert.equal(audits, 1);
  } finally {
    await runtime.dispose();
  }
});

test("integrity migration rejects invalid graphs", async () => {
  const { runtime, database } = await createTestRuntime({ migrate: false });
  try {
    const migrationName = "0015_report_merge_integrity.sql";
    const migrationIndex = MIGRATION_FILES.indexOf(migrationName);
    assert.ok(migrationIndex > 0, "merge integrity migration is registered");
    await applyNumberedMigrations(database, MIGRATION_FILES.slice(0, migrationIndex));
    await insertReportFixture(database, {
      id: "SR-LEGACY-CYCLE-0001",
      discordId: "100000000000000073",
    });
    await insertReportFixture(database, {
      id: "SR-LEGACY-CYCLE-0002",
      discordId: "100000000000000073",
    });
    await database
      .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
      .bind("SR-LEGACY-CYCLE-0002", "SR-LEGACY-CYCLE-0001")
      .run();
    await database
      .prepare("UPDATE reports SET merged_into_report_id = ? WHERE id = ?")
      .bind("SR-LEGACY-CYCLE-0001", "SR-LEGACY-CYCLE-0002")
      .run();

    await assert.rejects(
      applyNumberedMigrations(database, [migrationName]),
      /0015_report_merge_integrity\.sql statement 3 failed/iu,
    );
    assert.equal(
      await database
        .prepare("SELECT COUNT(*) AS count FROM d1_migrations WHERE name = ?")
        .bind(migrationName)
        .first("count"),
      0,
    );
  } finally {
    await runtime.dispose();
  }
});
