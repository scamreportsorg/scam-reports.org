#!/usr/bin/env node

import { basename, resolve } from "node:path";
import {
  MAX_D1_EXPORT_BYTES,
  assertBucketName,
  assertDatabaseName,
  assertEnvironment,
  assertEqual,
  assertUuid,
  downloadResponseToExclusiveFile,
  headR2Object,
  listR2Objects,
  parseArgs,
  r2Request,
  requireArg,
  requireEnv,
  writeJsonExclusive,
} from "./operator-common.mjs";

const HELP = `Usage:
  node scripts/operator-r2-backup-download.mjs [options]

Required:
  --environment <staging|production>
  --confirm-environment <same value>
  --database-name <source D1 name>
  --confirm-database-name <same value>
  --database-id <source D1 UUID>
  --confirm-database-id <same UUID>
  --bucket <scheduled-backup R2 bucket>
  --confirm-bucket <same bucket>
  --backup-kind <weekly|monthly>
  --output-file <new .sql path>
  --manifest-file <new .json path>

Optional:
  --max-age-hours <integer, default 192>
  --max-bytes <integer, default 1073741824>

The newest strict scheduled-backup path is downloaded read-only. Its R2
sidecar manifest, object size, age, SHA-256, database ID, and environment must
all match before a D1 restore manifest is written. Credentials are read from
R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY.`;

