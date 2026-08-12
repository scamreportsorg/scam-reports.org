import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";

const PRIVATE_ERROR = ["private D1 error token", "test-redaction-token-placeholder"].join("=");
const BOT_TOKEN = "test-discord-bot-token-placeholder";
const identityEncryptionFixture = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const GUILD_ID = "700000000000000001";
const ROLE_IDS = [
  "700000000000000011",
  "700000000000000012",
  "700000000000000013",
  "700000000000000014",
  "700000000000000015",
  "700000000000000016",
];

let vite;
let buildDiscordStatusSnapshot;

before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 0 } },
    appType: "custom",
    plugins: [
      {
        name: "test-cloudflare-workers-environment",
        enforce: "pre",
        resolveId(id) {
          return id === "cloudflare:workers" ? "\0test-cloudflare-workers" : null;
        },
        load(id) {
          if (id !== "\0test-cloudflare-workers") return null;
          return `export const env = Object.freeze({
            PUBLIC_RELEASE_VERSION: "0.2.0-status-test",
            PUBLIC_SOURCE_AVAILABLE: "false"
          });`;
        },
      },
    ],
  });
  ({ buildDiscordStatusSnapshot } = await vite.ssrLoadModule("/lib/discord-integrations.ts"));
});

after(async () => vite?.close());

function roleSyncBindings() {
  return Object.fromEntries(
    ROLE_IDS.map((roleId, index) => [`DISCORD_ROLE_LEVEL_${index + 1}_ID`, roleId]),
  );
}

function statusDatabase({ fail = false } = {}) {
  const queries = [];
  return {
    queries,
    prepare(query) {
      queries.push(query);
      return {
        async first() {
          if (fail) throw new Error(PRIVATE_ERROR);
          if (query.includes("SELECT 1 AS ready")) {
            return { ready: 1, raw_error: PRIVATE_ERROR };
          }
          if (query.includes("notification_outbox")) {
            return { status: "dead", pending_count: 987654321, raw_error: PRIVATE_ERROR };
          }
          if (query.includes("discord_rank_sync_control")) {
            return {
              circuit_open_until: null,
              terminal_count: 2,
              discord_account_id: "private-account-id",
              raw_error: PRIVATE_ERROR,
            };
          }
          if (query.includes("backup_runs")) {
            return {
              status: "complete",
              started_at: "2026-08-10T00:00:00.000Z",
              completed_at: "2026-08-10T00:01:00.000Z",
              object_key: "private/backup/object-key",
              raw_error: PRIVATE_ERROR,
            };
          }
          throw new Error(`Unexpected status query: ${query}`);
        },
      };
    },
  };
}

test("status snapshot exposes coarse states only", async () => {
  const database = statusDatabase();
  const values = {
    AUTH_APP_ORIGIN: "https://scam-reports.org",
    DISCORD_CLIENT_ID: "700000000000000021",
    DISCORD_CLIENT_SECRET: "test-discord-client-secret-placeholder-32-chars",
    RESEND_API_KEY: "test-resend-api-key-placeholder-32-characters",
    RESEND_FROM: "Scam Reports <login@auth.scam-reports.org>",
    DISCORD_ROLE_SYNC_ENABLED: "true",
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_GUILD_ID: GUILD_ID,
    IDENTITY_ENCRYPTION_KEY: identityEncryptionFixture,
    ...roleSyncBindings(),
    EVIDENCE_DERIVATIVES: {
      async head(key) {
        assert.equal(key, "__discord_status_probe__");
        return null;
      },
    },
  };
  const now = new Date("2026-08-11T12:34:56.000Z");
  const snapshot = await buildDiscordStatusSnapshot(database, values, {
    now,
    minuteJobsHealthy: false,
  });

  assert.deepEqual(snapshot, {
    website: "operational",
    api: "operational",
    database: "operational",
    authentication: "operational",
    evidence: "operational",
    email: "degraded",
    discordRoles: "degraded",
    backups: "operational",
    scheduledJobs: "degraded",
    version: "0.2.0-status-test",
    updatedAt: now.toISOString(),
  });
  assert.equal(database.queries.length, 4);

  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(
    serialized,
    /test-redaction-token-placeholder|987654321|private-account-id/iu,
  );
  assert.doesNotMatch(serialized, /private\/backup\/object-key/iu);
  assert.equal(serialized.includes(BOT_TOKEN), false);
  assert.equal(serialized.includes(GUILD_ID), false);
  for (const roleId of ROLE_IDS) assert.equal(serialized.includes(roleId), false);
});

test("failed probes return unavailable", async () => {
  const snapshot = await buildDiscordStatusSnapshot(
    statusDatabase({ fail: true }),
    {
      AUTH_APP_ORIGIN: "https://scam-reports.org",
      DISCORD_ROLE_SYNC_ENABLED: "true",
      DISCORD_BOT_TOKEN: "test-short-placeholder",
      EVIDENCE_DERIVATIVES: {
        async head() {
          throw new Error("private R2 bucket identifier");
        },
      },
    },
    {
      now: new Date("2026-08-11T12:34:56.000Z"),
    },
  );

  assert.deepEqual(
    {
      website: snapshot.website,
      api: snapshot.api,
      database: snapshot.database,
      authentication: snapshot.authentication,
      evidence: snapshot.evidence,
      email: snapshot.email,
      discordRoles: snapshot.discordRoles,
      backups: snapshot.backups,
      scheduledJobs: snapshot.scheduledJobs,
    },
    {
      website: "operational",
      api: "operational",
      database: "unavailable",
      authentication: "unavailable",
      evidence: "unavailable",
      email: "unavailable",
      discordRoles: "unavailable",
      backups: "unavailable",
      scheduledJobs: "operational",
    },
  );
  assert.doesNotMatch(
    JSON.stringify(snapshot),
    /private D1|private R2|private upstream|bucket identifier|response body/iu,
  );
});
