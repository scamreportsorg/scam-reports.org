import type { AuditLog } from "@/lib/types";
import { formatDate } from "@/lib/format";
import type { QueuePagination } from "./moderation-queue-types";
import { QueuePaginationControls } from "./queue-pagination";

type AuditQueueProps = {
  logs: AuditLog[];
  pagination: QueuePagination;
  loading: boolean;
  onPageChange: (page: number) => void;
};

export function AuditQueue({ logs, pagination, loading, onPageChange }: AuditQueueProps) {
  return (
    <section className="forum-box audit-box">
      <div className="forum-box-title">
        <h2>Moderator activity</h2>
        <span>{pagination.totalItems} audit entries</span>
      </div>
      {logs.length ? (
        <ul className="audit-list">
          {logs.map((log) => (
            <li key={log.id}>
              <time>{formatDate(log.createdAt, true)}</time>
              <b>{log.action}</b>
              <span>{log.reportId}</span>
              <small>
                {log.actor}
                {!log.actorVerified && " · legacy attribution not verified"}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state">No audit entries yet.</div>
      )}
      <QueuePaginationControls
        pagination={pagination}
        loading={loading}
        label="Audit log pages"
        itemName="entries"
        onPageChange={onPageChange}
      />
    </section>
  );
}
