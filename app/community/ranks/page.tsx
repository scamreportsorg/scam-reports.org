import { Breadcrumbs } from "@/components/breadcrumbs";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import {
  COMMUNITY_POINT_VALUES,
  COMMUNITY_RANK_LADDER,
  COMMUNITY_REPLY_DAILY_THREAD_CAP,
} from "@/lib/community-ranks";
import { publicPageMetadata } from "@/lib/site-metadata";

export const metadata = publicPageMetadata({
  title: "Community Ranks",
  description: "The public rank ladder for approved community contributions.",
  path: "/community/ranks",
});

export default function CommunityRanksPage() {
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Community", href: "/community" }, { label: "Ranks" }]} />
      <div className="page-heading">
        <div>
          <small>Approved contributions</small>
          <h1>Community ranks</h1>
        </div>
        <span>Activity only, not staff access</span>
      </div>

      <section className="community-rank-separation-notice">
        <strong>Ranks don&apos;t unlock permissions.</strong>
        <span>
          Points track approved public activity. Moderator and admin access always goes through the
          staff process.
        </span>
      </section>

      <div className="content-columns community-rank-columns">
        <SectionBox title="Rank ladder">
          <div className="report-table-wrap">
            <table className="report-table compact-table community-rank-table">
              <thead>
                <tr>
                  <th scope="col">Level</th>
                  <th scope="col">Public rank</th>
                  <th scope="col">Points</th>
                </tr>
              </thead>
              <tbody>
                {COMMUNITY_RANK_LADDER.map((rank) => (
                  <tr key={rank.level}>
                    <td>Lv. {rank.level}</td>
                    <td>{rank.name}</td>
                    <td>{rank.minimumPoints}+</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionBox>

        <SectionBox title="Contribution points">
          <div className="identity-table community-point-table">
            <div>
              <span>Published report</span>
              <strong>+{COMMUNITY_POINT_VALUES.publishedReport}</strong>
            </div>
            <div>
              <span>Approved review</span>
              <strong>+{COMMUNITY_POINT_VALUES.approvedReview}</strong>
            </div>
            <div>
              <span>Eligible approved reply</span>
              <strong>+{COMMUNITY_POINT_VALUES.eligibleReply}</strong>
            </div>
          </div>
          <p className="compact-copy community-rank-copy">
            Pending and rejected posts earn no points. Totals update after moderation.
          </p>
        </SectionBox>
      </div>

      <SectionBox title="Point rules">
        <ol className="rule-list review-rules-grid">
          <li>
            <b>Approved posts only.</b> Reports, reviews and replies count after moderation.
          </li>
          <li>
            <b>One case, one credit.</b> Merged copies of a report don&apos;t earn extra points.
          </li>
          <li>
            <b>Reply cap.</b> At most {COMMUNITY_REPLY_DAILY_THREAD_CAP} approved replies in the
            same report family per UTC day earn points. Extra approved replies still show in the
            contribution total.
          </li>
          <li>
            <b>No paid boost.</b> Donations, account age, Discord roles and staff access don&apos;t
            change your rank.
          </li>
        </ol>
      </SectionBox>
    </SiteShell>
  );
}
