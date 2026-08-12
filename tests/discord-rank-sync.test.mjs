import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";
import {
  TEST_BINDINGS,
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
  projectRoot,
} from "./helpers/runtime.mjs";

let DiscordApiError;
let DiscordRoleApi;
let readDiscordRoleSyncConfiguration;

const BOT_TOKEN = "test-discord-bot-token-placeholder-0000000000000000";
const GUILD_ID = "910000000000000000";
const ROLE_IDS = Object.freeze({
  1: "920000000000000001",
  2: "920000000000000002",
  3: "920000000000000003",
  4: "920000000000000004",
  5: "920000000000000005",
  6: "920000000000000006",
});
const BOT_USER_ID = "910000000000000001";
const BOT_ROLE_ID = "910000000000000002";
const FOREIGN_ROLE_ID = "930000000000000001";
const FUTURE_NOW = new Date("2099-01-01T00:00:00.000Z");

let vite;
let database;
let getDiscordRankSyncStatus;
let processDiscordRankSync;
let purgeExpiredDiscordRankOrphans;
let requestDiscordRankSync;
let runtime;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    root: projectRoot,
    server: { middlewareMode: true },
  });
  ({ DiscordApiError, DiscordRoleApi, readDiscordRoleSyncConfiguration } =
    await vite.ssrLoadModule("/lib/discord-api.ts"));
  const syncModule = await vite.ssrLoadModule("/lib/discord-rank-sync.ts");
  ({
    getDiscordRankSyncStatus,
    processDiscordRankSync,
    purgeExpiredDiscordRankOrphans,
    requestDiscordRankSync,
  } = syncModule);
  ({ database, runtime } = await createTestRuntime());
});

after(async () => {
  await runtime?.dispose();
  await vite?.close();
});

function syncValues(overrides = {}) {
  return {
    DISCORD_ROLE_SYNC_ENABLED: "true",
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_GUILD_ID: GUILD_ID,
    DISCORD_ROLE_LEVEL_1_ID: ROLE_IDS[1],
    DISCORD_ROLE_LEVEL_2_ID: ROLE_IDS[2],
    DISCORD_ROLE_LEVEL_3_ID: ROLE_IDS[3],
    DISCORD_ROLE_LEVEL_4_ID: ROLE_IDS[4],
    DISCORD_ROLE_LEVEL_5_ID: ROLE_IDS[5],
    DISCORD_ROLE_LEVEL_6_ID: ROLE_IDS[6],
    IDENTITY_ENCRYPTION_KEY: TEST_BINDINGS.IDENTITY_ENCRYPTION_KEY,
    ...overrides,
  };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function safeGuildRoles(overrides = {}) {
  return [
    ...Object.values(ROLE_IDS).map((id, index) => ({
      id,
      managed: false,
      permissions: "0",
      position: index + 1,
      ...overrides[id],
    })),
    {
      id: BOT_ROLE_ID,
      managed: true,
      permissions: "268435456",
      position: 20,
      ...overrides[BOT_ROLE_ID],
    },
  ];
}

function createDiscordMock(initialMembers = {}, options = {}) {
  const members = new Map(
    Object.entries(initialMembers).map(([id, roles]) => [id, new Set(roles)]),
  );
  const botRoleIds = options.botRoleIds ?? [BOT_ROLE_ID];
  const guildRoles = options.guildRoles ?? safeGuildRoles();
  const requests = [];
  const queued = [];

  const mock = {
    members,
    requests,
    queue(handler) {
      queued.push(handler);
    },
    async fetch(input, init = {}) {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input));
      const method = String(init.method ?? request?.method ?? "GET").toUpperCase();
      const headers = new Headers(init.headers ?? request?.headers);
      const record = {
        authorization: headers.get("authorization"),
        method,
        pathname: url.pathname,
        redirect: init.redirect,
        url: url.toString(),
        userAgent: headers.get("user-agent"),
      };
      requests.push(record);

      assert.equal(url.origin, "https://discord.com");
      assert.match(url.pathname, /^\/api\/v10\//u);
      assert.equal(record.authorization, `Bot ${BOT_TOKEN}`);
      assert.equal(record.redirect, "manual");

      if (url.pathname === "/api/v10/users/@me" && method === "GET") {
        return jsonResponse({ id: BOT_USER_ID });
      }
      if (
        url.pathname === `/api/v10/guilds/${GUILD_ID}/members/${BOT_USER_ID}` &&
        method === "GET"
      ) {
        return jsonResponse({ roles: botRoleIds });
      }
      if (url.pathname === `/api/v10/guilds/${GUILD_ID}/roles` && method === "GET") {
        return jsonResponse(guildRoles);
      }

      if (queued.length > 0) {
        const response = await queued.shift()(record);
        if (response) return response;
      }

      const match = url.pathname.match(
        /^\/api\/v10\/guilds\/(\d+)\/members\/(\d+)(?:\/roles\/(\d+))?$/u,
      );
      if (!match || match[1] !== GUILD_ID) {
        return new Response("Unexpected Discord API request.", { status: 502 });
      }
      const [, , memberId, roleId] = match;
      const roles = members.get(memberId);
      if (!roles) return jsonResponse({ code: 10_007, message: "Unknown Member" }, 404);

      if (method === "GET" && !roleId) return jsonResponse({ roles: [...roles] });
      if (method === "PUT" && roleId) {
        roles.add(roleId);
        return new Response(null, { status: 204 });
      }
      if (method === "DELETE" && roleId) {
        roles.delete(roleId);
        return new Response(null, { status: 204 });
      }
      return new Response("Unexpected Discord API method.", { status: 502 });
    },
  };
  return mock;
}

