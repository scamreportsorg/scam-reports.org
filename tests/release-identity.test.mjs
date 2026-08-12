import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const releaseTagScript = fileURLToPath(
  new URL("../scripts/check-release-tags.mjs", import.meta.url),
);
const releaseCheckScript = fileURLToPath(new URL("../scripts/release-check.mjs", import.meta.url));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function createReleaseHistory(t) {
  const directory = await mkdtemp(join(tmpdir(), "scam-reports-release-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const manifest = {
    name: "release-history-fixture",
    version: "0.1.1",
    private: true,
  };
  const lockfile = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: manifest.name, version: manifest.version } },
  };
  await Promise.all([
    writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(directory, "package-lock.json"), `${JSON.stringify(lockfile, null, 2)}\n`),
  ]);
  git(directory, "init", "--quiet");
  git(directory, "config", "user.name", "Release Test");
  git(directory, "config", "user.email", "release-test@example.test");
  git(directory, "config", "core.autocrlf", "false");
  git(directory, "add", "package.json", "package-lock.json");
  git(directory, "commit", "--quiet", "-m", "Initial public source");
  return directory;
}

function annotatedTag(directory, tag) {
  git(directory, "tag", "--annotate", tag, "--message", `Release ${tag}`);
}

async function createReleaseGateFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "scam-reports-release-gate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const manifest = {
    name: "release-gate-fixture",
    version: "0.1.1",
    private: true,
  };
  const lockfile = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: manifest.name, version: manifest.version } },
  };
  await mkdir(join(directory, "scripts"));
  await Promise.all([
    copyFile(releaseCheckScript, join(directory, "scripts", "release-check.mjs")),
    writeFile(join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(join(directory, "package-lock.json"), `${JSON.stringify(lockfile, null, 2)}\n`),
    writeFile(join(directory, "tracked.txt"), "tracked\n"),
    writeFile(join(directory, "unstaged.txt"), "unstaged\n"),
  ]);
  git(directory, "init", "--quiet");
  git(directory, "config", "user.name", "Release Test");
  git(directory, "config", "user.email", "release-test@example.test");
  git(directory, "config", "core.autocrlf", "false");
  git(directory, "add", "--all");
  git(directory, "commit", "--quiet", "-m", "Initial public source");
  return directory;
}

function runReleaseGate(directory, args = [], environment = {}) {
  return spawnSync(process.execPath, ["scripts/release-check.mjs", ...args], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_execpath: process.execPath,
      ...environment,
    },
  });
}

function protectedReleaseEnvironment(directory) {
  return {
    RELEASE_TAG: "v0.1.1",
    PUBLIC_RELEASE_VERSION: "v0.1.1",
    PUBLIC_SOURCE_COMMIT: git(directory, "rev-parse", "HEAD").trim(),
    PUBLIC_BUILD_TIME: "2026-08-12T00:00:00Z",
    PUBLIC_SOURCE_AVAILABLE: "true",
    PRODUCTION_D1_DATABASE_ID: "22222222-2222-4222-8222-222222222223",
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0xReleaseIdentityTestSiteKey123456789",
  };
}

test("release candidates match the package identity", async () => {
  const [manifestText, lockfileText, workflow] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release-candidate.yml", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const lockfile = JSON.parse(lockfileText);

  assert.match(manifest.version, /^\d+\.\d+\.\d+$/u);
  assert.equal(lockfile.version, manifest.version);
  assert.equal(lockfile.packages[""].version, manifest.version);
  assert.match(workflow, /check-release-tags\.mjs --tag "\$RELEASE_TAG"/u);
  assert.ok(
    workflow.indexOf("Verify package and release identity") <
      workflow.indexOf("Install locked dependencies"),
  );
});

