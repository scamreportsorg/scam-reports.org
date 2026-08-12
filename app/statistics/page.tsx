import { Breadcrumbs } from "@/components/breadcrumbs";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { StatsStrip } from "@/components/stats-strip";
import { StatusBadge } from "@/components/status-badge";
import { getStatisticsDashboard } from "@/lib/public-analytics";
import { publicPageMetadata } from "@/lib/site-metadata";
import type { ReportStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata = publicPageMetadata({
  title: "Database Statistics",
  description: "Public report, review, reputation, and category totals from Scam-Reports.org.",
  path: "/statistics",
});

export default async function StatisticsPage() {
  const dashboard = await getStatisticsDashboard();
  const statusRows: Array<[ReportStatus, number]> = [
    ["Confirmed", dashboard.stats.confirmed],
    ["Under Review", dashboard.stats.underReview],
    ["Reported", dashboard.stats.reported],
    ["Rejected", dashboard.stats.rejected],
  ];
  const maximumMonth = Math.max(1, ...dashboard.monthly.map((item) => item.count));
  const averageReview =
    dashboard.averageRating === null
      ? "Not available"
      : `${dashboard.averageRating.toFixed(1)} / 5`;

  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Database Statistics" }]} />
      <div className="page-heading">
        <div>
          <h1>Database Statistics</h1>
        </div>
        <span>Current public totals</span>
      </div>
      <StatsStrip stats={dashboard.stats} />
      <div className="community-metrics">
        <div>
          <span>Approved reviews</span>
          <strong>{dashboard.approvedReviews}</strong>
          <small>Public after moderation</small>
        </div>
        <div>
          <span>Average review</span>
          <strong>{averageReview}</strong>
          <small>Across approved reviews</small>
        </div>
        <div>
          <span>Average reputation</span>
          <strong>{dashboard.averageReputation} / 100</strong>
          <small>All published profiles</small>
        </div>
        <div>
          <span>High-confidence profiles</span>
          <strong>{dashboard.highConfidenceProfiles}</strong>
          <small>Evidence and review depth</small>
        </div>
      </div>
      <div className="statistics-grid">
        <SectionBox title="Status breakdown">
          <div className="bar-list">
            {statusRows.map(([status, count]) => (
              <div className="bar-row" key={status}>
                <StatusBadge status={status} compact />
                <div className="bar-track">
                  <span
                    style={{
                      width: `${
                        dashboard.stats.total ? (count / dashboard.stats.total) * 100 : 0
                      }%`,
                    }}
                  />
                </div>
                <b>{count}</b>
              </div>
            ))}
          </div>
        </SectionBox>
        <SectionBox title="Reports added by month">
          {dashboard.monthly.length ? (
            <div className="month-chart">
              {dashboard.monthly.map(({ month, count }) => (
                <div key={month}>
                  <span>{month}</span>
                  <div>
                    <i
                      style={{
                        height: `${Math.max(12, (count / maximumMonth) * 100)}%`,
                      }}
                    />
                  </div>
                  <b>{count}</b>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty-state">No reports have been published yet.</div>
          )}
        </SectionBox>
      </div>
      <SectionBox title="Reports by category">
        <div className="category-stat-list">
          {dashboard.categories.map(({ category, count }) => (
            <div key={category}>
              <b>{category}</b>
              <span>{count}</span>
            </div>
          ))}
        </div>
      </SectionBox>
    </SiteShell>
  );
}
