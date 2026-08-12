import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { batchD1 } from "../scripts/operator-common.mjs";
import {
  assertPerformanceFixture,
  assertStagingConfig,
  PERFORMANCE_FIXTURE_SQL,
  PERFORMANCE_FIXTURE_VERIFICATION_SQL,
} from "../scripts/seed-staging-performance.mjs";
import { verifyReleaseAssets } from "../scripts/verify-release-assets.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const wranglerCli = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

function stagingConfig(databaseId = "11111111-1111-4111-8111-111111111111") {
  return {
    name: "scam-reports-staging",
    workers_dev: true,
    routes: [{ pattern: "staging.scam-reports.org", custom_domain: true }],
    vars: {
      ENVIRONMENT: "staging",
      APP_ENVIRONMENT: "staging",
      AUTH_RUNTIME_ENV: "staging",
      AUTH_APP_ORIGIN: "https://staging.scam-reports.org",
    },
    d1_databases: [
      { binding: "DB", database_name: "scam-reports-staging", database_id: databaseId },
    ],
  };
}

test("CI builds production without test credentials", async () => {
  const workflow = await readFile(join(repositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /NEXT_PUBLIC_TURNSTILE_SITE_KEY: "ci-validation-only-site-key"/u);
  assert.doesNotMatch(workflow, /NEXT_PUBLIC_TURNSTILE_SITE_KEY: ["']?[123]x0{20}/u);
  assert.match(workflow, /PUBLIC_SOURCE_COMMIT: "[0-9a-f]{40}"/u);
});

test("deployment accepts 0x keys and rejects zero IDs", async () => {
  const config = await readFile(join(repositoryRoot, "vite.config.ts"), "utf8");
  assert.match(config, /\^0\+\(\?:-0\+\)\*\$/u);
  assert.doesNotMatch(config, /0\+\[-0\]\*\)\/iu\.test/u);
});

test("backup cron uses Cloudflare Sunday syntax", async () => {
  const wrangler = await readFile(join(repositoryRoot, "wrangler.jsonc"), "utf8");
  const deploymentConfig = await readFile(
    join(repositoryRoot, "scripts", "prepare-deployment-config.mjs"),
    "utf8",
  );
  assert.match(wrangler, /17 3 \* \* SUN/u);
  assert.match(wrangler, /"\* \* \* \* \*"/u);
  assert.doesNotMatch(wrangler, /17 3 \* \* 0/u);
  assert.match(deploymentConfig, /17 3 \* \* SUN/u);
  assert.match(deploymentConfig, /crons\.has\("\* \* \* \* \*"\)/u);
});

test("Cloudflare API calls use public fetch", async () => {
  const wrangler = await readFile(join(repositoryRoot, "wrangler.jsonc"), "utf8");
  assert.match(
    wrangler,
    /"compatibility_flags":\s*\[[^\]]*"global_fetch_strictly_public"[^\]]*\]/u,
  );
});

