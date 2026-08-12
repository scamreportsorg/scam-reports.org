import { SafeLink as Link } from "./safe-link";
import type { CommunityActivity } from "@/lib/types";

export function CommunityRankBadge({ activity }: { activity: CommunityActivity }) {
  return (
    <span
      className={`community-rank-badge community-rank-level-${activity.rank.level}`}
      title={`${activity.contributionPoints} contribution points from ${activity.approvedContributionCount} approved contributions`}
    >
      <b>Lv. {activity.rank.level}</b>
      <span>{activity.rank.name}</span>
    </span>
  );
}

export function CommunityRankPanel({ activity }: { activity: CommunityActivity }) {
  const progressLabel = activity.rank.nextName
    ? `${activity.rank.pointsToNext} points to ${activity.rank.nextName}`
    : "Highest community rank reached";
  const hasNextRank = activity.rank.nextMinimumPoints !== null;

  return (
    <div className="community-rank-panel">
      <div className="community-rank-summary">
        <CommunityRankBadge activity={activity} />
        <div>
          <strong>{activity.contributionPoints} contribution points</strong>
          <span>{progressLabel}</span>
        </div>
      </div>
      {hasNextRank ? (
        <div
          className="community-rank-progress"
          role="progressbar"
          aria-label="Progress to the next community rank"
          aria-valuemin={activity.rank.minimumPoints}
          aria-valuemax={activity.rank.nextMinimumPoints ?? undefined}
          aria-valuenow={activity.contributionPoints}
          aria-valuetext={progressLabel}
        >
          <i style={{ width: `${activity.rank.progressPercent}%` }} />
        </div>
      ) : (
        <div
          className="community-rank-progress is-complete"
          role="status"
          aria-label="Highest community rank reached"
        >
          <i style={{ width: "100%" }} />
        </div>
      )}
      <small>
        Rank doesn&apos;t grant staff access. <Link href="/community/ranks">How points work</Link>
      </small>
    </div>
  );
}
