import type { CommunityReview, ScamReport } from "./types";

export type ReputationTone = "critical" | "poor" | "mixed" | "good" | "trusted";

export type ReputationSummary = {
  score: number;
  label: string;
  tone: ReputationTone;
  averageRating: number | null;
  reviewCount: number;
  confidence: "Low" | "Medium" | "High";
};

const STATUS_ADJUSTMENT: Record<ScamReport["status"], number> = {
  Confirmed: -35,
  "Under Review": -15,
  Reported: -8,
  Rejected: 15,
};

export const REPUTATION_SCORE_SQL = `CAST(MAX(0, MIN(100, ROUND(
  50 + CASE reports.status
    WHEN 'Confirmed' THEN -35
    WHEN 'Under Review' THEN -15
    WHEN 'Reported' THEN -8
    WHEN 'Rejected' THEN 15
    ELSE 0 END
  + (((family_metrics.approved_rating_sum + 9.0) /
    (family_metrics.approved_review_count + 3.0)) - 3.0) * 12.5
))) AS INTEGER)`;

function band(score: number): Pick<ReputationSummary, "label" | "tone"> {
  if (score < 20) return { label: "Critical risk", tone: "critical" };
  if (score < 40) return { label: "Poor", tone: "poor" };
  if (score < 60) return { label: "Mixed / unverified", tone: "mixed" };
  if (score < 80) return { label: "Good", tone: "good" };
  return { label: "Trusted", tone: "trusted" };
}

export function calculateReputation(
  report: ScamReport,
  reviews: CommunityReview[],
): ReputationSummary {
  const approved = reviews.filter(
    (review) => review.reportId === report.id && review.status === "Approved",
  );
  const ratingTotal = approved.reduce((sum, review) => sum + review.rating, 0);
  return calculateReputationFromAggregates(report, {
    reviewCount: approved.length,
    ratingTotal,
    evidenceCount: report.evidence.length,
  });
}

export function calculateReputationFromAggregates(
  report: Pick<ScamReport, "status">,
  aggregate: { reviewCount: number; ratingTotal: number; evidenceCount: number },
): ReputationSummary {
  const reviewCount = Math.max(0, Math.trunc(aggregate.reviewCount));
  const ratingTotal = Number.isFinite(aggregate.ratingTotal) ? aggregate.ratingTotal : 0;
  const evidenceCount = Math.max(0, Math.trunc(aggregate.evidenceCount));
  const averageRating = reviewCount ? ratingTotal / reviewCount : null;

  const weightedAverage = (ratingTotal + 3 * 3) / (reviewCount + 3);
  const reviewAdjustment = (weightedAverage - 3) * 12.5;
  const score = Math.max(
    0,
    Math.min(100, Math.round(50 + STATUS_ADJUSTMENT[report.status] + reviewAdjustment)),
  );

  const confidencePoints =
    Math.min(reviewCount, 4) +
    Math.min(evidenceCount, 3) +
    (report.status === "Confirmed" || report.status === "Rejected" ? 2 : 0);
  const confidence = confidencePoints >= 7 ? "High" : confidencePoints >= 4 ? "Medium" : "Low";

  return {
    score,
    ...band(score),
    averageRating,
    reviewCount,
    confidence,
  };
}

export function reputationByReport(reports: ScamReport[], reviews: CommunityReview[]) {
  return new Map(reports.map((report) => [report.id, calculateReputation(report, reviews)]));
}
