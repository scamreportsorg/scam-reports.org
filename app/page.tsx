import { SafeLink as Link } from "@/components/safe-link";
import { ReportDirectory } from "@/components/report-directory";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { formatDate } from "@/lib/format";
import { getHomeDashboard } from "@/lib/public-analytics";
import { listReportDirectory, parseDirectorySearchParams } from "@/lib/report-query";
import { publicPageMetadata } from "@/lib/site-metadata";

const categoryDescriptions = {
  Cheating: "Gameplay evidence, hardware cheats and linked accounts.",
  "Cheat Sales": "Cheat shops, loaders and sellers.",
  "Marketplace Scam": "Non-delivery, payment disputes and chargebacks.",
  "Malware / Unsafe Files": "Unsafe downloads, credential theft and technical analysis.",
  Impersonation: "Copycat identities and fake storefronts.",
  "Ban Evasion": "Linked accounts and repeated enforcement evasion.",
  Other: "Reports that do not fit another section.",
} as const;

export const dynamic = "force-dynamic";

export const metadata = publicPageMetadata({
  title: "Scam-Reports.org",
  description: "A community-run archive of reviewed scam and cheating reports.",
  path: "/",
});

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = parseDirectorySearchParams(params);
  const [directory, dashboard] = await Promise.all([
    listReportDirectory(query),
    getHomeDashboard(),
  ]);

  return (
    <SiteShell>
      <h1 className="visually-hidden">Scam and cheating report archive</h1>
      <section className="forum-notice" aria-label="Database notice">
        <strong>Notice:</strong>
        <span>
          Unconfirmed reports are allegations, not findings.{" "}
          <Link href="/rules">Check the rules before you submit or rely on a report.</Link>
        </span>
      </section>
      <section className="forum-box forum-board-index">
        <div className="forum-box-title">
          <h2>Report forums</h2>
          <span>{dashboard.stats.total.toLocaleString("en-GB")} public reports</span>
        </div>
        <div className="forum-board-head" aria-hidden="true">
          <span>Board</span>
          <span>Reports</span>
          <span>Reviews</span>
          <span>Latest thread</span>
        </div>
        {dashboard.categories.map(({ category, reportCount, reviewCount, latest }) => (
          <div className="forum-board-row" key={category}>
            <div className="board-identity">
              <span className="board-icon" aria-hidden="true" />
              <div>
                <Link href={`/?category=${encodeURIComponent(category)}#database`}>{category}</Link>
                <p>{categoryDescriptions[category]}</p>
              </div>
            </div>
            <b>{reportCount}</b>
            <b>{reviewCount}</b>
            <div className="board-latest">
              {latest ? (
                <>
                  <Link href={`/reports/${latest.id}`}>{latest.username}</Link>
                  <span>
                    {formatDate(latest.updatedAt)} · {latest.game}
                  </span>
                </>
              ) : (
                <span>No reports</span>
              )}
            </div>
          </div>
        ))}
        <div className="board-statistics">
          <span>
            <strong>Board statistics:</strong> {dashboard.stats.total} reports
          </span>
          <span>{dashboard.stats.confirmed} confirmed</span>
          <span>{dashboard.stats.pending} awaiting review</span>
          <span>{dashboard.stats.rejected} cleared</span>
          <Link href="/statistics">Full statistics</Link>
        </div>
      </section>
      <div className="home-layout">
        <ReportDirectory result={directory} query={query} />
        <aside className="forum-sidebar">
          <SectionBox title="Lowest reputation">
            {dashboard.watchlist.length ? (
              <>
                <ol className="watchlist-list">
                  {dashboard.watchlist.map((report) => (
                    <li key={report.id}>
                      <span className={`watch-score reputation-${report.reputation.tone}`}>
                        {report.reputation.score}
                      </span>
                      <span>
                        <Link href={`/reports/${report.id}`}>{report.username}</Link>
                        <small>{report.reputation.label}</small>
                      </span>
                    </li>
                  ))}
                </ol>
                <Link className="text-link" href="/rankings">
                  Full ranking →
                </Link>
              </>
            ) : (
              <p className="compact-copy">No published profiles yet.</p>
            )}
          </SectionBox>
          <SectionBox title="Recent activity">
            <h3 className="sidebar-subhead">Reports</h3>
            <ul className="activity-list">
              {dashboard.newest.map((report) => (
                <li key={report.id}>
                  <Link href={`/reports/${report.id}`}>{report.username}</Link>
                  <span>
                    {report.status} · {formatDate(report.updatedAt)}
                  </span>
                </li>
              ))}
              {!dashboard.newest.length && (
                <li>
                  <span>No published reports yet.</span>
                </li>
              )}
            </ul>
            <h3 className="sidebar-subhead">Approved reviews</h3>
            <ul className="activity-list">
              {dashboard.latestReviews.map((review) => (
                <li key={review.id}>
                  <Link href={`/reports/${review.reportId}#community-reviews`}>{review.title}</Link>
                  <span>
                    {review.rating}/5 · {review.username}
                  </span>
                </li>
              ))}
              {!dashboard.latestReviews.length && (
                <li>
                  <span>No approved reviews yet.</span>
                </li>
              )}
            </ul>
          </SectionBox>
        </aside>
      </div>
    </SiteShell>
  );
}
