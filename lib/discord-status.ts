import {
  DiscordWebhookError,
  discordWebhookDestination,
  editDiscordWebhookMessage,
  executeDiscordWebhook,
  requireDiscordWebhookUrl,
  type DiscordWebhookEnvironment,
  type DiscordWebhookPayload,
  type DiscordWebhookRequestOptions,
} from "./discord-webhook";

export const DISCORD_STATUS_SINGLETON_ID = "primary" as const;

export type PublicServiceState =
  | "operational"
  | "degraded"
  | "unavailable"
  | "maintenance"
  | "unknown";

export type DiscordStatusSnapshot = {
  website: PublicServiceState;
  api: PublicServiceState;
  database: PublicServiceState;
  authentication: PublicServiceState;
  evidence: PublicServiceState;
  email: PublicServiceState;
  discordRoles: PublicServiceState;
  backups: PublicServiceState;
  scheduledJobs: PublicServiceState;
  version: string;
  updatedAt: string;
};

export type DiscordStatusMessageRecord = {
  id: typeof DISCORD_STATUS_SINGLETON_ID;
  messageId: string | null;
  webhookFingerprint: string;
  deliveryState: "active" | "disabled";
  updatedAt: string;
};

export type DiscordStatusStoreExpectation = {
  messageId: string | null;
  webhookFingerprint: string | null;
};

export type DiscordStatusMessageStore = {
  read(id: typeof DISCORD_STATUS_SINGLETON_ID): Promise<DiscordStatusMessageRecord | null>;
  write(record: DiscordStatusMessageRecord, expected: DiscordStatusStoreExpectation): Promise<void>;
};

type DiscordStatusDatabaseRow = {
  id: string;
  message_id: string | null;
  webhook_fingerprint: string;
  delivery_state: string;
  updated_at: string;
};

const MESSAGE_ID_PATTERN = /^[0-9]{15,22}$/u;
const WEBHOOK_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;

export class DiscordStatusStoreConflictError extends Error {
  constructor() {
    super("The Discord status state changed during this update.");
    this.name = "DiscordStatusStoreConflictError";
  }
}

function validStatusRecord(record: DiscordStatusMessageRecord): boolean {
  return (
    record.id === DISCORD_STATUS_SINGLETON_ID &&
    (record.messageId === null || MESSAGE_ID_PATTERN.test(record.messageId)) &&
    WEBHOOK_FINGERPRINT_PATTERN.test(record.webhookFingerprint) &&
    (record.deliveryState === "active" || record.deliveryState === "disabled") &&
    Number.isFinite(Date.parse(record.updatedAt))
  );
}

function statusRecord(row: DiscordStatusDatabaseRow): DiscordStatusMessageRecord {
  if (row.delivery_state !== "active" && row.delivery_state !== "disabled") {
    throw new Error("The stored Discord status state is invalid.");
  }
  const record: DiscordStatusMessageRecord = {
    id: DISCORD_STATUS_SINGLETON_ID,
    messageId: row.message_id,
    webhookFingerprint: row.webhook_fingerprint,
    deliveryState: row.delivery_state,
    updatedAt: row.updated_at,
  };
  if (row.id !== DISCORD_STATUS_SINGLETON_ID || !validStatusRecord(record)) {
    throw new Error("The stored Discord status state is invalid.");
  }
  return record;
}

function validExpectation(expected: DiscordStatusStoreExpectation): boolean {
  return (
    (expected.messageId === null || MESSAGE_ID_PATTERN.test(expected.messageId)) &&
    (expected.webhookFingerprint === null ||
      WEBHOOK_FINGERPRINT_PATTERN.test(expected.webhookFingerprint)) &&
    (expected.webhookFingerprint !== null || expected.messageId === null)
  );
}

