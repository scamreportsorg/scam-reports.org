import { getAuthDatabase } from "./auth-db";
import { AuthError } from "./auth-errors";

const PAGE_SIZE = 25;
const MAX_PAGE = 10_000;
const NOTIFICATION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type OperationsPagination = {
  page: number;
  pageSize: 25;
  totalItems: number;
  totalPages: number;
};

export type AdminNotificationItem = {
  id: string;
  channel: "email" | "discord";
  caseId: string;
  eventType: string;
  queuePath: string | null;
  status: "pending" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: string;
  errorSummary: string | null;
  createdAt: string;
};

export type AdminBackupRunItem = {
  id: string;
  kind: string;
  status: string;
  size: number | null;
  errorSummary: string | null;
  startedAt: string;
  completedAt: string | null;
};

export type AdminSecurityEventItem = {
  id: string;
  eventType: string;
  subject: { id: string; handle: string } | null;
  actorAccountId: string | null;
  targetAccountId: string | null;
  summary: string;
  createdAt: string;
};

type NotificationRow = {
  id: string;
  channel: string;
  case_id: string;
  event_type: string;
  queue_path: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string;
  created_at: string;
};

type BackupRow = {
  id: string;
  kind: string;
  status: string;
  size: number | null;
  error: string;
  started_at: string;
  completed_at: string | null;
};

type SecurityEventRow = {
  id: string;
  account_id: string | null;
  account_handle: string | null;
  event_type: string;
  detail: string;
  created_at: string;
};

function requestedPage(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE) : 1;
}

function pagination(page: number, totalItems: number): OperationsPagination {
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  return {
    page: Math.min(page, totalPages),
    pageSize: PAGE_SIZE,
    totalItems,
    totalPages,
  };
}

function safeToken(value: string, fallback = "unknown") {
  return /^[a-z0-9._-]{1,64}$/iu.test(value) ? value : fallback;
}

function safeTimestamp(value: string | null): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

function deliveryErrorSummary(value: string): string | null {
  if (!value) return null;
  if (/stopped after repeated failures/iu.test(value)) {
    return "Delivery stopped after repeated failures.";
  }
  if (/not configured|unavailable/iu.test(value)) {
    return "This channel is not configured.";
  }
  if (/HTTP\s+\d{3}/iu.test(value)) {
    return "The provider returned an error.";
  }
  return "Delivery failed. Check the provider status and configuration.";
}

function backupErrorSummary(value: string): string | null {
  if (!value) return null;
  if (/not configured|unavailable|missing/iu.test(value)) {
    return "Backups are not fully configured.";
  }
  return "Backup failed. Check the private logs.";
}

function safeQueuePath(value: string): string | null {
  return /^\/admin(?:\?queue=(?:appeals|applications|comments|evidence|reports|reviews))?$/u.test(
    value,
  )
    ? value
    : null;
}

function parseCount(value: number | undefined) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export async function listOperationalNotifications(input: { page?: number } = {}) {
  const database = getAuthDatabase();
  const page = requestedPage(input.page);
  const countRow = await database
    .prepare(
      "SELECT COUNT(*) AS count FROM notification_outbox WHERE status IN ('pending', 'failed', 'dead')",
    )
    .first<{ count: number }>();
  const pageInfo = pagination(page, parseCount(countRow?.count));
  const rows = await database
    .prepare(
      `SELECT id, channel, case_id, event_type, queue_path, status, attempts,
        next_attempt_at, last_error, created_at
      FROM notification_outbox
      WHERE status IN ('pending', 'failed', 'dead')
      ORDER BY CASE status WHEN 'dead' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
        next_attempt_at ASC, created_at ASC, id ASC
      LIMIT ? OFFSET ?`,
    )
    .bind(PAGE_SIZE, (pageInfo.page - 1) * PAGE_SIZE)
    .all<NotificationRow>();
  return {
    items: rows.results.flatMap((row): AdminNotificationItem[] => {
      if (
        (row.channel !== "email" && row.channel !== "discord") ||
        (row.status !== "pending" && row.status !== "failed" && row.status !== "dead")
      ) {
        return [];
      }
      return [
        {
          id: row.id,
          channel: row.channel,
          caseId: safeToken(row.case_id, "unavailable"),
          eventType: safeToken(row.event_type),
          queuePath: safeQueuePath(row.queue_path),
          status: row.status,
          attempts: Math.max(0, Number(row.attempts) || 0),
          nextAttemptAt: safeTimestamp(row.next_attempt_at) ?? row.created_at,
          errorSummary: deliveryErrorSummary(row.last_error),
          createdAt: safeTimestamp(row.created_at) ?? "",
        },
      ];
    }),
    pagination: pageInfo,
  };
}

