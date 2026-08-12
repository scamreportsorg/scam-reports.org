import type { CommunityReview, ReviewStatus, ScamReport } from "@/lib/types";
import { formatDate } from "@/lib/format";
import type { QueuePagination } from "./moderation-queue-types";
import { QueuePaginationControls } from "./queue-pagination";

type ReviewQueueProps = {
  reviews: CommunityReview[];
  reports: ScamReport[];
  pendingCount: number;
  pagination: QueuePagination;
  loading: boolean;
  onPageChange: (page: number) => void;
  onModerate: (
    review: CommunityReview,
    status: Extract<ReviewStatus, "Approved" | "Rejected">,
  ) => void;
  onDelete: (review: CommunityReview) => void;
};

export function ReviewQueue({
  reviews,
  reports,
  pendingCount,
  pagination,
  loading,
  onPageChange,
  onModerate,
  onDelete,
}: ReviewQueueProps) {
  return (
    <section className="forum-box review-moderation-box">
      <div className="forum-box-title">
        <h2>Review queue</h2>
        <span>
          {pendingCount} pending on page · {pagination.totalItems} total
        </span>
      </div>
      <div className="report-table-wrap">
        <table className="report-table review-admin-table">
          <thead>
            <tr>
              <th>Review</th>
              <th>Profile</th>
              <th>Rating</th>
              <th>Submission</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {reviews.map((review) => {
              const report = reports.find((item) => item.id === review.reportId);

              return (
                <tr key={review.id}>
                  <td>
                    <b>{review.id}</b>
                    <small>{formatDate(review.createdAt, true)}</small>
                  </td>
                  <td>
                    <strong>{report?.username ?? review.reportId}</strong>
                    <small>
                      {review.relationship} · {review.displayName}
                      {review.reviewerVerified ? " · signed in" : ""}
                    </small>
                  </td>
                  <td>
                    <span className="admin-stars">
                      {"★".repeat(review.rating)}
                      {"☆".repeat(5 - review.rating)}
                    </span>
                    <small>{review.rating}/5</small>
                  </td>
                  <td className="review-copy-cell">
                    <strong>{review.title}</strong>
                    <p>{review.body}</p>
                    {review.moderatorNotes && <small>Private note: {review.moderatorNotes}</small>}
                  </td>
                  <td>
                    <span className={`review-status review-status-${review.status.toLowerCase()}`}>
                      {review.status}
                    </span>
                  </td>
                  <td className="action-cell">
                    {review.status !== "Approved" && (
                      <button disabled={loading} onClick={() => onModerate(review, "Approved")}>
                        Approve
                      </button>
                    )}
                    {review.status !== "Rejected" && (
                      <button disabled={loading} onClick={() => onModerate(review, "Rejected")}>
                        Reject
                      </button>
                    )}
                    <button
                      disabled={loading}
                      className="danger-action"
                      onClick={() => onDelete(review)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <QueuePaginationControls
        pagination={pagination}
        loading={loading}
        label="Review moderation pages"
        itemName="reviews"
        onPageChange={onPageChange}
      />
    </section>
  );
}
