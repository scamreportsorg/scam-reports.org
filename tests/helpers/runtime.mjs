import { createCipheriv, createHash, createHmac } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

export const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
export const serverRoot = path.join(projectRoot, "dist", "server");
export const migrationsRoot = path.join(projectRoot, "drizzle");

export const MIGRATION_FILES = [
  "0000_chilly_sleepwalker.sql",
  "0001_blue_doctor_doom.sql",
  "0002_eminent_anthem.sql",
  "0003_happy_johnny_blaze.sql",
  "0004_flowery_bishop.sql",
  "0005_lean_zombie.sql",
  "0006_report_family_metrics.sql",
  "0007_restore_legacy_integrity.sql",
  "0008_evidence_privacy_replacements.sql",
  "0009_authoritative_status_history.sql",
  "0010_session_bound_step_up.sql",
  "0011_evidence_deletion_lease.sql",
  "0012_fast_report_family_metrics.sql",
  "0013_moderator_applications.sql",
  "0014_public_member_activity.sql",
  "0015_report_merge_integrity.sql",
  "0016_discord_rank_sync.sql",
  "0017_discord_status_delivery.sql",
  "0018_discord_orphan_retention.sql",
  "0019_security_attack_monitor.sql",
  "0020_security_monitor_diagnostics.sql",
  "0021_magic_login_browser_context.sql",
];

export const TURNSTILE_BYPASS = "test-turnstile-bypass-placeholder";
const identityEncryptionFixture = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export const TEST_BINDINGS = Object.freeze({
  APP_ENVIRONMENT: "test",
  AUTH_RUNTIME_ENV: "test",
  AUTH_APP_ORIGIN: "http://localhost",
  IDENTITY_HASH_KEY: "test-identity-hash-key-placeholder-32-bytes",
  IDENTITY_ENCRYPTION_KEY: identityEncryptionFixture,
  INTAKE_PEPPER: "test-intake-pepper-with-at-least-32-bytes",
  DISCORD_CLIENT_ID: "test-discord-client-id",
  DISCORD_CLIENT_SECRET: "test-discord-client-secret-placeholder-32-chars",
  RESEND_API_KEY: "test-resend-api-key-placeholder-32-characters",
  RESEND_FROM: "Scam Reports Test <login@test.invalid>",
  TURNSTILE_TEST_BYPASS_TOKEN: TURNSTILE_BYPASS,
  EVIDENCE_TEST_SANITIZER: "unsafe-copy",
  PUBLIC_SOURCE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
  PUBLIC_SOURCE_URL: "https://github.com/scamreportsorg/scam-reports.org",
  PUBLIC_SOURCE_AVAILABLE: "false",
  PUBLIC_RELEASE_VERSION: "0.1.0-test",
  PUBLIC_BUILD_TIME: "2026-08-09T00:00:00.000Z",
});

let cachedWorkerModules;

export function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

export function identitySubjectHashForFixture(provider, subject) {
  return createHmac("sha256", TEST_BINDINGS.IDENTITY_HASH_KEY)
    .update(`${provider}:${subject}`)
    .digest("base64url");
}