export function createD1DiscordStatusMessageStore(database: D1Database): DiscordStatusMessageStore {
  return {
    async read(id) {
      if (id !== DISCORD_STATUS_SINGLETON_ID) {
        throw new Error("The Discord status singleton ID is invalid.");
      }
      const row = await database
        .prepare(
          `SELECT id, message_id, webhook_fingerprint, delivery_state, updated_at
          FROM discord_status_messages WHERE id = ? LIMIT 1`,
        )
        .bind(DISCORD_STATUS_SINGLETON_ID)
        .first<DiscordStatusDatabaseRow>();
      return row ? statusRecord(row) : null;
    },

    async write(record, expected) {
      if (!validStatusRecord(record) || !validExpectation(expected)) {
        throw new Error("The Discord status state update is invalid.");
      }

      // Compare both fields so an old publisher cannot revive stale status state.
      const result =
        expected.webhookFingerprint === null
          ? await database
              .prepare(
                `INSERT OR IGNORE INTO discord_status_messages
                (id, message_id, webhook_fingerprint, delivery_state, updated_at)
                VALUES (?, ?, ?, ?, ?)`,
              )
              .bind(
                DISCORD_STATUS_SINGLETON_ID,
                record.messageId,
                record.webhookFingerprint,
                record.deliveryState,
                record.updatedAt,
              )
              .run()
          : await database
              .prepare(
                `UPDATE discord_status_messages
                SET message_id = ?, webhook_fingerprint = ?, delivery_state = ?, updated_at = ?
                WHERE id = ? AND webhook_fingerprint = ? AND message_id IS ?`,
              )
              .bind(
                record.messageId,
                record.webhookFingerprint,
                record.deliveryState,
                record.updatedAt,
                DISCORD_STATUS_SINGLETON_ID,
                expected.webhookFingerprint,
                expected.messageId,
              )
              .run();
      if (Number(result.meta.changes) !== 1) throw new DiscordStatusStoreConflictError();
    },
  };
}

type PublishDiscordStatusOptions = DiscordWebhookRequestOptions & {
  webhookEnvironment: DiscordWebhookEnvironment;
  store: DiscordStatusMessageStore;
};

const STATE_LABELS: Record<PublicServiceState, string> = {
  operational: "Operational",
  degraded: "Degraded",
  unavailable: "Unavailable",
  maintenance: "Maintenance",
  unknown: "Unknown",
};

function stateLabel(value: PublicServiceState): string {
  return STATE_LABELS[value] ?? STATE_LABELS.unknown;
}

const STATE_MARKS: Record<PublicServiceState, string> = {
  operational: "🟢",
  degraded: "🟠",
  unavailable: "🔴",
  maintenance: "🟡",
  unknown: "⚪",
};

function stateLine(name: string, state: PublicServiceState): string {
  return `${STATE_MARKS[state]} **${name}**\n${stateLabel(state)}`;
}

function overallStatus(snapshot: DiscordStatusSnapshot): {
  color: number;
  title: string;
} {
  const core = [
    snapshot.website,
    snapshot.api,
    snapshot.database,
    snapshot.authentication,
    snapshot.scheduledJobs,
  ];
  if (core.includes("unavailable")) {
    return { color: 0xed4245, title: "Service interruption" };
  }
  if (core.includes("degraded")) {
    return { color: 0xfee75c, title: "Degraded performance" };
  }
  return { color: 0x57f287, title: "Core systems operational" };
}

function publicVersion(value: string): string {
  const version = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/u.test(version) ? version : "unknown";
}

function publicTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date(0).toISOString();
}

export async function discordWebhookFingerprint(destination: string): Promise<string> {
  const webhook = requireDiscordWebhookUrl(destination);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(webhook));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildDiscordStatusPayload(snapshot: DiscordStatusSnapshot): DiscordWebhookPayload {
  const updatedAt = publicTimestamp(snapshot.updatedAt);
  const updatedUnix = Math.floor(Date.parse(updatedAt) / 1000);
  const overall = overallStatus(snapshot);
  return {
    content: "",
    embeds: [
      {
        title: overall.title,
        url: "https://scam-reports.org/",
        description: `Live internal checks · Updated <t:${updatedUnix}:R>`,
        color: overall.color,
        thumbnail: { url: "https://scam-reports.org/brand/sr-mark.png" },
        fields: [
          {
            name: "Core",
            value: [
              stateLine("Website", snapshot.website),
              stateLine("API", snapshot.api),
              stateLine("Database", snapshot.database),
              stateLine("Sign-in", snapshot.authentication),
            ].join("\n\n"),
            inline: true,
          },
          {
            name: "Services",
            value: [
              stateLine("Evidence", snapshot.evidence),
              stateLine("Email", snapshot.email),
              stateLine("Discord roles", snapshot.discordRoles),
              stateLine("Backups", snapshot.backups),
            ].join("\n\n"),
            inline: true,
          },
          {
            name: "Automation",
            value: stateLine("Scheduled jobs", snapshot.scheduledJobs),
            inline: true,
          },
        ],
        footer: { text: `Scam-Reports.org · ${publicVersion(snapshot.version)}` },
        timestamp: updatedAt,
      },
    ],
  };
}

function storeExpectation(
  current: DiscordStatusMessageRecord | null,
): DiscordStatusStoreExpectation {
  return {
    messageId: current?.messageId ?? null,
    webhookFingerprint: current?.webhookFingerprint ?? null,
  };
}

