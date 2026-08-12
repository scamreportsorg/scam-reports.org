import type { ScamReport } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { StatusBadge } from "../status-badge";
import type { QueuePagination } from "./moderation-queue-types";
import { QueuePaginationControls } from "./queue-pagination";

type ReportQueueProps = {
  reports: ScamReport[];
  pagination: QueuePagination;
  loading: boolean;
  canDelete: boolean;
  onPageChange: (page: number) => void;
  onEdit: (report: ScamReport) => void;
  onMerge: (report: ScamReport) => void;
  onUnmerge: (report: ScamReport) => void;
  onDelete: (report: ScamReport) => void;
};

export function ReportQueue({
  reports,
  pagination,
  loading,
  canDelete,
  onPageChange,
  onEdit,
  onMerge,
  onUnmerge,
  onDelete,
}: ReportQueueProps) {
  return (
    <section className="forum-box">
      <div className="forum-box-title">
        <h2>Moderation queue</h2>
        <span>
          {reports.length} shown · {pagination.totalItems} total
        </span>
      </div>
      <div className="report-table-wrap">
        <table className="report-table admin-table">
          <thead>
            <tr>
              <th>Report</th>
              <th>Identity</th>
              <th>Status</th>
              <th>Visibility</th>
              <th>Updated</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => (
              <tr key={report.id}>
                <td>
                  <b>{report.id}</b>
                  <small>
                    {report.category} · {report.game}
                  </small>
                </td>
                <td>
                  <strong>{report.username || "Untitled draft"}</strong>
                  <code>{report.discordId || "No Discord ID"}</code>
                </td>
                <td>
                  <StatusBadge status={report.status} compact />
                </td>
                <td>
                  {report.isPublished ? (
                    <span className="published-label">Published</span>
                  ) : (
                    <span className="draft-label">Draft</span>
                  )}
                </td>
                <td>{formatDate(report.updatedAt, true)}</td>
                <td className="action-cell">
                  <button onClick={() => onEdit(report)}>Edit</button>
                  {report.mergedIntoReportId ? (
                    <button onClick={() => onUnmerge(report)}>
                      Unmerge from {report.mergedIntoReportId}
                    </button>
                  ) : (
                    <button onClick={() => onMerge(report)}>Merge duplicate</button>
                  )}
                  {canDelete && (
                    <button className="danger-action" onClick={() => onDelete(report)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <QueuePaginationControls
        pagination={pagination}
        loading={loading}
        label="Report moderation pages"
        itemName="reports"
        onPageChange={onPageChange}
      />
    </section>
  );
}
