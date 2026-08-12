import type { CommunityReview, ReviewStatus, ReviewSubmission } from "./types";
import {
  communityActivityFromDatabaseRow,
  type CommunityActivityDatabaseRow,
} from "./community-ranks";
import { ensureDatabase, getD1 } from "./reports";
import { moderatorNotificationStatements } from "./notifications";
import { assertIndependentModerator } from "./moderation-conflicts";
import { pageBounds } from "./pagination";

type ReviewRow = CommunityActivityDatabaseRow & {
  id: string;
  report_id: string;
  account_id: string | null;
  author_handle?: string | null;
  display_name: string;
  rating: number;
  relationship: string;
  title: string;
  body: string;
  status: string;
  moderator_notes: string;
  author_fingerprint: string;
  reviewer_verified: number;
  approved_revision_id: string | null;
  pending_revision_id: string | null;
  created_at: string;
  updated_at: string;
};

type ReviewAuthor = {
  accountId: string;
  accountHandle: string;
  authorFingerprint: string;
};

function fromRow(row: ReviewRow, exposeAccountId: boolean): CommunityReview {
  return {
    id: row.id,
    reportId: row.report_id,
    displayName: row.author_handle ?? row.display_name,
    rating: row.rating,
    relationship: row.relationship as CommunityReview["relationship"],
    title: row.title,
    body: row.body,
    status: row.status as ReviewStatus,
    moderatorNotes: row.moderator_notes,
    reviewerVerified: Boolean(row.account_id),
    authorHandle: row.author_handle ?? row.display_name,
    authorAccountId: exposeAccountId ? row.account_id : null,
    authorActivity: communityActivityFromDatabaseRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function forPublic(review: CommunityReview): CommunityReview {
  const { authorAccountId: _privateAccountId, ...publicReview } = review;
  void _privateAccountId;
  return { ...publicReview, moderatorNotes: "" };
}

const adminReviewSelect = `SELECT
  r.id, r.report_id, r.account_id, a.handle AS author_handle,
  COALESCE(pr.rating, r.rating) AS rating,
  COALESCE(pr.relationship, r.relationship) AS relationship,
  COALESCE(pr.title, r.title) AS title,
  COALESCE(pr.body, r.body) AS body,
  CASE WHEN pr.id IS NOT NULL THEN pr.status ELSE r.status END AS status,
  COALESCE(pr.moderator_notes, r.moderator_notes) AS moderator_notes,
  r.display_name, r.author_fingerprint, r.reviewer_verified,
  r.approved_revision_id, r.pending_revision_id, r.created_at,
  COALESCE(pr.updated_at, r.updated_at) AS updated_at
  FROM reviews r
  LEFT JOIN accounts a ON a.id = r.account_id
  LEFT JOIN review_revisions pr ON pr.id = r.pending_revision_id`;

export async function listReviews(options?: {
  reportId?: string;
  reportIds?: string[];
  includeUnpublished?: boolean;
}) {
  const reportIds = [...new Set(options?.reportIds ?? [])].slice(0, 100);
  const database = getD1();
  await ensureDatabase();
  const bindings: string[] = [];
  let statement: D1PreparedStatement;
  if (options?.includeUnpublished) {
    let where = "";
    if (options.reportId) {
      where = "WHERE r.report_id = ?";
      bindings.push(options.reportId);
    } else if (reportIds.length) {
      where = `WHERE r.report_id IN (${reportIds.map(() => "?").join(", ")})`;
      bindings.push(...reportIds);
    }
    statement = database.prepare(`${adminReviewSelect} ${where}
      ORDER BY CASE WHEN pr.id IS NOT NULL THEN 0 ELSE 1 END, r.updated_at DESC`);
  } else {
    const conditions = ["r.status = 'Approved'"];
    if (options?.reportId) {
      conditions.push("r.report_id = ?");
      bindings.push(options.reportId);
    } else if (reportIds.length) {
      conditions.push(`r.report_id IN (${reportIds.map(() => "?").join(", ")})`);
      bindings.push(...reportIds);
    }
    statement = database.prepare(`SELECT r.*, a.handle AS author_handle
      FROM reviews r LEFT JOIN accounts a ON a.id = r.account_id AND a.status = 'active'
      WHERE ${conditions.join(" AND ")} ORDER BY r.created_at DESC`);
  }
  const rows = await (bindings.length ? statement.bind(...bindings) : statement).all<ReviewRow>();
  return rows.results.map((row) => {
    const review = fromRow(row, Boolean(options?.includeUnpublished));
    return options?.includeUnpublished ? review : forPublic(review);
  });
}

export async function listPublicReviewsPage(
  input: {
    reportIds?: string[];
    page?: number;
    pageSize?: number;
  } = {},
) {
  const bounds = pageBounds(input.page, input.pageSize);
  const reportIds = [...new Set(input.reportIds ?? [])].slice(0, 100);
  const database = getD1();
  await ensureDatabase();
  const publishedParent = `(
    (p.merged_into_report_id IS NULL AND p.is_published = 1)
    OR (p.merged_into_report_id IS NOT NULL AND canonical.is_published = 1)
  )`;
  const where = reportIds.length
    ? `WHERE r.status = 'Approved' AND ${publishedParent} AND r.report_id IN (${reportIds.map(() => "?").join(", ")})`
    : `WHERE r.status = 'Approved' AND ${publishedParent}`;
  const parentJoins = `INNER JOIN reports p ON p.id = r.report_id
    LEFT JOIN reports canonical ON canonical.id = p.merged_into_report_id`;
  const rankedSelect = `SELECT r.*,
      ROW_NUMBER() OVER (
        PARTITION BY COALESCE(p.merged_into_report_id, p.id),
          COALESCE(r.account_id, 'review:' || r.id)
        ORDER BY r.updated_at DESC, r.id DESC
      ) AS family_position
    FROM reviews r ${parentJoins} ${where}`;
  const countStatement = database.prepare(`WITH ranked_reviews AS (${rankedSelect})
    SELECT COUNT(*) AS count FROM ranked_reviews WHERE family_position = 1`);
  const count = await (
    reportIds.length ? countStatement.bind(...reportIds) : countStatement
  ).first<{ count: number }>();
  const totalItems = Number(count?.count) || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / bounds.pageSize));
  const page = Math.min(bounds.page, totalPages);
  const rowsStatement = database.prepare(`WITH ranked_reviews AS (${rankedSelect})
    SELECT ranked_reviews.*, a.handle AS author_handle,
      activity.account_id AS activity_account_id,
      activity.approved_report_count,
      activity.approved_review_count,
      activity.approved_comment_count,
      activity.score_eligible_comment_count
    FROM ranked_reviews
    LEFT JOIN accounts a ON a.id = ranked_reviews.account_id AND a.status = 'active'
    LEFT JOIN public_member_activity activity ON activity.account_id = ranked_reviews.account_id
    WHERE ranked_reviews.family_position = 1
    ORDER BY ranked_reviews.updated_at DESC, ranked_reviews.id DESC LIMIT ? OFFSET ?`);
  const rows = await rowsStatement
    .bind(...reportIds, bounds.pageSize, (page - 1) * bounds.pageSize)
    .all<ReviewRow>();
  return {
    items: rows.results.map((row) => forPublic(fromRow(row, false))),
    pagination: { page, pageSize: bounds.pageSize, totalItems, totalPages },
  };
}