async function rememberMessage(
  store: DiscordStatusMessageStore,
  current: DiscordStatusMessageRecord | null,
  messageId: string,
  webhookFingerprint: string,
  updatedAt: string,
) {
  await store.write(
    {
      id: DISCORD_STATUS_SINGLETON_ID,
      messageId,
      webhookFingerprint,
      deliveryState: "active",
      updatedAt: publicTimestamp(updatedAt),
    },
    storeExpectation(current),
  );
}

function opensStatusCircuit(error: unknown): error is DiscordWebhookError {
  return (
    error instanceof DiscordWebhookError &&
    !error.retryable &&
    (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 404)
  );
}

async function disableStatusDelivery(
  store: DiscordStatusMessageStore,
  current: DiscordStatusMessageRecord | null,
  webhookFingerprint: string,
  messageId: string | null,
  updatedAt: string,
) {
  await store.write(
    {
      id: DISCORD_STATUS_SINGLETON_ID,
      messageId,
      webhookFingerprint,
      deliveryState: "disabled",
      updatedAt: publicTimestamp(updatedAt),
    },
    storeExpectation(current),
  );
}

async function clearMissingStatusMessage(
  store: DiscordStatusMessageStore,
  current: DiscordStatusMessageRecord | null,
  webhookFingerprint: string,
  updatedAt: string,
): Promise<DiscordStatusMessageRecord> {
  const missing: DiscordStatusMessageRecord = {
    id: DISCORD_STATUS_SINGLETON_ID,
    messageId: null,
    webhookFingerprint,
    deliveryState: "active",
    updatedAt: publicTimestamp(updatedAt),
  };
  await store.write(missing, storeExpectation(current));
  return missing;
}

export async function publishDiscordStatus(
  snapshot: DiscordStatusSnapshot,
  options: PublishDiscordStatusOptions,
): Promise<{
  action: "created" | "edited" | "recreated" | "disabled";
  messageId: string | null;
}> {
  const destination = discordWebhookDestination(options.webhookEnvironment, "status");
  const webhookFingerprint = await discordWebhookFingerprint(destination);
  const payload = buildDiscordStatusPayload(snapshot);
  const current = await options.store.read(DISCORD_STATUS_SINGLETON_ID);
  const requestOptions: DiscordWebhookRequestOptions = {
    fetchImpl: options.fetchImpl,
    random: options.random,
    timeoutMs: options.timeoutMs,
  };

  if (current?.deliveryState === "disabled" && current.webhookFingerprint === webhookFingerprint) {
    return { action: "disabled", messageId: current.messageId };
  }

  const currentMessageId =
    current?.webhookFingerprint === webhookFingerprint ? current.messageId : null;

  if (!currentMessageId) {
    let messageId: string;
    try {
      messageId = await executeDiscordWebhook(destination, payload, requestOptions);
    } catch (error) {
      if (opensStatusCircuit(error)) {
        await disableStatusDelivery(
          options.store,
          current,
          webhookFingerprint,
          null,
          snapshot.updatedAt,
        );
      }
      throw error;
    }
    await rememberMessage(
      options.store,
      current,
      messageId,
      webhookFingerprint,
      snapshot.updatedAt,
    );
    return { action: "created", messageId };
  }

  try {
    const messageId = await editDiscordWebhookMessage(
      destination,
      currentMessageId,
      payload,
      requestOptions,
    );
    await rememberMessage(
      options.store,
      current,
      messageId,
      webhookFingerprint,
      snapshot.updatedAt,
    );
    return { action: "edited", messageId };
  } catch (error) {
    if (!(error instanceof DiscordWebhookError) || error.code !== "not_found") {
      if (opensStatusCircuit(error)) {
        await disableStatusDelivery(
          options.store,
          current,
          webhookFingerprint,
          currentMessageId,
          snapshot.updatedAt,
        );
      }
      throw error;
    }

    const missing = await clearMissingStatusMessage(
      options.store,
      current,
      webhookFingerprint,
      snapshot.updatedAt,
    );
    let messageId: string;
    try {
      messageId = await executeDiscordWebhook(destination, payload, requestOptions);
    } catch (recreateError) {
      if (opensStatusCircuit(recreateError)) {
        await disableStatusDelivery(
          options.store,
          missing,
          webhookFingerprint,
          null,
          snapshot.updatedAt,
        );
      }
      throw recreateError;
    }
    await rememberMessage(
      options.store,
      missing,
      messageId,
      webhookFingerprint,
      snapshot.updatedAt,
    );
    return { action: "recreated", messageId };
  }
}