async function isolatedRuntime() {
  await database.batch([
    database.prepare("DELETE FROM accounts"),
    database.prepare("DELETE FROM discord_rank_sync"),
    database.prepare(
      `UPDATE discord_rank_sync_control SET circuit_open_until = NULL,
        last_error_code = '', updated_at = '2000-01-01T00:00:00.000Z'
       WHERE id = 'global'`,
    ),
  ]);
  return { database };
}

async function syncRow(database, accountId) {
  return database
    .prepare(
      `SELECT id, account_id, subject_hash, subject_encrypted, generation,
        desired_rank_level, applied_rank_level, status, attempts,
        next_attempt_at, next_reconcile_at, lease_token, lease_expires_at,
        last_error_code, last_checked_at, last_synced_at
       FROM discord_rank_sync WHERE account_id = ? LIMIT 1`,
    )
    .bind(accountId)
    .first();
}

async function syncRowBySubject(database, subjectHash) {
  return database
    .prepare(
      `SELECT id, account_id, subject_hash, subject_encrypted, generation,
        desired_rank_level, applied_rank_level, status, attempts,
        next_attempt_at, next_reconcile_at, lease_token, lease_expires_at,
        last_error_code, last_checked_at, last_synced_at
       FROM discord_rank_sync WHERE subject_hash = ? LIMIT 1`,
    )
    .bind(subjectHash)
    .first();
}

async function addAcceptedReport(database, account, suffix) {
  const reportId = `SR-DRS-${suffix}`;
  const timestamp = "2026-08-10T10:00:00.000Z";
  await insertReportFixture(database, {
    id: reportId,
    username: `RankSubject${suffix}`,
    discordId: `8000000000000${String(suffix).replace(/\D/gu, "").padStart(5, "0")}`.slice(0, 18),
  });
  await database
    .prepare(
      `INSERT INTO report_submissions (
        id, account_id, related_report_id, submitter_name, contact_email,
        username, discord_id, game, category, reason, description,
        evidence_json, status, moderator_notes, author_fingerprint,
        submitter_verified, result_report_id, created_at, updated_at
      ) VALUES (?, ?, NULL, ?, '', ?, '800000000000000101', 'Synthetic Arena',
        'Cheating', 'Synthetic accepted report for rank sync testing.',
        'Synthetic accepted report timeline with enough detail for this isolated test.',
        '[]', 'Accepted', '', ?, 1, ?, ?, ?)`,
    )
    .bind(
      `SUB-DRS-${suffix}`,
      account.id,
      account.handle,
      `RankSubject${suffix}`,
      `drs-report-${suffix}`,
      reportId,
      timestamp,
      timestamp,
    )
    .run();
  return reportId;
}

async function addApprovedReview(database, account, reportId, suffix) {
  const timestamp = "2026-08-10T11:00:00.000Z";
  await database
    .prepare(
      `INSERT INTO reviews (
        id, report_id, account_id, display_name, rating, relationship, title,
        body, status, moderator_notes, author_fingerprint, reviewer_verified,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 4, 'Player', 'Synthetic rank sync review',
        'Synthetic approved review content for isolated Discord rank testing.',
        'Approved', '', ?, 1, ?, ?)`,
    )
    .bind(
      `REV-DRS-${suffix}`,
      reportId,
      account.id,
      account.handle,
      `drs-review-${suffix}`,
      timestamp,
      timestamp,
    )
    .run();
}

