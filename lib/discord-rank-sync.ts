import {
  DiscordApiError,
  DiscordRoleApi,
  DISCORD_RANK_LEVELS,
  type DiscordRankLevel,
  type DiscordRoleSyncEnvironment,
  readDiscordRoleSyncConfiguration,
  safeDiscordCommunityInviteUrl,
} from "./discord-api";
import { decryptIdentity, fromBase64Url } from "./auth-crypto";
import { communityActivityFromCounts, COMMUNITY_RANK_LADDER } from "./community-ranks";

const LEASE_MILLISECONDS = 2 * 60_000;
const RECONCILE_MILLISECONDS = 6 * 60 * 60_000;
const NOT_IN_GUILD_MILLISECONDS = 24 * 60 * 60_000;
const CIRCUIT_MILLISECONDS = 15 * 60_000;
const MAX_BATCH = 50;

export type DiscordRankSyncEnvironment = DiscordRoleSyncEnvironment & {
  IDENTITY_ENCRYPTION_KEY?: string;
};

type SyncRow = {
  id: string;
  account_id: string | null;
  subject_hash: string;
  subject_encrypted: string;
  generation: number;
  desired_rank_level: number;
  applied_rank_level: number | null;
  status: string;
  attempts: number;
  next_attempt_at: string;
  next_reconcile_at: string;
  lease_token: string | null;
  lease_expires_at: string | null;
};

type ActivityRow = {
  account_status: string;
  activity_account_id: string | null;
  approved_report_count: number | string | null;
  approved_review_count: number | string | null;
  approved_comment_count: number | string | null;
  score_eligible_comment_count: number | string | null;
};

type SyncOptions = {
  fetch?: typeof fetch;
  limit?: number;
  now?: Date;
  random?: () => number;
  timeoutMs?: number;
};

export type DiscordRankSyncRunResult = {
  configured: boolean;
  configurationError: boolean;
  circuitOpen: boolean;
  claimed: number;
  synced: number;
  notInGuild: number;
  failed: number;
  staleCompletions: number;
};

export type DiscordRankSyncStatus = {
  configured: boolean;
  status: "pending" | "syncing" | "synced" | "not_in_guild" | "failed" | "disabled";
  desiredRank: { level: DiscordRankLevel; name: string } | null;
  appliedRank: { level: DiscordRankLevel; name: string } | null;
  lastCheckedAt: string | null;
  lastSyncedAt: string | null;
  communityInviteUrl: string | null;
};

type DiscordRankSyncStatusOptions = {
  database?: D1Database;
  values?: DiscordRankSyncEnvironment;
};

async function runtimeDatabase(): Promise<D1Database> {
  const { getD1 } = await import("./reports");
  return getD1();
}

async function runtimeValues(): Promise<DiscordRankSyncEnvironment> {
  const { env } = await import("cloudflare:workers");
  return env as unknown as DiscordRankSyncEnvironment;
}

function emptyRun(values: Partial<DiscordRankSyncRunResult> = {}): DiscordRankSyncRunResult {
  return {
    configured: false,
    configurationError: false,
    circuitOpen: false,
    claimed: 0,
    synced: 0,
    notInGuild: 0,
    failed: 0,
    staleCompletions: 0,
    ...values,
  };
}

function validEncryptionKey(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return fromBase64Url(value).byteLength === 32;
  } catch {
    return false;
  }
}

function boundedLimit(value: number | undefined) {
  return Number.isInteger(value) ? Math.max(1, Math.min(Number(value), MAX_BATCH)) : 20;
}

function later(now: Date, milliseconds: number) {
  return new Date(now.getTime() + milliseconds).toISOString();
}

function safeRandom(random: () => number) {
  const value = random();
  return Number.isFinite(value) ? Math.min(0.999_999, Math.max(0, value)) : 0;
}

function retryJitter(random: () => number) {
  return 250 + Math.floor(safeRandom(random) * 501);
}

