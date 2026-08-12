#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, requireArg } from "./operator-common.mjs";

const STAGING_DATABASE = "scam-reports-staging";
const STAGING_WORKER = "scam-reports-staging";
const STAGING_ORIGIN = "https://staging.scam-reports.org";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PLACEHOLDER_UUID_PATTERN = /^0{8}-0{4}-[0-9a-f]{4}-[0-9a-f]{4}-0{12}$/iu;
const WRANGLER_CLI = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const HELP = `Usage:
  node scripts/seed-staging-performance.mjs --database scam-reports-staging
    --config <generated staging wrangler.json>

Replaces only SR-STAGEPERF-* synthetic rows in the private staging database.
The command refuses local, production, or non-staging configurations. The
protected STAGING_D1_DATABASE_ID environment variable must exactly match the
generated binding and Cloudflare's remote database metadata.`;

export const PERFORMANCE_FIXTURE_SQL = `
PRAGMA foreign_keys = ON;
DELETE FROM reports WHERE id GLOB 'SR-STAGEPERF-*';

WITH digit(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
sequence(n) AS (
  SELECT hundreds.d * 100 + tens.d * 10 + ones.d + 1
  FROM digit hundreds CROSS JOIN digit tens CROSS JOIN digit ones
)
INSERT INTO reports (
  id, username, discord_id, game, category, reason, description, status,
  notes, moderator_notes, evidence_json, status_history_json, date_added,
  updated_at, views, is_published
)
SELECT printf('SR-STAGEPERF-%04d', n), printf('smokeprobe%04d', n),
  printf('910000000000%06d', n), 'Synthetic Performance Arena',
  CASE WHEN n % 2 = 0 THEN 'Cheating' ELSE 'Marketplace Scam' END,
  'Synthetic staging-only performance report reason.',
  'Synthetic staging-only record used to verify bounded indexed queries.',
  CASE WHEN n % 3 = 0 THEN 'Confirmed' ELSE 'Reported' END,
  'Synthetic staging performance fixture.', '', '[]', '[]',
  printf('2026-06-%02d', (n % 28) + 1), '2026-08-10T00:00:00.000Z', n, 1
FROM sequence;

WITH digit(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
sequence(n) AS (
  SELECT a.d * 1000 + b.d * 100 + c.d * 10 + d.d + 1
  FROM digit a CROSS JOIN digit b CROSS JOIN digit c CROSS JOIN digit d
)
INSERT INTO reviews (
  id, report_id, display_name, rating, relationship, title, body, status,
  moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
)
SELECT printf('REV-STAGEPERF-%05d', n),
  printf('SR-STAGEPERF-%04d', ((n - 1) % 1000) + 1),
  printf('SyntheticReviewer%05d', n), (n % 5) + 1, 'Researcher',
  'Synthetic staging performance review',
  'Synthetic staging-only review used for repeatable performance verification.',
  'Approved', '', printf('staging-performance-%05d', n), 0,
  '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z'
FROM sequence;

WITH digit(d) AS (VALUES(0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
sequence(n) AS (
  SELECT hundreds.d * 100 + tens.d * 10 + ones.d + 1
  FROM digit hundreds CROSS JOIN digit tens CROSS JOIN digit ones
)
INSERT INTO report_status_events (
  id, report_id, status, public_note, actor_account_id, created_at
)
SELECT printf('RSE-STAGEPERF-%04d', n), printf('SR-STAGEPERF-%04d', n),
  CASE WHEN n % 3 = 0 THEN 'Confirmed' ELSE 'Reported' END,
  'Synthetic staging performance fixture.', NULL, '2026-08-10T00:00:00.000Z'
FROM sequence;
`;

export const PERFORMANCE_FIXTURE_VERIFICATION_SQL = `
SELECT
  (SELECT COUNT(*) FROM reports WHERE id GLOB 'SR-STAGEPERF-*') AS fixture_reports,
  (SELECT COUNT(*) FROM reports
    WHERE id GLOB 'SR-STAGEPERF-[0-9][0-9][0-9][0-9]') AS valid_fixture_report_ids,
  (SELECT COUNT(*) FROM reviews WHERE id GLOB 'REV-STAGEPERF-*') AS fixture_reviews,
  (SELECT COUNT(*) FROM reviews
    WHERE report_id GLOB 'SR-STAGEPERF-*') AS reviews_on_fixture_reports,
  (SELECT COUNT(DISTINCT report_id) FROM reviews
    WHERE report_id GLOB 'SR-STAGEPERF-*') AS reviewed_fixture_reports,
  (SELECT MIN(review_count) FROM (
    SELECT COUNT(*) AS review_count FROM reviews
    WHERE report_id GLOB 'SR-STAGEPERF-*' GROUP BY report_id
  )) AS minimum_reviews_per_report,
  (SELECT MAX(review_count) FROM (
    SELECT COUNT(*) AS review_count FROM reviews
    WHERE report_id GLOB 'SR-STAGEPERF-*' GROUP BY report_id
  )) AS maximum_reviews_per_report,
  (SELECT COUNT(*) FROM report_status_events
    WHERE report_id GLOB 'SR-STAGEPERF-*') AS fixture_status_events,
  (SELECT COUNT(*) FROM reports
    WHERE rowid IN (
      SELECT rowid FROM reports_fts WHERE reports_fts MATCH '"smokeprobe"'
    )) AS searchable_fixture_reports,
  (SELECT COUNT(*) FROM reports
    WHERE id GLOB 'SR-STAGEPERF-*'
      AND (is_published != 1 OR merged_into_report_id IS NOT NULL)) AS invalid_fixture_reports,
  (SELECT COUNT(*) FROM reviews
    WHERE report_id GLOB 'SR-STAGEPERF-*' AND status != 'Approved') AS invalid_fixture_reviews;
`;