export async function listOperationalBackupRuns(input: { page?: number } = {}) {
  const database = getAuthDatabase();
  const page = requestedPage(input.page);
  const countRow = await database
    .prepare("SELECT COUNT(*) AS count FROM backup_runs")
    .first<{ count: number }>();
  const pageInfo = pagination(page, parseCount(countRow?.count));
  const rows = await database
    .prepare(
      `SELECT id, kind, status, size, error, started_at, completed_at
      FROM backup_runs ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(PAGE_SIZE, (pageInfo.page - 1) * PAGE_SIZE)
    .all<BackupRow>();
  return {
    items: rows.results.map(
      (row): AdminBackupRunItem => ({
        id: safeToken(row.id, "unavailable"),
        kind: /^(weekly|monthly)$/u.test(row.kind) ? row.kind : "unknown",
        status: /^(running|complete|completed|failed)$/u.test(row.status) ? row.status : "unknown",
        size: row.size === null ? null : Math.max(0, Number(row.size) || 0),
        errorSummary: backupErrorSummary(row.error),
        startedAt: safeTimestamp(row.started_at) ?? "",
        completedAt: safeTimestamp(row.completed_at),
      }),
    ),
    pagination: pageInfo,
  };
}

function securityDetail(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safeAccountId(value: unknown): string | null {
  return typeof value === "string" && /^account_[a-f0-9]{32}$/u.test(value) ? value : null;
}

function safeAccessValue(value: unknown) {
  return typeof value === "string" && /^(member|moderator|admin|active|suspended)$/u.test(value)
    ? value
    : null;
}

function securitySummary(eventType: string, detail: Record<string, unknown>) {
  if (eventType === "account.access_changed") {
    const fromRole = safeAccessValue(detail.fromRole);
    const toRole = safeAccessValue(detail.toRole);
    const fromStatus = safeAccessValue(detail.fromStatus);
    const toStatus = safeAccessValue(detail.toStatus);
    if (fromRole && toRole && fromStatus && toStatus) {
      return `Access changed from ${fromRole}/${fromStatus} to ${toRole}/${toStatus}.`;
    }
    return "Account access was changed.";
  }
  if (eventType === "account.deleted") {
    return "An account was permanently deleted.";
  }
  if (eventType === "notification.retry_requested") {
    return "A failed notification was returned to the delivery queue.";
  }
  return "A security-relevant account or administrator event was recorded.";
}

export async function listOperationalSecurityEvents(input: { page?: number } = {}) {
  const database = getAuthDatabase();
  const page = requestedPage(input.page);
  const countRow = await database
    .prepare("SELECT COUNT(*) AS count FROM auth_security_events")
    .first<{ count: number }>();
  const pageInfo = pagination(page, parseCount(countRow?.count));
  const rows = await database
    .prepare(
      `SELECT e.id, e.account_id, a.handle AS account_handle,
        e.event_type, e.detail, e.created_at
      FROM auth_security_events e
      LEFT JOIN accounts a ON a.id = e.account_id
      ORDER BY e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(PAGE_SIZE, (pageInfo.page - 1) * PAGE_SIZE)
    .all<SecurityEventRow>();
  return {
    items: rows.results.map((row): AdminSecurityEventItem => {
      const detail = securityDetail(row.detail);
      const subjectId = safeAccountId(row.account_id);
      return {
        id: safeToken(row.id, "unavailable"),
        eventType: safeToken(row.event_type),
        subject:
          subjectId && row.account_handle
            ? { id: subjectId, handle: row.account_handle.slice(0, 40) }
            : null,
        actorAccountId: safeAccountId(detail.actorAccountId),
        targetAccountId: safeAccountId(detail.targetAccountId),
        summary: securitySummary(row.event_type, detail),
        createdAt: safeTimestamp(row.created_at) ?? "",
      };
    }),
    pagination: pageInfo,
  };
}

export async function retryOperationalNotification(input: {
  notificationId: string;
  actorAccountId: string;
}) {
  if (!NOTIFICATION_ID.test(input.notificationId)) {
    throw new AuthError(404, "notification_not_found", "Notification not found.");
  }
  const actorAccountId = safeAccountId(input.actorAccountId);
  if (!actorAccountId) {
    throw new AuthError(403, "invalid_actor", "The administrator session is invalid.");
  }
  const database = getAuthDatabase();
  const current = await database
    .prepare("SELECT status, next_attempt_at FROM notification_outbox WHERE id = ? LIMIT 1")
    .bind(input.notificationId)
    .first<{ status: string; next_attempt_at: string }>();
  if (!current) {
    throw new AuthError(404, "notification_not_found", "Notification not found.");
  }
  if (current.status === "pending") {
    return { queued: true, changed: false, status: "pending" as const };
  }
  if (current.status !== "failed" && current.status !== "dead") {
    throw new AuthError(
      409,
      "notification_not_retryable",
      "Only failed, stopped, or already-pending notifications can be queued.",
    );
  }

  const now = new Date().toISOString();
  const queuedAt = Math.max(0, Date.parse(current.next_attempt_at) || 0).toString(36);
  const auditId = `security_retry_${input.notificationId.replaceAll("-", "")}_${queuedAt}`;
  const [transition] = await database.batch([
    database
      .prepare(
        `UPDATE notification_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = ?, last_error = '',
          delivered_at = NULL, provider_message_id = NULL
        WHERE id = ? AND status IN ('failed', 'dead')`,
      )
      .bind(now, input.notificationId),
    database
      .prepare(
        `INSERT OR IGNORE INTO auth_security_events
        (id, account_id, event_type, detail, created_at)
        SELECT ?, ?, 'notification.retry_requested', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM notification_outbox WHERE id = ? AND status = 'pending'
        )`,
      )
      .bind(
        auditId,
        actorAccountId,
        JSON.stringify({ actorAccountId, notificationId: input.notificationId }),
        now,
        input.notificationId,
      ),
  ]);
  const after = await database
    .prepare("SELECT status FROM notification_outbox WHERE id = ? LIMIT 1")
    .bind(input.notificationId)
    .first<{ status: string }>();
  if (after?.status === "pending") {
    return {
      queued: true,
      changed: Number(transition.meta.changes) > 0,
      status: "pending" as const,
    };
  }
  throw new AuthError(409, "notification_not_retryable", "The notification state changed.");
}
