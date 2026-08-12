#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertEqual,
  assertDatabaseName,
  assertEnvironment,
  assertFile,
  assertSafeRestoreTarget,
  assertUuid,
  ensureFreshDirectory,
  loadJson,
  parseArgs,
  queryD1,
  removeOwnedTemporaryDirectory,
  requireArg,
  requireEnv,
  sha256File,
  verifyD1Target,
  writeJsonExclusive,
} from "./operator-common.mjs";

const execFileAsync = promisify(execFile);
const REQUIRED_TABLES = [
  "account_identities",
  "accounts",
  "appeals",
  "audit_logs",
  "auth_magic_links",
  "auth_oauth_transactions",
  "auth_security_events",
  "auth_sessions",
  "auth_settings",
  "backup_runs",
  "comments",
  "d1_migrations",
  "evidence_assets",
  "notification_outbox",
  "rate_events",
  "report_evidence",
  "report_merge_events",
  "report_status_events",
  "report_submissions",
  "reports",
  "review_revisions",
  "reviews",
];

const HELP = `Usage:
  node scripts/operator-restore-dry-run.mjs [options]

Required:
  --source <D1 export .sql>
  --manifest <matching export manifest .json>
  --target-mode <local|remote-restore-test>
  --target-database <explicit local or restore-test database name>
  --confirm-target-database <same name>
  --report-file <new verification report .json>

Local-only:
  --persist-to <fresh local persistence directory>

Remote-restore-test-only:
  --target-database-id <dedicated restore-test D1 UUID>
  --confirm-target-database-id <same UUID>

Safety switches:
  --execute     Required to perform the restore rehearsal. Without it, this is plan-only.
  --help

Production-like targets are always rejected. Remote targets must contain a distinct
'restore-test' segment and must be completely empty. This tool never truncates,
drops, deletes, or resets a target database.`;

function fail(message) {
  console.error(`operator-restore-dry-run: ${message}`);
  process.exitCode = 1;
}

function unwrapWranglerJson(stdout) {
  const start = Math.min(
    ...[stdout.indexOf("["), stdout.indexOf("{")].filter((index) => index >= 0),
  );
  if (!Number.isFinite(start)) throw new Error("Wrangler returned no JSON result.");
  const payload = JSON.parse(stdout.slice(start));
  const statements = Array.isArray(payload) ? payload : [payload];
  for (const statement of statements) {
    if (!statement?.success) throw new Error("Wrangler D1 command did not complete successfully.");
  }
  return statements.flatMap((statement) =>
    Array.isArray(statement.results) ? statement.results : [],
  );
}

async function runWrangler(configPath, databaseName, mode, argumentsList) {
  const executable = await assertFile(
    resolve("node_modules/wrangler/bin/wrangler.js"),
    "Local Wrangler executable",
  );
  const modeFlag = mode === "local" ? "--local" : "--remote";
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      executable,
      "d1",
      "execute",
      databaseName,
      modeFlag,
      "--config",
      configPath,
      "--json",
      "--yes",
      ...argumentsList,
    ],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: process.env,
      maxBuffer: 256 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    },
  );
  return unwrapWranglerJson(stdout);
}

