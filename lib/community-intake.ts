import type { AppealRecord, CommunityComment, IntakeStatus, ReportSubmissionRecord } from "./types";
import {
  communityActivityFromDatabaseRow,
  type CommunityActivityDatabaseRow,
} from "./community-ranks";
import { ensureDatabase, getD1, listReportFamilyIds } from "./reports";
import { moderatorNotificationStatements } from "./notifications";
import { assertIndependentModerator } from "./moderation-conflicts";
import { pageBounds } from "./pagination";
import { allocateUniqueIntakeId } from "./intake-identifiers";

type StoredReportSubmission = ReportSubmissionRecord & {
  authorFingerprint: string;
  accountId: string;
};

type StoredAppeal = AppealRecord & {
  authorFingerprint: string;
  accountId: string | null;
};

type StoredComment = CommunityComment & {
  authorFingerprint: string;
  accountId: string;
};

type ReportSubmissionRow = {
  id: string;
  account_id: string | null;
  related_report_id: string | null;
  submitter_name: string;
  contact_email: string;
  username: string;
  discord_id: string;
  game: string;
  category: string;
  reason: string;
  description: string;
  evidence_json: string;
  status: string;
  moderator_notes: string;
  author_fingerprint: string;
  submitter_verified: number;
  result_report_id: string | null;
  created_at: string;
  updated_at: string;
};

type AppealRow = {
  id: string;
  account_id: string | null;
  report_id: string;
  request_type: string;
  submitter_name: string;
  relationship: string;
  contact_email: string;
  body: string;
  evidence_json: string;
  status: string;
  moderator_notes: string;
  public_resolution: string;
  author_fingerprint: string;
  submitter_verified: number;
  created_at: string;
  updated_at: string;
};

type CommentRow = CommunityActivityDatabaseRow & {
  id: string;
  account_id: string | null;
  author_handle?: string | null;
  report_id: string;
  parent_id: string | null;
  parent_display_name?: string | null;
  display_name: string;
  body: string;
  status: string;
  moderator_notes: string;
  author_fingerprint: string;
  reviewer_verified: number;
  created_at: string;
  updated_at: string;
};

let communityInitialization: Promise<void> | null = null;

