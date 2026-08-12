#!/usr/bin/env node

import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  assertBucketName,
  assertDatabaseName,
  assertEnvironment,
  assertEqual,
  assertUuid,
  headR2Object,
  listR2Objects,
  mapConcurrent,
  parseArgs,
  queryD1,
  requireArg,
  requireEnv,
  verifyD1Target,
  writeJsonExclusive,
} from "./operator-common.mjs";

const HELP = `Usage:
  node scripts/operator-evidence-inventory.mjs [options]

Required target confirmation:
  --environment <development|staging|production|restore-test>
  --confirm-environment <same value>
  --database-name <exact D1 name>
  --confirm-database-name <same value>
  --database-id <exact D1 UUID>
  --confirm-database-id <same UUID>
  --originals-bucket <exact R2 bucket name>
  --confirm-originals-bucket <same value>
  --derivatives-bucket <exact R2 bucket name>
  --confirm-derivatives-bucket <same value>
  --backups-bucket <exact R2 bucket name>
  --confirm-backups-bucket <same value>
  --output-file <new private JSON report path>

Optional:
  --concurrency <1-25, default 10>
  --transient-minutes <5-1440, default 60>
  --plan-only   Validate targets only; make no network requests.
  --help

Credentials are read from CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY. The operator reads D1 technical
metadata and R2 LIST/HEAD metadata only; it never downloads evidence bodies.`;

function fail(message) {
  console.error(`operator-evidence-inventory: ${message}`);
  process.exitCode = 1;
}