export async function approvedReviewAggregate(reportIds: string[]) {
  const ids = [...new Set(reportIds)].slice(0, 100);
  const database = getD1();
  await ensureDatabase();
  if (!ids.length) return { reviewCount: 0, ratingTotal: 0 };
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS review_count,
    COALESCE(SUM(rating), 0) AS rating_total FROM (
      SELECT rating, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(account_id, 'review:' || id)
        ORDER BY updated_at DESC, id DESC
      ) AS family_position
      FROM reviews
      WHERE status = 'Approved' AND report_id IN (${ids.map(() => "?").join(", ")})
    ) WHERE family_position = 1`,
    )
    .bind(...ids)
    .first<{ review_count: number; rating_total: number }>();
  return {
    reviewCount: Number(row?.review_count) || 0,
    ratingTotal: Number(row?.rating_total) || 0,
  };
}

export async function listReviewsPage(page = 1, pageSize = 25) {
  const bounds = pageBounds(page, pageSize);
  const database = getD1();
  await ensureDatabase();
  const count = await database
    .prepare("SELECT COUNT(*) AS count FROM reviews")
    .first<{ count: number }>();
  const totalItems = Number(count?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / bounds.pageSize));
  const safePage = Math.min(bounds.page, totalPages);
  const rows = await database
    .prepare(
      `${adminReviewSelect}
    ORDER BY CASE WHEN pr.id IS NOT NULL THEN 0 ELSE 1 END, r.updated_at DESC
    LIMIT ? OFFSET ?`,
    )
    .bind(bounds.pageSize, (safePage - 1) * bounds.pageSize)
    .all<ReviewRow>();
  return {
    items: rows.results.map((row) => fromRow(row, true)),
    pagination: {
      page: safePage,
      pageSize: bounds.pageSize,
      totalItems,
      totalPages,
    },
  };
}

export async function countRecentReviews(authorFingerprint: string, since: string) {
  const database = getD1();
  await ensureDatabase();
  const row = await database
    .prepare(
      "SELECT COUNT(*) AS count FROM review_revisions WHERE account_id IN (SELECT account_id FROM reviews WHERE author_fingerprint = ?) AND created_at >= ?",
    )
    .bind(authorFingerprint, since)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function createReview(input: ReviewSubmission, author: ReviewAuthor) {
  const timestamp = new Date().toISOString();
  const database = getD1();
  await ensureDatabase();
  const existing = await database
    .prepare(
      `SELECT id, approved_revision_id, pending_revision_id
    FROM reviews WHERE account_id = ? AND report_id = ? LIMIT 1`,
    )
    .bind(author.accountId, input.reportId)
    .first<{
      id: string;
      approved_revision_id: string | null;
      pending_revision_id: string | null;
    }>();
  const reviewId =
    existing?.id ??
    `REV-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const revisionId = `RVR-${crypto.randomUUID()}`;
  const statements: D1PreparedStatement[] = [];
  if (existing?.pending_revision_id) {
    statements.push(
      database
        .prepare(
          `UPDATE review_revisions SET status = 'Rejected',
      moderator_notes = 'Superseded by a newer author edit.', updated_at = ?
      WHERE id = ? AND status = 'Pending'`,
        )
        .bind(timestamp, existing.pending_revision_id),
    );
  }
  if (!existing) {
    statements.push(
      database
        .prepare(
          `INSERT INTO reviews (
      id, report_id, account_id, display_name, rating, relationship, title, body,
      status, moderator_notes, author_fingerprint, reviewer_verified,
      approved_revision_id, pending_revision_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Pending', '', ?, 1, NULL, ?, ?, ?)`,
        )
        .bind(
          reviewId,
          input.reportId,
          author.accountId,
          author.accountHandle,
          input.rating,
          input.relationship,
          input.title,
          input.body,
          author.authorFingerprint,
          revisionId,
          timestamp,
          timestamp,
        ),
    );
  } else if (existing.approved_revision_id) {
    statements.push(
      database
        .prepare(
          `UPDATE reviews SET pending_revision_id = ?,
      display_name = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(revisionId, author.accountHandle, timestamp, reviewId),
    );
  } else {
    statements.push(
      database
        .prepare(
          `UPDATE reviews SET display_name = ?, rating = ?,
      relationship = ?, title = ?, body = ?, status = 'Pending', moderator_notes = '',
      pending_revision_id = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(
          author.accountHandle,
          input.rating,
          input.relationship,
          input.title,
          input.body,
          revisionId,
          timestamp,
          reviewId,
        ),
    );
  }
  statements.push(
    database
      .prepare(
        `INSERT INTO review_revisions (
      id, review_id, account_id, rating, relationship, title, body, status,
      moderator_notes, created_at, updated_at, moderated_at, moderated_by_account_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Pending', '', ?, ?, NULL, NULL)`,
      )
      .bind(
        revisionId,
        reviewId,
        author.accountId,
        input.rating,
        input.relationship,
        input.title,
        input.body,
        timestamp,
        timestamp,
      ),
    database
      .prepare(
        `INSERT INTO audit_logs
      (report_id, action, actor, actor_account_id, created_at, detail)
      VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.reportId,
        existing ? "review-edit-submitted" : "review-submitted",
        author.accountHandle,
        author.accountId,
        timestamp,
        JSON.stringify({ reviewId, revisionId }),
      ),
    ...moderatorNotificationStatements(
      database,
      {
        caseId: reviewId,
        eventType: "review",
        queuePath: "/admin?queue=reviews",
        dedupeKey: `${reviewId}:${revisionId}`,
      },
      timestamp,
    ),
  );
  await database.batch(statements);
  return {
    id: reviewId,
    ...input,
    displayName: author.accountHandle,
    status: "Pending" as const,
    moderatorNotes: "",
    reviewerVerified: true,
    authorHandle: author.accountHandle,
    authorAccountId: author.accountId,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export async function moderateReview(
  id: string,
  status: Extract<ReviewStatus, "Approved" | "Rejected">,
  moderatorNotes: string,
  actor: string,
  actorAccountId?: string,
) {
  const timestamp = new Date().toISOString();
  const database = getD1();
  await ensureDatabase();
  const existing = await database
    .prepare(
      `SELECT r.report_id, r.account_id, r.pending_revision_id,
      r.approved_revision_id, rr.rating, rr.relationship, rr.title, rr.body
    FROM reviews r LEFT JOIN review_revisions rr ON rr.id = r.pending_revision_id
    WHERE r.id = ? LIMIT 1`,
    )
    .bind(id)
    .first<{
      report_id: string;
      account_id: string | null;
      pending_revision_id: string | null;
      approved_revision_id: string | null;
      rating: number | null;
      relationship: string | null;
      title: string | null;
      body: string | null;
    }>();
  if (!existing?.pending_revision_id || existing.rating === null) return null;
  assertIndependentModerator(existing.account_id, actorAccountId);

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE review_revisions SET status = ?, moderator_notes = ?,
      moderated_at = ?, moderated_by_account_id = ?, updated_at = ? WHERE id = ?`,
      )
      .bind(
        status,
        moderatorNotes,
        timestamp,
        actorAccountId ?? null,
        timestamp,
        existing.pending_revision_id,
      ),
  ];
  if (status === "Approved") {
    statements.push(
      database
        .prepare(
          `UPDATE reviews SET rating = ?, relationship = ?,
      title = ?, body = ?, status = 'Approved', moderator_notes = ?,
      approved_revision_id = ?, pending_revision_id = NULL, updated_at = ? WHERE id = ?`,
        )
        .bind(
          existing.rating,
          existing.relationship,
          existing.title,
          existing.body,
          moderatorNotes,
          existing.pending_revision_id,
          timestamp,
          id,
        ),
    );
  } else if (existing.approved_revision_id) {
    statements.push(
      database
        .prepare(
          `UPDATE reviews SET pending_revision_id = NULL,
      status = 'Approved', updated_at = ? WHERE id = ?`,
        )
        .bind(timestamp, id),
    );
  } else {
    statements.push(
      database
        .prepare(
          `UPDATE reviews SET pending_revision_id = NULL,
      status = 'Rejected', moderator_notes = ?, updated_at = ? WHERE id = ?`,
        )
        .bind(moderatorNotes, timestamp, id),
    );
  }
  statements.push(
    database
      .prepare(
        `UPDATE reports SET
      approved_review_count = (SELECT COUNT(*) FROM reviews WHERE report_id = ? AND status = 'Approved'),
      approved_rating_sum = COALESCE((SELECT SUM(rating) FROM reviews WHERE report_id = ? AND status = 'Approved'), 0)
      WHERE id = ?`,
      )
      .bind(existing.report_id, existing.report_id, existing.report_id),
    database
      .prepare(
        `INSERT INTO audit_logs
      (report_id, action, actor, actor_account_id, created_at, detail)
      VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        existing.report_id,
        `review-${status.toLowerCase()}`,
        actor,
        actorAccountId ?? null,
        timestamp,
        JSON.stringify({
          reviewId: id,
          revisionId: existing.pending_revision_id,
        }),
      ),
  );
  await database.batch(statements);
  const row = await database
    .prepare(
      `SELECT r.*, a.handle AS author_handle
    FROM reviews r LEFT JOIN accounts a ON a.id = r.account_id WHERE r.id = ?`,
    )
    .bind(id)
    .first<ReviewRow>();
  return row ? fromRow(row, true) : null;
}

export async function removeReview(id: string, actor: string, actorAccountId?: string) {
  const database = getD1();
  await ensureDatabase();
  const existing = await database
    .prepare("SELECT report_id FROM reviews WHERE id = ?")
    .bind(id)
    .first<{ report_id: string }>();
  if (!existing) return false;
  const timestamp = new Date().toISOString();
  await database.batch([
    database.prepare("DELETE FROM reviews WHERE id = ?").bind(id),
    database
      .prepare(
        `UPDATE reports SET
      approved_review_count = (SELECT COUNT(*) FROM reviews WHERE report_id = ? AND status = 'Approved'),
      approved_rating_sum = COALESCE((SELECT SUM(rating) FROM reviews WHERE report_id = ? AND status = 'Approved'), 0)
      WHERE id = ?`,
      )
      .bind(existing.report_id, existing.report_id, existing.report_id),
    database
      .prepare(
        `INSERT INTO audit_logs
      (report_id, action, actor, actor_account_id, created_at, detail)
      VALUES (?, 'review-deleted', ?, ?, ?, ?)`,
      )
      .bind(existing.report_id, actor, actorAccountId ?? null, timestamp, id),
  ]);
  return true;
}