function numberArg(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function backupKeyPattern(kind) {
  return new RegExp(`^d1/${kind}/\\d{4}-\\d{2}-\\d{2}-BKP-\\d{14}-[A-Za-z0-9_-]{1,32}\\.sql$`, "u");
}

async function readManifest(r2, key) {
  const response = await r2Request({ ...r2, key: `${key}.manifest.json`, method: "GET" });
  if (!response.ok) throw new Error(`Scheduled backup sidecar returned HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 64 * 1024)
    throw new Error("Scheduled backup sidecar is unexpectedly large.");
  if (!response.body) throw new Error("Scheduled backup sidecar returned no body.");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > 64 * 1024) throw new Error("Scheduled backup sidecar is unexpectedly large.");
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks, size).toString("utf8");
  return JSON.parse(text);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["help"] });
  if (args.help) {
    console.log(HELP);
    return;
  }
  const environment = assertEnvironment(requireArg(args, "environment"));
  if (environment !== "staging" && environment !== "production")
    throw new Error("Scheduled backup source must be staging or production.");
  assertEqual("Environment", environment, requireArg(args, "confirm-environment").toLowerCase());
  const databaseName = assertDatabaseName(requireArg(args, "database-name"));
  assertEqual("Database name", databaseName, requireArg(args, "confirm-database-name"));
  const databaseId = assertUuid(requireArg(args, "database-id"));
  assertEqual("Database ID", databaseId, requireArg(args, "confirm-database-id"));
  const bucket = assertBucketName(requireArg(args, "bucket"));
  assertEqual("Backup bucket", bucket, requireArg(args, "confirm-bucket"));
  const kind = requireArg(args, "backup-kind");
  if (kind !== "weekly" && kind !== "monthly")
    throw new Error("--backup-kind must be weekly or monthly.");
  const outputFile = resolve(requireArg(args, "output-file"));
  const manifestFile = resolve(requireArg(args, "manifest-file"));
  if (!outputFile.toLowerCase().endsWith(".sql"))
    throw new Error("--output-file must end in .sql.");
  if (!manifestFile.toLowerCase().endsWith(".json"))
    throw new Error("--manifest-file must end in .json.");
  const maxAgeHours = numberArg(args["max-age-hours"] ?? "192", "--max-age-hours", 1, 744);
  const maxBytes = numberArg(
    args["max-bytes"] ?? String(MAX_D1_EXPORT_BYTES),
    "--max-bytes",
    1024,
    MAX_D1_EXPORT_BYTES,
  );
  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const accessKeyId = requireEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = requireEnv("R2_SECRET_ACCESS_KEY");
  const r2 = { accountId, accessKeyId, secretAccessKey, bucket };

  const prefix = `d1/${kind}/`;
  const pattern = backupKeyPattern(kind);
  const listed = await listR2Objects(r2, prefix);
  const candidates = listed
    .filter((item) => pattern.test(item.key))
    .sort((left, right) => right.key.localeCompare(left.key));
  if (!candidates.length)
    throw new Error(`No valid scheduled ${kind} D1 backup path exists in the confirmed bucket.`);
  const selected = candidates[0];
  const object = await headR2Object(r2, selected.key);
  if (!object) throw new Error("Selected scheduled backup disappeared before verification.");
  const uploadedAt = new Date(object.uploadedAt);
  if (!Number.isFinite(uploadedAt.getTime()))
    throw new Error("Scheduled backup has no valid R2 Last-Modified timestamp.");
  const ageMs = Date.now() - uploadedAt.getTime();
  if (ageMs < -5 * 60 * 1000 || ageMs > maxAgeHours * 60 * 60 * 1000) {
    throw new Error(`Newest scheduled backup is outside the ${maxAgeHours}-hour freshness window.`);
  }
  if (object.size !== selected.size || object.size > maxBytes)
    throw new Error("Scheduled backup object size is invalid or exceeds the safety bound.");

  const sidecar = await readManifest(r2, selected.key);
  if (sidecar?.schema !== "scam-reports.r2-d1-backup/v1")
    throw new Error("Scheduled backup sidecar schema is unsupported.");
  if (
    sidecar.environment !== environment ||
    sidecar.databaseId !== databaseId ||
    sidecar.kind !== kind ||
    sidecar.key !== selected.key
  ) {
    throw new Error("Scheduled backup sidecar does not match the explicitly confirmed source.");
  }
  if (!/^[0-9a-f]{64}$/u.test(sidecar.sha256 ?? "") || sidecar.size !== object.size) {
    throw new Error("Scheduled backup sidecar checksum or size is invalid.");
  }
  const runId = selected.key.slice(prefix.length + 11, -".sql".length);
  if (
    sidecar.runId !== runId ||
    object.metadata.runid !== runId ||
    object.metadata.bookmark !== sidecar.bookmark
  ) {
    throw new Error("Scheduled backup object metadata does not match its sidecar identity.");
  }
  const createdAt = new Date(sidecar.createdAt ?? "");
  if (!sidecar.bookmark || !Number.isFinite(createdAt.getTime())) {
    throw new Error("Scheduled backup sidecar has no valid export bookmark or creation time.");
  }
  const keyDate = selected.key.slice(prefix.length, prefix.length + 10);
  const uploadDelayMs = uploadedAt.getTime() - createdAt.getTime();
  if (
    createdAt.toISOString().slice(0, 10) !== keyDate ||
    uploadDelayMs < -5 * 60 * 1000 ||
    uploadDelayMs > 6 * 60 * 60 * 1000
  ) {
    throw new Error("Scheduled backup key, creation time, and R2 upload time are inconsistent.");
  }

  const response = await r2Request({
    ...r2,
    key: selected.key,
    method: "GET",
    timeoutMs: 10 * 60_000,
  });
  const downloaded = await downloadResponseToExclusiveFile(
    response,
    outputFile,
    maxBytes,
    "Scheduled R2 backup",
  );
  if (downloaded.sha256 !== sidecar.sha256 || downloaded.size !== sidecar.size) {
    throw new Error("Scheduled R2 backup bytes do not match the signed-request sidecar manifest.");
  }
  const restoreManifest = {
    schema: "scam-reports.d1-export-manifest/v1",
    environment,
    databaseName,
    databaseId,
    exportedAt: createdAt.toISOString(),
    bookmark: sidecar.bookmark ?? "",
    backup: {
      kind,
      objectKey: selected.key,
      uploadedAt: uploadedAt.toISOString(),
      runId: sidecar.runId ?? "",
      sidecarSchema: sidecar.schema,
    },
    snapshot: {
      file: basename(downloaded.path),
      sha256: downloaded.sha256,
      size: downloaded.size,
    },
  };
  await writeJsonExclusive(manifestFile, restoreManifest);
  console.log(
    JSON.stringify(
      {
        status: "downloaded-and-verified",
        environment,
        kind,
        objectKey: selected.key,
        uploadedAt: uploadedAt.toISOString(),
        snapshot: restoreManifest.snapshot,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    `operator-r2-backup-download: ${error instanceof Error ? error.message : "unexpected failure"}`,
  );
  process.exitCode = 1;
});
