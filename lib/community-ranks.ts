import type { CommunityActivity, CommunityRank, CommunityRankName } from "./types";

export const COMMUNITY_POINT_VALUES = Object.freeze({
  publishedReport: 8,
  approvedReview: 4,
  eligibleReply: 1,
});

export const COMMUNITY_REPLY_DAILY_THREAD_CAP = 3;

export const COMMUNITY_RANK_LADDER = Object.freeze([
  { level: 1, name: "Newcomer", minimumPoints: 0 },
  { level: 2, name: "Contributor", minimumPoints: 10 },
  { level: 3, name: "Regular", minimumPoints: 30 },
  { level: 4, name: "Senior Contributor", minimumPoints: 75 },
  { level: 5, name: "Veteran", minimumPoints: 150 },
  { level: 6, name: "Community Guardian", minimumPoints: 300 },
] as const satisfies readonly {
  level: number;
  name: CommunityRankName;
  minimumPoints: number;
}[]);

export type CommunityContributionCounts = {
  approvedReports: number;
  approvedReviews: number;
  approvedComments: number;
  scoreEligibleComments: number;
};

export type CommunityActivityDatabaseRow = {
  activity_account_id?: string | null;
  approved_report_count?: number | string | null;
  approved_review_count?: number | string | null;
  approved_comment_count?: number | string | null;
  score_eligible_comment_count?: number | string | null;
};

function wholeCount(value: unknown) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(count));
}

export function communityRankForPoints(value: number): CommunityRank {
  const points = wholeCount(value);
  let index = 0;
  for (let position = 1; position < COMMUNITY_RANK_LADDER.length; position += 1) {
    if (points < COMMUNITY_RANK_LADDER[position].minimumPoints) break;
    index = position;
  }
  const current = COMMUNITY_RANK_LADDER[index];
  const next = COMMUNITY_RANK_LADDER[index + 1] ?? null;
  const span = next ? next.minimumPoints - current.minimumPoints : 0;
  const progressPercent = next
    ? Math.min(100, Math.floor(((points - current.minimumPoints) / span) * 100))
    : 100;

  return {
    level: current.level,
    name: current.name,
    minimumPoints: current.minimumPoints,
    nextName: next?.name ?? null,
    nextMinimumPoints: next?.minimumPoints ?? null,
    pointsToNext: next ? Math.max(0, next.minimumPoints - points) : 0,
    progressPercent,
  };
}

export function communityActivityFromCounts(input: CommunityContributionCounts): CommunityActivity {
  const approvedReportCount = wholeCount(input.approvedReports);
  const approvedReviewCount = wholeCount(input.approvedReviews);
  const approvedCommentCount = wholeCount(input.approvedComments);
  const scoreEligibleCommentCount = Math.min(
    approvedCommentCount,
    wholeCount(input.scoreEligibleComments),
  );
  const contributionPoints = Math.min(
    Number.MAX_SAFE_INTEGER,
    approvedReportCount * COMMUNITY_POINT_VALUES.publishedReport +
      approvedReviewCount * COMMUNITY_POINT_VALUES.approvedReview +
      scoreEligibleCommentCount * COMMUNITY_POINT_VALUES.eligibleReply,
  );

  return {
    approvedReportCount,
    approvedReviewCount,
    approvedCommentCount,
    approvedContributionCount: approvedReportCount + approvedReviewCount + approvedCommentCount,
    contributionPoints,
    rank: communityRankForPoints(contributionPoints),
  };
}

export function communityActivityFromDatabaseRow(
  row: CommunityActivityDatabaseRow | null | undefined,
): CommunityActivity | null {
  if (!row?.activity_account_id) return null;
  return communityActivityFromCounts({
    approvedReports: wholeCount(row.approved_report_count),
    approvedReviews: wholeCount(row.approved_review_count),
    approvedComments: wholeCount(row.approved_comment_count),
    scoreEligibleComments: wholeCount(row.score_eligible_comment_count),
  });
}

export const EMPTY_COMMUNITY_ACTIVITY = Object.freeze(
  communityActivityFromCounts({
    approvedReports: 0,
    approvedReviews: 0,
    approvedComments: 0,
    scoreEligibleComments: 0,
  }),
);
