import type {
  AppealRecord,
  CommunityComment,
  IntakeStatus,
  QuarantineAttachment,
  ReportSubmissionRecord,
} from "@/lib/types";
import { formatDate } from "@/lib/format";
import type { QueuePagination } from "./moderation-queue-types";
import { QueuePaginationControls } from "./queue-pagination";

type ReportSubmissionQueueProps = {
  submissions: ReportSubmissionRecord[];
  pendingCount: number;
  pagination: QueuePagination;
  loading: boolean;
  onPageChange: (page: number) => void;
  onOpenEvidence: (attachment: QuarantineAttachment) => void;
  onCreateDraft: (submission: ReportSubmissionRecord) => void;
  onModerate: (submission: ReportSubmissionRecord, status: IntakeStatus) => void;
  onDelete: (submission: ReportSubmissionRecord) => void;
};

export function ReportSubmissionQueue({
  submissions,
  pendingCount,
  pagination,
  loading,
  onPageChange,
  onOpenEvidence,
  onCreateDraft,
  onModerate,
  onDelete,
}: ReportSubmissionQueueProps) {
  return (
    <section className="forum-box intake-admin-box">
      <div className="forum-box-title">
        <h2>Public report intake</h2>
        <span>
          {pendingCount} open on page · {pagination.totalItems} total
        </span>
      </div>
      <div className="report-table-wrap">
        <table className="report-table intake-admin-table report-intake-table">
          <thead>
            <tr>
              <th>Submission</th>
              <th>Reported identity</th>
              <th>Reporter</th>
              <th>Claim</th>
              <th>Private evidence</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((submission) => (
              <tr key={submission.id}>
                <td>
                  <b>{submission.id}</b>
                  <small>{formatDate(submission.createdAt, true)}</small>
                  {submission.relatedReportId && (
                    <small>Related: {submission.relatedReportId}</small>
                  )}
                </td>
                <td>
                  <strong>{submission.username}</strong>
                  <code>{submission.discordId}</code>
                  <small>
                    {submission.category} · {submission.game}
                  </small>
                </td>
                <td>
                  <strong>{submission.submitterName}</strong>
                  <small>
                    {submission.contactEmail || "No contact email"}
                    {submission.submitterVerified ? " · signed in" : ""}
                  </small>
                </td>
                <td className="admin-intake-copy">
                  <strong>{submission.reason}</strong>
                  <p>{submission.description}</p>
                  {submission.moderatorNotes && (
                    <small>Private note: {submission.moderatorNotes}</small>
                  )}
                </td>
                <td>
                  {submission.evidence.length ? (
                    <div className="admin-evidence-list">
                      {submission.evidence.map((attachment) => (
                        <button
                          type="button"
                          key={attachment.id}
                          onClick={() => onOpenEvidence(attachment)}
                        >
                          {attachment.filename}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <small>No files</small>
                  )}
                </td>
                <td>
                  <span
                    className={`review-status review-status-${submission.status.toLowerCase().replaceAll(" ", "-")}`}
                  >
                    {submission.status}
                  </span>
                  {submission.resultReportId && <small>Result: {submission.resultReportId}</small>}
                </td>
                <td className="action-cell intake-action-cell">
                  {!submission.resultReportId && (
                    <button disabled={loading} onClick={() => onCreateDraft(submission)}>
                      Create draft
                    </button>
                  )}
                  {submission.status !== "Needs Info" && (
                    <button disabled={loading} onClick={() => onModerate(submission, "Needs Info")}>
                      Needs info
                    </button>
                  )}
                  {submission.status !== "Accepted" && (
                    <button disabled={loading} onClick={() => onModerate(submission, "Accepted")}>
                      Accept
                    </button>
                  )}
                  {submission.status !== "Rejected" && (
                    <button disabled={loading} onClick={() => onModerate(submission, "Rejected")}>
                      Reject
                    </button>
                  )}
                  <button
                    disabled={loading}
                    className="danger-action"
                    onClick={() => onDelete(submission)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!submissions.length && (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">No public report submissions yet.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <QueuePaginationControls
        pagination={pagination}
        loading={loading}
        label="Report intake queue pages"
        itemName="submissions"
        onPageChange={onPageChange}
      />
    </section>
  );
}

type AppealQueueProps = {
  appeals: AppealRecord[];
  pendingCount: number;
  pagination: QueuePagination;
  loading: boolean;
  onPageChange: (page: number) => void;
  onOpenEvidence: (attachment: QuarantineAttachment) => void;
  onModerate: (appeal: AppealRecord, status: IntakeStatus) => void;
  onDelete: (appeal: AppealRecord) => void;
};

export function AppealQueue({
  appeals,
  pendingCount,
  pagination,
  loading,
  onPageChange,
  onOpenEvidence,
  onModerate,
  onDelete,
}: AppealQueueProps) {
  return (
    <section className="forum-box intake-admin-box">
      <div className="forum-box-title">
        <h2>Corrections and appeals</h2>
        <span>
          {pendingCount} open on page · {pagination.totalItems} total
        </span>
      </div>
      <div className="report-table-wrap">
        <table className="report-table intake-admin-table appeal-intake-table">
          <thead>
            <tr>
              <th>Appeal</th>
              <th>Report</th>
              <th>Requester</th>
              <th>Request</th>
              <th>Private evidence</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {appeals.map((appeal) => (
              <tr key={appeal.id}>
                <td>
                  <b>{appeal.id}</b>
                  <small>{formatDate(appeal.createdAt, true)}</small>
                </td>
                <td>
                  <strong>{appeal.reportId}</strong>
                  <small>{appeal.requestType}</small>
                </td>
                <td>
                  <strong>{appeal.submitterName}</strong>
                  <small>{appeal.relationship}</small>
                  <small>
                    {appeal.contactEmail || "No contact email"}
                    {appeal.submitterVerified ? " · signed in" : ""}
                  </small>
                </td>
                <td className="admin-intake-copy">
                  <p>{appeal.body}</p>
                  {appeal.publicResolution && (
                    <small>Public resolution: {appeal.publicResolution}</small>
                  )}
                  {appeal.moderatorNotes && <small>Private note: {appeal.moderatorNotes}</small>}
                </td>
                <td>
                  {appeal.evidence.length ? (
                    <div className="admin-evidence-list">
                      {appeal.evidence.map((attachment) => (
                        <button
                          type="button"
                          key={attachment.id}
                          onClick={() => onOpenEvidence(attachment)}
                        >
                          {attachment.filename}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <small>No files</small>
                  )}
                </td>
                <td>
                  <span
                    className={`review-status review-status-${appeal.status.toLowerCase().replaceAll(" ", "-")}`}
                  >
                    {appeal.status}
                  </span>
                </td>
                <td className="action-cell intake-action-cell">
                  {appeal.status !== "Needs Info" && (
                    <button disabled={loading} onClick={() => onModerate(appeal, "Needs Info")}>
                      Needs info
                    </button>
                  )}
                  {appeal.status !== "Accepted" && (
                    <button disabled={loading} onClick={() => onModerate(appeal, "Accepted")}>
                      Accept
                    </button>
                  )}
                  {appeal.status !== "Rejected" && (
                    <button disabled={loading} onClick={() => onModerate(appeal, "Rejected")}>
                      Reject
                    </button>
                  )}
                  <button
                    disabled={loading}
                    className="danger-action"
                    onClick={() => onDelete(appeal)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!appeals.length && (
              <tr>
                <td colSpan={7}>
                  <div className="empty-state">No correction or appeal requests yet.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <QueuePaginationControls
        pagination={pagination}
        loading={loading}
        label="Appeal queue pages"
        itemName="appeals"
        onPageChange={onPageChange}
      />
    </section>
  );
}

type CommentQueueProps = {
  comments: CommunityComment[];
  pendingCount: number;
  pagination: QueuePagination;
  loading: boolean;
  onPageChange: (page: number) => void;
  onModerate: (
    comment: CommunityComment,
    status: Extract<CommunityComment["status"], "Approved" | "Rejected">,
  ) => void;
  onDelete: (comment: CommunityComment) => void;
};

export function CommentQueue({
  comments,
  pendingCount,
  pagination,
  loading,
  onPageChange,
  onModerate,
  onDelete,
}: CommentQueueProps) {
  return (
    <section className="forum-box intake-admin-box">
      <div className="forum-box-title">
        <h2>Report discussion moderation</h2>
        <span>
          {pendingCount} pending on page · {pagination.totalItems} total
        </span>
      </div>
      <div className="report-table-wrap">
        <table className="report-table intake-admin-table comment-intake-table">
          <thead>
            <tr>
              <th>Reply</th>
              <th>Report</th>
              <th>Member</th>
              <th>Message</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {comments.map((comment) => (
              <tr key={comment.id}>
                <td>
                  <b>{comment.id}</b>
                  <small>{formatDate(comment.createdAt, true)}</small>
                  {comment.parentId && <small>Reply to: {comment.parentId}</small>}
                </td>
                <td>
                  <strong>{comment.reportId}</strong>
                </td>
                <td>
                  <strong>{comment.displayName}</strong>
                  <small>{comment.reviewerVerified ? "Signed in" : "Unverified"}</small>
                </td>
                <td className="admin-intake-copy">
                  <p>{comment.body}</p>
                  {comment.moderatorNotes && <small>Private note: {comment.moderatorNotes}</small>}
                </td>
                <td>
                  <span className={`review-status review-status-${comment.status.toLowerCase()}`}>
                    {comment.status}
                  </span>
                </td>
                <td className="action-cell intake-action-cell">
                  {comment.status !== "Approved" && (
                    <button disabled={loading} onClick={() => onModerate(comment, "Approved")}>
                      Approve
                    </button>
                  )}
                  {comment.status !== "Rejected" && (
                    <button disabled={loading} onClick={() => onModerate(comment, "Rejected")}>
                      Reject
                    </button>
                  )}
                  <button
                    disabled={loading}
                    className="danger-action"
                    onClick={() => onDelete(comment)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!comments.length && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">No discussion replies yet.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <QueuePaginationControls
        pagination={pagination}
        loading={loading}
        label="Discussion moderation pages"
        itemName="replies"
        onPageChange={onPageChange}
      />
    </section>
  );
}
