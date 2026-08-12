#!/usr/bin/env node

import { basename, resolve } from "node:path";
import {
  MAX_D1_EXPORT_BYTES,
  assertDatabaseName,
  assertEnvironment,
  assertEqual,
  assertUuid,
  cloudflareApi,
  downloadToExclusiveFile,
  parseArgs,
  requireArg,
  requireEnv,
  verifyD1Target,
  writeJsonExclusive,
} from "./operator-common.mjs";

const HELP = `Usage:
  node scripts/operator-d1-export.mjs [options]

Required:
  --environment <development|staging|production|restore-test>
  --confirm-environment <same value>
  --database-name <exact Cloudflare D1 name>
  --confirm-database-name <same value>
  --database-id <exact Cloudflare D1 UUID>
  --confirm-database-id <same UUID>
  --output-file <new .sql path>
  --manifest-file <new .json path>

Optional:
  --max-bytes <integer, default 1073741824>
  --plan-only   Validate and print the target without using credentials or writing files.
  --help

Credentials are read from CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.
Existing output files are never overwritten.`;

function fail(message) {
  console.error(`operator-d1-export: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["help", "plan-only"] });
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
  const outputFile = resolve(requireArg(args, "output-file"));
  const manifestFile = resolve(requireArg(args, "manifest-file"));
  if (!outputFile.toLowerCase().endsWith(".sql"))
    throw new Error("--output-file must end in .sql.");
  if (!manifestFile.toLowerCase().endsWith(".json"))
    throw new Error("--manifest-file must end in .json.");
  if (outputFile === manifestFile)
    throw new Error("Snapshot and manifest paths must be different.");
  const maxBytes = args["max-bytes"] ? Number(args["max-bytes"]) : MAX_D1_EXPORT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > MAX_D1_EXPORT_BYTES) {
    throw new Error(`--max-bytes must be an integer between 1024 and ${MAX_D1_EXPORT_BYTES}.`);
  }

  const plan = { environment, databaseName, databaseId, outputFile, manifestFile, maxBytes };
  if (args["plan-only"]) {
    console.log(JSON.stringify({ mode: "plan-only", ...plan }, null, 2));
    return;
  }

  const accountId = requireEnv("CLOUDFLARE_ACCOUNT_ID");
  const token = requireEnv("CLOUDFLARE_API_TOKEN");
  await verifyD1Target({ accountId, token, databaseId, databaseName });

  let state = await cloudflareApi(`/d1/database/${encodeURIComponent(databaseId)}/export`, {
    accountId,
    token,
    method: "POST",
    body: JSON.stringify({ output_format: "polling" }),
  });
  for (let attempt = 0; attempt < 60 && state?.status !== "complete"; attempt += 1) {
    if (state?.status === "error") throw new Error("Cloudflare D1 export reported an error.");
    if (!state?.at_bookmark) throw new Error("Cloudflare D1 export polling bookmark is missing.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
    state = await cloudflareApi(`/d1/database/${encodeURIComponent(databaseId)}/export`, {
      accountId,
      token,
      method: "POST",
      body: JSON.stringify({ output_format: "polling", current_bookmark: state.at_bookmark }),
    });
  }
  const signedUrl = state?.result?.signed_url;
  if (state?.status !== "complete" || typeof signedUrl !== "string") {
    throw new Error("Cloudflare D1 export did not complete within five minutes.");
  }
  const downloaded = await downloadToExclusiveFile(signedUrl, outputFile, maxBytes);
  const exportedAt = new Date().toISOString();
  const manifest = {
    schema: "scam-reports.d1-export-manifest/v1",
    environment,
    databaseName,
    databaseId,
    exportedAt,
    bookmark: state.at_bookmark ?? "",
    snapshot: {
      file: basename(downloaded.path),
      sha256: downloaded.sha256,
      size: downloaded.size,
    },
  };
  await writeJsonExclusive(manifestFile, manifest);
  console.log(
    JSON.stringify(
      {
        status: "complete",
        environment,
        databaseName,
        exportedAt,
        snapshot: {
          file: basename(downloaded.path),
          sha256: downloaded.sha256,
          size: downloaded.size,
        },
        manifestFile: basename(manifestFile),
      },
      null,
      2,
    ),
  );
}

main().catch((error) =>
  fail(error instanceof Error ? error.message : "Unexpected export failure."),
);
