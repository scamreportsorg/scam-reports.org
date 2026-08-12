import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { CommunityRankBadge, CommunityRankPanel } from "@/components/community-rank";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { findPublicAccountByHandle, publicCommunityActivity } from "@/lib/auth";
import { publicPageMetadata } from "@/lib/site-metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}): Promise<Metadata> {
  const { handle } = await params;
  const account = await findPublicAccountByHandle(handle);
  if (!account) {
    return {
      ...publicPageMetadata({
        title: "Member not found",
        description: "This community profile is not available.",
        path: `/members/${encodeURIComponent(handle)}`,
      }),
      robots: { index: false, follow: false },
    };
  }

  return publicPageMetadata({
    title: `${account.handle} | community profile`,
    description: `Public activity and community rank for ${account.handle}.`,
    path: `/members/${encodeURIComponent(account.handle)}`,
  });
}

export default async function MemberPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const account = await findPublicAccountByHandle(handle);
  if (!account) notFound();
  const activity = await publicCommunityActivity(account.id);
  const staffAccess =
    account.role === "admin"
      ? "Administrator"
      : account.role === "moderator"
        ? "Moderator"
        : "None";
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Members" }, { label: account.handle }]} />
      <div className="page-heading">
        <div>
          <small>Community member</small>
          <h1>{account.handle}</h1>
        </div>
        <CommunityRankBadge activity={activity} />
      </div>
      <div className="content-columns">
        <SectionBox title="Public activity">
          <CommunityRankPanel activity={activity} />
          <div className="stats-strip">
            <div className="stat-cell">
              <span>Approved reports</span>
              <strong>{activity.approvedReportCount}</strong>
            </div>
            <div className="stat-cell">
              <span>Approved reviews</span>
              <strong>{activity.approvedReviewCount}</strong>
            </div>
            <div className="stat-cell">
              <span>Approved replies</span>
              <strong>{activity.approvedCommentCount}</strong>
            </div>
          </div>
          <p className="compact-copy">
            Only approved reports, reviews and replies count. Contact details stay private. Rank
            doesn&apos;t give staff access.
          </p>
        </SectionBox>
        <SectionBox title="Account details">
          <div className="identity-table">
            <div>
              <span>Handle</span>
              <strong>{account.handle}</strong>
            </div>
            <div>
              <span>Community rank</span>
              <strong>{activity.rank.name}</strong>
            </div>
            <div>
              <span>Staff access</span>
              <strong>{staffAccess}</strong>
            </div>
            <div>
              <span>Joined</span>
              <strong>{account.createdAt.slice(0, 10)}</strong>
            </div>
          </div>
        </SectionBox>
      </div>
    </SiteShell>
  );
}