export function encryptIdentityForFixture(value, nonce = value) {
  const key = Buffer.from(TEST_BINDINGS.IDENTITY_ENCRYPTION_KEY, "base64url");
  const iv = createHash("sha256").update(`fixture:${nonce}`).digest().subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${Buffer.concat([encrypted, cipher.getAuthTag()]).toString(
    "base64url",
  )}`;
}

function defaultProviderSubject(accountId, provider) {
  if (provider === "discord") {
    const suffix = BigInt(`0x${createHash("sha256").update(accountId).digest("hex").slice(0, 12)}`);
    return String(900_000_000_000_000_000n + suffix);
  }
  return `${accountId.toLowerCase().replace(/[^a-z0-9._-]/gu, "-")}@example.test`;
}

async function collectWorkerModules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const modules = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      modules.push(...(await collectWorkerModules(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      modules.push({
        type: "ESModule",
        path: path.relative(projectRoot, absolutePath).replaceAll("\\", "/"),
      });
    }
  }
  return modules;
}

export async function getWorkerModules() {
  if (!cachedWorkerModules) {
    cachedWorkerModules = await collectWorkerModules(serverRoot);
    cachedWorkerModules.sort((left, right) => {
      return left.path.localeCompare(right.path);
    });
    cachedWorkerModules.unshift({
      type: "ESModule",
      path: "tests/fixtures/worker-entry.mjs",
    });
  }
  return cachedWorkerModules;
}

export async function applyNumberedMigrations(database, filenames = MIGRATION_FILES) {
  await database
    .prepare(
      `CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
    )
    .run();

  for (const filename of filenames) {
    const alreadyApplied = await database
      .prepare("SELECT 1 AS applied FROM d1_migrations WHERE name = ? LIMIT 1")
      .bind(filename)
      .first();
    if (alreadyApplied) continue;

    const sql = await readFile(path.join(migrationsRoot, filename), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const [index, statement] of statements.entries()) {
      try {
        await database.prepare(statement).run();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${filename} statement ${index + 1} failed: ${detail}`, {
          cause: error,
        });
      }
    }
    await database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(filename).run();
  }
}

export async function createTestRuntime({
  bindings = {},
  fetchMock,
  migrate = true,
  outboundService,
  r2Buckets = ["EVIDENCE_ORIGINALS", "EVIDENCE_DERIVATIVES", "BACKUPS"],
  unsafeTriggerHandlers = false,
} = {}) {
  const runtime = new Miniflare({
    compatibilityDate: "2026-05-22",
    compatibilityFlags: ["nodejs_compat"],
    modules: await getWorkerModules(),
    modulesRoot: projectRoot,
    bindings: { ...TEST_BINDINGS, ...bindings },
    ...(fetchMock ? { fetchMock } : {}),
    ...(outboundService ? { outboundService } : {}),
    d1Databases: ["DB"],
    r2Buckets,
    unsafeTriggerHandlers,
  });
  await runtime.ready;
  const database = await runtime.getD1Database("DB");
  if (migrate) await applyNumberedMigrations(database);
  return {
    runtime,
    database,
    originals: r2Buckets.includes("EVIDENCE_ORIGINALS")
      ? await runtime.getR2Bucket("EVIDENCE_ORIGINALS")
      : undefined,
    derivatives: r2Buckets.includes("EVIDENCE_DERIVATIVES")
      ? await runtime.getR2Bucket("EVIDENCE_DERIVATIVES")
      : undefined,
    backups: r2Buckets.includes("BACKUPS") ? await runtime.getR2Bucket("BACKUPS") : undefined,
  };
}

export async function insertReportFixture(
  database,
  {
    id,
    username = `User-${id}`,
    discordId = "100000000000000001",
    game = "Test Arena",
    category = "Cheating",
    reason = "A sufficiently detailed synthetic report reason for automated tests.",
    description = "Synthetic test-only report content with no real person or allegation.",
    status = "Reported",
    dateAdded = "2026-08-09",
    updatedAt = "2026-08-09T00:00:00.000Z",
    views = 0,
    isPublished = true,
  },
) {
  await database
    .prepare(
      `INSERT INTO reports (
      id, username, discord_id, game, category, reason, description, status,
      notes, moderator_notes, evidence_json, status_history_json, date_added,
      updated_at, views, is_published
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '[]', '[]', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      username,
      discordId,
      game,
      category,
      reason,
      description,
      status,
      dateAdded,
      updatedAt,
      views,
      isPublished ? 1 : 0,
    )
    .run();
}

export async function insertAccountFixture(
  database,
  {
    id,
    handle,
    role = "member",
    status = "active",
    token = ["test", id, "session", "value", "s".repeat(40)].join("-"),
    csrf = `${id}-csrf-token-${"c".repeat(40)}`,
    providers = [],
    providerSubjects = {},
    confirmedProviders = providers,
    authenticatedAt = new Date().toISOString(),
    roleVersion = 1,
    legacyAuthSession = false,
  },
) {
  const now = new Date();
  const createdAt = now.toISOString();
  const idleExpiresAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const absoluteExpiresAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
  await database
    .prepare(
      `INSERT INTO accounts (
      id, handle, handle_normalized, role, status, role_version,
      created_at, updated_at, last_authenticated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      handle,
      handle.toLowerCase(),
      role,
      status,
      roleVersion,
      createdAt,
      createdAt,
      authenticatedAt,
    )
    .run();
  const sessionValues = [
    `session_${id}`,
    id,
    sha256Base64Url(token),
    sha256Base64Url(csrf),
    roleVersion,
    authenticatedAt,
  ];
  if (legacyAuthSession) {
    await database
      .prepare(
        `INSERT INTO auth_sessions (
        id, account_id, token_hash, csrf_token_hash, role_version,
        authenticated_at, created_at, last_seen_at, idle_expires_at,
        absolute_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(...sessionValues, createdAt, createdAt, idleExpiresAt, absoluteExpiresAt)
      .run();
  } else {
    await database
      .prepare(
        `INSERT INTO auth_sessions (
        id, account_id, token_hash, csrf_token_hash, role_version,
        authenticated_at, discord_confirmed_at, email_confirmed_at,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        ...sessionValues,
        confirmedProviders.includes("discord") ? authenticatedAt : null,
        confirmedProviders.includes("email") ? authenticatedAt : null,
        createdAt,
        createdAt,
        idleExpiresAt,
        absoluteExpiresAt,
      )
      .run();
  }

  for (const provider of providers) {
    const subject = providerSubjects[provider] ?? defaultProviderSubject(id, provider);
    await database
      .prepare(
        `INSERT INTO account_identities (
        id, account_id, provider, subject_hash, subject_encrypted,
        display_hint, verified_at, created_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `identity_${id}_${provider}`,
        id,
        provider,
        identitySubjectHashForFixture(provider, subject),
        encryptIdentityForFixture(subject, `${id}:${provider}:${subject}`),
        `${provider} test identity`,
        createdAt,
        createdAt,
        createdAt,
      )
      .run();
  }

  return {
    id,
    handle,
    role,
    token,
    csrf,
    cookie: `sr_session=${token}; sr_csrf=${csrf}`,
  };
}

export function authHeaders(account, extra = {}) {
  return {
    origin: "http://localhost",
    cookie: account.cookie,
    "x-csrf-token": account.csrf,
    "cf-connecting-ip": "198.51.100.42",
    ...extra,
  };
}

export function anonymousIntakeHeaders(extra = {}) {
  return {
    origin: "http://localhost",
    "cf-connecting-ip": "198.51.100.77",
    "user-agent": "scam-reports-test-suite",
    ...extra,
  };
}

export async function dispatchForm(runtime, pathname, formData, headers = {}) {
  const turnstileToken = formData.get("cf-turnstile-response");
  const request = new Request(`http://localhost${pathname}`, {
    method: "POST",
    headers: {
      ...(typeof turnstileToken === "string" && turnstileToken
        ? { "x-turnstile-token": turnstileToken }
        : {}),
      ...headers,
    },
    body: formData,
  });
  return runtime.dispatchFetch(request.url, {
    method: "POST",
    headers: Object.fromEntries(request.headers),
    body: await request.arrayBuffer(),
    redirect: "manual",
  });
}
