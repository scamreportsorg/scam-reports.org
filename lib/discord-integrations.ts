import { env } from "cloudflare:workers";
import { isValidResendFrom } from "./auth-config";
import { fromBase64Url } from "./auth-crypto";
import { readDiscordRoleSyncConfiguration } from "./discord-api";
import { processDiscordRankSync, type DiscordRankSyncEnvironment } from "./discord-rank-sync";
import {
  createD1DiscordStatusMessageStore,
  publishDiscordStatus,
  type DiscordStatusSnapshot,
  type PublicServiceState,
} from "./discord-status";
import type { DiscordWebhookEnvironment } from "./discord-webhook";
import { processNotificationOutbox } from "./notifications";
import { getD1 } from "./reports";
import { runDiscordSecurityMonitor } from "./discord-security-monitor";
import type { SecurityMonitorEnvironment } from "./security-events";
import { getPublicVersion } from "./version";

type DiscordIntegrationEnvironment = DiscordRankSyncEnvironment &
  DiscordWebhookEnvironment & {
    AUTH_APP_ORIGIN?: string;
    DISCORD_CLIENT_ID?: string;
    DISCORD_CLIENT_SECRET?: string;
    RESEND_API_KEY?: string;
    RESEND_FROM?: string;
    EVIDENCE_DERIVATIVES?: R2Bucket;
  } & SecurityMonitorEnvironment;

type SnapshotOptions = {
  minuteJobsHealthy?: boolean;
  now?: Date;
};

type LatestDeliveryRow = {
  status: string;
};

type RoleSyncHealthRow = {
  circuit_open_until: string | null;
  terminal_count: number | string;
};

type BackupHealthRow = {
  status: string;
  completed_at: string | null;
  started_at: string;
};

export type MinuteDiscordIntegrationResult = {
  notifications: "complete" | "failed";
  rankSync: "complete" | "failed";
  securityMonitor: "complete" | "failed";
  status: "updated" | "skipped" | "failed";
};

function runtimeEnvironment(): DiscordIntegrationEnvironment {
  return env as unknown as DiscordIntegrationEnvironment;
}

function configured(value: string | undefined) {
  const normalized = value?.trim() ?? "";
  return normalized && !normalized.startsWith("replace-with") ? normalized : "";
}

function validIdentityEncryptionKey(value: string | undefined) {
  try {
    return fromBase64Url(configured(value)).byteLength === 32;
  } catch {
    return false;
  }
}