test("Discord config and API routes fail closed", async () => {
  const { database } = await isolatedRuntime();
  let outboundCalls = 0;
  const forbiddenFetch = async () => {
    outboundCalls += 1;
    throw new Error("outbound fetch should not run");
  };

  const disabled = await processDiscordRankSync(
    database,
    syncValues({ DISCORD_ROLE_SYNC_ENABLED: "TRUE" }),
    { fetch: forbiddenFetch, now: FUTURE_NOW },
  );
  assert.deepEqual(disabled, {
    configured: false,
    configurationError: false,
    circuitOpen: false,
    claimed: 0,
    synced: 0,
    notInGuild: 0,
    failed: 0,
    staleCompletions: 0,
  });

  const duplicateRoles = await processDiscordRankSync(
    database,
    syncValues({ DISCORD_ROLE_LEVEL_6_ID: ROLE_IDS[5] }),
    { fetch: forbiddenFetch, now: FUTURE_NOW },
  );
  assert.equal(duplicateRoles.configurationError, true);

  const badEncryptionKey = await processDiscordRankSync(
    database,
    syncValues({ IDENTITY_ENCRYPTION_KEY: "test-invalid-encryption-key-placeholder" }),
    { fetch: forbiddenFetch, now: FUTURE_NOW },
  );
  assert.equal(badEncryptionKey.configurationError, true);

  const noWork = await processDiscordRankSync(database, syncValues(), {
    fetch: forbiddenFetch,
    now: FUTURE_NOW,
  });
  assert.equal(noWork.configured, true);
  assert.equal(noWork.claimed, 0);
  assert.equal(outboundCalls, 0);

  const configuration = readDiscordRoleSyncConfiguration(syncValues());
  assert.equal(configuration.enabled, true);
  assert.ok("config" in configuration);
  const userId = "940000000000000001";
  const mock = createDiscordMock({ [userId]: [FOREIGN_ROLE_ID] });
  const api = new DiscordRoleApi(configuration.config, { fetch: mock.fetch });
  assert.deepEqual(await api.getGuildMember(userId), { roles: [FOREIGN_ROLE_ID] });
  await api.addMemberRole(userId, ROLE_IDS[1]);
  await api.removeMemberRole(userId, ROLE_IDS[1]);
  assert.deepEqual(
    mock.requests.map(({ method, pathname }) => `${method} ${pathname}`),
    [
      `GET /api/v10/guilds/${GUILD_ID}/members/${userId}`,
      `PUT /api/v10/guilds/${GUILD_ID}/members/${userId}/roles/${ROLE_IDS[1]}`,
      `DELETE /api/v10/guilds/${GUILD_ID}/members/${userId}/roles/${ROLE_IDS[1]}`,
    ],
  );
  assert.ok(
    mock.requests.every(
      (request) => request.userAgent === "DiscordBot (https://scam-reports.org, 0.2.10)",
    ),
  );

  const savedTimeout = AbortSignal.timeout;
  try {
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: undefined,
    });
    const compatibleApi = new DiscordRoleApi(configuration.config, { fetch: mock.fetch });
    assert.deepEqual(await compatibleApi.getGuildMember(userId), {
      roles: [FOREIGN_ROLE_ID],
    });
  } finally {
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: savedTimeout,
    });
  }

  const beforeRejectedTarget = mock.requests.length;
  await assert.rejects(
    api.addMemberRole(userId, FOREIGN_ROLE_ID),
    (error) => error instanceof DiscordApiError && error.code === "discord_role_target_invalid",
  );
  assert.equal(mock.requests.length, beforeRejectedTarget);

  const upstreamErrorBody = `upstream detail containing ${BOT_TOKEN}`;
  const rejectedMock = createDiscordMock({ [userId]: [] });
  rejectedMock.queue(() => jsonResponse({ message: upstreamErrorBody }, 401));
  const rejectedApi = new DiscordRoleApi(configuration.config, { fetch: rejectedMock.fetch });
  await assert.rejects(rejectedApi.getGuildMember(userId), (error) => {
    assert.ok(error instanceof DiscordApiError);
    assert.equal(error.kind, "terminal");
    assert.equal(error.code, "discord_auth_rejected");
    assert.doesNotMatch(String(error), new RegExp(BOT_TOKEN, "u"));
    assert.doesNotMatch(String(error), /upstream detail/iu);
    return true;
  });
});