test("release check accepts a matching annotated tag", async (t) => {
  const directory = await createReleaseHistory(t);
  annotatedTag(directory, "v0.1.1");

  const output = execFileSync(process.execPath, [releaseTagScript, "--tag", "v0.1.1"], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.match(output, /Release-tag verification passed for 1 tag\(s\)/u);
});

test("release check validates every tag", async (t) => {
  const directory = await createReleaseHistory(t);
  annotatedTag(directory, "v0.1.1");
  annotatedTag(directory, "v0.1.9");

  const result = spawnSync(process.execPath, [releaseTagScript], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /v0\.1\.9 points to package version 0\.1\.1/u);
});

test("CI and releases use the same gate", async () => {
  const [manifestText, ci, candidate, releaseCheck] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/release-candidate.yml", import.meta.url), "utf8"),
    readFile(new URL("../scripts/release-check.mjs", import.meta.url), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.scripts["release:check"], "node scripts/release-check.mjs");
  assert.match(ci, /fetch-depth: 0/u);
  assert.match(ci, /npm run release:check -- --skip-e2e/u);
  assert.match(candidate, /npm run release:check -- --require-release-env --with-github-metadata/u);
  assert.equal((candidate.match(/npm run build:production/gu) ?? []).length, 0);
  assert.ok(releaseCheck.indexOf('"test:e2e"') < releaseCheck.indexOf('"build:production"'));
  assert.doesNotMatch(releaseCheck, /"test:e2e:run"/u);
  assert.match(releaseCheck, /check-dco\.mjs", "--all"/u);
  assert.match(releaseCheck, /"diff-tree",\s*"--check",\s*"--root"/u);
  assert.match(releaseCheck, /"diff", "--cached", "--check"/u);
  assert.match(releaseCheck, /"status", "--porcelain=v1", "--untracked-files=all"/u);
  assert.match(releaseCheck, /"drizzle-kit",\s*"check"/u);
  assert.match(releaseCheck, /--strict-history-identifiers/u);
  assert.match(releaseCheck, /Protected release builds refuse local environment file/u);
  assert.match(releaseCheck, /Protected release candidates require PUBLIC_SOURCE_AVAILABLE=true/u);
});

test("staged whitespace fails the release gate", async (t) => {
  const directory = await createReleaseGateFixture(t);
  await writeFile(join(directory, "tracked.txt"), "staged trailing whitespace   \n");
  git(directory, "add", "tracked.txt");

  assert.equal(git(directory, "diff", "--name-only").trim(), "");
  assert.equal(git(directory, "diff", "--cached", "--name-only").trim(), "tracked.txt");

  const result = runReleaseGate(directory);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /==> Check staged patch whitespace/u);
  assert.doesNotMatch(result.stdout, /==> Check unstaged patch whitespace/u);
});

test("protected releases reject tracked changes", async (t) => {
  const directory = await createReleaseGateFixture(t);
  await writeFile(join(directory, "tracked.txt"), "changed but whitespace-clean\n");

  const result = runReleaseGate(
    directory,
    ["--require-release-env"],
    protectedReleaseEnvironment(directory),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Protected release candidates require a clean Git worktree/u);
  assert.doesNotMatch(
    result.stdout,
    /==> Check committed whitespace|==> Build production artifact/u,
  );
});

test("protected releases reject untracked files", async (t) => {
  const directory = await createReleaseGateFixture(t);
  await writeFile(join(directory, "untracked.txt"), "untracked but whitespace-clean\n");

  const result = runReleaseGate(
    directory,
    ["--require-release-env"],
    protectedReleaseEnvironment(directory),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Protected release candidates require a clean Git worktree/u);
  assert.doesNotMatch(
    result.stdout,
    /==> Check committed whitespace|==> Build production artifact/u,
  );
});

test("unprotected CI allows clean local changes", async (t) => {
  const directory = await createReleaseGateFixture(t);
  await writeFile(join(directory, "tracked.txt"), "staged and whitespace-clean\n");
  git(directory, "add", "tracked.txt");
  await writeFile(join(directory, "unstaged.txt"), "unstaged and whitespace-clean\n");
  await writeFile(join(directory, "untracked.txt"), "untracked and whitespace-clean\n");

  const result = runReleaseGate(directory);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /Protected release candidates require a clean Git worktree/u);
  assert.match(result.stdout, /==> Check staged patch whitespace/u);
  assert.match(result.stdout, /==> Check unstaged patch whitespace/u);
  assert.match(result.stdout, /==> Check historical release identity/u);
});

test("protected builds reject private-source artifacts", () => {
  const headCommit = git(repositoryRoot, "rev-parse", "HEAD").trim();
  const result = spawnSync(
    process.execPath,
    ["scripts/release-check.mjs", "--require-release-env"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_execpath: process.execPath,
        RELEASE_TAG: "v0.2.10",
        PUBLIC_RELEASE_VERSION: "v0.2.10",
        PUBLIC_SOURCE_COMMIT: headCommit,
        PUBLIC_BUILD_TIME: "2026-08-11T20:00:00Z",
        PUBLIC_SOURCE_AVAILABLE: "false",
        PRODUCTION_D1_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
        NEXT_PUBLIC_TURNSTILE_SITE_KEY: "0xReleaseIdentityTestSiteKey123456789",
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Protected release candidates require PUBLIC_SOURCE_AVAILABLE=true/u);
});

test("smoke and cutover require public source", async () => {
  const [smokeWorkflow, cutoverWorkflow] = await Promise.all([
    readFile(new URL("../.github/workflows/deploy-production.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/cutover-production.yml", import.meta.url), "utf8"),
  ]);

  assert.match(smokeWorkflow, /config\.vars\.PUBLIC_SOURCE_AVAILABLE !== "true"/u);
  assert.match(
    cutoverWorkflow,
    /smoke\.vars\.PUBLIC_SOURCE_AVAILABLE !== "true" \|\| config\.vars\.PUBLIC_SOURCE_AVAILABLE !== "true"/u,
  );
});

test("metadata audit self-test does not echo values", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/audit-github-metadata.mjs", "--self-test"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  assert.match(output, /self-test passed without printing inspected values/u);
  assert.doesNotMatch(output, /Codex Security review completed|RESEND_API_KEY|prod_/u);
});

test("metadata audit is read-only and host-restricted", async () => {
  const source = await readFile(
    new URL("../scripts/audit-github-metadata.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /method: "GET"/u);
  assert.match(source, /apiUrl\.hostname !== "api\.github\.com"/u);
  assert.doesNotMatch(source, /method: "(?:POST|PUT|PATCH|DELETE)"/u);
});

test("CodeQL can read its workflow run", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/codeql.yml", import.meta.url),
    "utf8",
  );
  const jobPermissions = workflow.slice(workflow.indexOf("jobs:"), workflow.indexOf("steps:"));

  assert.match(jobPermissions, /actions: read/u);
  assert.match(jobPermissions, /contents: read/u);
  assert.match(jobPermissions, /security-events: write/u);
  assert.match(workflow, /if: github\.event\.repository\.private == false/u);
  assert.match(workflow, /workflow_dispatch:/u);
});

test("private repos skip unsupported security jobs", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

  assert.match(
    workflow,
    /if: github\.event_name == 'pull_request' && github\.event\.repository\.private == false/u,
  );
});
