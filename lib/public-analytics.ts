import { ensureDatabase, getD1 } from "./reports";
import { calculateReputationFromAggregates, REPUTATION_SCORE_SQL } from "./reputation";
import { REPORT_CATEGORIES } from "./types";
import type { ReportCategory, ReportListItem, ReportStatus } from "./types";

export type PublicReportStats = {
  total: number;
  confirmed: number;
  underReview: number;
  reported: number;
  rejected: number;
  pending: number;
};

export type CategoryBoardSummary = {
  category: ReportCategory;
  reportCount: number;
  reviewCount: number;
  latest: Pick<ReportListItem, "id" | "username" | "game" | "updatedAt"> | null;
};

export type LatestReviewSummary = {
  id: string;
  reportId: string;
  title: string;
  rating: number;
  username: string;
};

export type HomeDashboard = {
  stats: PublicReportStats;
  categories: CategoryBoardSummary[];
  newest: ReportListItem[];
  watchlist: ReportListItem[];
  latestReviews: LatestReviewSummary[];
};

export type StatisticsDashboard = {
  stats: PublicReportStats;
  approvedReviews: number;
  averageRating: number | null;
  averageReputation: number;
  highConfidenceProfiles: number;
  monthly: Array<{ month: string; count: number }>;
  categories: Array<{ category: ReportCategory; count: number }>;
};

type CompactRow = {
  id: string;
  username: string;
  discord_id: string;
  game: string;
  category: string;
  reason: string;
  status: string;
  date_added: string;
  updated_at: string;
  evidence_count: number;
  approved_review_count: number;
  approved_rating_sum: number;
  reputation_score: number;
};

type CategorySummaryRow = {
  category: string;
  report_count: number;
  review_count: number;
};

type LatestReportRow = {
  id: string;
  username: string;
  game: string;
  category: string;
  updated_at: string;
};

type LatestReviewRow = {
  id: string;
  report_id: string;
  title: string;
  rating: number;
  username: string;
};

const COMPACT_SELECT = `
  reports.id,
  reports.username,
  reports.discord_id,
  reports.game,
  reports.category,
  reports.reason,
  reports.status,
  reports.date_added,
  reports.updated_at,
  family_metrics.public_evidence_count AS evidence_count,
  family_metrics.approved_review_count,
  family_metrics.approved_rating_sum,
  ${REPUTATION_SCORE_SQL} AS reputation_score
`;

const STATUS_STATS_SQL = `
  SELECT status, COUNT(*) AS count
  FROM reports
  WHERE is_published = 1 AND merged_into_report_id IS NULL
  GROUP BY status
`;

const CATEGORY_SUMMARIES_SQL = `
  SELECT
    reports.category,
    COUNT(*) AS report_count,
    COALESCE(SUM(family_metrics.approved_review_count), 0) AS review_count
  FROM reports
  INNER JOIN report_family_metrics family_metrics
    ON family_metrics.report_id = reports.id
  WHERE reports.is_published = 1 AND reports.merged_into_report_id IS NULL
  GROUP BY reports.category
`;

const LATEST_CATEGORY_REPORTS_SQL = `
  SELECT id, username, game, category, updated_at
  FROM (
    SELECT
      id,
      username,
      game,
      category,
      updated_at,
      ROW_NUMBER() OVER (
        PARTITION BY category
        ORDER BY date_added DESC, id DESC
      ) AS position
    FROM reports
    WHERE is_published = 1 AND merged_into_report_id IS NULL
  )
  WHERE position = 1
`;

const LATEST_REVIEWS_SQL = `
  WITH ranked_reviews AS (
    SELECT
      reviews.id,
      canonical.id AS report_id,
      reviews.title,
      reviews.rating,
      canonical.username,
      reviews.updated_at,
      ROW_NUMBER() OVER (
        PARTITION BY
          canonical.id,
          COALESCE(reviews.account_id, 'review:' || reviews.id)
        ORDER BY reviews.updated_at DESC, reviews.id DESC
      ) AS family_position
    FROM reviews
    INNER JOIN reports source ON source.id = reviews.report_id
    INNER JOIN reports canonical
      ON canonical.id = COALESCE(source.merged_into_report_id, source.id)
    WHERE reviews.status = 'Approved'
      AND canonical.is_published = 1
      AND canonical.merged_into_report_id IS NULL
  )
  SELECT id, report_id, title, rating, username
  FROM ranked_reviews
  WHERE family_position = 1
  ORDER BY updated_at DESC, id DESC
  LIMIT 4
`;

const REVIEW_STATS_SQL = `
  SELECT
    COALESCE(SUM(family_metrics.approved_review_count), 0) AS count,
    CASE
      WHEN SUM(family_metrics.approved_review_count) > 0
      THEN SUM(family_metrics.approved_rating_sum) * 1.0 /
        SUM(family_metrics.approved_review_count)
      ELSE NULL
    END AS average_rating
  FROM reports
  INNER JOIN report_family_metrics family_metrics
    ON family_metrics.report_id = reports.id
  WHERE reports.is_published = 1 AND reports.merged_into_report_id IS NULL
`;

const REPUTATION_STATS_SQL = `
  SELECT
    AVG(score) AS average_score,
    SUM(CASE WHEN confidence_points >= 7 THEN 1 ELSE 0 END) AS high_confidence
  FROM (
    SELECT
      ${REPUTATION_SCORE_SQL} AS score,
      MIN(family_metrics.approved_review_count, 4) +
        MIN(family_metrics.public_evidence_count, 3) +
        CASE WHEN reports.status IN ('Confirmed', 'Rejected') THEN 2 ELSE 0 END
        AS confidence_points
    FROM reports
    INNER JOIN report_family_metrics family_metrics
      ON family_metrics.report_id = reports.id
    WHERE reports.is_published = 1 AND reports.merged_into_report_id IS NULL
  )
`;