function retryDelay(attempts: number, random: () => number) {
  const exponent = Math.max(0, Math.min(8, attempts - 1));
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** exponent) + retryJitter(random);
}

function rankLevel(value: number): DiscordRankLevel {
  if (DISCORD_RANK_LEVELS.includes(value as DiscordRankLevel)) {
    return value as DiscordRankLevel;
  }
  return 1;
}

function rankSummary(value: number | null): { level: DiscordRankLevel; name: string } | null {
  if (value === null || !DISCORD_RANK_LEVELS.includes(value as DiscordRankLevel)) return null;
  const rank = COMMUNITY_RANK_LADDER.find((candidate) => candidate.level === value);
  return rank ? { level: rank.level, name: rank.name } : null;
}

function safeTimestamp(value: string | null) {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

async function seedMissingRows(database: D1Database, now: string, limit: number) {
  await database
    .prepare(
      `INSERT OR IGNORE INTO discord_rank_sync (
        id, account_id, subject_hash, subject_encrypted, generation,
        desired_rank_level, applied_rank_level, status, attempts,
        next_attempt_at, next_reconcile_at, lease_token, lease_expires_at,
        last_error_code, last_checked_at, last_synced_at, created_at, updated_at
      )
      SELECT 'drs_' || lower(hex(randomblob(16))), identity.account_id,
        identity.subject_hash, identity.subject_encrypted, 1, 0, NULL,
        'pending', 0, ?, ?, NULL, NULL, '', NULL, NULL, ?, ?
      FROM account_identities identity
      LEFT JOIN discord_rank_sync sync ON sync.subject_hash = identity.subject_hash
      WHERE identity.provider = 'discord' AND sync.id IS NULL
      ORDER BY identity.id ASC LIMIT ?`,
    )
    .bind(now, now, now, now, limit)
    .run();
}

async function circuitOpen(database: D1Database, now: string) {
  const row = await database
    .prepare(
      `SELECT circuit_open_until FROM discord_rank_sync_control
       WHERE id = 'global' LIMIT 1`,
    )
    .first<{ circuit_open_until: string | null }>();
  return Boolean(row?.circuit_open_until && row.circuit_open_until > now);
}

async function openCircuit(
  database: D1Database,
  now: Date,
  code: string,
  duration = CIRCUIT_MILLISECONDS,
) {
  await database
    .prepare(
      `INSERT INTO discord_rank_sync_control
        (id, circuit_open_until, last_error_code, updated_at)
       VALUES ('global', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET circuit_open_until = excluded.circuit_open_until,
         last_error_code = excluded.last_error_code, updated_at = excluded.updated_at`,
    )
    .bind(later(now, duration), code, now.toISOString())
    .run();
}

async function closeCircuit(database: D1Database, now: Date) {
  await database
    .prepare(
      `UPDATE discord_rank_sync_control
       SET circuit_open_until = NULL, last_error_code = '', updated_at = ?
       WHERE id = 'global'`,
    )
    .bind(now.toISOString())
    .run();
}

async function dueRows(database: D1Database, now: string, limit: number) {
  return database
    .prepare(
      `SELECT id, account_id, subject_hash, subject_encrypted, generation,
        desired_rank_level, applied_rank_level, status, attempts,
        next_attempt_at, next_reconcile_at, lease_token, lease_expires_at
       FROM discord_rank_sync
       WHERE (
         (status IN ('pending', 'failed') AND next_attempt_at <= ?)
         OR (status = 'leased' AND lease_expires_at <= ?)
         OR (status IN ('synced', 'not_in_guild') AND next_reconcile_at <= ?)
       )
       ORDER BY
         CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1
           WHEN 'leased' THEN 2 ELSE 3 END,
         next_attempt_at ASC, updated_at ASC, id ASC
       LIMIT ?`,
    )
    .bind(now, now, now, limit)
    .all<SyncRow>();
}

async function claimRow(database: D1Database, row: SyncRow, now: Date) {
  const leaseToken = crypto.randomUUID();
  const claimed = await database
    .prepare(
      `UPDATE discord_rank_sync
       SET status = 'leased', attempts = attempts + 1, lease_token = ?,
         lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND generation = ? AND (
         (status IN ('pending', 'failed') AND next_attempt_at <= ?)
         OR (status = 'leased' AND lease_expires_at <= ?)
         OR (status IN ('synced', 'not_in_guild') AND next_reconcile_at <= ?)
       )
       RETURNING id, account_id, subject_hash, subject_encrypted, generation,
         desired_rank_level, applied_rank_level, status, attempts,
         next_attempt_at, next_reconcile_at, lease_token, lease_expires_at`,
    )
    .bind(
      leaseToken,
      later(now, LEASE_MILLISECONDS),
      now.toISOString(),
      row.id,
      row.generation,
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
    )
    .first<SyncRow>();
  return claimed;
}

async function activityForSyncRow(database: D1Database, row: SyncRow) {
  if (!row.account_id) return null;
  return database
    .prepare(
      `SELECT account.status AS account_status,
        activity.account_id AS activity_account_id,
        activity.approved_report_count, activity.approved_review_count,
        activity.approved_comment_count, activity.score_eligible_comment_count
       FROM accounts account
       INNER JOIN account_identities identity
         ON identity.account_id = account.id
         AND identity.provider = 'discord'
         AND identity.subject_hash = ?
       LEFT JOIN public_member_activity activity ON activity.account_id = account.id
       WHERE account.id = ? LIMIT 1`,
    )
    .bind(row.subject_hash, row.account_id)
    .first<ActivityRow>();
}

async function leaseIsCurrent(database: D1Database, row: SyncRow) {
  const current = await database
    .prepare(
      `SELECT 1 AS current FROM discord_rank_sync
       WHERE id = ? AND generation = ? AND status = 'leased' AND lease_token = ?
       LIMIT 1`,
    )
    .bind(row.id, row.generation, row.lease_token)
    .first<{ current: number }>();
  return current?.current === 1;
}

function desiredLevel(activity: ActivityRow | null): 0 | DiscordRankLevel {
  if (!activity || activity.account_status !== "active") return 0;
  return rankLevel(
    communityActivityFromCounts({
      approvedReports: Number(activity.approved_report_count) || 0,
      approvedReviews: Number(activity.approved_review_count) || 0,
      approvedComments: Number(activity.approved_comment_count) || 0,
      scoreEligibleComments: Number(activity.score_eligible_comment_count) || 0,
    }).rank.level,
  );
}

async function finishSuccess(
  database: D1Database,
  row: SyncRow,
  desired: 0 | DiscordRankLevel,
  deleteAfterCleanup: boolean,
  now: Date,
) {
  if (deleteAfterCleanup && desired === 0) {
    const result = await database
      .prepare(
        `DELETE FROM discord_rank_sync
         WHERE id = ? AND generation = ? AND status = 'leased' AND lease_token = ?`,
      )
      .bind(row.id, row.generation, row.lease_token)
      .run();
    return Number(result.meta.changes) > 0;
  }
  const result = await database
    .prepare(
      `UPDATE discord_rank_sync
       SET desired_rank_level = ?, applied_rank_level = ?, status = 'synced',
         attempts = 0, next_attempt_at = ?, next_reconcile_at = ?,
         lease_token = NULL, lease_expires_at = NULL, last_error_code = '',
         last_checked_at = ?, last_synced_at = ?, updated_at = ?
       WHERE id = ? AND generation = ? AND status = 'leased' AND lease_token = ?`,
    )
    .bind(
      desired,
      desired,
      later(now, RECONCILE_MILLISECONDS),
      later(now, RECONCILE_MILLISECONDS),
      now.toISOString(),
      now.toISOString(),
      now.toISOString(),
      row.id,
      row.generation,
      row.lease_token,
    )
    .run();
  return Number(result.meta.changes) > 0;
}

async function finishFailure(
  database: D1Database,
  row: SyncRow,
  input: {
    desired: 0 | DiscordRankLevel;
    status: "failed" | "not_in_guild" | "terminal";
    code: string;
    retryAt: string;
  },
  now: Date,
) {
  const result = await database
    .prepare(
      `UPDATE discord_rank_sync
       SET desired_rank_level = ?, status = ?, next_attempt_at = ?,
         next_reconcile_at = ?, lease_token = NULL, lease_expires_at = NULL,
         last_error_code = ?, last_checked_at = ?, updated_at = ?
       WHERE id = ? AND generation = ? AND status = 'leased' AND lease_token = ?`,
    )
    .bind(
      input.desired,
      input.status,
      input.retryAt,
      input.retryAt,
      input.code,
      now.toISOString(),
      now.toISOString(),
      row.id,
      row.generation,
      row.lease_token,
    )
    .run();
  return Number(result.meta.changes) > 0;
}

export async function processDiscordRankSync(
  database: D1Database,
  values: DiscordRankSyncEnvironment,
  options: SyncOptions = {},
): Promise<DiscordRankSyncRunResult> {
  const configuration = readDiscordRoleSyncConfiguration(values);
  if (!configuration.enabled) return emptyRun();
  if ("error" in configuration || !validEncryptionKey(values.IDENTITY_ENCRYPTION_KEY)) {
    return emptyRun({ configurationError: true });
  }

  const result = emptyRun({ configured: true });
  const now = options.now ?? new Date();
  const nowText = now.toISOString();
  if (await circuitOpen(database, nowText)) return { ...result, circuitOpen: true };

  const limit = boundedLimit(options.limit);
  await seedMissingRows(database, nowText, limit);
  const candidates = await dueRows(database, nowText, limit);
  const api = new DiscordRoleApi(configuration.config, {
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  const random = options.random ?? Math.random;

  if (candidates.results.length === 0) return result;
  try {
    await api.preflightManagedRoles();
    await closeCircuit(database, now);
  } catch (error) {
    const failure =
      error instanceof DiscordApiError
        ? error
        : new DiscordApiError("retryable", "discord_preflight_failed");
    const delay =
      failure.kind === "rate_limited"
        ? (failure.retryAfterMs ?? 60_000) + retryJitter(random)
        : failure.kind === "retryable"
          ? retryDelay(1, random)
          : CIRCUIT_MILLISECONDS;
    await openCircuit(database, now, failure.code, delay);
    return { ...result, circuitOpen: true, failed: 1 };
  }

  for (const candidate of candidates.results) {
    if (result.circuitOpen) break;
    const row = await claimRow(database, candidate, now);
    if (!row) continue;
    result.claimed += 1;
    const activity = await activityForSyncRow(database, row);
    const desired = desiredLevel(activity);
    const deleteAfterCleanup = activity === null;

    let discordUserId: string;
    try {
      discordUserId = await decryptIdentity(values.IDENTITY_ENCRYPTION_KEY, row.subject_encrypted);
    } catch {
      const changed = await finishFailure(
        database,
        row,
        {
          desired,
          status: "terminal",
          code: "identity_decryption_failed",
          retryAt: later(now, NOT_IN_GUILD_MILLISECONDS),
        },
        now,
      );
      if (!changed) result.staleCompletions += 1;
      result.failed += 1;
      continue;
    }

    try {
      const member = await api.getGuildMember(discordUserId);
      if (!(await leaseIsCurrent(database, row))) {
        result.staleCompletions += 1;
        continue;
      }
      const desiredRoleId = desired === 0 ? null : api.managedRoleId(desired);
      const unwantedRoles = member.roles.filter(
        (roleId) => api.isManagedRole(roleId) && roleId !== desiredRoleId,
      );
      for (const roleId of unwantedRoles) {
        if (!(await leaseIsCurrent(database, row))) {
          break;
        }
        await api.removeMemberRole(discordUserId, roleId);
      }
      if (!(await leaseIsCurrent(database, row))) {
        result.staleCompletions += 1;
        continue;
      }
      if (desiredRoleId && !member.roles.includes(desiredRoleId)) {
        await api.addMemberRole(discordUserId, desiredRoleId);
      }
      const changed = await finishSuccess(database, row, desired, deleteAfterCleanup, now);
      if (changed) result.synced += 1;
      else result.staleCompletions += 1;
    } catch (error) {
      const failure =
        error instanceof DiscordApiError
          ? error
          : new DiscordApiError("retryable", "discord_sync_failed");
      if (failure.kind === "not_in_guild") {
        if (deleteAfterCleanup) {
          const changed = await finishSuccess(database, row, 0, true, now);
          if (changed) result.synced += 1;
          else result.staleCompletions += 1;
        } else {
          const changed = await finishFailure(
            database,
            row,
            {
              desired,
              status: "not_in_guild",
              code: failure.code,
              retryAt: later(now, NOT_IN_GUILD_MILLISECONDS),
            },
            now,
          );
          if (!changed) result.staleCompletions += 1;
          result.notInGuild += 1;
        }
        continue;
      }

      const opensCircuit =
        failure.code === "discord_auth_rejected" ||
        failure.code === "discord_permission_rejected" ||
        failure.code === "discord_managed_role_not_found";
      if (opensCircuit) {
        await openCircuit(database, now, failure.code);
        result.circuitOpen = true;
      }
      const rateDelay =
        failure.kind === "rate_limited"
          ? (failure.retryAfterMs ?? 60_000) + retryJitter(random)
          : retryDelay(row.attempts, random);
      const changed = await finishFailure(
        database,
        row,
        {
          desired,
          status: failure.kind === "terminal" ? "terminal" : "failed",
          code: failure.code,
          retryAt: later(now, opensCircuit ? CIRCUIT_MILLISECONDS : rateDelay),
        },
        now,
      );
      if (!changed) result.staleCompletions += 1;
      result.failed += 1;
      if (failure.kind === "rate_limited") break;
    }
  }
  return result;
}

export async function requestDiscordRankSync(
  accountId: string,
  database?: D1Database,
): Promise<boolean> {
  if (!accountId || accountId.length > 200) return false;
  const target = database ?? (await runtimeDatabase());
  const now = new Date().toISOString();
  // Incrementing the generation invalidates any in-flight lease.
  const result = await target
    .prepare(
      `INSERT INTO discord_rank_sync (
        id, account_id, subject_hash, subject_encrypted, generation,
        desired_rank_level, applied_rank_level, status, attempts,
        next_attempt_at, next_reconcile_at, lease_token, lease_expires_at,
        last_error_code, last_checked_at, last_synced_at, created_at, updated_at
      )
      SELECT 'drs_' || lower(hex(randomblob(16))), identity.account_id,
        identity.subject_hash, identity.subject_encrypted, 1, 0, NULL,
        'pending', 0, ?, ?, NULL, NULL, '', NULL, NULL, ?, ?
      FROM account_identities identity
      INNER JOIN accounts account ON account.id = identity.account_id
      WHERE identity.account_id = ? AND identity.provider = 'discord'
      ON CONFLICT(subject_hash) DO UPDATE SET
        account_id = excluded.account_id,
        subject_encrypted = excluded.subject_encrypted,
        generation = discord_rank_sync.generation + 1,
        status = 'pending', attempts = 0,
        next_attempt_at = excluded.next_attempt_at,
        next_reconcile_at = excluded.next_reconcile_at,
        lease_token = NULL, lease_expires_at = NULL,
        last_error_code = '', updated_at = excluded.updated_at`,
    )
    .bind(now, now, now, now, accountId)
    .run();
  return Number(result.meta.changes) === 1;
}

export async function purgeExpiredDiscordRankOrphans(
  limit = 100,
  currentTime = new Date(),
  database?: D1Database,
) {
  const target = database ?? (await runtimeDatabase());
  const now = currentTime.toISOString();
  const boundedLimit = Math.max(1, Math.min(limit, 500));
  const rows = await target
    .prepare(
      `SELECT id FROM discord_rank_sync
       WHERE account_id IS NULL AND orphan_purge_after IS NOT NULL AND orphan_purge_after <= ?
       ORDER BY orphan_purge_after ASC, id ASC LIMIT ?`,
    )
    .bind(now, boundedLimit)
    .all<{ id: string }>();
  if (rows.results.length === 0) return { purged: 0 };

  const statements = rows.results.map((row) =>
    target
      .prepare(
        `DELETE FROM discord_rank_sync
         WHERE id = ? AND account_id IS NULL
           AND orphan_purge_after IS NOT NULL AND orphan_purge_after <= ?`,
      )
      .bind(row.id, now),
  );
  const results = await target.batch(statements);
  return { purged: results.filter((result) => result.meta.changes > 0).length };
}

export async function getDiscordRankSyncStatus(
  accountId: string,
  options: DiscordRankSyncStatusOptions = {},
): Promise<DiscordRankSyncStatus> {
  const [database, values] = await Promise.all([
    options.database ? Promise.resolve(options.database) : runtimeDatabase(),
    options.values ? Promise.resolve(options.values) : runtimeValues(),
  ]);
  const inviteUrl = safeDiscordCommunityInviteUrl(values.DISCORD_COMMUNITY_INVITE_URL);
  const configuration = readDiscordRoleSyncConfiguration(values);
  const configured =
    configuration.enabled &&
    !("error" in configuration) &&
    validEncryptionKey(values.IDENTITY_ENCRYPTION_KEY);
  if (!configured) {
    return {
      configured: false,
      status: "disabled",
      desiredRank: null,
      appliedRank: null,
      lastCheckedAt: null,
      lastSyncedAt: null,
      communityInviteUrl: inviteUrl,
    };
  }

  const row = await database
    .prepare(
      `SELECT sync.applied_rank_level, sync.status,
        sync.last_checked_at, sync.last_synced_at,
        account.status AS account_status,
        activity.account_id AS activity_account_id,
        activity.approved_report_count, activity.approved_review_count,
        activity.approved_comment_count, activity.score_eligible_comment_count
       FROM accounts account
       LEFT JOIN public_member_activity activity ON activity.account_id = account.id
       LEFT JOIN discord_rank_sync sync ON sync.account_id = account.id
       WHERE account.id = ? LIMIT 1`,
    )
    .bind(accountId)
    .first<
      {
        applied_rank_level: number | null;
        status: string | null;
        last_checked_at: string | null;
        last_synced_at: string | null;
      } & ActivityRow
    >();
  const status: DiscordRankSyncStatus["status"] = !row
    ? "pending"
    : row.status === "leased"
      ? "syncing"
      : row.status === "synced"
        ? "synced"
        : row.status === "not_in_guild"
          ? "not_in_guild"
          : row.status === "pending"
            ? "pending"
            : row.status === "disabled"
              ? "disabled"
              : "failed";
  return {
    configured: true,
    status,
    desiredRank: row ? rankSummary(desiredLevel(row)) : null,
    appliedRank: rankSummary(row?.applied_rank_level ?? null),
    lastCheckedAt: safeTimestamp(row?.last_checked_at ?? null),
    lastSyncedAt: safeTimestamp(row?.last_synced_at ?? null),
    communityInviteUrl: inviteUrl,
  };
}