test("D1 batch sends one transactional request", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return Response.json({
      success: true,
      result: [
        { success: true, meta: { changes: 1 }, results: [] },
        { success: true, meta: { changes: 1 }, results: [] },
      ],
    });
  };
  try {
    const result = await batchD1({
      accountId: "a".repeat(32),
      token: "test-cloudflare-token-placeholder",
      databaseId: "11111111-1111-4111-8111-111111111111",
      statements: [
        {
          sql: "UPDATE evidence_assets SET state = ? WHERE id = ?",
          params: ["withheld", "EVA-test"],
        },
        { sql: "INSERT INTO audit_logs (action) VALUES (?)", params: ["evidence.test"] },
      ],
    });
    assert.equal(result.length, 2);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/d1\/database\/11111111-1111-4111-8111-111111111111\/query$/u);
    assert.deepEqual(calls[0].body, {
      batch: [
        {
          sql: "UPDATE evidence_assets SET state = ? WHERE id = ?",
          params: ["withheld", "EVA-test"],
        },
        { sql: "INSERT INTO audit_logs (action) VALUES (?)", params: ["evidence.test"] },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("D1 batch rejects incomplete results", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      success: true,
      result: [{ success: true, meta: { changes: 1 }, results: [] }],
    });
  try {
    await assert.rejects(
      batchD1({
        accountId: "a".repeat(32),
        token: "test-cloudflare-token-placeholder",
        databaseId: "11111111-1111-4111-8111-111111111111",
        statements: [
          {
            sql: "UPDATE evidence_assets SET state = ? WHERE id = ?",
            params: ["withheld", "EVA-test"],
          },
          { sql: "INSERT INTO audit_logs (action) VALUES (?)", params: ["evidence.test"] },
        ],
      }),
      /did not complete every statement/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("release verification checks exact subjects", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scam-reports-release-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archiveName = "scam-reports-v1.2.3.tar.gz";
  const archive = Buffer.from("synthetic immutable archive");
  const sbom = Buffer.from('{"spdxVersion":"SPDX-2.3"}\n');
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  await Promise.all([
    writeFile(join(directory, archiveName), archive),
    writeFile(join(directory, "sbom.spdx.json"), sbom),
    writeFile(join(directory, "metadata.json"), "{}\n"),
    writeFile(
      join(directory, "SHA256SUMS"),
      `${digest(archive)}  ${archiveName}\n${digest(sbom)}  sbom.spdx.json\n`,
    ),
  ]);
  assert.equal((await verifyReleaseAssets(directory, "v1.2.3")).status, "verified");

  await writeFile(
    join(directory, "SHA256SUMS"),
    `${digest(archive)}  ../outside\n${digest(sbom)}  sbom.spdx.json\n`,
  );
  await assert.rejects(verifyReleaseAssets(directory, "v1.2.3"), /unexpected or duplicate/u);
});

test("performance seeder only accepts staging", () => {
  const result = spawnSync(
    process.execPath,
    [
      "scripts/seed-staging-performance.mjs",
      "--database",
      "scam-reports-production",
      "--config",
      "wrangler.jsonc",
    ],
    { cwd: new URL("..", import.meta.url), encoding: "utf8", shell: false },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be exactly scam-reports-staging/u);
});

test("performance seeder checks staging config and D1 ID", () => {
  const databaseId = "11111111-1111-4111-8111-111111111111";
  assert.equal(assertStagingConfig(stagingConfig(databaseId), databaseId).database_id, databaseId);
  assert.throws(
    () => assertStagingConfig(stagingConfig(databaseId), "22222222-2222-4222-8222-222222222222"),
    /protected staging-only/u,
  );
  assert.throws(
    () =>
      assertStagingConfig({ ...stagingConfig(databaseId), name: "scam-reports-org" }, databaseId),
    /protected staging-only/u,
  );
  assert.throws(
    () => assertStagingConfig({ ...stagingConfig(databaseId), workers_dev: false }, databaseId),
    /protected staging-only/u,
  );
  const placeholder = "00000000-0000-4000-8000-000000000000";
  assert.throws(
    () => assertStagingConfig(stagingConfig(placeholder), placeholder),
    /protected staging-only/u,
  );
});

test("performance fixture loads on a fresh D1", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scam-reports-performance-d1-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixturePath = join(directory, "fixture.sql");
  await writeFile(fixturePath, PERFORMANCE_FIXTURE_SQL, "utf8");
  const common = ["--config", "wrangler.jsonc", "--persist-to", directory];
  const migrate = spawnSync(
    process.execPath,
    [wranglerCli, "d1", "migrations", "apply", "scam-reports-local", "--local", ...common],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  assert.equal(migrate.status, 0, migrate.stderr || migrate.stdout);

  const started = performance.now();
  const load = spawnSync(
    process.execPath,
    [
      wranglerCli,
      "d1",
      "execute",
      "scam-reports-local",
      "--local",
      "--file",
      fixturePath,
      ...common,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const elapsedMs = performance.now() - started;
  assert.equal(load.status, 0, load.stderr || load.stdout);

  const reloadStarted = performance.now();
  const reload = spawnSync(
    process.execPath,
    [
      wranglerCli,
      "d1",
      "execute",
      "scam-reports-local",
      "--local",
      "--file",
      fixturePath,
      ...common,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  const reloadElapsedMs = performance.now() - reloadStarted;
  assert.equal(reload.status, 0, reload.stderr || reload.stdout);

  const verify = spawnSync(
    process.execPath,
    [
      wranglerCli,
      "d1",
      "execute",
      "scam-reports-local",
      "--local",
      "--command",
      PERFORMANCE_FIXTURE_VERIFICATION_SQL,
      "--json",
      ...common,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  assertPerformanceFixture(JSON.parse(verify.stdout));
  t.diagnostic(
    `Fresh local D1 fixture import: ${elapsedMs.toFixed(1)} ms; replacement import: ${reloadElapsedMs.toFixed(1)} ms`,
  );
});
