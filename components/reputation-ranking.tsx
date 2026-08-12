import { SafeLink as Link } from "./safe-link";
import { formatDate } from "@/lib/format";
import { REPORT_STATUSES } from "@/lib/types";
import type { PaginatedResult, ReportDirectoryQuery, ReportListItem } from "@/lib/types";
import { ReputationScore } from "./reputation-score";
import { StatusBadge } from "./status-badge";

function href(query: ReportDirectoryQuery, page: number) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.status) params.set("status", query.status);
  if (query.sort && query.sort !== "risk") params.set("sort", query.sort);
  if (page > 1) params.set("page", String(page));
  return `/rankings${params.size ? `?${params}` : ""}`;
}

export function ReputationRanking({
  result,
  query,
}: {
  result: PaginatedResult<ReportListItem>;
  query: ReportDirectoryQuery;
}) {
  const { items, pagination } = result;
  const start = Math.max(1, pagination.page - 2);
  const end = Math.min(pagination.totalPages, start + 4);
  const pages = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
  const rankOffset = (pagination.page - 1) * pagination.pageSize;

  return (
    <section className="forum-box ranking-directory">
      <div className="forum-box-title">
        <h2>Reputation ranking</h2>
        <span>{pagination.totalItems} visible profiles</span>
      </div>
      <form className="directory-controls ranking-controls" action="/rankings" method="get">
        <label className="control-search">
          <span>Search profiles</span>
          <input
            name="q"
            maxLength={100}
            defaultValue={query.q ?? ""}
            placeholder="Username, Discord ID or game"
          />
        </label>
        <label>
          <span>Status</span>
          <select name="status" defaultValue={query.status ?? ""}>
            <option value="">All</option>
            {REPORT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Ranking</span>
          <select name="sort" defaultValue={query.sort ?? "risk"}>
            <option value="risk">Highest risk first</option>
            <option value="reputation">Highest reputation first</option>
            <option value="reviews">Most reviewed</option>
            <option value="newest">Newest profiles</option>
          </select>
        </label>
        <button className="forum-button" type="submit">
          Apply
        </button>
        <Link className="forum-button subtle" href="/rankings">
          Reset
        </Link>
      </form>
      <div className="report-table-wrap">
        <table className="report-table ranking-table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Profile</th>
              <th>Reputation</th>
              <th>Community rating</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {items.map((report, index) => {
              const rating =
                report.reputation.averageRating === null
                  ? "No rating"
                  : `${report.reputation.averageRating.toFixed(1)} / 5`;

              return (
                <tr key={report.id}>
                  <td data-label="Rank" className="ranking-position">
                    #{rankOffset + index + 1}
                  </td>
                  <td data-label="Profile">
                    <Link className="thread-link" href={`/reports/${report.id}`}>
                      {report.username}
                    </Link>
                    <code>{report.discordId}</code>
                    <small>
                      {report.game} · {report.category}
                    </small>
                  </td>
                  <td data-label="Reputation">
                    <ReputationScore summary={report.reputation} compact />
                  </td>
                  <td data-label="Community rating">
                    <strong>{rating}</strong>
                    <small>
                      {report.reputation.reviewCount} approved review
                      {report.reputation.reviewCount === 1 ? "" : "s"}
                    </small>
                  </td>
                  <td data-label="Status">
                    <StatusBadge status={report.status} compact />
                  </td>
                  <td data-label="Updated">{formatDate(report.updatedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!items.length && <div className="empty-state">Nothing matched these filters.</div>}
      {pagination.totalPages > 1 && (
        <nav className="forum-pagination" aria-label="Reputation pages">
          <span>
            Page {pagination.page} of {pagination.totalPages}
          </span>
          <div>
            {pagination.page > 1 && <Link href={href(query, pagination.page - 1)}>‹ Previous</Link>}
            {pages.map((page) => {
              if (page === pagination.page) {
                return (
                  <strong key={page} aria-current="page">
                    {page}
                  </strong>
                );
              }
              return (
                <Link key={page} href={href(query, page)}>
                  {page}
                </Link>
              );
            })}
            {pagination.page < pagination.totalPages && (
              <Link href={href(query, pagination.page + 1)}>Next ›</Link>
            )}
          </div>
        </nav>
      )}
    </section>
  );
}