test("rank sync ignores website staff roles", async () => {
  const { database } = await isolatedRuntime();
  const discordId = "940000000000000002";
  const account = await insertAccountFixture(database, {
    id: "account_drs_staff_separation",
    handle: "RankedAdministrator",
    role: "admin",
    providers: ["discord", "email"],
    providerSubjects: { discord: discordId },
  });
  const reportId = await addAcceptedReport(database, account, "ROLE-2");
  await addApprovedReview(database, account, reportId, "ROLE-2");

  const mock = createDiscordMock({
    [discordId]: [ROLE_IDS[1], ROLE_IDS[4], FOREIGN_ROLE_ID],
  });
  const first = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    now: FUTURE_NOW,
    random: () => 0,
  });
  assert.equal(first.synced, 1);
  assert.deepEqual(
    mock.requests.slice(0, 3).map(({ method, pathname }) => `${method} ${pathname}`),
    [
      "GET /api/v10/users/@me",
      `GET /api/v10/guilds/${GUILD_ID}/members/${BOT_USER_ID}`,
      `GET /api/v10/guilds/${GUILD_ID}/roles`,
    ],
  );
  assert.equal(mock.requests.filter(({ pathname }) => pathname === "/api/v10/users/@me").length, 1);
  assert.deepEqual([...mock.members.get(discordId)].sort(), [FOREIGN_ROLE_ID, ROLE_IDS[2]].sort());
  const row = await syncRow(database, account.id);
  assert.deepEqual(
    {
      applied: row.applied_rank_level,
      desired: row.desired_rank_level,
      status: row.status,
    },
    { applied: 2, desired: 2, status: "synced" },
  );
  assert.equal(
    await database.prepare("SELECT role FROM accounts WHERE id = ?").bind(account.id).first("role"),
    "admin",
  );

  const publicStatus = await getDiscordRankSyncStatus(account.id, {
    database,
    values: syncValues({ DISCORD_COMMUNITY_INVITE_URL: "https://discord.gg/scam-reports" }),
  });
  assert.deepEqual(publicStatus, {
    configured: true,
    status: "synced",
    desiredRank: { level: 2, name: "Contributor" },
    appliedRank: { level: 2, name: "Contributor" },
    lastCheckedAt: FUTURE_NOW.toISOString(),
    lastSyncedAt: FUTURE_NOW.toISOString(),
    communityInviteUrl: "https://discord.gg/scam-reports",
  });
  const serializedStatus = JSON.stringify(publicStatus);
  assert.doesNotMatch(
    serializedStatus,
    /subject|hash|encrypted|cipher|lastError|botToken|discord-test-token|admin/iu,
  );
  const invalidInviteStatus = await getDiscordRankSyncStatus(account.id, {
    database,
    values: syncValues({
      DISCORD_COMMUNITY_INVITE_URL: "https://attacker.invalid/invite/scam-reports",
    }),
  });
  assert.equal(invalidInviteStatus.communityInviteUrl, null);

  const mutationsBefore = mock.requests.filter(({ method }) => method !== "GET").length;
  const reconcileAt = new Date(FUTURE_NOW.getTime() + 6 * 60 * 60_000);
  const second = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    now: reconcileAt,
    random: () => 0,
  });
  assert.equal(second.synced, 1);
  assert.equal(mock.requests.filter(({ method }) => method !== "GET").length, mutationsBefore);
  assert.deepEqual([...mock.members.get(discordId)].sort(), [FOREIGN_ROLE_ID, ROLE_IDS[2]].sort());
});

test("preflight rejects privileged rank roles", async () => {
  const { database } = await isolatedRuntime();
  const discordId = "940000000000000003";
  const account = await insertAccountFixture(database, {
    id: "account_drs_permission_role",
    handle: "PermissionRole",
    providers: ["discord"],
    providerSubjects: { discord: discordId },
  });
  const mock = createDiscordMock(
    { [discordId]: [] },
    {
      guildRoles: safeGuildRoles({
        [ROLE_IDS[3]]: { permissions: "8" },
      }),
    },
  );

  const result = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    now: FUTURE_NOW,
    random: () => 0,
  });
  assert.deepEqual(
    {
      circuitOpen: result.circuitOpen,
      claimed: result.claimed,
      failed: result.failed,
      synced: result.synced,
    },
    { circuitOpen: true, claimed: 0, failed: 1, synced: 0 },
  );
  assert.equal((await syncRow(database, account.id)).status, "pending");
  assert.deepEqual(
    mock.requests.map(({ pathname }) => pathname),
    [
      "/api/v10/users/@me",
      `/api/v10/guilds/${GUILD_ID}/members/${BOT_USER_ID}`,
      `/api/v10/guilds/${GUILD_ID}/roles`,
    ],
  );
  const control = await database
    .prepare(
      "SELECT circuit_open_until, last_error_code FROM discord_rank_sync_control WHERE id = 'global'",
    )
    .first();
  assert.equal(control.last_error_code, "discord_rank_role_has_permissions");
  assert.equal(
    control.circuit_open_until,
    new Date(FUTURE_NOW.getTime() + 15 * 60_000).toISOString(),
  );
});

for (const [label, permissions] of [
  ["Administrator", "8"],
  ["missing Manage Roles", "0"],
  ["Manage Roles plus an unrelated permission", "268437504"],
]) {
  test(`preflight rejects bot permission: ${label}`, async () => {
    const { database } = await isolatedRuntime();
    const discordId = `94000000000000010${permissions === "8" ? "1" : permissions === "0" ? "2" : "3"}`;
    const account = await insertAccountFixture(database, {
      id: `account_drs_bot_permissions_${permissions}`,
      handle: `BotPermissions${permissions}`,
      providers: ["discord"],
      providerSubjects: { discord: discordId },
    });
    const mock = createDiscordMock(
      { [discordId]: [] },
      { guildRoles: safeGuildRoles({ [BOT_ROLE_ID]: { permissions } }) },
    );

    const result = await processDiscordRankSync(database, syncValues(), {
      fetch: mock.fetch,
      now: FUTURE_NOW,
      random: () => 0,
    });

    assert.deepEqual(
      {
        circuitOpen: result.circuitOpen,
        claimed: result.claimed,
        failed: result.failed,
        synced: result.synced,
      },
      { circuitOpen: true, claimed: 0, failed: 1, synced: 0 },
    );
    assert.equal((await syncRow(database, account.id)).status, "pending");
    const control = await database
      .prepare("SELECT last_error_code FROM discord_rank_sync_control WHERE id = 'global'")
      .first();
    assert.equal(control.last_error_code, "discord_bot_permissions_invalid");
  });
}

