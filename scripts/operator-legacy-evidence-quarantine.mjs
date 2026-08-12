#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  assertDatabaseName,
  assertEnvironment,
  assertEqual,
  assertUuid,
  batchD1,
  parseArgs,
  queryD1,
  requireArg,
  requireEnv,
  verifyD1Target,
  writeJsonExclusive,
} from "./operator-common.mjs";

const EXECUTION_CONFIRMATION = "WITHHOLD_SELECTED_LEGACY_EVIDENCE";
const HELP = `Usage:
  node scripts/operator-legacy-evidence-quarantine.mjs [options]

Required:
  --environment <development|staging|production|restore-test>
  --confirm-environment <same value>
  --database-name <exact D1 name>
  --confirm-database-name <same value>
  --database-id <exact D1 UUID>
  --confirm-database-id <same UUID>
  --asset-ids <comma-separated explicit EVA-* IDs, maximum 90>
  --output-file <new private JSON plan/result path>

Execution:
  --execute
  --confirm-execute ${EXECUTION_CONFIRMATION}

Without --execute this command is read-only. Execution only changes selected legacy
assets to 'withheld', resets their visible-PII review, marks them for re-encoding,
and creates audit records. It never publishes, downloads, rewrites, or deletes
evidence bytes. Re-encoding must subsequently use the current Cloudflare Images
pipeline; a metadata-only rewrite is explicitly not a migration.`;

function fail(message) {
  console.error(`operator-legacy-evidence-quarantine: ${message}`);
  process.exitCode = 1;
}

function parseAssetIds(value) {
  const ids = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!ids.length || ids.length > 90)
    throw new Error("--asset-ids must contain between 1 and 90 explicit IDs.");
  if (new Set(ids).size !== ids.length) throw new Error("--asset-ids contains a duplicate ID.");
  for (const id of ids) {
    if (!/^EVA-[A-Za-z0-9-]{8,80}$/u.test(id)) throw new Error(`Invalid evidence asset ID: ${id}`);
  }
  return ids;
}