function onlyResultRow(payload) {
  const executions = Array.isArray(payload) ? payload : [payload];
  const rows = executions.flatMap((execution) =>
    Array.isArray(execution?.results) ? execution.results : [],
  );
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new Error("Wrangler did not return one fixture verification row.");
  }
  return rows[0];
}

export function assertPerformanceFixture(payload) {
  const row = onlyResultRow(payload);
  const expected = {
    fixture_reports: 1_000,
    valid_fixture_report_ids: 1_000,
    fixture_reviews: 10_000,
    reviews_on_fixture_reports: 10_000,
    reviewed_fixture_reports: 1_000,
    minimum_reviews_per_report: 10,
    maximum_reviews_per_report: 10,
    fixture_status_events: 1_000,
    searchable_fixture_reports: 1_000,
    invalid_fixture_reports: 0,
    invalid_fixture_reviews: 0,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (Number(row[field]) !== value) {
      throw new Error(
        `Synthetic fixture verification failed for ${field}: expected ${value}, received ${String(row[field])}.`,
      );
    }
  }
  return expected;
}

export function assertStagingConfig(config, protectedDatabaseId) {
  const bindings = config.d1_databases?.filter((entry) => entry.binding === "DB") ?? [];
  const binding = bindings[0];
  const routes = config.routes ?? [];
  if (
    config.name !== STAGING_WORKER ||
    config.vars?.ENVIRONMENT !== "staging" ||
    config.vars?.APP_ENVIRONMENT !== "staging" ||
    config.vars?.AUTH_RUNTIME_ENV !== "staging" ||
    config.vars?.AUTH_APP_ORIGIN !== STAGING_ORIGIN ||
    config.workers_dev !== true ||
    routes.length !== 1 ||
    routes[0]?.pattern !== "staging.scam-reports.org" ||
    routes[0]?.custom_domain !== true ||
    bindings.length !== 1 ||
    binding?.database_name !== STAGING_DATABASE ||
    typeof binding?.database_id !== "string" ||
    !UUID_PATTERN.test(binding.database_id) ||
    PLACEHOLDER_UUID_PATTERN.test(binding.database_id) ||
    !UUID_PATTERN.test(protectedDatabaseId ?? "") ||
    PLACEHOLDER_UUID_PATTERN.test(protectedDatabaseId ?? "") ||
    binding.database_id !== protectedDatabaseId
  ) {
    throw new Error("Generated config is not the protected staging-only deployment config.");
  }
  return binding;
}

function runWrangler(arguments_, options = {}) {
  const result = spawnSync(process.execPath, [WRANGLER_CLI, ...arguments_], {
    encoding: options.json ? "utf8" : undefined,
    stdio: options.json ? ["ignore", "pipe", "pipe"] : "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    if (options.json && result.stderr) process.stderr.write(result.stderr);
    if (result.error) throw result.error;
    throw new Error(`Wrangler exited with status ${String(result.status ?? "unknown")}.`);
  }
  if (!options.json) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Wrangler returned invalid JSON.");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["help"] });
  if (args.help) {
    console.log(HELP);
    return;
  }
  const database = requireArg(args, "database");
  if (database !== STAGING_DATABASE) {
    throw new Error(`--database must be exactly ${STAGING_DATABASE}.`);
  }
  const configPath = resolve(requireArg(args, "config"));
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const binding = assertStagingConfig(config, process.env.STAGING_D1_DATABASE_ID?.trim());

  const remoteInfo = runWrangler(
    ["d1", "info", STAGING_DATABASE, "--config", configPath, "--json"],
    { json: true },
  );
  if (remoteInfo?.uuid !== binding.database_id || remoteInfo?.name !== STAGING_DATABASE) {
    throw new Error("Cloudflare remote metadata does not match the protected staging D1 binding.");
  }

  const directory = await mkdtemp(join(tmpdir(), "scam-reports-staging-performance-"));
  const sqlPath = join(directory, "synthetic-staging-performance.sql");
  try {
    await writeFile(sqlPath, PERFORMANCE_FIXTURE_SQL, "utf8");
    runWrangler([
      "d1",
      "execute",
      STAGING_DATABASE,
      "--remote",
      "--yes",
      "--config",
      configPath,
      "--file",
      sqlPath,
    ]);
    const verification = runWrangler(
      [
        "d1",
        "execute",
        STAGING_DATABASE,
        "--remote",
        "--config",
        configPath,
        "--command",
        PERFORMANCE_FIXTURE_VERIFICATION_SQL,
        "--json",
      ],
      { json: true },
    );
    assertPerformanceFixture(verification);
    console.log(
      "Loaded exactly 1,000 synthetic reports and 10,000 synthetic reviews into private staging.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `seed-staging-performance: ${error instanceof Error ? error.message : "unexpected failure"}`,
    );
    process.exitCode = 1;
  });
}
