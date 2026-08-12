import { env } from "cloudflare:workers";
import {
  DiscordWebhookError,
  discordWebhookDestination,
  executeDiscordWebhook,
  type DiscordWebhookEnvironment,
  type DiscordWebhookPayload,
} from "./discord-webhook";
import { OutboundRequestError, readJsonWithinLimit, sendOutboundRequest } from "./outbound-http";
import { getD1 } from "./reports";

type NotificationEnv = DiscordWebhookEnvironment & {
  AUTH_APP_ORIGIN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  MODERATOR_NOTIFICATION_EMAIL?: string;
};

type OutboxRow = {
  id: string;
  event_key: string;
  channel: "email" | "discord";
  case_id: string;
  event_type: string;
  queue_path: string;
  attempts: number;
};

const MODERATOR_QUEUE_PATH =
  /^\/admin(?:\?queue=(?:appeals|applications|comments|evidence|reports|reviews))?$/u;
export const MAX_NOTIFICATION_ATTEMPTS = 8;
export const MODERATOR_NOTIFICATION_EVENT_TYPES = [
  "report",
  "appeal",
  "review",
  "comment",
  "evidence",
  "application",
] as const;
export type ModeratorNotificationEventType = (typeof MODERATOR_NOTIFICATION_EVENT_TYPES)[number];
const MODERATOR_NOTIFICATION_EVENT_TYPE_SET = new Set<string>(MODERATOR_NOTIFICATION_EVENT_TYPES);

