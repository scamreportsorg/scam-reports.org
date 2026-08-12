import { SafeLink as Link } from "./safe-link";
import { formatDate } from "@/lib/format";
import { REPORT_CATEGORIES, REPORT_STATUSES } from "@/lib/types";
import type { PaginatedResult, ReportDirectoryQuery, ReportListItem } from "@/lib/types";
import { ReputationScore } from "./reputation-score";
import { StatusBadge } from "./status-badge";

function directoryHref(query: ReportDirectoryQuery, page: number) {
  const search = new URLSearchParams();
  if (query.q) search.set("q", query.q);
  if (query.category) search.set("category", query.category);
  if (query.status) search.set("status", query.status);
  if (query.sort && query.sort !== "newest") search.set("sort", query.sort);
  if (page > 1) search.set("page", String(page));
  const suffix = search.toString();
  return `${suffix ? `/?${suffix}` : "/"}#database`;
}

function pageWindow(current: number, total: number) {
  const start = Math.max(1, Math.min(current - 2, total - 4));
  const end = Math.min(total, Math.max(current + 2, 5));
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
}

export function ReportDirectory({
  result,
  query,
}: {
  result: PaginatedResult<ReportListItem>;
  query: ReportDirectoryQuery;
}) {
  const { items, pagination } = result;
  const first = pagination.totalItems ? (pagination.page - 1) * pagination.pageSize + 1 : 0;
  const last = Math.min(pagination.page * pagination.pageSize, pagination.totalItems);

  return (
    <section className="forum-box" id="database">
      <div className="forum-box-title directory-title-row">
        <h2>Reports</h2>
        <span>
          {pagination.totalItems.toLocaleString("en-GB")} matching record
          {pagination.totalItems === 1 ? "" : "s"}
        </span>
      </div>
      <form className="directory-controls" action="/" method="get">
        <label className="control-search">
          <span>Search reports</span>
          <input
            name="q"
            defaultValue={query.q ?? ""}
            maxLength={100}
            placeholder="Username, Discord ID, report ID or game"
          />
        </label>
        <label>
          <span>Category</span>
          <select name="category" defaultValue={query.category ?? ""}>
            <option value="">All</option>
            {REPORT_CATEGORIES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Status</span>
          <select name="status" defaultValue={query.status ?? ""}>
            <option value="">All</option>
            {REPORT_STATUSES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Sort by</span>
          <select name="sort" defaultValue={query.sort ?? "newest"}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
            <option value="evidence">Evidence count</option>
            <option value="risk">Highest risk</option>
          </select>
        </label>
        <button className="forum-button" type="submit">
          Apply
        </button>
        <Link className="forum-button subtle" href="/#database">
          Reset
        </Link>
      </form>
      <div className="report-table-wrap">
        <table className="report-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Reported identity</th>
              <th>Report summary</th>
              <th>Reputation</th>
              <th>Added</th>
              <th>Evidence</th>
            </tr>
          </thead>
          <tbody>
            {items.map((report) => (
              <tr key={report.id}>
                <td data-label="Status">
                  <StatusBadge status={report.status} compact />
                </td>
                <td data-label="Reported identity">
                  <Link className="thread-link" href={`/reports/${report.id}`}>
                    {report.username}
                  </Link>
                  <code>{report.discordId}</code>
                  <small>
                    {report.category} · {report.game}
                  </small>
                </td>
                <td data-label="Report summary">
                  <Link href={`/reports/${report.id}`}>{report.reason}</Link>
                  <small>
                    {report.id} · Updated {formatDate(report.updatedAt)}
                  </small>
                </td>
                <td data-label="Reputation">
                  <ReputationScore summary={report.reputation} compact />
                </td>
                <td data-label="Added">{formatDate(report.dateAdded)}</td>
                <td data-label="Evidence">
                  {report.evidenceCount} file{report.evidenceCount === 1 ? "" : "s"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!items.length && (
        <div className="empty-state">
          <strong>Nothing matched.</strong>
          <span>Try another username, Discord ID, game, category or status.</span>
        </div>
      )}
      {pagination.totalPages > 1 && (
        <nav className="forum-pagination" aria-label="Report directory pages">
          <span>
            Showing {first}–{last} of {pagination.totalItems}
          </span>
          <div>
            {pagination.page > 1 && (
              <Link href={directoryHref(query, pagination.page - 1)}>‹ Previous</Link>
            )}
            {pageWindow(pagination.page, pagination.totalPages).map((page) =>
              page === pagination.page ? (
                <strong key={page} aria-current="page">
                  {page}
                </strong>
              ) : (
                <Link key={page} href={directoryHref(query, page)}>
                  {page}
                </Link>
              ),
            )}
            {pagination.page < pagination.totalPages && (
              <Link href={directoryHref(query, pagination.page + 1)}>Next ›</Link>
            )}
          </div>
        </nav>
      )}
    </section>
  );
}