test("rank roles must stay below the bot", async () => {
  const { database } = await isolatedRuntime();
  const discordId = "940000000000000004";
  const account = await insertAccountFixture(database, {
    id: "account_drs_hierarchy_role",
    handle: "HierarchyRole",
    providers: ["discord"],
    providerSubjects: { discord: discordId },
  });
  const mock = createDiscordMock(
    { [discordId]: [] },
    {
      guildRoles: safeGuildRoles({
        [ROLE_IDS[6]]: { position: 20 },
      }),
    },
  );

  const result = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    now: FUTURE_NOW,
    random: () => 0,
  });
  assert.deepEqual(
    {
      circuitOpen: result.circuitOpen,
      claimed: result.claimed,
      failed: result.failed,
      synced: result.synced,
    },
    { circuitOpen: true, claimed: 0, failed: 1, synced: 0 },
  );
  assert.equal((await syncRow(database, account.id)).status, "pending");
  assert.equal(mock.requests.length, 3);
  const control = await database
    .prepare("SELECT last_error_code FROM discord_rank_sync_control WHERE id = 'global'")
    .first();
  assert.equal(control.last_error_code, "discord_rank_role_hierarchy_invalid");
});

test("account removal clears only managed roles", async () => {
  const { database } = await isolatedRuntime();
  const fixtures = [
    ["unlink", "940000000000000011"],
    ["suspend", "940000000000000012"],
    ["delete", "940000000000000013"],
  ];
  const accounts = {};
  for (const [kind, discordId] of fixtures) {
    accounts[kind] = await insertAccountFixture(database, {
      id: `account_drs_cleanup_${kind}`,
      handle: `Cleanup${kind}`,
      providers: ["discord"],
      providerSubjects: { discord: discordId },
    });
  }
  const hashes = Object.fromEntries(
    await Promise.all(
      fixtures.map(async ([kind]) => [
        kind,
        (await syncRow(database, accounts[kind].id)).subject_hash,
      ]),
    ),
  );

  await database
    .prepare("DELETE FROM account_identities WHERE account_id = ? AND provider = 'discord'")
    .bind(accounts.unlink.id)
    .run();
  await database
    .prepare("UPDATE accounts SET status = 'suspended' WHERE id = ?")
    .bind(accounts.suspend.id)
    .run();
  await database.prepare("DELETE FROM accounts WHERE id = ?").bind(accounts.delete.id).run();

  const mock = createDiscordMock(
    Object.fromEntries(
      fixtures.map(([, discordId], index) => [
        discordId,
        [ROLE_IDS[index + 1], ROLE_IDS[6], FOREIGN_ROLE_ID],
      ]),
    ),
  );
  const result = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    now: FUTURE_NOW,
    random: () => 0,
  });
  assert.equal(result.synced, 3);
  for (const [, discordId] of fixtures) {
    assert.deepEqual([...mock.members.get(discordId)], [FOREIGN_ROLE_ID]);
  }
  assert.equal(await syncRowBySubject(database, hashes.unlink), null);
  assert.equal(await syncRowBySubject(database, hashes.delete), null);
  const suspended = await syncRowBySubject(database, hashes.suspend);
  assert.deepEqual(
    {
      accountId: suspended.account_id,
      applied: suspended.applied_rank_level,
      desired: suspended.desired_rank_level,
      status: suspended.status,
    },
    {
      accountId: accounts.suspend.id,
      applied: 0,
      desired: 0,
      status: "synced",
    },
  );
});

test("orphaned Discord identities expire", async () => {
  const { database: isolatedDatabase } = await isolatedRuntime();
  const account = await insertAccountFixture(isolatedDatabase, {
    id: "account_drs_retention",
    handle: "RetentionMember",
    providers: ["discord"],
    providerSubjects: { discord: "940000000000000014" },
  });

  await isolatedDatabase
    .prepare("DELETE FROM account_identities WHERE account_id = ? AND provider = 'discord'")
    .bind(account.id)
    .run();
  const orphan = await isolatedDatabase
    .prepare(
      `SELECT id, account_id, orphan_purge_after FROM discord_rank_sync
       WHERE account_id IS NULL LIMIT 1`,
    )
    .first();
  assert.equal(orphan.account_id, null);
  assert.match(orphan.orphan_purge_after, /^\d{4}-\d{2}-\d{2}T/u);
  const deadline = new Date(orphan.orphan_purge_after);

  assert.deepEqual(
    await purgeExpiredDiscordRankOrphans(100, new Date(deadline.getTime() - 1), isolatedDatabase),
    { purged: 0 },
  );
  assert.notEqual(
    await isolatedDatabase
      .prepare("SELECT id FROM discord_rank_sync WHERE id = ?")
      .bind(orphan.id)
      .first(),
    null,
  );

  assert.deepEqual(
    await purgeExpiredDiscordRankOrphans(100, new Date(deadline.getTime() + 1), isolatedDatabase),
    { purged: 1 },
  );
  assert.equal(
    await isolatedDatabase
      .prepare("SELECT id FROM discord_rank_sync WHERE id = ?")
      .bind(orphan.id)
      .first(),
    null,
  );
});

