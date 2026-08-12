import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  MIGRATION_FILES,
  applyNumberedMigrations,
  createTestRuntime,
  insertReportFixture,
} from "./helpers/runtime.mjs";

let runtime;
let database;
const statusHistoryMigration = "0009_authoritative_status_history.sql";

before(async () => {
  ({ runtime, database } = await createTestRuntime({ migrate: false }));
  await applyNumberedMigrations(
    database,
    MIGRATION_FILES.slice(0, MIGRATION_FILES.indexOf(statusHistoryMigration)),
  );
});

after(async () => runtime?.dispose());

test("status history migration backfills legacy reports", async () => {
  await insertReportFixture(database, {
    id: "SR-HISTORY-LEGACY",
    username: "LegacyHistory",
    discordId: "100000000000000071",
    status: "Confirmed",
    updatedAt: "2026-08-09T12:00:00.000Z",
  });
  await database
    .prepare(`UPDATE reports SET status_history_json = ?, notes = ? WHERE id = ?`)
    .bind(
      JSON.stringify([
        {
          status: "Reported",
          date: "2026-08-01T10:00:00.000Z",
          note: "Legacy report received.",
          moderator: "Legacy Moderator",
        },
        "not-an-event",
        {
          status: "Not a real status",
          date: "2026-08-02T10:00:00.000Z",
          note: "This entry must be ignored.",
        },
        {
          status: "Confirmed",
          date: "2026-08-03T10:00:00.000Z",
          note: "Legacy report confirmed.",
          moderator: "Legacy Moderator",
        },
      ]),
      "Legacy public note",
      "SR-HISTORY-LEGACY",
    )
    .run();

  await insertReportFixture(database, {
    id: "SR-HISTORY-FALLBACK",
    username: "FallbackHistory",
    discordId: "100000000000000072",
    status: "Under Review",
    updatedAt: "2026-08-09T13:00:00.000Z",
  });
  await database
    .prepare(`UPDATE reports SET status_history_json = ?, notes = ? WHERE id = ?`)
    .bind(JSON.stringify({ status: "Confirmed" }), "Fallback public note", "SR-HISTORY-FALLBACK")
    .run();

  await applyNumberedMigrations(database, [statusHistoryMigration]);

  const legacy = await database
    .prepare(
      `SELECT status, public_note, created_at
    FROM report_status_events WHERE report_id = ? ORDER BY created_at, id`,
    )
    .bind("SR-HISTORY-LEGACY")
    .all();
  assert.deepEqual(legacy.results, [
    {
      status: "Reported",
      public_note: "Legacy report received.",
      created_at: "2026-08-01T10:00:00.000Z",
    },
    {
      status: "Confirmed",
      public_note: "Legacy report confirmed.",
      created_at: "2026-08-03T10:00:00.000Z",
    },
  ]);
  assert.deepEqual(
    await database
      .prepare(
        `SELECT status, public_note, created_at
      FROM report_status_events WHERE report_id = ?`,
      )
      .bind("SR-HISTORY-FALLBACK")
      .first(),
    {
      status: "Under Review",
      public_note: "Fallback public note",
      created_at: "2026-08-09T13:00:00.000Z",
    },
  );

  await database
    .prepare("DELETE FROM d1_migrations WHERE name = ?")
    .bind(statusHistoryMigration)
    .run();
  await applyNumberedMigrations(database, [statusHistoryMigration]);
  assert.equal(
    await database.prepare("SELECT COUNT(*) AS count FROM report_status_events").first("count"),
    3,
  );
});
