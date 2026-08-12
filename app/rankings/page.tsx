import { Breadcrumbs } from "@/components/breadcrumbs";
import { ReputationRanking } from "@/components/reputation-ranking";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { getStatisticsDashboard } from "@/lib/public-analytics";
import { listReportDirectory, parseDirectorySearchParams } from "@/lib/report-query";
import { publicPageMetadata } from "@/lib/site-metadata";

export const dynamic = "force-dynamic";

export const metadata = publicPageMetadata({
  title: "Reputation Rankings",
  description: "Reputation scores for profiles in the public report archive.",
  path: "/rankings",
});

export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const query = parseDirectorySearchParams({ ...raw, sort: raw.sort ?? "risk" });
  const [result, statistics] = await Promise.all([
    listReportDirectory(query),
    getStatisticsDashboard(),
  ]);

  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Reputation Rankings" }]} />
      <div className="page-heading">
        <div>
          <h1>Reputation Rankings</h1>
        </div>
        <span>{statistics.approvedReviews} approved reviews</span>
      </div>
      <section className="ranking-notice">
        <strong>Reading the score:</strong> 0 means higher recorded risk. 100 means stronger
        community trust. It uses report status and approved reviews, but it is never a guarantee.
      </section>
      <ReputationRanking result={result} query={query} />
      <SectionBox title="How scores work">
        <div className="report-table-wrap">
          <table className="report-table ranking-method-table">
            <tbody>
              <tr>
                <th scope="row">Score</th>
                <td>
                  Profiles start at 50. Report status moves the score most, while approved ratings
                  make smaller changes. A neutral baseline stops one extreme rating from taking
                  over.
                </td>
              </tr>
              <tr>
                <th scope="row">Confidence</th>
                <td>
                  More approved reviews, checked evidence and a final decision raise confidence. Low
                  confidence simply means there isn&apos;t much data yet.
                </td>
              </tr>
              <tr>
                <th scope="row">Reviews</th>
                <td>
                  Reviews appear after approval. Spam, copied claims, harassment and personal data
                  don&apos;t make it through.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </SectionBox>
    </SiteShell>
  );
}
