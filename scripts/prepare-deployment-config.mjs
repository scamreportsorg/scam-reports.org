#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parseArgs, requireArg } from "./operator-common.mjs";

const HELP = `Usage:
  node scripts/prepare-deployment-config.mjs --source <generated wrangler.json> --target <staging|production>

The matching STAGING_D1_DATABASE_ID or PRODUCTION_D1_DATABASE_ID must be in the
process environment. The generated configuration must already contain the
public Turnstile site key, source commit, version, and build time. Production
creates two configs beside the source: a bearer-gated workers.dev smoke target
and the explicit apex/www cutover target. No application bundle is rebuilt.`;

function requiredString(value, label) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /^(?:development|unreleased|replace|placeholder|not-set)$/iu.test(value)
  ) {
    throw new Error(`${label} is missing or still a placeholder.`);
  }
  return value;
}

function assertDatabaseId(value) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value ?? "")
  ) {
    throw new Error("Protected deployment configuration does not contain a valid D1 database ID.");
  }
  if (/^0{8}-0{4}-[0-9a-f]{4}-[0-9a-f]{4}-0{12}$/iu.test(value)) {
    throw new Error(
      "Protected deployment configuration still contains a placeholder D1 database ID.",
    );
  }
  return value;
}

function expectedEnvironment(target) {
  return target === "production"
    ? {
        name: "scam-reports-org",
        appOrigin: "https://scam-reports.org",
        databaseName: "scam-reports-production",
        resourcePrefix: "scam-reports-production",
      }
    : {
        name: "scam-reports-staging",
        appOrigin: "https://staging.scam-reports.org",
        databaseName: "scam-reports-staging",
        resourcePrefix: "scam-reports-staging",
      };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["help"] });
  if (args.help) {
    console.log(HELP);
    return;
  }
  const source = resolve(requireArg(args, "source"));
  const target = requireArg(args, "target");
  if (target !== "staging" && target !== "production")
    throw new Error("--target must be staging or production.");
  const config = JSON.parse(await readFile(source, "utf8"));
  const expected = expectedEnvironment(target);
  delete config.configPath;
  delete config.userConfigPath;
  const protectedDatabaseId = assertDatabaseId(
    process.env[target === "production" ? "PRODUCTION_D1_DATABASE_ID" : "STAGING_D1_DATABASE_ID"],
  );
  if (config.name !== expected.name)
    throw new Error(`Generated Worker name is not ${expected.name}.`);
  if (config.vars?.AUTH_APP_ORIGIN !== expected.appOrigin)
    throw new Error("Generated authentication origin does not match the deployment target.");
  const sourceCommit = requiredString(config.vars?.PUBLIC_SOURCE_COMMIT, "PUBLIC_SOURCE_COMMIT");
  if (!/^[0-9a-f]{40}$/iu.test(sourceCommit))
    throw new Error("PUBLIC_SOURCE_COMMIT must be a full Git SHA.");
  const releaseVersion = requiredString(
    config.vars?.PUBLIC_RELEASE_VERSION,
    "PUBLIC_RELEASE_VERSION",
  );
  if (target === "production" && !/^v\d+\.\d+\.\d+$/u.test(releaseVersion))
    throw new Error("Production release version must be a vMAJOR.MINOR.PATCH tag.");
  if (target === "staging" && !/^[0-9A-Za-z][0-9A-Za-z.+-]{2,79}$/u.test(releaseVersion))
    throw new Error("Staging release version is invalid.");
  const buildTime = requiredString(config.vars?.PUBLIC_BUILD_TIME, "PUBLIC_BUILD_TIME");
  if (!Number.isFinite(Date.parse(buildTime)))
    throw new Error("PUBLIC_BUILD_TIME is not an ISO timestamp.");
  const turnstileSiteKey = requiredString(
    config.vars?.PUBLIC_TURNSTILE_SITE_KEY,
    "PUBLIC_TURNSTILE_SITE_KEY",
  );
  if (turnstileSiteKey.length < 20)
    throw new Error("PUBLIC_TURNSTILE_SITE_KEY is too short to be a configured site key.");
  const migrations = (await readdir(resolve("drizzle")))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (
    !migrations.length ||
    migrations.some((name, index) => Number.parseInt(name.slice(0, 4), 10) !== index)
  ) {
    throw new Error("Numbered deployment migrations are empty or non-contiguous.");
  }
  if (config.vars?.PUBLIC_SCHEMA_VERSION !== String(migrations.length)) {
    throw new Error("PUBLIC_SCHEMA_VERSION does not match the immutable migration set.");
  }
  const databaseBindings = config.d1_databases?.filter((binding) => binding.binding === "DB") ?? [];
  if (databaseBindings.length !== 1)
    throw new Error("Generated configuration must contain exactly one DB binding.");
  const database = databaseBindings[0];
  if (database.database_name !== expected.databaseName)
    throw new Error("Generated DB binding name does not match the deployment target.");
  database.database_id = protectedDatabaseId;
  database.migrations_dir = "../../drizzle";
  const expectedBuckets = new Map([
    ["EVIDENCE_ORIGINALS", `${expected.resourcePrefix}-originals`],
    ["EVIDENCE_DERIVATIVES", `${expected.resourcePrefix}-derivatives`],
    ["BACKUPS", `${expected.resourcePrefix}-backups`],
  ]);
  if (!Array.isArray(config.r2_buckets) || config.r2_buckets.length !== expectedBuckets.size) {
    throw new Error("Generated configuration must contain exactly the protected R2 bindings.");
  }
  for (const bucket of config.r2_buckets) {
    if (expectedBuckets.get(bucket.binding) !== bucket.bucket_name) {
      throw new Error("Generated R2 binding does not match the deployment target.");
    }
    expectedBuckets.delete(bucket.binding);
  }
  if (
    expectedBuckets.size ||
    config.images?.binding !== "IMAGES" ||
    config.images?.remote !== true
  ) {
    throw new Error("Generated Images/R2 resources do not match the deployment target.");
  }
  const workflow =
    Array.isArray(config.workflows) && config.workflows.length === 1 ? config.workflows[0] : null;
  if (
    workflow?.binding !== "BACKUP_WORKFLOW" ||
    workflow.name !== `${expected.resourcePrefix}-backup` ||
    workflow.class_name !== "D1BackupWorkflow"
  ) {
    throw new Error("Generated backup Workflow binding does not match the deployment target.");
  }
  const crons = new Set(config.triggers?.crons ?? []);
  if (
    crons.size !== 3 ||
    !crons.has("* * * * *") ||
    !crons.has("*/5 * * * *") ||
    !crons.has("17 3 * * SUN")
  ) {
    throw new Error("Generated integration, maintenance, and backup schedules are incomplete.");
  }
  await writeFile(source, `${JSON.stringify(config)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  if (target === "staging") {
    if (
      !Array.isArray(config.routes) ||
      !config.routes.some((route) => route.pattern === "staging.scam-reports.org")
    ) {
      throw new Error("Generated staging config is missing its protected custom domain.");
    }
    console.log(JSON.stringify({ status: "verified", target, config: basename(source) }));
    return;
  }

  const routePatterns = new Set((config.routes ?? []).map((route) => route.pattern));
  if (
    !routePatterns.has("scam-reports.org") ||
    !routePatterns.has("www.scam-reports.org") ||
    routePatterns.size !== 2
  ) {
    throw new Error(
      "Generated production config does not contain exactly the apex and www cutover routes.",
    );
  }
  if (config.workers_dev !== false)
    throw new Error("Production cutover config must disable workers.dev.");

  const cutover = structuredClone(config);
  const smoke = structuredClone(config);
  smoke.name = "scam-reports-org-smoke";
  smoke.workers_dev = true;
  smoke.preview_urls = false;
  smoke.routes = [];
  delete smoke.triggers;
  delete smoke.workflows;
  smoke.vars = {
    ...smoke.vars,
    ENVIRONMENT: "staging",
    PUBLIC_DEPLOYMENT_CHANNEL: "production-smoke",
  };
  cutover.vars = {
    ...cutover.vars,
    PUBLIC_DEPLOYMENT_CHANNEL: "production",
  };

  const directory = dirname(source);
  const smokePath = resolve(directory, "wrangler.production-smoke.json");
  const cutoverPath = resolve(directory, "wrangler.production-cutover.json");
  await writeFile(smokePath, `${JSON.stringify(smoke)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(cutoverPath, `${JSON.stringify(cutover)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      status: "prepared",
      target,
      smokeConfig: basename(smokePath),
      cutoverConfig: basename(cutoverPath),
    }),
  );
}

main().catch((error) => {
  console.error(
    `prepare-deployment-config: ${error instanceof Error ? error.message : "unexpected failure"}`,
  );
  process.exitCode = 1;
});