test("manual rank sync is scoped and coalesced", async () => {
  const { database } = await isolatedRuntime();
  const first = await insertAccountFixture(database, {
    id: "account_drs_request_first",
    handle: "RequestFirst",
    providers: ["discord"],
    providerSubjects: { discord: "940000000000000021" },
  });
  const second = await insertAccountFixture(database, {
    id: "account_drs_request_second",
    handle: "RequestSecond",
    providers: ["discord"],
    providerSubjects: { discord: "940000000000000022" },
  });
  const emailOnly = await insertAccountFixture(database, {
    id: "account_drs_request_email",
    handle: "RequestEmail",
    providers: ["email"],
  });
  const firstBefore = await syncRow(database, first.id);
  const secondBefore = await syncRow(database, second.id);

  assert.equal(await requestDiscordRankSync(first.id, database), true);
  assert.equal((await syncRow(database, first.id)).generation, firstBefore.generation + 1);
  assert.equal((await syncRow(database, second.id)).generation, secondBefore.generation);
  assert.equal((await syncRow(database, first.id)).status, "pending");
  assert.equal(await requestDiscordRankSync(emailOnly.id, database), false);
  assert.equal(await syncRow(database, emailOnly.id), null);
  assert.equal(await requestDiscordRankSync("", database), false);
  assert.equal(await requestDiscordRankSync("x".repeat(201), database), false);
});

test("rank sync handles retries and missing members", async () => {
  const { database } = await isolatedRuntime();
  const rateLimitedId = "940000000000000031";
  const missingId = "940000000000000032";
  const rateAccount = await insertAccountFixture(database, {
    id: "account_drs_rate_limited",
    handle: "RateLimitedMember",
    providers: ["discord"],
    providerSubjects: { discord: rateLimitedId },
  });
  const missingAccount = await insertAccountFixture(database, {
    id: "account_drs_missing_member",
    handle: "MissingDiscordMember",
    providers: ["discord"],
    providerSubjects: { discord: missingId },
  });

  await database
    .prepare(
      "UPDATE discord_rank_sync SET next_attempt_at = ?, updated_at = ? WHERE account_id = ?",
    )
    .bind(FUTURE_NOW.toISOString(), "2000-01-01T00:00:00.000Z", rateAccount.id)
    .run();
  await database
    .prepare(
      "UPDATE discord_rank_sync SET next_attempt_at = ?, updated_at = ? WHERE account_id = ?",
    )
    .bind(
      new Date(FUTURE_NOW.getTime() + 10_000).toISOString(),
      "2000-01-02T00:00:00.000Z",
      missingAccount.id,
    )
    .run();

  const mock = createDiscordMock({ [rateLimitedId]: [] });
  mock.queue(() =>
    jsonResponse({ message: `private upstream text ${BOT_TOKEN}`, retry_after: 2 }, 429, {
      "retry-after": "999",
    }),
  );
  const first = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    limit: 1,
    now: FUTURE_NOW,
    random: () => 0,
  });
  assert.equal(first.failed, 1);
  const rateRow = await syncRow(database, rateAccount.id);
  assert.equal(rateRow.status, "failed");
  assert.equal(rateRow.last_error_code, "discord_rate_limited");
  assert.equal(rateRow.next_attempt_at, new Date(FUTURE_NOW.getTime() + 2_250).toISOString());
  assert.doesNotMatch(JSON.stringify(rateRow), new RegExp(BOT_TOKEN, "u"));
  assert.doesNotMatch(JSON.stringify(rateRow), /private upstream text/iu);

  const requestCount = mock.requests.length;
  const tooEarly = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    limit: 1,
    now: new Date(FUTURE_NOW.getTime() + 2_000),
    random: () => 0,
  });
  assert.equal(tooEarly.claimed, 0);
  assert.equal(mock.requests.length, requestCount);

  await database
    .prepare("UPDATE discord_rank_sync SET next_attempt_at = ? WHERE account_id = ?")
    .bind(FUTURE_NOW.toISOString(), missingAccount.id)
    .run();
  const missingRun = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    limit: 1,
    now: new Date(FUTURE_NOW.getTime() + 3_000),
    random: () => 0,
  });
  assert.equal(missingRun.notInGuild, 1);
  const missingRow = await syncRow(database, missingAccount.id);
  assert.equal(missingRow.status, "not_in_guild");
  assert.equal(missingRow.last_error_code, "discord_member_not_found");
  assert.equal(
    missingRow.next_attempt_at,
    new Date(FUTURE_NOW.getTime() + 3_000 + 24 * 60 * 60_000).toISOString(),
  );
  const missingRequestsBeforeCooldown = mock.requests.filter((request) =>
    request.pathname.includes(`/members/${missingId}`),
  ).length;
  await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    now: new Date(FUTURE_NOW.getTime() + 60_000),
    random: () => 0,
  });
  assert.equal(
    mock.requests.filter((request) => request.pathname.includes(`/members/${missingId}`)).length,
    missingRequestsBeforeCooldown,
  );
});