async function loadSelectedAssets(options, ids) {
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await queryD1({
    ...options,
    sql: `SELECT id, intake_id, intake_kind, state, original_sha256, derivative_sha256,
      visible_pii_reviewed, updated_at FROM evidence_assets WHERE id IN (${placeholders}) ORDER BY id`,
    params: ids,
  });
  const found = new Set(rows.map((row) => String(row.id)));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length)
    throw new Error(`Selected evidence IDs were not found: ${missing.join(", ")}.`);
  for (const row of rows) {
    if (row.intake_kind !== "legacy")
      throw new Error(`Asset ${row.id} is not marked as legacy evidence.`);
    if (!["private_ready", "public", "withheld"].includes(String(row.state))) {
      throw new Error(
        `Asset ${row.id} has state ${row.state} and cannot enter the re-encode quarantine.`,
      );
    }
  }
  return rows;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["help", "execute"],
  });
  if (args.help) {
    console.log(HELP);
    return;
  }
  const environment = assertEnvironment(requireArg(args, "environment"));
  assertEqual("Environment", environment, requireArg(args, "confirm-environment").toLowerCase());
  const databaseName = assertDatabaseName(requireArg(args, "database-name"));
  assertEqual("Database name", databaseName, requireArg(args, "confirm-database-name"));
  const databaseId = assertUuid(requireArg(args, "database-id"));
  assertEqual("Database ID", databaseId, requireArg(args, "confirm-database-id"));
  const ids = parseAssetIds(requireArg(args, "asset-ids"));
  const outputFile = resolve(requireArg(args, "output-file"));
  if (!outputFile.toLowerCase().endsWith(".json"))
    throw new Error("--output-file must end in .json.");
  if (args.execute && args["confirm-execute"] !== EXECUTION_CONFIRMATION) {
    throw new Error(`Execution requires --confirm-execute ${EXECUTION_CONFIRMATION}.`);
  }
  if (!args.execute && args["confirm-execute"])
    throw new Error("--confirm-execute is only valid together with --execute.");

  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  await verifyD1Target({ accountId, token, databaseId, databaseName });
  const selected = await loadSelectedAssets({ accountId, token, databaseId }, ids);
  const before = selected.map((row) => ({
    id: String(row.id),
    state: String(row.state),
    hasOriginalHash: /^[0-9a-f]{64}$/u.test(String(row.original_sha256 ?? "")),
    hasDerivativeHash: /^[0-9a-f]{64}$/u.test(String(row.derivative_sha256 ?? "")),
    visiblePiiReviewed: Number(row.visible_pii_reviewed) === 1,
  }));

  if (args.execute) {
    const now = new Date().toISOString();
    const guardId = `legacy-quarantine:${randomUUID()}`;
    const guardPlaceholders = ids.map(() => "?").join(", ");
    const statements = [
      {
        sql: `INSERT INTO audit_logs (report_id, action, actor, created_at, detail)
        SELECT ?, CASE WHEN (SELECT COUNT(*) FROM evidence_assets WHERE id IN (${guardPlaceholders})
          AND intake_kind = 'legacy' AND state IN ('private_ready', 'public', 'withheld')) = ?
          THEN 'operator.atomic_guard' ELSE NULL END,
          'operator:legacy-evidence:guard', ?, ?`,
        params: [selected[0].intake_id || selected[0].id, ...ids, ids.length, now, guardId],
      },
    ];
    for (const row of selected) {
      statements.push({
        sql: `UPDATE evidence_assets SET state = 'withheld', visible_pii_reviewed = 0,
          processing_error = CASE
            WHEN processing_error = '' THEN 'legacy-reencode-required'
            WHEN processing_error NOT LIKE '%legacy-reencode-required%' THEN processing_error || ';legacy-reencode-required'
            ELSE processing_error END,
          updated_at = ? WHERE id = ? AND intake_kind = 'legacy'
            AND state IN ('private_ready', 'public', 'withheld')`,
        params: [now, row.id],
      });
      statements.push({
        sql: `INSERT INTO audit_logs (report_id, action, actor, created_at, detail)
          VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM evidence_assets WHERE id = ?
            AND intake_kind = 'legacy' AND state = 'withheld' AND visible_pii_reviewed = 0
            AND processing_error LIKE '%legacy-reencode-required%')
            THEN 'evidence.legacy_reencode_quarantined' ELSE NULL END,
            'operator:legacy-evidence', ?, ?)`,
        params: [
          row.intake_id || row.id,
          row.id,
          now,
          JSON.stringify({
            evidenceId: row.id,
            priorState: row.state,
            nextAction: "reencode-with-current-images-pipeline",
          }),
        ],
      });
    }
    statements.push({
      sql: `DELETE FROM audit_logs WHERE action = 'operator.atomic_guard'
        AND actor = 'operator:legacy-evidence:guard' AND detail = ?`,
      params: [guardId],
    });
    const completed = await batchD1({
      accountId,
      token,
      databaseId,
      statements,
    });
    const changedUpdates = completed
      .slice(1, -1)
      .filter((_, index) => index % 2 === 0)
      .map((statement) => Number(statement.meta?.changes ?? 0));
    const writtenAudits = completed
      .slice(1, -1)
      .filter((_, index) => index % 2 === 1)
      .map((statement) => Number(statement.meta?.changes ?? 0));
    if (
      Number(completed[0]?.meta?.changes ?? 0) !== 1 ||
      Number(completed.at(-1)?.meta?.changes ?? 0) !== 1 ||
      changedUpdates.some((changes) => changes !== 1) ||
      writtenAudits.some((changes) => changes !== 1)
    ) {
      throw new Error(
        "Atomic D1 quarantine batch did not update and audit every selected asset exactly once.",
      );
    }
    const verified = await loadSelectedAssets({ accountId, token, databaseId }, ids);
    if (
      verified.some((row) => row.state !== "withheld" || Number(row.visible_pii_reviewed) !== 0)
    ) {
      throw new Error("One or more selected assets did not enter the withheld state.");
    }
  }

  const report = {
    schema: "scam-reports.legacy-evidence-quarantine/v1",
    generatedAt: new Date().toISOString(),
    mode: args.execute ? "executed" : "plan-only",
    environment,
    databaseName,
    databaseId,
    selectedAssets: before,
    guarantees: [
      "No evidence object body was downloaded.",
      "No evidence object was published, replaced, or deleted.",
      "Executed assets are withheld and require a fresh visible-PII review.",
      "Each evidence-state change and matching audit row were submitted in one atomic D1 batch.",
      "A metadata-only rewrite is not accepted as re-encoding.",
    ],
    nextAction:
      "Re-encode each original through the current Cloudflare Images metadata:none/anim:false WebP pipeline, keep it withheld, verify hashes, and require moderator PII review before any publication.",
  };
  await writeJsonExclusive(outputFile, report);
  console.log(
    JSON.stringify(
      {
        status: args.execute ? "withheld" : "planned",
        selectedAssets: ids.length,
        outputFile: basename(outputFile),
        nextAction: "fresh Cloudflare Images re-encode required",
      },
      null,
      2,
    ),
  );
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : "Unexpected legacy evidence quarantine failure."),
);
