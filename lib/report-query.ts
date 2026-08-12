import { ensureDatabase, getD1 } from "./reports";
import { calculateReputationFromAggregates, REPUTATION_SCORE_SQL } from "./reputation";
import {
  REPORT_CATEGORIES,
  REPORT_STATUSES,
  type PaginatedResult,
  type ReportDirectoryQuery,
  type ReportListItem,
  type ReportSort,
} from "./types";

const PUBLIC_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

type DirectoryRow = {
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

type CountRow = { count: number };

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizedQuery(query: ReportDirectoryQuery) {
  return {
    q: query.q?.trim().slice(0, 100) ?? "",
    status: REPORT_STATUSES.includes(query.status as (typeof REPORT_STATUSES)[number])
      ? query.status!
      : "",
    category: REPORT_CATEGORIES.includes(query.category as (typeof REPORT_CATEGORIES)[number])
      ? query.category!
      : "",
    sort: (
      ["newest", "oldest", "evidence", "risk", "reputation", "reviews"] as ReportSort[]
    ).includes(query.sort as ReportSort)
      ? query.sort!
      : "newest",
    page: clampInteger(query.page, 1, 1, 10_000),
    pageSize: clampInteger(query.pageSize, PUBLIC_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  };
}

function fromDirectoryRow(row: DirectoryRow): ReportListItem {
  const reviewCount = Number(row.approved_review_count) || 0;
  const ratingSum = Number(row.approved_rating_sum) || 0;
  const evidenceCount = Number(row.evidence_count) || 0;
  const status = row.status as ReportListItem["status"];

  return {
    id: row.id,
    username: row.username,
    discordId: row.discord_id,
    game: row.game,
    category: row.category as ReportListItem["category"],
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

function ftsTerm(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function orderSql(sort: ReportSort) {
  if (sort === "oldest") return "reports.date_added ASC, reports.id ASC";
  if (sort === "evidence") return "family_metrics.public_evidence_count DESC, reports.id ASC";
  if (sort === "risk") return "reputation_score ASC, reports.id ASC";
  if (sort === "reputation") return "reputation_score DESC, reports.id ASC";
  if (sort === "reviews") return "family_metrics.approved_review_count DESC, reports.id ASC";
  return "reports.date_added DESC, reports.id DESC";
}

function buildWhere(filters: ReturnType<typeof normalizedQuery>, useFts: boolean) {
  const clauses = ["reports.is_published = 1", "reports.merged_into_report_id IS NULL"];
  const bindings: Array<string | number> = [];

  if (filters.status) {
    clauses.push("reports.status = ?");
    bindings.push(filters.status);
  }
  if (filters.category) {
    clauses.push("reports.category = ?");
    bindings.push(filters.category);
  }
  if (filters.q) {
    if (useFts && filters.q.length >= 3) {
      clauses.push("reports.rowid IN (SELECT rowid FROM reports_fts WHERE reports_fts MATCH ?)");
      bindings.push(ftsTerm(filters.q));
    } else if (filters.q.length < 3) {
      clauses.push(
        "(reports.id = ? OR reports.discord_id = ? OR reports.username LIKE ? ESCAPE '\\')",
      );
      bindings.push(filters.q, filters.q, `${escapeLike(filters.q)}%`);
    } else {
      clauses.push(`(
        reports.id LIKE ? ESCAPE '\\' OR reports.username LIKE ? ESCAPE '\\' OR
        reports.discord_id LIKE ? ESCAPE '\\' OR reports.game LIKE ? ESCAPE '\\' OR
        reports.category LIKE ? ESCAPE '\\' OR reports.reason LIKE ? ESCAPE '\\' OR
        reports.description LIKE ? ESCAPE '\\'
      )`);
      const contains = `%${escapeLike(filters.q)}%`;
      bindings.push(contains, contains, contains, contains, contains, contains, contains);
    }
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, bindings };
}

function escapeLike(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

async function queryD1(
  database: D1Database,
  filters: ReturnType<typeof normalizedQuery>,
  useFts: boolean,
): Promise<PaginatedResult<ReportListItem>> {
  const { where, bindings } = buildWhere(filters, useFts);
  const count = await database
    .prepare(`SELECT COUNT(*) AS count FROM reports ${where}`)
    .bind(...bindings)
    .first<CountRow>();
  const totalItems = Number(count?.count) || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / filters.pageSize));
  const page = Math.min(filters.page, totalPages);
  const offset = (page - 1) * filters.pageSize;

  const rows = await database
    .prepare(
      `SELECT
      reports.id, reports.username, reports.discord_id, reports.game, reports.category,
      reports.reason, reports.status, reports.date_added, reports.updated_at,
      family_metrics.public_evidence_count AS evidence_count,
      family_metrics.approved_review_count, family_metrics.approved_rating_sum,
      ${REPUTATION_SCORE_SQL} AS reputation_score
    FROM reports
    INNER JOIN report_family_metrics family_metrics ON family_metrics.report_id = reports.id
    ${where}
    ORDER BY ${orderSql(filters.sort)}
    LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, filters.pageSize, offset)
    .all<DirectoryRow>();

  return {
    items: rows.results.map(fromDirectoryRow),
    pagination: { page, pageSize: filters.pageSize, totalItems, totalPages },
  };
}

export async function listReportDirectory(
  query: ReportDirectoryQuery = {},
): Promise<PaginatedResult<ReportListItem>> {
  await ensureDatabase();
  const database = getD1();
  const filters = normalizedQuery(query);
  try {
    return await queryD1(database, filters, true);
  } catch (error) {
    if (filters.q.length < 3 || !String(error).toLowerCase().includes("fts")) throw error;
    return queryD1(database, filters, false);
  }
}

export function parseDirectorySearchParams(
  searchParams: Record<string, string | string[] | undefined>,
) {
  const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return normalizedQuery({
    q: first(searchParams.q),
    status: first(searchParams.status) as ReportDirectoryQuery["status"],
    category: first(searchParams.category) as ReportDirectoryQuery["category"],
    sort: first(searchParams.sort) as ReportDirectoryQuery["sort"],
    page: Number(first(searchParams.page) ?? 1),
    pageSize: PUBLIC_PAGE_SIZE,
  });
}

export const REPORTS_PER_PAGE = PUBLIC_PAGE_SIZE;

export type AdjacentReport = Pick<ReportListItem, "id" | "username">;

export async function findAdjacentPublicReports(
  reportId: string,
  dateAdded: string,
): Promise<{ newer: AdjacentReport | null; older: AdjacentReport | null }> {
  await ensureDatabase();
  const database = getD1();
  const [newer, older] = await Promise.all([
    database
      .prepare(
        `SELECT id, username FROM reports
      WHERE is_published = 1 AND merged_into_report_id IS NULL
        AND (date_added > ? OR (date_added = ? AND id > ?))
      ORDER BY date_added ASC, id ASC LIMIT 1`,
      )
      .bind(dateAdded, dateAdded, reportId)
      .first<AdjacentReport>(),
    database
      .prepare(
        `SELECT id, username FROM reports
      WHERE is_published = 1 AND merged_into_report_id IS NULL
        AND (date_added < ? OR (date_added = ? AND id < ?))
      ORDER BY date_added DESC, id DESC LIMIT 1`,
      )
      .bind(dateAdded, dateAdded, reportId)
      .first<AdjacentReport>(),
  ]);
  return { newer: newer ?? null, older: older ?? null };
}
