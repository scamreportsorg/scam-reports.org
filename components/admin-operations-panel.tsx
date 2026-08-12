"use client";

import { useEffect, useState } from "react";
import type {
  AdminBackupRunItem,
  AdminNotificationItem,
  AdminSecurityEventItem,
  OperationsPagination,
} from "@/lib/admin-operations";
import { formatFileSize } from "@/lib/format";
import { SafeLink as Link } from "./safe-link";

type PageResult<T> = {
  items: T[];
  pagination: OperationsPagination;
};

function useOperationsPage<T>(endpoint: string, page: number, reloadKey = 0) {
  const [result, setResult] = useState<PageResult<T> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
        setError("");
      }
    });
    void fetch(`${endpoint}?page=${page}`, {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as PageResult<T> & {
          error?: string;
        };
        if (!response.ok) throw new Error(payload.error ?? "Couldn't load this queue.");
        return payload;
      })
      .then((payload) => {
        if (!cancelled) setResult(payload);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Couldn't load this queue.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint, page, reloadKey]);

  return { result, error, loading };
}

function displayDate(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unavailable";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(value));
}

function QueuePagination({
  value,
  setPage,
}: {
  value: OperationsPagination | undefined;
  setPage: (page: number) => void;
}) {
  if (!value || value.totalPages <= 1) return null;
  return (
    <nav className="operations-pagination" aria-label="Operations queue pages">
      <button
        type="button"
        disabled={value.page <= 1}
        onClick={() => setPage(Math.max(1, value.page - 1))}
      >
        Previous
      </button>
      <span>
        Page {value.page} of {value.totalPages}
      </span>
      <button
        type="button"
        disabled={value.page >= value.totalPages}
        onClick={() => setPage(Math.min(value.totalPages, value.page + 1))}
      >
        Next
      </button>
    </nav>
  );
}

function QueueState({
  loading,
  error,
  empty,
}: {
  loading: boolean;
  error: string;
  empty: boolean;
}) {
  if (loading) return <p className="operations-queue-state">Loading queue...</p>;
  if (error)
    return (
      <p className="operations-queue-state operations-queue-error" role="alert">
        {error}
      </p>
    );
  if (empty) return <p className="operations-queue-state">No items are waiting in this queue.</p>;
  return null;
}

export function AdminOperationsPanel({ csrfToken }: { csrfToken: string }) {
  const [notificationPage, setNotificationPage] = useState(1);
  const [backupPage, setBackupPage] = useState(1);
  const [securityPage, setSecurityPage] = useState(1);
  const [notificationReload, setNotificationReload] = useState(0);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const notifications = useOperationsPage<AdminNotificationItem>(
    "/api/admin/operations/notifications",
    notificationPage,
    notificationReload,
  );
  const backups = useOperationsPage<AdminBackupRunItem>(
    "/api/admin/operations/backups",
    backupPage,
  );
  const securityEvents = useOperationsPage<AdminSecurityEventItem>(
    "/api/admin/operations/security-events",
    securityPage,
  );

  async function retryNotification(item: AdminNotificationItem) {
    setRetrying(item.id);
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/operations/notifications/${encodeURIComponent(item.id)}/retry`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "x-csrf-token": csrfToken },
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't queue the notification.");
      setMessage(`Notification for ${item.caseId} is queued for another delivery attempt.`);
      setNotificationReload((value) => value + 1);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "Couldn't queue the notification.");
    } finally {
      setRetrying(null);
    }
  }

  return (
    <section className="admin-operations-panel" aria-labelledby="admin-operations-heading">
      <header className="operations-heading">
        <div>
          <small>Admin only</small>
          <h2 id="admin-operations-heading">Delivery, backups and security</h2>
        </div>
        <span>Storage locations and private identity values stay hidden.</span>
      </header>

      {message && (
        <p className="admin-inline-message operations-message" role="status">
          {message}
        </p>
      )}

      <section className="forum-box operations-box">
        <div className="forum-box-title">
          <h2>Notification queue</h2>
          <span>{notifications.result?.pagination.totalItems ?? 0} entries</span>
        </div>
        <QueueState
          loading={notifications.loading}
          error={notifications.error}
          empty={!notifications.result?.items.length}
        />
        {!!notifications.result?.items.length && (
          <div className="table-scroll">
            <table className="operations-table notification-operations-table">
              <thead>
                <tr>
                  <th>Case</th>
                  <th>Channel</th>
                  <th>State</th>
                  <th>Schedule</th>
                  <th>Result</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {notifications.result.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.caseId}</strong>
                      <small>{item.eventType}</small>
                      {item.queuePath && <Link href={item.queuePath}>Open moderation queue</Link>}
                    </td>
                    <td>{item.channel}</td>
                    <td>
                      <span className={`operations-status operations-status-${item.status}`}>
                        {item.status === "dead" ? "stopped" : item.status}
                      </span>
                      <small>{item.attempts} attempts</small>
                    </td>
                    <td>
                      <time dateTime={item.nextAttemptAt}>{displayDate(item.nextAttemptAt)}</time>
                      <small>Created {displayDate(item.createdAt)}</small>
                    </td>
                    <td>{item.errorSummary ?? "Waiting for delivery."}</td>
                    <td>
                      {item.status === "failed" || item.status === "dead" ? (
                        <button
                          className="forum-button"
                          type="button"
                          disabled={retrying === item.id}
                          onClick={() => void retryNotification(item)}
                        >
                          {retrying === item.id ? "Queuing..." : "Retry"}
                        </button>
                      ) : (
                        <span className="operations-muted">Scheduled</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <QueuePagination value={notifications.result?.pagination} setPage={setNotificationPage} />
      </section>

      <section className="forum-box operations-box">
        <div className="forum-box-title">
          <h2>Backup runs</h2>
          <span>{backups.result?.pagination.totalItems ?? 0} recorded</span>
        </div>
        <QueueState
          loading={backups.loading}
          error={backups.error}
          empty={!backups.result?.items.length}
        />
        {!!backups.result?.items.length && (
          <div className="table-scroll">
            <table className="operations-table backup-operations-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Completed</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {backups.result.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.id}</strong>
                      {item.size !== null && <small>{formatFileSize(item.size)}</small>}
                    </td>
                    <td>{item.kind}</td>
                    <td>
                      <span className={`operations-status operations-status-${item.status}`}>
                        {item.status}
                      </span>
                    </td>
                    <td>
                      <time dateTime={item.startedAt}>{displayDate(item.startedAt)}</time>
                    </td>
                    <td>{displayDate(item.completedAt)}</td>
                    <td>{item.errorSummary ?? "No failure recorded."}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <QueuePagination value={backups.result?.pagination} setPage={setBackupPage} />
      </section>

      <section className="forum-box operations-box">
        <div className="forum-box-title">
          <h2>Auth security events</h2>
          <span>{securityEvents.result?.pagination.totalItems ?? 0} recorded</span>
        </div>
        <QueueState
          loading={securityEvents.loading}
          error={securityEvents.error}
          empty={!securityEvents.result?.items.length}
        />
        {!!securityEvents.result?.items.length && (
          <div className="table-scroll">
            <table className="operations-table security-operations-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Subject</th>
                  <th>Actor</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {securityEvents.result.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <time dateTime={item.createdAt}>{displayDate(item.createdAt)}</time>
                    </td>
                    <td>
                      <strong>{item.eventType}</strong>
                    </td>
                    <td>
                      {item.subject ? (
                        <>
                          <strong>{item.subject.handle}</strong>
                          <small>{item.subject.id}</small>
                        </>
                      ) : (
                        (item.targetAccountId ?? "Deleted or unavailable")
                      )}
                    </td>
                    <td>{item.actorAccountId ?? "System"}</td>
                    <td>{item.summary}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <QueuePagination value={securityEvents.result?.pagination} setPage={setSecurityPage} />
      </section>
    </section>
  );
}
