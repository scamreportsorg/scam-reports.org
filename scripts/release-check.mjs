#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const allowedArguments = new Set(["--skip-e2e", "--require-release-env", "--with-github-metadata"]);
for (const argument of process.argv.slice(2)) {
  if (!allowedArguments.has(argument)) {
    console.error(`Unknown release-check option: ${argument}`);
    process.exit(2);
  }
}

const skipE2e = process.argv.includes("--skip-e2e");
const requireReleaseEnvironment = process.argv.includes("--require-release-env");
const withGitHubMetadata = process.argv.includes("--with-github-metadata");
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("Run this gate through npm run release:check so the locked npm CLI is known.");
  process.exit(2);
}

function run(label, command, args, options = {}) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error || result.status !== 0) {
    if (options.quiet) console.error(`${label} failed; output was withheld from logs.`);
    else if (result.error) console.error(`${label} could not start.`);
    process.exit(result.status || 1);
  }
}

function runNpm(label, args, options = {}) {
  run(label, process.execPath, [npmCli, ...args], options);
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw new Error("Unable to read Git release identity.");
  return result.stdout.trim();
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing protected release value: ${name}.`);
  return value;
}

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));
if (
  !/^\d+\.\d+\.\d+$/u.test(manifest.version ?? "") ||
  lockfile.version !== manifest.version ||
  lockfile.packages?.[""]?.version !== manifest.version
) {
  throw new Error("package.json and package-lock.json release identities do not agree.");
}

const headCommit = output("git", ["rev-parse", "HEAD"]);
let releaseTag = process.env.RELEASE_TAG?.trim();
const releaseEnvironment = { ...process.env };

if (requireReleaseEnvironment) {
  releaseTag = required("RELEASE_TAG");
  const releaseVersion = required("PUBLIC_RELEASE_VERSION");
  const sourceCommit = required("PUBLIC_SOURCE_COMMIT");
  const buildTime = required("PUBLIC_BUILD_TIME");
  const sourceAvailable = required("PUBLIC_SOURCE_AVAILABLE");
  const databaseId = required("PRODUCTION_D1_DATABASE_ID");
  const turnstileSiteKey = required("NEXT_PUBLIC_TURNSTILE_SITE_KEY");

  if (releaseTag !== `v${manifest.version}` || releaseVersion !== releaseTag) {
    throw new Error("Protected release tag, package version, and public version do not agree.");
  }
  if (sourceCommit !== headCommit || !/^[0-9a-f]{40}$/u.test(sourceCommit)) {
    throw new Error("Protected source commit does not match the checked-out commit.");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(buildTime) ||
    !Number.isFinite(Date.parse(buildTime))
  ) {
    throw new Error("PUBLIC_BUILD_TIME must be a UTC second-precision timestamp.");
  }
  if (sourceAvailable !== "true") {
    throw new Error(
      "Protected release candidates require PUBLIC_SOURCE_AVAILABLE=true after the public tag source archive has been verified.",
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      databaseId,
    ) ||
    /^(?:0{8}-0{4}-[0-9a-f]{4}-[0-9a-f]{4}-0{12}|1{8}-1{4}-[0-9a-f]{4}-[0-9a-f]{4}-1{12})$/iu.test(
      databaseId,
    )
  ) {
    throw new Error("PRODUCTION_D1_DATABASE_ID is invalid.");
  }
  if (!/^0x[A-Za-z0-9_-]{20,}$/u.test(turnstileSiteKey)) {
    throw new Error("NEXT_PUBLIC_TURNSTILE_SITE_KEY is not a production Turnstile site key.");
  }
  for (const file of [".env", ".env.local", ".env.production", ".env.production.local"]) {
    if (existsSync(file))
      throw new Error(`Protected release builds refuse local environment file ${file}.`);
  }
  if (output("git", ["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("Protected release candidates require a clean Git worktree.");
  }
  Object.assign(releaseEnvironment, {
    RELEASE_TAG: releaseTag,
    PUBLIC_RELEASE_VERSION: releaseVersion,
    PUBLIC_SOURCE_COMMIT: sourceCommit,
    PUBLIC_BUILD_TIME: buildTime,
    PUBLIC_SOURCE_AVAILABLE: sourceAvailable,
    PRODUCTION_D1_DATABASE_ID: databaseId,
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: turnstileSiteKey,
  });
} else {
  Object.assign(releaseEnvironment, {
    PRODUCTION_D1_DATABASE_ID:
      process.env.PRODUCTION_D1_DATABASE_ID ?? "11111111-1111-4111-8111-111111111111",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY:
      process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "release-check-only-site-key",
    PUBLIC_RELEASE_VERSION: process.env.PUBLIC_RELEASE_VERSION ?? `v${manifest.version}`,
    PUBLIC_SOURCE_COMMIT: process.env.PUBLIC_SOURCE_COMMIT ?? headCommit,
    PUBLIC_SOURCE_AVAILABLE: process.env.PUBLIC_SOURCE_AVAILABLE ?? "false",
    PUBLIC_BUILD_TIME: process.env.PUBLIC_BUILD_TIME ?? "2026-01-01T00:00:00Z",
  });
}

run("Check committed whitespace", "git", [
  "diff-tree",
  "--check",
  "--root",
  "-r",
  "-m",
  "--no-commit-id",
  "HEAD",
]);
run("Check staged patch whitespace", "git", ["diff", "--cached", "--check"]);
run("Check unstaged patch whitespace", "git", ["diff", "--check"]);
run("Check historical release identity", process.execPath, [
  "scripts/check-release-tags.mjs",
  ...(requireReleaseEnvironment ? ["--tag", releaseTag] : []),
]);
run("Check DCO across reachable history", process.execPath, ["scripts/check-dco.mjs", "--all"]);
runNpm("Audit production dependencies", ["audit", "--omit=dev", "--audit-level=high"]);
runNpm("Type check", ["run", "typecheck"]);
runNpm("Check migration metadata", ["exec", "--", "drizzle-kit", "check"]);
runNpm("Check formatting", ["run", "format:check"]);
runNpm("Lint", ["run", "lint"]);
run("Self-test publication audit", process.execPath, [
  "scripts/audit-publication.mjs",
  "--self-test",
]);
run("Audit publication boundary and history", process.execPath, [
  "scripts/audit-publication.mjs",
  "--history",
  ...(releaseEnvironment.PUBLIC_SOURCE_AVAILABLE === "true"
    ? ["--strict-history-identifiers"]
    : []),
]);
run("Check dependency licenses", process.execPath, ["scripts/check-licenses.mjs"]);

if (withGitHubMetadata) {
  run("Audit GitHub-hosted publication metadata", process.execPath, [
    "scripts/audit-github-metadata.mjs",
  ]);
}

if (!skipE2e) {
  runNpm("Build the isolated browser fixture and run the local browser suite", ["run", "test:e2e"]);
}

runNpm("Build production artifact", ["run", "build:production"], {
  env: releaseEnvironment,
});
runNpm("Run Node test suite", ["run", "test:node"], {
  env: releaseEnvironment,
});
run(
  "Prepare production deployment configs",
  process.execPath,
  [
    "scripts/prepare-deployment-config.mjs",
    "--source",
    "dist/server/wrangler.json",
    "--target",
    "production",
  ],
  { env: releaseEnvironment },
);

const smoke = JSON.parse(readFileSync("dist/server/wrangler.production-smoke.json", "utf8"));
const cutover = JSON.parse(readFileSync("dist/server/wrangler.production-cutover.json", "utf8"));
for (const config of [smoke, cutover]) {
  if (config.vars.PUBLIC_SOURCE_COMMIT !== releaseEnvironment.PUBLIC_SOURCE_COMMIT) {
    throw new Error("Generated source commit mismatch.");
  }
  if (config.vars.PUBLIC_RELEASE_VERSION !== releaseEnvironment.PUBLIC_RELEASE_VERSION) {
    throw new Error("Generated release version mismatch.");
  }
  if (config.vars.PUBLIC_SOURCE_AVAILABLE !== releaseEnvironment.PUBLIC_SOURCE_AVAILABLE) {
    throw new Error("Generated source-availability mismatch.");
  }
  if (config.vars.PUBLIC_TURNSTILE_SITE_KEY !== releaseEnvironment.NEXT_PUBLIC_TURNSTILE_SITE_KEY) {
    throw new Error("Generated Turnstile site key mismatch.");
  }
  const databases = config.d1_databases?.filter((item) => item.binding === "DB") ?? [];
  if (
    databases.length !== 1 ||
    databases[0].database_id !== releaseEnvironment.PRODUCTION_D1_DATABASE_ID ||
    databases[0].database_name !== "scam-reports-production"
  ) {
    throw new Error("Generated production D1 binding mismatch.");
  }
}
for (const binding of ["d1_databases", "r2_buckets", "images"]) {
  if (JSON.stringify(smoke[binding]) !== JSON.stringify(cutover[binding])) {
    throw new Error(`Smoke and cutover ${binding} differ.`);
  }
}

runNpm(
  "Dry-run smoke deployment",
  [
    "exec",
    "--",
    "wrangler",
    "deploy",
    "--dry-run",
    "--config",
    "dist/server/wrangler.production-smoke.json",
  ],
  { env: releaseEnvironment, quiet: true },
);
runNpm(
  "Dry-run cutover deployment",
  [
    "exec",
    "--",
    "wrangler",
    "deploy",
    "--dry-run",
    "--config",
    "dist/server/wrangler.production-cutover.json",
  ],
  { env: releaseEnvironment, quiet: true },
);

console.log(
  `\nRelease check passed${skipE2e ? " (browser suite runs in its own required job)" : ""}.`,
);