export async function ensureCommunityDatabase() {
  await ensureDatabase();
  const database = getD1();
  if (communityInitialization) return communityInitialization;

  communityInitialization = (async () => {
    const row = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'table' AND name IN ('report_submissions', 'appeals', 'comments')`,
      )
      .first<{ count: number }>();
    if (Number(row?.count) !== 3) {
      throw new Error(
        "Community intake tables are unavailable. Apply all numbered migrations before serving requests.",
      );
    }
  })().catch((error) => {
    communityInitialization = null;
    throw error;
  });

  return communityInitialization;
}
function reportSubmissionFromRow(row: ReportSubmissionRow): StoredReportSubmission {
  return {
    id: row.id,
    accountId: row.account_id ?? "",
    relatedReportId: row.related_report_id,
    submitterName: row.submitter_name,
    contactEmail: row.contact_email,
    username: row.username,
    discordId: row.discord_id,
    game: row.game,
    category: row.category as ReportSubmissionRecord["category"],
    reason: row.reason,
    description: row.description,
    evidence: JSON.parse(row.evidence_json),
    status: row.status as IntakeStatus,
    moderatorNotes: row.moderator_notes,
    authorFingerprint: row.author_fingerprint,
    submitterVerified: Boolean(row.submitter_verified),
    resultReportId: row.result_report_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function appealFromRow(row: AppealRow): StoredAppeal {
  return {
    id: row.id,
    accountId: row.account_id,
    reportId: row.report_id,
    requestType: row.request_type as AppealRecord["requestType"],
    submitterName: row.submitter_name,
    relationship: row.relationship as AppealRecord["relationship"],
    contactEmail: row.contact_email,
    body: row.body,
    evidence: JSON.parse(row.evidence_json),
    status: row.status as IntakeStatus,
    moderatorNotes: row.moderator_notes,
    publicResolution: row.public_resolution,
    authorFingerprint: row.author_fingerprint,
    submitterVerified: Boolean(row.submitter_verified),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function commentFromRow(row: CommentRow): StoredComment {
  return {
    id: row.id,
    reportId: row.report_id,
    parentId: row.parent_id,
    parentDisplayName: row.parent_display_name ?? null,
    displayName: row.display_name,
    body: row.body,
    status: row.status as CommunityComment["status"],
    moderatorNotes: row.moderator_notes,
    authorFingerprint: row.author_fingerprint,
    reviewerVerified: Boolean(row.reviewer_verified),
    accountId: row.account_id ?? "",
    authorAccountId: row.account_id,
    authorHandle: row.author_handle ?? row.display_name,
    authorActivity: communityActivityFromDatabaseRow(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function withoutFingerprint<T extends { authorFingerprint: string }>(record: T) {
  const { authorFingerprint: _privateFingerprint, ...safeRecord } = record;
  void _privateFingerprint;
  return safeRecord;
}

function forPublicComment(record: ReturnType<typeof commentFromRow>) {
  const safe = withoutFingerprint(record);
  const { accountId: _privateAccountId, authorAccountId: _authorAccountId, ...publicRecord } = safe;
  void _privateAccountId;
  void _authorAccountId;
  return {
    ...publicRecord,
    moderatorNotes: "",
  };
}

const INTAKE_TABLES = {
  SUB: "report_submissions",
  APL: "appeals",
  COM: "comments",
} as const;

export async function allocateIntakeId(prefix: "SUB" | "APL" | "COM") {
  const database = getD1();
  await ensureCommunityDatabase();
  const table = INTAKE_TABLES[prefix];
  return allocateUniqueIntakeId(prefix, async (id) => {
    const existing = await database
      .prepare(`SELECT 1 AS found FROM ${table} WHERE id = ? LIMIT 1`)
      .bind(id)
      .first();
    return Boolean(existing);
  });
}

export async function countRecentCommunityEntries(
  kind: "report" | "appeal" | "comment",
  authorFingerprint: string,
  since: string,
) {
  const database = getD1();
  await ensureCommunityDatabase();
  const table =
    kind === "report" ? "report_submissions" : kind === "appeal" ? "appeals" : "comments";
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE author_fingerprint = ? AND created_at >= ?`,
    )
    .bind(authorFingerprint, since)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function createReportSubmission(record: StoredReportSubmission) {
  const database = getD1();
  await ensureCommunityDatabase();
  await database.batch([
    database
      .prepare(
        `INSERT INTO report_submissions (
        id, account_id, related_report_id, submitter_name, contact_email, username, discord_id,
        game, category, reason, description, evidence_json, status, moderator_notes,
        author_fingerprint, submitter_verified, result_report_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.accountId,
        record.relatedReportId,
        record.submitterName,
        record.contactEmail,
        record.username,
        record.discordId,
        record.game,
        record.category,
        record.reason,
        record.description,
        JSON.stringify(record.evidence),
        record.status,
        record.moderatorNotes,
        record.authorFingerprint,
        record.submitterVerified ? 1 : 0,
        record.resultReportId,
        record.createdAt,
        record.updatedAt,
      ),
    database
      .prepare(
        "INSERT INTO audit_logs (report_id, action, actor, actor_account_id, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        record.relatedReportId ?? record.id,
        "report-submitted",
        record.submitterName,
        record.accountId,
        record.createdAt,
        record.id,
      ),
    ...moderatorNotificationStatements(
      database,
      {
        caseId: record.id,
        eventType: "report",
        queuePath: "/admin?queue=reports",
      },
      record.createdAt,
    ),
  ]);
  return withoutFingerprint(record);
}

export async function listReportSubmissions() {
  const database = getD1();
  await ensureCommunityDatabase();
  const rows = await database
    .prepare(
      "SELECT * FROM report_submissions ORDER BY CASE status WHEN 'Pending' THEN 0 WHEN 'Needs Info' THEN 1 ELSE 2 END, created_at DESC",
    )
    .all<ReportSubmissionRow>();
  return rows.results.map(reportSubmissionFromRow).map(withoutFingerprint);
}

export async function listReportSubmissionsPage(page = 1, pageSize = 25) {
  const bounds = pageBounds(page, pageSize);
  const database = getD1();
  await ensureCommunityDatabase();
  const count = await database
    .prepare("SELECT COUNT(*) AS count FROM report_submissions")
    .first<{ count: number }>();
  const totalItems = Number(count?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / bounds.pageSize));
  const safePage = Math.min(bounds.page, totalPages);
  const rows = await database
    .prepare(
      `SELECT * FROM report_submissions
      ORDER BY CASE status WHEN 'Pending' THEN 0 WHEN 'Needs Info' THEN 1 ELSE 2 END,
      created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(bounds.pageSize, (safePage - 1) * bounds.pageSize)
    .all<ReportSubmissionRow>();
  return {
    items: rows.results.map(reportSubmissionFromRow).map(withoutFingerprint),
    pagination: {
      page: safePage,
      pageSize: bounds.pageSize,
      totalItems,
      totalPages,
    },
  };
}

export async function moderateReportSubmission(
  id: string,
  status: IntakeStatus,
  moderatorNotes: string,
  resultReportId: string | null,
  actor: string,
  actorAccountId?: string,
) {
  const timestamp = new Date().toISOString();
  const database = getD1();
  await ensureCommunityDatabase();
  const existing = await database
    .prepare("SELECT id, account_id FROM report_submissions WHERE id = ?")
    .bind(id)
    .first<{ id: string; account_id: string | null }>();
  if (!existing) return null;
  assertIndependentModerator(existing.account_id, actorAccountId);
  await database.batch([
    database
      .prepare(
        "UPDATE report_submissions SET status = ?, moderator_notes = ?, result_report_id = ?, updated_at = ? WHERE id = ?",
      )
      .bind(status, moderatorNotes, resultReportId, timestamp, id),
    database
      .prepare(
        "INSERT INTO audit_logs (report_id, action, actor, actor_account_id, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        resultReportId ?? id,
        `submission-${status.toLowerCase().replaceAll(" ", "-")}`,
        actor,
        actorAccountId ?? null,
        timestamp,
        id,
      ),
  ]);
  const row = await database
    .prepare("SELECT * FROM report_submissions WHERE id = ?")
    .bind(id)
    .first<ReportSubmissionRow>();
  return row ? withoutFingerprint(reportSubmissionFromRow(row)) : null;
}

export async function permanentlyRemoveReportSubmission(
  id: string,
  actor: string,
  actorAccountId: string | undefined,
  deleteEvidence: (attachments: ReportSubmissionRecord["evidence"]) => Promise<void>,
) {
  const database = getD1();
  await ensureCommunityDatabase();
  const row = await database
    .prepare("SELECT * FROM report_submissions WHERE id = ?")
    .bind(id)
    .first<ReportSubmissionRow>();
  if (!row) return null;
  const submission = reportSubmissionFromRow(row);
  await deleteEvidence(submission.evidence);
  await database.batch([
    database.prepare("DELETE FROM report_submissions WHERE id = ?").bind(id),
    database
      .prepare(
        "INSERT INTO audit_logs (report_id, action, actor, actor_account_id, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(id, "submission-deleted", actor, actorAccountId ?? null, new Date().toISOString(), id),
  ]);
  return withoutFingerprint(submission);
}

export async function createAppeal(record: StoredAppeal) {
  const database = getD1();
  await ensureCommunityDatabase();
  await database.batch([
    database
      .prepare(
        `INSERT INTO appeals (
        id, account_id, report_id, request_type, submitter_name, relationship, contact_email,
        body, evidence_json, status, moderator_notes, public_resolution,
        author_fingerprint, submitter_verified, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.accountId,
        record.reportId,
        record.requestType,
        record.submitterName,
        record.relationship,
        record.contactEmail,
        record.body,
        JSON.stringify(record.evidence),
        record.status,
        record.moderatorNotes,
        record.publicResolution,
        record.authorFingerprint,
        record.submitterVerified ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      ),
    database
      .prepare(
        "INSERT INTO audit_logs (report_id, action, actor, actor_account_id, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        record.reportId,
        "appeal-submitted",
        record.accountId ? record.submitterName : "Anonymous appellant",
        record.accountId,
        record.createdAt,
        record.id,
      ),
    ...moderatorNotificationStatements(
      database,
      {
        caseId: record.id,
        eventType: "appeal",
        queuePath: "/admin?queue=appeals",
      },
      record.createdAt,
    ),
  ]);
  return withoutFingerprint(record);
}

export async function listAppeals(options?: {
  reportId?: string;
  reportIds?: string[];
  publicOnly?: boolean;
}) {
  const reportIds = [...new Set(options?.reportIds ?? [])].slice(0, 100);
  const database = getD1();
  await ensureCommunityDatabase();
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (options?.reportId) {
    conditions.push("report_id = ?");
    bindings.push(options.reportId);
  } else if (reportIds.length) {
    conditions.push(`report_id IN (${reportIds.map(() => "?").join(", ")})`);
    bindings.push(...reportIds);
  }
  if (options?.publicOnly) {
    conditions.push("status = 'Accepted'");
    conditions.push("public_resolution != ''");
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const statement = database.prepare(
    `SELECT * FROM appeals ${where} ORDER BY CASE status WHEN 'Pending' THEN 0 WHEN 'Needs Info' THEN 1 ELSE 2 END, created_at DESC`,
  );
  const rows = await (bindings.length ? statement.bind(...bindings) : statement).all<AppealRow>();
  return rows.results.map(appealFromRow).map(withoutFingerprint);
}

export async function listAppealsPage(page = 1, pageSize = 25) {
  const bounds = pageBounds(page, pageSize);
  const database = getD1();
  await ensureCommunityDatabase();
  const count = await database
    .prepare("SELECT COUNT(*) AS count FROM appeals")
    .first<{ count: number }>();
  const totalItems = Number(count?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / bounds.pageSize));
  const safePage = Math.min(bounds.page, totalPages);
  const rows = await database
    .prepare(
      `SELECT * FROM appeals
    ORDER BY CASE status WHEN 'Pending' THEN 0 WHEN 'Needs Info' THEN 1 ELSE 2 END,
    created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(bounds.pageSize, (safePage - 1) * bounds.pageSize)
    .all<AppealRow>();
  return {
    items: rows.results.map(appealFromRow).map(withoutFingerprint),
    pagination: {
      page: safePage,
      pageSize: bounds.pageSize,
      totalItems,
      totalPages,
    },
  };
}

export async function moderateAppeal(
  id: string,
  status: IntakeStatus,
  moderatorNotes: string,
  publicResolution: string,
  actor: string,
  actorAccountId?: string,
) {
  const timestamp = new Date().toISOString();
  const database = getD1();
  await ensureCommunityDatabase();
  const existing = await database
    .prepare("SELECT report_id, account_id FROM appeals WHERE id = ?")
    .bind(id)
    .first<{ report_id: string; account_id: string | null }>();
  if (!existing) return null;
  assertIndependentModerator(existing.account_id, actorAccountId);
  await database.batch([
    database
      .prepare(
        "UPDATE appeals SET status = ?, moderator_notes = ?, public_resolution = ?, updated_at = ? WHERE id = ?",
      )
      .bind(status, moderatorNotes, publicResolution, timestamp, id),
    database
      .prepare(
        "INSERT INTO audit_logs (report_id, action, actor, actor_account_id, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        existing.report_id,
        `appeal-${status.toLowerCase().replaceAll(" ", "-")}`,
        actor,
        actorAccountId ?? null,
        timestamp,
        id,
      ),
  ]);
  const row = await database
    .prepare("SELECT * FROM appeals WHERE id = ?")
    .bind(id)
    .first<AppealRow>();
  return row ? withoutFingerprint(appealFromRow(row)) : null;
}

export async function permanentlyRemoveAppeal(
  id: string,
  actor: string,
  actorAccountId: string | undefined,
  deleteEvidence: (attachments: AppealRecord["evidence"]) => Promise<void>,
) {
  const database = getD1();
  await ensureCommunityDatabase();
  const row = await database
    .prepare("SELECT * FROM appeals WHERE id = ?")
    .bind(id)
    .first<AppealRow>();
  if (!row) return null;
  const appeal = appealFromRow(row);
  await deleteEvidence(appeal.evidence);
  await database.batch([
    database.prepare("DELETE FROM appeals WHERE id = ?").bind(id),
    database
      .prepare(
        "INSERT INTO audit_logs (report_id, action, actor, actor_account_id, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        row.report_id,
        "appeal-deleted",
        actor,
        actorAccountId ?? null,
        new Date().toISOString(),
        id,
      ),
  ]);
  return withoutFingerprint(appeal);
}

export async function createComment(record: StoredComment) {
  const database = getD1();
  await ensureCommunityDatabase();
  await database.batch([
    database
      .prepare(
        `INSERT INTO comments (
        id, report_id, parent_id, account_id, display_name, body, status, moderator_notes,
        author_fingerprint, reviewer_verified, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.reportId,
        record.parentId,
        record.accountId,
        record.displayName,
        record.body,
        record.status,
        record.moderatorNotes,
        record.authorFingerprint,
        record.reviewerVerified ? 1 : 0,
        record.createdAt,
        record.updatedAt,
      ),
    database
      .prepare(
        "INSERT INTO audit_logs (report_id, action, actor, actor_account_id, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        record.reportId,
        "comment-submitted",
        record.displayName,
        record.accountId,
        record.createdAt,
        record.id,
      ),
    ...moderatorNotificationStatements(
      database,
      {
        caseId: record.id,
        eventType: "comment",
        queuePath: "/admin?queue=comments",
      },
      record.createdAt,
    ),
  ]);
  return withoutFingerprint(record);
}

export async function listComments(
  options: {
    reportId?: string;
    reportIds?: string[];
    includeUnpublished?: boolean;
  } = {},
) {
  const reportIds = [...new Set(options.reportIds ?? [])].slice(0, 100);
  const database = getD1();
  await ensureCommunityDatabase();
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (options.reportId) {
    conditions.push("report_id = ?");
    bindings.push(options.reportId);
  } else if (reportIds.length) {
    conditions.push(`report_id IN (${reportIds.map(() => "?").join(", ")})`);
    bindings.push(...reportIds);
  }
  if (!options.includeUnpublished) conditions.push("status = 'Approved'");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const statement = database.prepare(`SELECT c.*, a.handle AS author_handle,
    parent_comment.display_name AS parent_display_name
    FROM comments c LEFT JOIN accounts a ON a.id = c.account_id AND a.status = 'active'
    LEFT JOIN reports comment_report ON comment_report.id = c.report_id
    LEFT JOIN comments parent_comment ON parent_comment.id = c.parent_id
      AND parent_comment.status = 'Approved'
      AND EXISTS (
        SELECT 1 FROM reports parent_report
        WHERE parent_report.id = parent_comment.report_id
          AND COALESCE(parent_report.merged_into_report_id, parent_report.id) =
            COALESCE(comment_report.merged_into_report_id, comment_report.id)
      )
    ${where.replaceAll("report_id", "c.report_id").replaceAll("status", "c.status")}
    ORDER BY c.created_at ASC`);
  const rows = await (bindings.length ? statement.bind(...bindings) : statement).all<CommentRow>();
  return rows.results.map(commentFromRow).map((entry) => {
    const safe = withoutFingerprint(entry);
    return options.includeUnpublished ? safe : forPublicComment(entry);
  });
}

export async function listPublicCommentsPage(
  input: {
    reportIds?: string[];
    page?: number;
    pageSize?: number;
  } = {},
) {
  const bounds = pageBounds(input.page, input.pageSize);
  const reportIds = [...new Set(input.reportIds ?? [])].slice(0, 100);
  const database = getD1();
  await ensureCommunityDatabase();
  const publishedParent = `(
    (p.merged_into_report_id IS NULL AND p.is_published = 1)
    OR (p.merged_into_report_id IS NOT NULL AND canonical.is_published = 1)
  )`;
  const where = reportIds.length
    ? `WHERE c.status = 'Approved' AND ${publishedParent} AND c.report_id IN (${reportIds.map(() => "?").join(", ")})`
    : `WHERE c.status = 'Approved' AND ${publishedParent}`;
  const parentJoins = `INNER JOIN reports p ON p.id = c.report_id
    LEFT JOIN reports canonical ON canonical.id = p.merged_into_report_id`;
  const countStatement = database.prepare(`SELECT COUNT(*) AS count FROM comments c
    ${parentJoins} ${where}`);
  const count = await (
    reportIds.length ? countStatement.bind(...reportIds) : countStatement
  ).first<{ count: number }>();
  const totalItems = Number(count?.count) || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / bounds.pageSize));
  const page = Math.min(bounds.page, totalPages);
  const rows = await database
    .prepare(
      `SELECT c.*, a.handle AS author_handle,
      activity.account_id AS activity_account_id,
      activity.approved_report_count,
      activity.approved_review_count,
      activity.approved_comment_count,
      activity.score_eligible_comment_count,
      parent_comment.display_name AS parent_display_name
    FROM comments c
    ${parentJoins}
    LEFT JOIN accounts a ON a.id = c.account_id AND a.status = 'active'
    LEFT JOIN public_member_activity activity ON activity.account_id = c.account_id
    LEFT JOIN comments parent_comment ON parent_comment.id = c.parent_id
      AND parent_comment.status = 'Approved'
      AND EXISTS (
        SELECT 1 FROM reports parent_report
        WHERE parent_report.id = parent_comment.report_id
          AND COALESCE(parent_report.merged_into_report_id, parent_report.id) =
            COALESCE(p.merged_into_report_id, p.id)
      )
    ${where}
    ORDER BY c.created_at ASC, c.id ASC LIMIT ? OFFSET ?`,
    )
    .bind(...reportIds, bounds.pageSize, (page - 1) * bounds.pageSize)
    .all<CommentRow>();
  return {
    items: rows.results.map(commentFromRow).map(forPublicComment),
    pagination: { page, pageSize: bounds.pageSize, totalItems, totalPages },
  };
}

export async function publicCommentExists(reportId: string, commentId: string) {
  const familyIds = await listReportFamilyIds(reportId);
  const database = getD1();
  await ensureCommunityDatabase();
  if (!familyIds.length) return false;
  return Boolean(
    await database
      .prepare(
        `SELECT 1 AS found FROM comments
    WHERE id = ? AND report_id IN (${familyIds.map(() => "?").join(", ")})
      AND status = 'Approved' LIMIT 1`,
      )
      .bind(commentId, ...familyIds)
      .first<{ found: number }>(),
  );
}

export async function listCommentsPage(page = 1, pageSize = 25) {
  const bounds = pageBounds(page, pageSize);
  const database = getD1();
  await ensureCommunityDatabase();
  const count = await database
    .prepare("SELECT COUNT(*) AS count FROM comments")
    .first<{ count: number }>();
  const totalItems = Number(count?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / bounds.pageSize));
  const safePage = Math.min(bounds.page, totalPages);
  const rows = await database
    .prepare(
      `SELECT c.*, a.handle AS author_handle
    FROM comments c LEFT JOIN accounts a ON a.id = c.account_id
    ORDER BY CASE c.status WHEN 'Pending' THEN 0 ELSE 1 END,
      c.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(bounds.pageSize, (safePage - 1) * bounds.pageSize)
    .all<CommentRow>();
  return {
    items: rows.results.map(commentFromRow).map(withoutFingerprint),
    pagination: {
      page: safePage,
      pageSize: bounds.pageSize,
      totalItems,
      totalPages,
    },
  };
}

export async function moderateComment(
  id: string,
  status: Extract<CommunityComment["status"], "Approved" | "Rejected">,
  moderatorNotes: string,
  actor: string,
  actorAccountId?: string,
) {
  const timestamp = new Date().toISOString();
  const database = getD1();
  await ensureCommunityDatabase();
  const existing = await database
    .prepare("SELECT report_id, account_id FROM comments WHERE id = ?")
    .bind(id)
    .first<{ report_id: string; account_id: string | null }>();
  if (!existing) return null;
  assertIndependentModerator(existing.account_id, actorAccountId);
  await database.batch([
    database
      .prepare("UPDATE comments SET status = ?, moderator_notes = ?, updated_at = ? WHERE id = ?")
      .bind(status, moderatorNotes, timestamp, id),
    database
      .prepare(
        "INSERT INTO audit_logs (report_id, action, actor, actor_account_id, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        existing.report_id,
        `comment-${status.toLowerCase()}`,
        actor,
        actorAccountId ?? null,
        timestamp,
        id,
      ),
  ]);
  const row = await database
    .prepare("SELECT * FROM comments WHERE id = ?")
    .bind(id)
    .first<CommentRow>();
  return row ? withoutFingerprint(commentFromRow(row)) : null;
}

export async function removeComment(id: string, actor: string, actorAccountId?: string) {
  const database = getD1();
  await ensureCommunityDatabase();
  const existing = await database
    .prepare("SELECT report_id FROM comments WHERE id = ?")
    .bind(id)
    .first<{ report_id: string }>();
  if (!existing) return false;
  await database.batch([
    database.prepare("DELETE FROM comments WHERE id = ? OR parent_id = ?").bind(id, id),
    database
      .prepare(
        "INSERT INTO audit_logs (report_id, action, actor, actor_account_id, created_at, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(
        existing.report_id,
        "comment-deleted",
        actor,
        actorAccountId ?? null,
        new Date().toISOString(),
        id,
      ),
  ]);
  return true;
}