class NotificationDeliveryError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(message: string, options: { retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = "NotificationDeliveryError";
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

function runtime(): NotificationEnv {
  try {
    return env as unknown as NotificationEnv;
  } catch {
    return process.env as NotificationEnv;
  }
}

function safeCaseId(value: string) {
  if (!/^[A-Za-z][A-Za-z0-9-]{5,63}$/u.test(value)) {
    throw new NotificationDeliveryError("Invalid notification case ID.");
  }
  return value;
}

function safeQueuePath(value: string) {
  if (!MODERATOR_QUEUE_PATH.test(value)) {
    throw new NotificationDeliveryError("Invalid moderator queue path.");
  }
  return value;
}

function safeEventType(value: string): ModeratorNotificationEventType {
  if (!MODERATOR_NOTIFICATION_EVENT_TYPE_SET.has(value)) {
    throw new NotificationDeliveryError("The notification type is invalid.");
  }
  return value as ModeratorNotificationEventType;
}

export type ModeratorNotificationInput = {
  caseId: string;
  eventType: ModeratorNotificationEventType;
  queuePath: string;
  dedupeKey?: string;
};

export function moderatorNotificationStatements(
  database: D1Database,
  input: ModeratorNotificationInput,
  timestamp = new Date().toISOString(),
) {
  const caseId = safeCaseId(input.caseId);
  const eventType = safeEventType(input.eventType);
  const queuePath = safeQueuePath(input.queuePath);
  const dedupeKey = input.dedupeKey?.trim() || caseId;
  if (!/^[A-Za-z0-9:-]{5,160}$/u.test(dedupeKey)) {
    throw new Error("Invalid notification deduplication key.");
  }
  return (["email", "discord"] as const).map((channel) =>
    database
      .prepare(
        `INSERT OR IGNORE INTO notification_outbox
      (id, event_key, channel, case_id, event_type, queue_path, status,
       attempts, next_attempt_at, last_error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, '', ?)`,
      )
      .bind(
        crypto.randomUUID(),
        `${eventType}:${dedupeKey}:${channel}`,
        channel,
        caseId,
        eventType,
        queuePath,
        timestamp,
        timestamp,
      ),
  );
}

export async function enqueueModeratorNotification(input: ModeratorNotificationInput) {
  const database = getD1();
  await database.batch(moderatorNotificationStatements(database, input));
}

function moderatorUrl(
  row: Pick<OutboxRow, "queue_path">,
  values: Pick<NotificationEnv, "AUTH_APP_ORIGIN">,
) {
  if (!values.AUTH_APP_ORIGIN) {
    throw new NotificationDeliveryError("The moderator application origin is unavailable.", {
      retryable: true,
    });
  }
  let origin: URL;
  try {
    origin = new URL(values.AUTH_APP_ORIGIN);
  } catch {
    throw new NotificationDeliveryError("The moderator application origin is invalid.");
  }
  const localDevelopment =
    origin.protocol === "http:" &&
    (origin.hostname === "localhost" || origin.hostname === "127.0.0.1");
  if (
    (origin.protocol !== "https:" && !localDevelopment) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new NotificationDeliveryError("The moderator application origin is invalid.");
  }
  const queuePath = safeQueuePath(row.queue_path);
  return new URL(queuePath, `${origin.origin}/`).toString();
}

async function sendEmail(row: OutboxRow, values: NotificationEnv) {
  if (!values.RESEND_API_KEY || !values.RESEND_FROM || !values.MODERATOR_NOTIFICATION_EMAIL) {
    throw new NotificationDeliveryError("Moderator email delivery is not configured.", {
      retryable: true,
    });
  }
  if (!/^[A-Za-z0-9:-]{5,200}$/u.test(row.event_key)) {
    throw new NotificationDeliveryError("The notification idempotency key is invalid.");
  }
  const url = moderatorUrl(row, values);
  const eventType = safeEventType(row.event_type);
  const caseId = safeCaseId(row.case_id);
  let response: Response;
  try {
    response = await sendOutboundRequest(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${values.RESEND_API_KEY}`,
          "Content-Type": "application/json",
          "Idempotency-Key": row.event_key,
        },
        body: JSON.stringify({
          from: values.RESEND_FROM,
          to: [values.MODERATOR_NOTIFICATION_EMAIL],
          subject: `[Scam-Reports.org] New ${eventType} case ${caseId}`,
          text: `A new moderation item is waiting.\n\nCase: ${caseId}\nType: ${eventType}\nQueue: ${url}\n\nNo evidence or contact details are included in this email.`,
        }),
      },
      { origin: "https://api.resend.com", pathname: "/emails", timeoutMs: 10_000 },
    );
  } catch (error) {
    throw new NotificationDeliveryError(
      error instanceof OutboundRequestError && error.problem === "timeout"
        ? "Moderator email delivery timed out."
        : "Moderator email delivery could not connect.",
      { retryable: true },
    );
  }
  if (response.status === 429) {
    const header = response.headers.get("retry-after");
    const seconds = header === null || !header.trim() ? NaN : Number(header);
    const retryAfterMs =
      Math.max(0, Number.isFinite(seconds) ? Math.round(seconds * 1000) : 1000) +
      Math.floor(Math.random() * 250);
    throw new NotificationDeliveryError("Moderator email delivery was rate-limited.", {
      retryable: true,
      retryAfterMs,
    });
  }
  if (response.status >= 500) {
    throw new NotificationDeliveryError("Moderator email delivery is unavailable.", {
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new NotificationDeliveryError("Moderator email delivery was rejected.");
  }
  const body = await readJsonWithinLimit<{ id?: unknown }>(response, 32 * 1024);
  return body && typeof body.id === "string" && /^[A-Za-z0-9_-]{6,200}$/u.test(body.id)
    ? body.id
    : null;
}

export function buildModeratorDiscordPayload(
  row: Pick<OutboxRow, "case_id" | "event_type" | "queue_path">,
  values: Pick<NotificationEnv, "AUTH_APP_ORIGIN">,
): DiscordWebhookPayload {
  const url = moderatorUrl(row, values);
  const eventType = safeEventType(row.event_type);
  const caseId = safeCaseId(row.case_id);
  return {
    content: `New **${eventType}** moderation item: \`${caseId}\`\n${url}`,
  };
}

async function sendDiscord(row: OutboxRow, values: NotificationEnv) {
  const destination = discordWebhookDestination(values, "moderation");
  return executeDiscordWebhook(destination, buildModeratorDiscordPayload(row, values));
}

export type NotificationFailureDisposition = {
  status: "failed" | "dead";
  nextAttemptAt: string;
  lastError: string;
};

function deliveryFailure(error: unknown): {
  retryable: boolean;
  retryAfterMs: number | null;
  lastError: string;
} {
  if (error instanceof DiscordWebhookError) {
    if (error.code === "not_configured") {
      return {
        retryable: true,
        retryAfterMs: null,
        lastError: "Delivery is not configured for this channel.",
      };
    }
    if (error.code === "invalid_destination") {
      return {
        retryable: false,
        retryAfterMs: null,
        lastError: "Delivery is not configured for this channel.",
      };
    }
    if (error.retryable) {
      return {
        retryable: true,
        retryAfterMs: error.retryAfterMs,
        lastError: "Delivery failed temporarily.",
      };
    }
    return {
      retryable: false,
      retryAfterMs: null,
      lastError: "Delivery was rejected by the provider.",
    };
  }
  if (error instanceof NotificationDeliveryError) {
    const missingConfiguration = /not configured|origin is unavailable/iu.test(error.message);
    return {
      retryable: error.retryable,
      retryAfterMs: error.retryAfterMs,
      lastError: missingConfiguration
        ? "Delivery is not configured for this channel."
        : error.retryable
          ? "Delivery failed temporarily."
          : "Delivery is not configured or was rejected.",
    };
  }
  return {
    retryable: true,
    retryAfterMs: null,
    lastError: "Delivery failed temporarily.",
  };
}

export function notificationFailureDisposition(
  error: unknown,
  attempts: number,
  nowMs = Date.now(),
): NotificationFailureDisposition {
  const failure = deliveryFailure(error);
  const attemptCount = Math.max(1, Math.floor(Number(attempts) || 1));
  if (!failure.retryable || attemptCount >= MAX_NOTIFICATION_ATTEMPTS) {
    return {
      status: "dead",
      nextAttemptAt: new Date(nowMs).toISOString(),
      lastError:
        failure.retryable && attemptCount >= MAX_NOTIFICATION_ATTEMPTS
          ? "Delivery stopped after repeated failures."
          : failure.lastError,
    };
  }
  const fallbackDelayMs = Math.min(24 * 60 * 60_000, 2 ** Math.min(attemptCount, 10) * 60_000);
  return {
    status: "failed",
    nextAttemptAt: new Date(nowMs + (failure.retryAfterMs ?? fallbackDelayMs)).toISOString(),
    lastError: failure.lastError,
  };
}

export async function processNotificationOutbox(limit = 20) {
  const database = getD1();
  const now = new Date().toISOString();
  const rows = await database
    .prepare(
      `SELECT id, event_key, channel, case_id, event_type,
      queue_path, attempts FROM notification_outbox
    WHERE status IN ('pending', 'failed', 'sending') AND next_attempt_at <= ?
    ORDER BY created_at ASC LIMIT ?`,
    )
    .bind(now, Math.max(1, Math.min(limit, 50)))
    .all<OutboxRow>();
  let processed = 0;
  let delivered = 0;
  const values = runtime();
  for (const row of rows.results) {
    const leaseExpiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const claimed = await database
      .prepare(
        `UPDATE notification_outbox
      SET status = 'sending', attempts = attempts + 1, next_attempt_at = ?
      WHERE id = ? AND status IN ('pending', 'failed', 'sending')
        AND next_attempt_at <= ? RETURNING id, attempts`,
      )
      .bind(leaseExpiresAt, row.id, now)
      .first<{ id: string; attempts: number }>();
    if (!claimed) continue;
    processed += 1;
    try {
      const providerMessageId =
        row.channel === "email" ? await sendEmail(row, values) : await sendDiscord(row, values);
      const completed = await database
        .prepare(
          `UPDATE notification_outbox
        SET status = 'delivered', delivered_at = ?, last_error = '', provider_message_id = ?
        WHERE id = ? AND status = 'sending' AND next_attempt_at = ?`,
        )
        .bind(new Date().toISOString(), providerMessageId, row.id, leaseExpiresAt)
        .run();
      if (completed.meta.changes) delivered += 1;
    } catch (error) {
      const attempts = Number(claimed.attempts);
      const failure = notificationFailureDisposition(error, attempts);
      await database
        .prepare(
          `UPDATE notification_outbox
        SET status = ?, next_attempt_at = ?, last_error = ?
        WHERE id = ? AND status = 'sending' AND next_attempt_at = ?`,
        )
        .bind(failure.status, failure.nextAttemptAt, failure.lastError, row.id, leaseExpiresAt)
        .run();
    }
  }
  return { processed, delivered };
}