test("Discord auth failure opens the rank-sync circuit", async () => {
  const { database } = await isolatedRuntime();
  const ids = ["940000000000000041", "940000000000000042"];
  for (const [index, discordId] of ids.entries()) {
    await insertAccountFixture(database, {
      id: `account_drs_circuit_${index}`,
      handle: `CircuitMember${index}`,
      providers: ["discord"],
      providerSubjects: { discord: discordId },
    });
  }
  const mock = createDiscordMock(Object.fromEntries(ids.map((id) => [id, []])));
  mock.queue(() => jsonResponse({ message: `do not persist ${BOT_TOKEN}`, code: 0 }, 401));

  const result = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    now: FUTURE_NOW,
    random: () => 0,
  });
  assert.equal(result.circuitOpen, true);
  assert.equal(result.claimed, 1);
  assert.equal(result.failed, 1);
  assert.equal(mock.requests.length, 4);
  const control = await database
    .prepare(
      "SELECT circuit_open_until, last_error_code, updated_at FROM discord_rank_sync_control WHERE id = 'global'",
    )
    .first();
  assert.equal(control.last_error_code, "discord_auth_rejected");
  assert.equal(
    control.circuit_open_until,
    new Date(FUTURE_NOW.getTime() + 15 * 60_000).toISOString(),
  );
  assert.doesNotMatch(JSON.stringify(control), new RegExp(BOT_TOKEN, "u"));

  const blocked = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    now: new Date(FUTURE_NOW.getTime() + 60_000),
  });
  assert.equal(blocked.circuitOpen, true);
  assert.equal(blocked.claimed, 0);
  assert.equal(mock.requests.length, 4);
});