const MONTHLY_REPORTS_SQL = `
  SELECT substr(date_added, 1, 7) AS month, COUNT(*) AS count
  FROM reports
  WHERE is_published = 1 AND merged_into_report_id IS NULL
  GROUP BY month
  ORDER BY month
`;

const CATEGORY_COUNTS_SQL = `
  SELECT category, COUNT(*) AS count
  FROM reports
  WHERE is_published = 1 AND merged_into_report_id IS NULL
  GROUP BY category
`;

function compactRow(row: CompactRow): ReportListItem {
  const reviewCount = Number(row.approved_review_count) || 0;
  const ratingSum = Number(row.approved_rating_sum) || 0;
  const evidenceCount = Number(row.evidence_count) || 0;
  const status = row.status as ReportStatus;
  return {
    id: row.id,
    username: row.username,
    discordId: row.discord_id,
    game: row.game,
    category: row.category as ReportCategory,
    reason: row.reason,
    status,
    dateAdded: row.date_added,
    updatedAt: row.updated_at,
    evidenceCount,
    reputation: calculateReputationFromAggregates(
      { status },
      {
        reviewCount,
        ratingTotal: ratingSum,
        evidenceCount,
      },
    ),
  };
}

async function statusStats(database: D1Database): Promise<PublicReportStats> {
  const rows = await database.prepare(STATUS_STATS_SQL).all<{ status: string; count: number }>();
  const counts = new Map(rows.results.map((row) => [row.status, Number(row.count)]));
  const confirmed = counts.get("Confirmed") ?? 0;
  const underReview = counts.get("Under Review") ?? 0;
  const reported = counts.get("Reported") ?? 0;
  const rejected = counts.get("Rejected") ?? 0;

  return {
    total: confirmed + underReview + reported + rejected,
    confirmed,
    underReview,
    reported,
    rejected,
    pending: underReview + reported,
  };
}

async function compactList(database: D1Database, orderBy: string, limit: number) {
  const sql = `
    SELECT ${COMPACT_SELECT}
    FROM reports
    INNER JOIN report_family_metrics family_metrics
      ON family_metrics.report_id = reports.id
    WHERE reports.is_published = 1 AND reports.merged_into_report_id IS NULL
    ORDER BY ${orderBy}
    LIMIT ?
  `;
  const result = await database.prepare(sql).bind(limit).all<CompactRow>();

  return result.results.map(compactRow);
}

export async function getHomeDashboard(): Promise<HomeDashboard> {
  await ensureDatabase();
  const database = getD1();
  const [stats, newest, watchlist, categoryRows, latestRows, reviewRows] = await Promise.all([
    statusStats(database),
    compactList(database, "reports.date_added DESC, reports.id DESC", 5),
    compactList(database, "reputation_score ASC, reports.id ASC", 5),
    database.prepare(CATEGORY_SUMMARIES_SQL).all<CategorySummaryRow>(),
    database.prepare(LATEST_CATEGORY_REPORTS_SQL).all<LatestReportRow>(),
    database.prepare(LATEST_REVIEWS_SQL).all<LatestReviewRow>(),
  ]);
  const counts = new Map(categoryRows.results.map((row) => [row.category, row]));
  const latest = new Map(latestRows.results.map((row) => [row.category, row]));

  return {
    stats,
    newest,
    watchlist,
    categories: REPORT_CATEGORIES.map((category) => {
      const count = counts.get(category);
      const item = latest.get(category);
      return {
        category,
        reportCount: Number(count?.report_count) || 0,
        reviewCount: Number(count?.review_count) || 0,
        latest: item
          ? {
              id: item.id,
              username: item.username,
              game: item.game,
              updatedAt: item.updated_at,
            }
          : null,
      };
    }),
    latestReviews: reviewRows.results.map((row) => ({
      id: row.id,
      reportId: row.report_id,
      title: row.title,
      rating: row.rating,
      username: row.username,
    })),
  };
}

export async function getStatisticsDashboard(): Promise<StatisticsDashboard> {
  await ensureDatabase();
  const database = getD1();
  const [stats, reviewStats, scoreStats, monthlyRows, categoryRows] = await Promise.all([
    statusStats(database),
    database.prepare(REVIEW_STATS_SQL).first<{ count: number; average_rating: number | null }>(),
    database
      .prepare(REPUTATION_STATS_SQL)
      .first<{ average_score: number | null; high_confidence: number }>(),
    database.prepare(MONTHLY_REPORTS_SQL).all<{ month: string; count: number }>(),
    database.prepare(CATEGORY_COUNTS_SQL).all<{ category: string; count: number }>(),
  ]);
  const categories = new Map(categoryRows.results.map((row) => [row.category, Number(row.count)]));

  return {
    stats,
    approvedReviews: Number(reviewStats?.count) || 0,
    averageRating: reviewStats?.average_rating == null ? null : Number(reviewStats.average_rating),
    averageReputation: Math.round(Number(scoreStats?.average_score) || 0),
    highConfidenceProfiles: Number(scoreStats?.high_confidence) || 0,
    monthly: monthlyRows.results.map((row) => ({
      month: row.month,
      count: Number(row.count),
    })),
    categories: REPORT_CATEGORIES.map((category) => ({
      category,
      count: categories.get(category) ?? 0,
    })),
  };
}