function validOrigin(value: string | undefined): URL | null {
  try {
    const url = new URL(configured(value));
    const local =
      url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if ((url.protocol !== "https:" && !local) || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function databaseState(database: D1Database): Promise<PublicServiceState> {
  try {
    const row = await database.prepare("SELECT 1 AS ready").first<{ ready: number }>();
    return Number(row?.ready) === 1 ? "operational" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function authenticationState(values: DiscordIntegrationEnvironment): PublicServiceState {
  const discord = Boolean(
    configured(values.DISCORD_CLIENT_ID) && configured(values.DISCORD_CLIENT_SECRET).length >= 32,
  );
  const email = Boolean(
    configured(values.RESEND_API_KEY).length >= 32 && isValidResendFrom(values.RESEND_FROM),
  );
  if (discord && email) return "operational";
  if (discord || email) return "degraded";
  return "unavailable";
}

async function evidenceState(values: DiscordIntegrationEnvironment): Promise<PublicServiceState> {
  if (!values.EVIDENCE_DERIVATIVES) return "unavailable";
  try {
    await values.EVIDENCE_DERIVATIVES.head("__discord_status_probe__");
    return "operational";
  } catch {
    return "unavailable";
  }
}

async function emailState(
  database: D1Database,
  values: DiscordIntegrationEnvironment,
): Promise<PublicServiceState> {
  if (configured(values.RESEND_API_KEY).length < 32 || !isValidResendFrom(values.RESEND_FROM)) {
    return "unavailable";
  }
  try {
    const row = await database
      .prepare(
        `SELECT status FROM notification_outbox
         WHERE channel = 'email' ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .first<LatestDeliveryRow>();
    return row?.status === "dead" ? "degraded" : "operational";
  } catch {
    return "unavailable";
  }
}

async function discordRoleState(
  database: D1Database,
  values: DiscordRankSyncEnvironment,
  now: Date,
): Promise<PublicServiceState> {
  const configuration = readDiscordRoleSyncConfiguration(values);
  if (!configuration.enabled) return "maintenance";
  if ("error" in configuration || !validIdentityEncryptionKey(values.IDENTITY_ENCRYPTION_KEY)) {
    return "unavailable";
  }
  try {
    const row = await database
      .prepare(
        `SELECT control.circuit_open_until,
          (SELECT COUNT(*) FROM discord_rank_sync WHERE status = 'terminal') AS terminal_count
         FROM discord_rank_sync_control control WHERE control.id = 'global' LIMIT 1`,
      )
      .first<RoleSyncHealthRow>();
    if (!row) return "unavailable";
    if (row.circuit_open_until && Date.parse(row.circuit_open_until) > now.getTime()) {
      return "unavailable";
    }
    return Number(row.terminal_count) > 0 ? "degraded" : "operational";
  } catch {
    return "unavailable";
  }
}

async function backupState(database: D1Database, now: Date): Promise<PublicServiceState> {
  try {
    const row = await database
      .prepare(
        `SELECT status, completed_at, started_at FROM backup_runs
         ORDER BY started_at DESC, id DESC LIMIT 1`,
      )
      .first<BackupHealthRow>();
    if (!row) return "unknown";
    if (row.status === "failed") return "degraded";
    if (row.status === "running") return "operational";
    if (row.status !== "complete" && row.status !== "completed") return "unknown";
    const timestamp = Date.parse(row.completed_at ?? row.started_at);
    return Number.isFinite(timestamp) && now.getTime() - timestamp <= 8 * 24 * 60 * 60_000
      ? "operational"
      : "degraded";
  } catch {
    return "unavailable";
  }
}

export async function buildDiscordStatusSnapshot(
  database: D1Database,
  values: DiscordIntegrationEnvironment,
  options: SnapshotOptions = {},
): Promise<DiscordStatusSnapshot> {
  const now = options.now ?? new Date();
  const origin = validOrigin(values.AUTH_APP_ORIGIN);
  const version = getPublicVersion();
  const website: PublicServiceState = origin ? "operational" : "unavailable";
  const api: PublicServiceState =
    origin && Number.isInteger(version.schemaVersion) && version.schemaVersion > 0
      ? "operational"
      : "unavailable";
  const [databaseHealth, evidence, email, discordRoles, backups] = await Promise.all([
    databaseState(database),
    evidenceState(values),
    emailState(database, values),
    discordRoleState(database, values, now),
    backupState(database, now),
  ]);

  return {
    website,
    api,
    database: databaseHealth,
    authentication: authenticationState(values),
    evidence,
    email,
    discordRoles,
    backups,
    scheduledJobs: options.minuteJobsHealthy === false ? "degraded" : "operational",
    version: version.version,
    updatedAt: now.toISOString(),
  };
}

export async function runMinuteDiscordIntegrations(): Promise<MinuteDiscordIntegrationResult> {
  const database = getD1();
  const values = runtimeEnvironment();
  const [notificationRun, rankRun, securityRun] = await Promise.allSettled([
    processNotificationOutbox(25),
    processDiscordRankSync(database, values, { limit: 25 }),
    runDiscordSecurityMonitor(database, values),
  ]);
  const result: MinuteDiscordIntegrationResult = {
    notifications: notificationRun.status === "fulfilled" ? "complete" : "failed",
    rankSync: rankRun.status === "fulfilled" ? "complete" : "failed",
    securityMonitor: securityRun.status === "fulfilled" ? "complete" : "failed",
    status: "skipped",
  };

  if (!configured(values.DISCORD_STATUS_WEBHOOK_URL)) return result;

  try {
    const snapshot = await buildDiscordStatusSnapshot(database, values, {
      minuteJobsHealthy:
        notificationRun.status === "fulfilled" &&
        rankRun.status === "fulfilled" &&
        securityRun.status === "fulfilled",
    });
    await publishDiscordStatus(snapshot, {
      webhookEnvironment: values,
      store: createD1DiscordStatusMessageStore(database),
    });
    result.status = "updated";
  } catch {
    result.status = "failed";
  }
  return result;
}