async function assertSafeSqlSnapshot(path) {
  const forbidden =
    /(?:^|[;\s])(?:ATTACH\s+(?:DATABASE\s+)?|DETACH\s+(?:DATABASE\s+)?|VACUUM\s+INTO\s+|SELECT\s+load_extension\s*\(|(?:readfile|writefile)\s*\(|\.\s*(?:shell|read|open)\b)/iu;
  let carry = "";
  for await (const chunk of createReadStream(path, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  })) {
    const text = `${carry}${chunk}`;
    if (forbidden.test(text))
      throw new Error(
        "Snapshot contains a filesystem- or extension-oriented SQLite directive and was rejected.",
      );
    carry = text.slice(-512);
  }
}

async function makeWranglerConfig(directory, databaseName, databaseId) {
  const mainPath = join(directory, "operator-placeholder.mjs");
  const configPath = join(directory, "wrangler.json");
  await writeFile(
    mainPath,
    "export default { fetch() { return new Response('operator-only'); } };\n",
    { mode: 0o600 },
  );
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        name: "scam-reports-restore-operator",
        main: mainPath.replaceAll("\\", "/"),
        compatibility_date: "2026-08-09",
        d1_databases: [
          {
            binding: "RESTORE_DB",
            database_name: databaseName,
            database_id: databaseId,
          },
        ],
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return configPath;
}

async function inspectEmptyRemoteTarget({ accountId, token, databaseId }) {
  const rows = await queryD1({
    accountId,
    token,
    databaseId,
    sql: "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  });
  const count = Number(rows[0]?.count ?? -1);
  if (count !== 0)
    throw new Error(
      "Remote restore-test target is not empty. This tool will not clear or overwrite it.",
    );
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["help", "execute"],
  });
  if (args.help) {
    console.log(HELP);
    return;
  }
  const source = await assertFile(requireArg(args, "source"), "Snapshot");
  const manifestPath = await assertFile(requireArg(args, "manifest"), "Manifest");
  const reportFile = resolve(requireArg(args, "report-file"));
  if (!source.toLowerCase().endsWith(".sql")) throw new Error("Snapshot path must end in .sql.");
  if (!manifestPath.toLowerCase().endsWith(".json"))
    throw new Error("Manifest path must end in .json.");
  if (!reportFile.toLowerCase().endsWith(".json"))
    throw new Error("Report path must end in .json.");
  const mode = requireArg(args, "target-mode");
  if (mode !== "local" && mode !== "remote-restore-test")
    throw new Error("--target-mode must be local or remote-restore-test.");
  const targetDatabase = assertSafeRestoreTarget(
    requireArg(args, "target-database"),
    mode === "local" ? "local" : "remote",
  );
  assertEqual("Target database", targetDatabase, requireArg(args, "confirm-target-database"));

  const manifest = await loadJson(manifestPath);
  if (manifest?.schema !== "scam-reports.d1-export-manifest/v1")
    throw new Error("Unsupported or missing D1 export manifest schema.");
  const sourceEnvironment = assertEnvironment(String(manifest.environment ?? ""));
  const sourceDatabaseName = assertDatabaseName(String(manifest.databaseName ?? ""));
  const sourceDatabaseId = assertUuid(String(manifest.databaseId ?? ""), "source database ID");
  const exportedAt = new Date(String(manifest.exportedAt ?? ""));
  if (!Number.isFinite(exportedAt.getTime()) || exportedAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new Error("Manifest export timestamp is invalid or in the future.");
  }
  if (
    typeof manifest.bookmark !== "string" ||
    !manifest.bookmark.trim() ||
    manifest.bookmark.length > 500
  ) {
    throw new Error("Manifest D1 export bookmark is invalid.");
  }
  if (manifest.snapshot?.file !== basename(source))
    throw new Error("Manifest snapshot filename does not match --source.");
  if (!/^[0-9a-f]{64}$/u.test(manifest.snapshot?.sha256 ?? ""))
    throw new Error("Manifest snapshot SHA-256 is invalid.");
  const digest = await sha256File(source);
  if (digest.sha256 !== manifest.snapshot.sha256 || digest.size !== manifest.snapshot.size) {
    throw new Error("Snapshot content does not match its SHA-256 manifest.");
  }
  await assertSafeSqlSnapshot(source);
  const expectedMigrations = (await readdir(resolve("drizzle")))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (!expectedMigrations.length)
    throw new Error("Repository contains no numbered D1 migrations to verify.");
  if (expectedMigrations.some((name, index) => Number.parseInt(name.slice(0, 4), 10) !== index)) {
    throw new Error("Repository D1 migrations are not a contiguous zero-based sequence.");
  }
  const expectedSchemaVersion = String(expectedMigrations.length);
  const versionSource = await readFile(resolve("lib/version.ts"), "utf8");
  const applicationSchemaMatch = /^export const SCHEMA_VERSION = (\d+);$/mu.exec(versionSource);
  if (!applicationSchemaMatch || applicationSchemaMatch[1] !== expectedSchemaVersion) {
    throw new Error("Application SCHEMA_VERSION does not match the numbered migration set.");
  }

  let databaseId;
  let persistTo;
  if (mode === "remote-restore-test") {
    databaseId = assertUuid(requireArg(args, "target-database-id"), "restore-test database ID");
    assertEqual(
      "Restore-test database ID",
      databaseId,
      requireArg(args, "confirm-target-database-id"),
    );
  } else {
    persistTo = resolve(requireArg(args, "persist-to"));
  }

  const plan = {
    mode: args.execute ? "execute" : "plan-only",
    source: basename(source),
    sourceSha256: digest.sha256,
    sourceBytes: digest.size,
    sourceEnvironment,
    targetMode: mode,
    targetDatabase,
    targetDatabaseId: databaseId ?? null,
    persistTo: persistTo ?? null,
  };
  if (!args.execute) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  if (mode === "local")
    await ensureFreshDirectory(persistTo, "Local restore persistence directory");
  const tempDirectory = await mkdtemp(join(tmpdir(), "scam-reports-operator-"));
  try {
    const configPath = await makeWranglerConfig(
      tempDirectory,
      targetDatabase,
      databaseId ?? randomUUID(),
    );
    if (mode === "remote-restore-test") {
      const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
      const token = requireEnv("CLOUDFLARE_API_TOKEN");
      await verifyD1Target({
        accountId,
        token,
        databaseId,
        databaseName: targetDatabase,
      });
      await inspectEmptyRemoteTarget({ accountId, token, databaseId });
    }

    const persistenceArguments = mode === "local" ? ["--persist-to", persistTo] : [];
    await runWrangler(configPath, targetDatabase, mode === "local" ? "local" : "remote", [
      ...persistenceArguments,
      "--file",
      source,
    ]);

    const query = async (sql) =>
      runWrangler(configPath, targetDatabase, mode === "local" ? "local" : "remote", [
        ...persistenceArguments,
        "--command",
        sql,
      ]);
    const integrityRows = await query("PRAGMA quick_check");
    if (
      integrityRows.length !== 1 ||
      String(integrityRows[0]?.quick_check ?? "").toLowerCase() !== "ok"
    ) {
      throw new Error("Restored database failed PRAGMA quick_check.");
    }
    const foreignKeyRows = await query("PRAGMA foreign_key_check");
    if (foreignKeyRows.length)
      throw new Error("Restored database contains foreign-key violations.");
    const tableRows = await query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const tables = new Set(tableRows.map((row) => String(row.name)));
    const missingTables = REQUIRED_TABLES.filter((table) => !tables.has(table));
    if (missingTables.length)
      throw new Error(`Restored database is missing required tables: ${missingTables.join(", ")}.`);
    const migrationRows = await query("SELECT name FROM d1_migrations ORDER BY id");
    const restoredMigrations = migrationRows.map((row) => String(row.name));
    if (JSON.stringify(restoredMigrations) !== JSON.stringify(expectedMigrations)) {
      const missingMigrations = expectedMigrations.filter(
        (name) => !restoredMigrations.includes(name),
      );
      const unexpectedMigrations = restoredMigrations.filter(
        (name) => !expectedMigrations.includes(name),
      );
      throw new Error(
        `Restored migration set does not match this release (missing: ${missingMigrations.join(", ") || "none"}; unexpected: ${unexpectedMigrations.join(", ") || "none"}).`,
      );
    }
    const countRows =
      await query(`SELECT 'accounts' AS table_name, COUNT(*) AS row_count FROM accounts
      UNION ALL SELECT 'reports', COUNT(*) FROM reports
      UNION ALL SELECT 'reviews', COUNT(*) FROM reviews
      UNION ALL SELECT 'evidence_assets', COUNT(*) FROM evidence_assets
      UNION ALL SELECT 'audit_logs', COUNT(*) FROM audit_logs`);
    const rowCounts = Object.fromEntries(
      countRows.map((row) => [String(row.table_name), Number(row.row_count)]),
    );
    const report = {
      schema: "scam-reports.restore-verification/v1",
      verifiedAt: new Date().toISOString(),
      source: {
        environment: sourceEnvironment,
        databaseName: sourceDatabaseName,
        databaseId: sourceDatabaseId,
        exportedAt: exportedAt.toISOString(),
        sha256: digest.sha256,
        size: digest.size,
      },
      target: {
        mode,
        databaseName: targetDatabase,
        databaseId: databaseId ?? null,
      },
      checks: {
        integrity: "ok",
        foreignKeys: "ok",
        requiredTables: "ok",
        migrations: "ok",
        schemaVersion: expectedSchemaVersion,
        applicationSchemaVersion: applicationSchemaMatch[1],
        migrationCount: restoredMigrations.length,
        rowCounts,
      },
    };
    await writeJsonExclusive(reportFile, report);
    console.log(
      JSON.stringify(
        {
          status: "verified",
          targetMode: mode,
          targetDatabase,
          sourceSha256: digest.sha256,
          checks: report.checks,
          reportFile: basename(reportFile),
        },
        null,
        2,
      ),
    );
  } finally {
    await removeOwnedTemporaryDirectory(tempDirectory, "scam-reports-operator-");
  }
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : "Unexpected restore rehearsal failure."),
);
