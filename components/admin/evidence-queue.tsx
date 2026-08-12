import { formatDate, formatFileSize } from "@/lib/format";
import type { EvidenceQueueItem, QueuePagination } from "./moderation-queue-types";
import { QueuePaginationControls } from "./queue-pagination";

type EvidenceQueueProps = {
  items: EvidenceQueueItem[];
  pagination: QueuePagination;
  loading: boolean;
  canDelete: boolean;
  onPageChange: (page: number) => void;
  onOpen: (url: string, filename: string, download?: boolean) => void;
  onReview: (item: EvidenceQueueItem) => void;
  onPublish: (item: EvidenceQueueItem) => void;
  onUpdate: (
    item: EvidenceQueueItem,
    update: Record<string, unknown>,
    successMessage: string,
  ) => void;
  onUploadReplacement: (item: EvidenceQueueItem) => void;
  onDelete: (item: EvidenceQueueItem) => void;
};

function EvidencePrivacyState({ item }: { item: EvidenceQueueItem }) {
  if (item.privacyWithheld) {
    return <span className="draft-label">Visible PII · replacement required</span>;
  }
  if (item.visiblePiiReviewed) {
    return <span className="published-label">Reviewed</span>;
  }
  return <span className="draft-label">Not reviewed</span>;
}

export function EvidenceQueue({
  items,
  pagination,
  loading,
  canDelete,
  onPageChange,
  onOpen,
  onReview,
  onPublish,
  onUpdate,
  onUploadReplacement,
  onDelete,
}: EvidenceQueueProps) {
  const awaitingReview = items.filter((item) => item.state === "private_ready").length;

  return (
    <section className="forum-box evidence-admin-box">
      <div className="forum-box-title">
        <h2>Evidence review</h2>
        <span>
          {awaitingReview} awaiting privacy review · {items.length} shown
        </span>
      </div>
      <div className="report-table-wrap">
        <table className="report-table intake-admin-table">
          <thead>
            <tr>
              <th>Evidence</th>
              <th>State</th>
              <th>Linked report</th>
              <th>Privacy</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <b>{item.originalFilename}</b>
                  <small>
                    {item.id} · {formatFileSize(item.originalSize)} ·{" "}
                    {formatDate(item.createdAt, true)}
                  </small>
                  {item.replacesEvidenceId && (
                    <small>Externally redacted replacement for {item.replacesEvidenceId}</small>
                  )}
                  {item.processingError && (
                    <small className="form-error">{item.processingError}</small>
                  )}
                </td>
                <td>
                  <span className={`review-status review-status-${item.state}`}>
                    {item.state.replaceAll("_", " ")}
                  </span>
                  {item.legalHold && <small>Legal hold</small>}
                </td>
                <td>
                  {item.links.length ? (
                    item.links.map((link) => (
                      <small key={link.reportId}>
                        {link.reportId}: {link.caption || "No caption"}
                      </small>
                    ))
                  ) : (
                    <small>Not linked</small>
                  )}
                </td>
                <td>
                  <EvidencePrivacyState item={item} />
                </td>
                <td className="action-cell">
                  {item.state !== "failed" && item.state !== "deleted" && (
                    <button
                      disabled={loading}
                      onClick={() => onOpen(item.previewUrl, item.originalFilename)}
                    >
                      Sanitized preview
                    </button>
                  )}
                  {item.state !== "deleted" && (
                    <button
                      disabled={loading}
                      onClick={() => onOpen(item.originalDownloadUrl, item.originalFilename, true)}
                    >
                      Download original (step-up)
                    </button>
                  )}
                  {(item.state === "private_ready" || item.state === "withheld") &&
                    !item.privacyWithheld && (
                      <button disabled={loading} onClick={() => onReview(item)}>
                        Review &amp; link
                      </button>
                    )}
                  {(item.state === "private_ready" || item.state === "withheld") &&
                    !item.privacyWithheld && (
                      <button disabled={loading} onClick={() => onPublish(item)}>
                        Publish derivative
                      </button>
                    )}
                  {(item.state === "private_ready" || item.state === "public") &&
                    !item.privacyWithheld && (
                      <button
                        disabled={loading}
                        onClick={() =>
                          onUpdate(item, { state: "withheld" }, `${item.id} was withheld.`)
                        }
                      >
                        Withhold (other)
                      </button>
                    )}
                  {(item.state === "private_ready" ||
                    item.state === "public" ||
                    (item.state === "withheld" && !item.privacyWithheld)) && (
                    <button
                      disabled={loading}
                      onClick={() =>
                        onUpdate(
                          item,
                          { visiblePiiDetected: true },
                          `${item.id} was permanently withheld for visible PII.`,
                        )
                      }
                    >
                      Visible PII
                    </button>
                  )}
                  {item.privacyWithheld && (
                    <button disabled={loading} onClick={() => onUploadReplacement(item)}>
                      Upload redacted replacement
                    </button>
                  )}
                  {canDelete && item.state !== "deleted" && (
                    <button
                      disabled={loading}
                      className="danger-action"
                      onClick={() => onDelete(item)}
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">No evidence on this page.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <QueuePaginationControls
        pagination={pagination}
        loading={loading}
        label="Evidence queue pages"
        itemName="assets"
        onPageChange={onPageChange}
      />
    </section>
  );
}
