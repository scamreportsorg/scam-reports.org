type AdminSummaryProps = {
  totalReports: number;
  pendingReports: number;
  unpublishedReports: number;
  pendingReviews: number;
  openSubmissions: number;
  totalSubmissions: number;
  openAppeals: number;
  totalAppeals: number;
  pendingComments: number;
  totalComments: number;
  onAddReport: () => void;
};

export function AdminSummary({
  totalReports,
  pendingReports,
  unpublishedReports,
  pendingReviews,
  openSubmissions,
  totalSubmissions,
  openAppeals,
  totalAppeals,
  pendingComments,
  totalComments,
  onAddReport,
}: AdminSummaryProps) {
  return (
    <section className="forum-box admin-overview">
      <div className="forum-box-title">
        <h2>Moderation overview</h2>
        <button className="forum-button" type="button" onClick={onAddReport}>
          Add report
        </button>
      </div>
      <div className="admin-summary">
        <div>
          <span>Total reports</span>
          <strong>{totalReports}</strong>
        </div>
        <div>
          <span>Queue on page</span>
          <strong>{pendingReports}</strong>
        </div>
        <div>
          <span>Drafts on page</span>
          <strong>{unpublishedReports}</strong>
        </div>
        <div>
          <span>Pending reviews on page</span>
          <strong>{pendingReviews}</strong>
        </div>
      </div>
      <div className="admin-intake-summary" aria-label="Community intake summary">
        <div>
          <span>Open report intake</span>
          <strong>{openSubmissions}</strong>
          <small>{totalSubmissions} total</small>
        </div>
        <div>
          <span>Open appeals</span>
          <strong>{openAppeals}</strong>
          <small>{totalAppeals} total</small>
        </div>
        <div>
          <span>Pending replies</span>
          <strong>{pendingComments}</strong>
          <small>{totalComments} total</small>
        </div>
      </div>
    </section>
  );
}