test("stale cleanup cannot remove a relinked account", async () => {
  const { database } = await isolatedRuntime();
  const discordId = "940000000000000051";
  const original = await insertAccountFixture(database, {
    id: "account_drs_original_link",
    handle: "OriginalDiscordLink",
    providers: ["discord"],
    providerSubjects: { discord: discordId },
  });
  const replacement = await insertAccountFixture(database, {
    id: "account_drs_replacement_link",
    handle: "ReplacementDiscordLink",
    providers: ["email"],
  });
  const identity = await database
    .prepare(
      `SELECT subject_hash, subject_encrypted, display_hint, verified_at,
        created_at, last_used_at FROM account_identities
       WHERE account_id = ? AND provider = 'discord'`,
    )
    .bind(original.id)
    .first();
  await database
    .prepare("DELETE FROM account_identities WHERE account_id = ? AND provider = 'discord'")
    .bind(original.id)
    .run();
  const cleanup = await syncRowBySubject(database, identity.subject_hash);
  assert.equal(cleanup.account_id, null);
  assert.equal(cleanup.status, "pending");

  let relinked = false;
  const mock = createDiscordMock({
    [discordId]: [ROLE_IDS[2], FOREIGN_ROLE_ID],
  });
  mock.queue(async ({ method }) => {
    assert.equal(method, "GET");
    await database
      .prepare(
        `INSERT INTO account_identities (
          id, account_id, provider, subject_hash, subject_encrypted,
          display_hint, verified_at, created_at, last_used_at
        ) VALUES ('identity_drs_relinked', ?, 'discord', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        replacement.id,
        identity.subject_hash,
        identity.subject_encrypted,
        identity.display_hint,
        identity.verified_at,
        identity.created_at,
        identity.last_used_at,
      )
      .run();
    relinked = true;
    return null;
  });

  const stale = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    now: FUTURE_NOW,
    random: () => 0,
  });
  assert.equal(relinked, true);
  assert.equal(stale.staleCompletions, 1);
  assert.equal(stale.synced, 0);
  const surviving = await syncRowBySubject(database, identity.subject_hash);
  assert.equal(surviving.account_id, replacement.id);
  assert.equal(surviving.status, "pending");
  assert.ok(surviving.generation > cleanup.generation);

  const converged = await processDiscordRankSync(database, syncValues(), {
    fetch: mock.fetch,
    now: new Date(FUTURE_NOW.getTime() + 1_000),
    random: () => 0,
  });
  assert.equal(converged.synced, 1);
  assert.deepEqual([...mock.members.get(discordId)].sort(), [FOREIGN_ROLE_ID, ROLE_IDS[1]].sort());
  const finalRow = await syncRow(database, replacement.id);
  assert.equal(finalRow.applied_rank_level, 1);
  assert.equal(finalRow.status, "synced");
});

test("rank migration bumps affected generations", async () => {
  const { database } = await isolatedRuntime();
  const account = await insertAccountFixture(database, {
    id: "account_drs_trigger_generation",
    handle: "TriggerGeneration",
    providers: ["discord"],
    providerSubjects: { discord: "940000000000000061" },
  });
  const initial = await syncRow(database, account.id);
  assert.equal(initial.generation, 1);

  const reportId = "SR-DRS-TRIGGER";
  const timestamp = "2026-08-10T12:00:00.000Z";
  await insertReportFixture(database, { id: reportId });
  await database
    .prepare(
      `INSERT INTO report_submissions (
        id, account_id, related_report_id, submitter_name, contact_email,
        username, discord_id, game, category, reason, description,
        evidence_json, status, moderator_notes, author_fingerprint,
        submitter_verified, result_report_id, created_at, updated_at
      ) VALUES ('SUB-DRS-TRIGGER', ?, NULL, ?, '', 'TriggerSubject',
        '800000000000000111', 'Synthetic Arena', 'Cheating',
        'Synthetic pending trigger reason.',
        'Synthetic pending trigger description with sufficient detail.',
        '[]', 'Pending', '', 'drs-trigger-submission', 1, NULL, ?, ?)`,
    )
    .bind(account.id, account.handle, timestamp, timestamp)
    .run();
  assert.equal((await syncRow(database, account.id)).generation, 1);
  await database
    .prepare(
      "UPDATE report_submissions SET status = 'Accepted', result_report_id = ? WHERE id = 'SUB-DRS-TRIGGER'",
    )
    .bind(reportId)
    .run();
  assert.equal((await syncRow(database, account.id)).generation, 2);

  await database
    .prepare(
      `INSERT INTO reviews (
        id, report_id, account_id, display_name, rating, relationship, title,
        body, status, moderator_notes, author_fingerprint, reviewer_verified,
        created_at, updated_at
      ) VALUES ('REV-DRS-TRIGGER', ?, ?, ?, 3, 'Player', 'Pending trigger review',
        'Synthetic pending review body with enough detail for this test.',
        'Pending', '', 'drs-trigger-review', 1, ?, ?)`,
    )
    .bind(reportId, account.id, account.handle, timestamp, timestamp)
    .run();
  assert.equal((await syncRow(database, account.id)).generation, 2);
  await database
    .prepare(
      `UPDATE discord_rank_sync SET status = 'leased', attempts = 4,
        lease_token = 'synthetic-lease-token-placeholder', lease_expires_at = '2099-01-01T01:00:00.000Z'
       WHERE account_id = ?`,
    )
    .bind(account.id)
    .run();
  await database
    .prepare("UPDATE reviews SET status = 'Approved' WHERE id = 'REV-DRS-TRIGGER'")
    .run();
  const afterReview = await syncRow(database, account.id);
  assert.deepEqual(
    {
      attempts: afterReview.attempts,
      generation: afterReview.generation,
      leaseExpiresAt: afterReview.lease_expires_at,
      leaseToken: afterReview.lease_token,
      status: afterReview.status,
    },
    {
      attempts: 0,
      generation: 3,
      leaseExpiresAt: null,
      leaseToken: null,
      status: "pending",
    },
  );

  await database
    .prepare(
      `INSERT INTO comments (
        id, report_id, parent_id, account_id, display_name, body, status,
        moderator_notes, author_fingerprint, reviewer_verified, created_at, updated_at
      ) VALUES ('COM-DRS-TRIGGER', ?, NULL, ?, ?,
        'Synthetic pending comment body with sufficient detail for testing.',
        'Pending', '', 'drs-trigger-comment', 1, ?, ?)`,
    )
    .bind(reportId, account.id, account.handle, timestamp, timestamp)
    .run();
  assert.equal((await syncRow(database, account.id)).generation, 3);
  await database
    .prepare("UPDATE comments SET status = 'Approved' WHERE id = 'COM-DRS-TRIGGER'")
    .run();
  assert.equal((await syncRow(database, account.id)).generation, 4);
  await database
    .prepare("UPDATE comments SET status = 'Approved' WHERE id = 'COM-DRS-TRIGGER'")
    .run();
  assert.equal((await syncRow(database, account.id)).generation, 4);
  await database.prepare("UPDATE reports SET is_published = 0 WHERE id = ?").bind(reportId).run();
  assert.equal((await syncRow(database, account.id)).generation, 5);
});