function keyFingerprint(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function backupKey(originalKey) {
  return `evidence-originals/${originalKey.replace(/^originals\//u, "")}`;
}

function normalizeAsset(row) {
  return {
    id: String(row.id),
    state: String(row.state),
    original_key: String(row.original_key),
    derivative_key: row.derivative_key === null ? null : String(row.derivative_key),
    original_size: Number(row.original_size),
    original_sha256: String(row.original_sha256),
    derivative_size: row.derivative_size === null ? null : Number(row.derivative_size),
    derivative_sha256: row.derivative_sha256 === null ? null : String(row.derivative_sha256),
    legal_hold: Number(row.legal_hold) === 1,
    processing_error: String(row.processing_error ?? ""),
    updated_at: String(row.updated_at),
    deleted_at: row.deleted_at === null ? null : String(row.deleted_at),
  };
}

async function readAssets(options) {
  const assets = [];
  let after = "";
  let hasMore = true;
  while (hasMore) {
    const rows = await queryD1({
      ...options,
      sql: `SELECT id, state, original_key, derivative_key, original_size, original_sha256,
        derivative_size, derivative_sha256, legal_hold, processing_error, updated_at, deleted_at
        FROM evidence_assets WHERE id > ? ORDER BY id LIMIT 500`,
      params: [after],
    });
    if (!rows.length) {
      hasMore = false;
    } else {
      assets.push(...rows.map(normalizeAsset));
      after = String(rows.at(-1).id);
      if (assets.length > 100_000)
        throw new Error("Evidence inventory exceeded the 100,000-row operator safety limit.");
      hasMore = rows.length === 500;
    }
  }
  return assets;
}

function buildExpectations(assets, transientMinutes) {
  const expected = {
    originals: new Map(),
    derivatives: new Map(),
    backups: new Map(),
  };
  const transientKeys = {
    originals: new Set(),
    derivatives: new Set(),
    backups: new Set(),
  };
  const mismatches = [];
  const warnings = [];
  const now = Date.now();
  const retentionMs = 90 * 24 * 60 * 60 * 1000;
  const transientMs = transientMinutes * 60 * 1000;
  for (const asset of assets) {
    const stable = new Set(["private_ready", "public", "withheld"]).has(asset.state);
    if (stable) {
      expected.originals.set(asset.original_key, asset);
      if (!asset.derivative_key || asset.derivative_size === null || !asset.derivative_sha256) {
        mismatches.push({
          assetId: asset.id,
          bucketRole: "derivatives",
          code: "database_derivative_metadata_missing",
        });
      } else {
        expected.derivatives.set(asset.derivative_key, asset);
      }
      expected.backups.set(backupKey(asset.original_key), asset);
      continue;
    }
    if (asset.state === "deleted") {
      const deletedAt = asset.deleted_at ? Date.parse(asset.deleted_at) : Number.NaN;
      if (!Number.isFinite(deletedAt)) {
        mismatches.push({
          assetId: asset.id,
          bucketRole: "backups",
          code: "deleted_timestamp_missing",
        });
      } else if (asset.legal_hold || now - deletedAt <= retentionMs) {
        expected.backups.set(backupKey(asset.original_key), asset);
      } else if (!asset.processing_error.includes("backup-purged")) {
        warnings.push({
          assetId: asset.id,
          bucketRole: "backups",
          code: "backup_purge_marker_pending",
        });
      }
      continue;
    }
    if (asset.state === "uploading") {
      const updatedAt = Date.parse(asset.updated_at);
      if (!Number.isFinite(updatedAt) || now - updatedAt > transientMs) {
        mismatches.push({
          assetId: asset.id,
          bucketRole: "all",
          code: "stale_uploading_record",
        });
      } else {
        const suffix = asset.original_key.replace(/^originals\//u, "");
        transientKeys.originals.add(asset.original_key);
        transientKeys.derivatives.add(asset.derivative_key || `derivatives/${suffix}.webp`);
        transientKeys.backups.add(backupKey(asset.original_key));
        warnings.push({
          assetId: asset.id,
          bucketRole: "all",
          code: "transient_upload_excluded",
        });
      }
      continue;
    }
    if (asset.state !== "failed") {
      mismatches.push({
        assetId: asset.id,
        bucketRole: "all",
        code: "unknown_evidence_state",
      });
    }
  }
  return { expected, transientKeys, mismatches, warnings };
}

function compareMetadata(role, asset, head) {
  const issues = [];
  const expectedSize = role === "derivatives" ? asset.derivative_size : asset.original_size;
  if (head.size !== expectedSize) issues.push("size_mismatch");
  if (head.metadata.assetid !== asset.id) issues.push("asset_id_metadata_mismatch");
  if (role === "derivatives") {
    if (head.metadata.sourcesha256 !== asset.original_sha256)
      issues.push("source_hash_metadata_mismatch");
    if (!head.metadata.sha256) issues.push("sha256_metadata_missing");
    else if (head.metadata.sha256 !== asset.derivative_sha256)
      issues.push("sha256_metadata_mismatch");
  } else if (!head.metadata.sha256) {
    issues.push("sha256_metadata_missing");
  } else if (head.metadata.sha256 !== asset.original_sha256) {
    issues.push("sha256_metadata_mismatch");
  }
  if (role === "originals" && head.metadata.private !== "true")
    issues.push("private_metadata_missing");
  return issues;
}

async function inspectRole({ role, bucket, prefix, expected, transientKeys, r2, concurrency }) {
  const listed = await listR2Objects({ ...r2, bucket }, prefix);
  const listedMap = new Map(listed.map((object) => [object.key, object]));
  const mismatches = [];
  for (const object of listed) {
    if (!expected.has(object.key) && !transientKeys.has(object.key)) {
      mismatches.push({
        bucketRole: role,
        code: "orphan_object",
        keyFingerprint: keyFingerprint(object.key),
      });
    }
  }
  const entries = [...expected.entries()];
  await mapConcurrent(entries, concurrency, async ([key, asset]) => {
    const listedObject = listedMap.get(key);
    if (!listedObject) {
      mismatches.push({
        assetId: asset.id,
        bucketRole: role,
        code: "object_missing",
        keyFingerprint: keyFingerprint(key),
      });
      return;
    }
    const expectedSize = role === "derivatives" ? asset.derivative_size : asset.original_size;
    if (listedObject.size !== expectedSize) {
      mismatches.push({
        assetId: asset.id,
        bucketRole: role,
        code: "listed_size_mismatch",
        keyFingerprint: keyFingerprint(key),
      });
    }
    const head = await headR2Object({ ...r2, bucket }, key);
    if (!head) {
      mismatches.push({
        assetId: asset.id,
        bucketRole: role,
        code: "object_disappeared_during_inventory",
        keyFingerprint: keyFingerprint(key),
      });
      return;
    }
    for (const code of compareMetadata(role, asset, head)) {
      mismatches.push({
        assetId: asset.id,
        bucketRole: role,
        code,
        keyFingerprint: keyFingerprint(key),
      });
    }
  });
  return { listed: listed.length, expected: expected.size, mismatches };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["help", "plan-only"],
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
  const originalsBucket = assertBucketName(requireArg(args, "originals-bucket"));
  assertEqual("Originals bucket", originalsBucket, requireArg(args, "confirm-originals-bucket"));
  const derivativesBucket = assertBucketName(requireArg(args, "derivatives-bucket"));
  assertEqual(
    "Derivatives bucket",
    derivativesBucket,
    requireArg(args, "confirm-derivatives-bucket"),
  );
  const backupsBucket = assertBucketName(requireArg(args, "backups-bucket"));
  assertEqual("Backups bucket", backupsBucket, requireArg(args, "confirm-backups-bucket"));
  if (new Set([originalsBucket, derivativesBucket, backupsBucket]).size !== 3) {
    throw new Error("Original, derivative, and backup buckets must be distinct.");
  }
  const outputFile = resolve(requireArg(args, "output-file"));
  if (!outputFile.toLowerCase().endsWith(".json"))
    throw new Error("--output-file must end in .json.");
  const concurrency = args.concurrency ? Number(args.concurrency) : 10;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 25)
    throw new Error("--concurrency must be between 1 and 25.");
  const transientMinutes = args["transient-minutes"] ? Number(args["transient-minutes"]) : 60;
  if (!Number.isSafeInteger(transientMinutes) || transientMinutes < 5 || transientMinutes > 1440) {
    throw new Error("--transient-minutes must be between 5 and 1440.");
  }

  const plan = {
    environment,
    databaseName,
    databaseId,
    buckets: {
      originals: originalsBucket,
      derivatives: derivativesBucket,
      backups: backupsBucket,
    },
    concurrency,
    transientMinutes,
    outputFile,
    access: "D1 SELECT plus R2 LIST/HEAD only; no evidence body downloads",
  };
  if (args["plan-only"]) {
    console.log(JSON.stringify({ mode: "plan-only", ...plan }, null, 2));
    return;
  }

  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  await verifyD1Target({ accountId, token, databaseId, databaseName });
  const assets = await readAssets({ accountId, token, databaseId });
  const { expected, transientKeys, mismatches, warnings } = buildExpectations(
    assets,
    transientMinutes,
  );
  const r2 = { accountId, accessKeyId, secretAccessKey };
  const roles = await Promise.all([
    inspectRole({
      role: "originals",
      bucket: originalsBucket,
      prefix: "originals/",
      expected: expected.originals,
      transientKeys: transientKeys.originals,
      r2,
      concurrency,
    }),
    inspectRole({
      role: "derivatives",
      bucket: derivativesBucket,
      prefix: "derivatives/",
      expected: expected.derivatives,
      transientKeys: transientKeys.derivatives,
      r2,
      concurrency,
    }),
    inspectRole({
      role: "backups",
      bucket: backupsBucket,
      prefix: "evidence-originals/",
      expected: expected.backups,
      transientKeys: transientKeys.backups,
      r2,
      concurrency,
    }),
  ]);
  for (const role of roles) mismatches.push(...role.mismatches);
  mismatches.sort((left, right) =>
    `${left.bucketRole}:${left.assetId ?? ""}:${left.code}`.localeCompare(
      `${right.bucketRole}:${right.assetId ?? ""}:${right.code}`,
    ),
  );
  const report = {
    schema: "scam-reports.evidence-inventory/v1",
    generatedAt: new Date().toISOString(),
    environment,
    databaseName,
    databaseId,
    access: "R2 metadata only; no evidence object bodies downloaded",
    summary: {
      assetsInD1: assets.length,
      originals: { expected: roles[0].expected, listed: roles[0].listed },
      derivatives: { expected: roles[1].expected, listed: roles[1].listed },
      backups: { expected: roles[2].expected, listed: roles[2].listed },
      mismatchCount: mismatches.length,
      warningCount: warnings.length,
      status: mismatches.length ? "failed" : "ok",
    },
    mismatches,
    warnings,
  };
  await writeJsonExclusive(outputFile, report);
  console.log(
    JSON.stringify(
      {
        status: report.summary.status,
        ...report.summary,
        outputFile: basename(outputFile),
      },
      null,
      2,
    ),
  );
  if (mismatches.length) process.exitCode = 2;
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : "Unexpected evidence inventory failure."),
);
