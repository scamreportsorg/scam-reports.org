import { env } from "cloudflare:workers";
import type { ReportRow as SchemaReportRow } from "@/db/schema";
import { buildReportEvidenceLinkStatements, deleteEvidenceAsset } from "./evidence";
import { LATEST_MIGRATION_NAME } from "./version";
import type {
  AuditLog,
  EvidenceAttachment,
  PaginatedResult,
  ReportInput,
  ScamReport,
} from "./types";

type DatabaseReportRow = Omit<SchemaReportRow, "isPublished"> & {
  isPublished: number | boolean;
};

type AuditRow = {
  id: number;
  report_id: string;
  action: string;
  actor: string;
  actor_account_id: string | null;
  created_at: string;
  detail: string;
};

type EvidenceRow = {
  report_id: string;
  id: string;
  original_filename: string;
  derivative_content_type: string | null;
  derivative_size: number | null;
  caption: string;
  created_at: string;
  state: string;
};

type StatusEventRow = {
  report_id: string;
  status: string;
  public_note: string;
  created_at: string;
  actor_handle: string | null;
};

export type AuditActor = { accountId: string; handle: string };

export type AuditLogListOptions = {
  page?: number;
  pageSize?: number;
  q?: string;
  reportId?: string;
  action?: string;
};

const REPORT_SELECT = `
  id,
  username,
  discord_id AS "discordId",
  game,
  category,
  reason,
  description,
  status,
  notes,
  moderator_notes AS "moderatorNotes",
  evidence_json AS "evidenceJson",
  status_history_json AS "statusHistoryJson",
  date_added AS "dateAdded",
  updated_at AS "updatedAt",
  views,
  is_published AS "isPublished",
  merged_into_report_id AS "mergedIntoReportId",
  created_by_account_id AS "createdByAccountId",
  evidence_count AS "evidenceCount",
  approved_review_count AS "approvedReviewCount",
  approved_rating_sum AS "approvedRatingSum"`;

const databaseInitializations = new WeakMap<object, Promise<void>>();

export function getD1(): D1Database {
  let database: D1Database | undefined;
  try {
    database = (env as unknown as { DB?: D1Database }).DB;
  } catch {
    database = undefined;
  }
  if (database) return database;
  throw new Error(
    "Cloudflare D1 binding DB is unavailable. Apply the numbered migrations before starting Scam-Reports.org.",
  );
}

function fromRow(row: DatabaseReportRow): ScamReport {
  return {
    id: row.id,
    username: row.username,
    discordId: row.discordId,
    game: row.game,
    category: row.category as ScamReport["category"],
    reason: row.reason,
    description: row.description,
    status: row.status as ScamReport["status"],
    notes: row.notes,
    moderatorNotes: row.moderatorNotes,
    evidence: [],
    statusHistory: [],
    dateAdded: row.dateAdded,
    updatedAt: row.updatedAt,
    views: Number(row.views) || 0,
    isPublished: Boolean(row.isPublished),
    mergedIntoReportId: row.mergedIntoReportId,
  };
}

function forPublic(report: ScamReport): ScamReport {
  return {
    id: report.id,
    username: report.username,
    discordId: report.discordId,
    game: report.game,
    category: report.category,
    reason: report.reason,
    description: report.description,
    status: report.status,
    notes: report.notes,
    moderatorNotes: "",
    evidence: report.evidence.map((evidence) => ({
      id: evidence.id,
      filename: `${evidence.id}.webp`,
      url: evidence.url,
      caption: evidence.caption,
      uploadedAt: evidence.uploadedAt,
      fileSize: evidence.fileSize,
      contentType: evidence.contentType,
      redacted: evidence.redacted,
    })),
    statusHistory: report.statusHistory.map((entry) => ({
      status: entry.status,
      date: entry.date,
      note: entry.note,
      moderator: "Moderation team",
    })),
    dateAdded: report.dateAdded,
    updatedAt: report.updatedAt,
    views: report.views,
    isPublished: report.isPublished,
    mergedIntoReportId: report.mergedIntoReportId,
  };
}

function actorValues(actor: AuditActor | string) {
  return typeof actor === "string"
    ? { label: actor, handle: actor, accountId: null }
    : {
        label: `${actor.handle} (${actor.accountId})`,
        handle: actor.handle,
        accountId: actor.accountId,
      };
}

function statusEventNote(report: ReportInput, fallback: string) {
  const proposed = report.statusHistory.at(-1);
  return proposed?.status === report.status && proposed.note.trim()
    ? proposed.note.trim()
    : fallback;
}

function reportBindings(report: ReportInput) {
  return [
    report.id,
    report.username,
    report.discordId,
    report.game,
    report.category,
    report.reason,
    report.description,
    report.status,
    report.notes,
    report.moderatorNotes,
    JSON.stringify(report.evidence),
    "[]",
    report.dateAdded,
    report.updatedAt,
    report.views ?? 0,
    report.isPublished ? 1 : 0,
  ] as const;
}

export async function ensureDatabase() {
  const database = getD1();
  const databaseKey = database as object;
  const existingInitialization = databaseInitializations.get(databaseKey);
  if (existingInitialization) return existingInitialization;

  const initialization = (async () => {
    const required = [
      "d1_migrations",
      "accounts",
      "reports",
      "reviews",
      "report_submissions",
      "appeals",
      "comments",
      "evidence_assets",
      "rate_events",
      "report_merge_events",
      "report_family_metrics",
      "moderator_applications",
      "public_member_activity",
      "discord_rank_sync",
      "discord_rank_sync_control",
      "discord_status_messages",
      "security_observations",
      "security_incidents",
      "security_monitor_state",
    ];
    const placeholders = required.map(() => "?").join(", ");
    const row = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type IN ('table', 'view') AND name IN (${placeholders})`,
      )
      .bind(...required)
      .first<{ count: number }>();
    if (Number(row?.count) !== required.length) {
      throw new Error(
        "The D1 schema is incomplete. Apply all numbered Drizzle migrations before serving requests.",
      );
    }
    const latestMigration = await database
      .prepare("SELECT 1 AS applied FROM d1_migrations WHERE name = ? LIMIT 1")
      .bind(LATEST_MIGRATION_NAME)
      .first<{ applied: number }>();
    if (!latestMigration) {
      throw new Error(
        `The D1 schema is outdated. Apply numbered migration ${LATEST_MIGRATION_NAME} before serving requests.`,
      );
    }
    await database
      .prepare(
        "SELECT merged_into_report_id, evidence_count, approved_review_count, approved_rating_sum FROM reports LIMIT 1",
      )
      .first();
  })();
  databaseInitializations.set(databaseKey, initialization);

  initialization.catch(() => {
    if (databaseInitializations.get(databaseKey) === initialization) {
      databaseInitializations.delete(databaseKey);
    }
  });

  return initialization;
}

async function evidenceForReports(database: D1Database, reportIds: string[], publicOnly: boolean) {
  const byReport = new Map<string, EvidenceAttachment[]>();
  for (let offset = 0; offset < reportIds.length; offset += 80) {
    const ids = reportIds.slice(offset, offset + 80);
    if (!ids.length) continue;
    const placeholders = ids.map(() => "?").join(", ");
    const stateClause = publicOnly
      ? "AND ea.state = 'public' AND ea.visible_pii_reviewed = 1 AND ea.privacy_withheld = 0"
      : "AND ea.state != 'deleted'";
    const rows = await database
      .prepare(
        `SELECT re.report_id, ea.id, ea.original_filename,
        ea.derivative_content_type, ea.derivative_size, re.caption,
        ea.created_at, ea.state
        FROM report_evidence re
        INNER JOIN evidence_assets ea ON ea.id = re.evidence_id
        WHERE re.report_id IN (${placeholders}) ${stateClause}
        ORDER BY re.report_id, re.display_order, ea.created_at`,
      )
      .bind(...ids)
      .all<EvidenceRow>();
    for (const row of rows.results) {
      const attachments = byReport.get(row.report_id) ?? [];
      attachments.push({
        id: row.id,
        filename: publicOnly ? `${row.id}.webp` : row.original_filename,
        url: row.state === "public" ? `/api/evidence/${encodeURIComponent(row.id)}` : null,
        caption: row.caption,
        uploadedAt: row.created_at,
        fileSize: Number(row.derivative_size) || 0,
        contentType: row.derivative_content_type ?? "image/webp",
        redacted: row.state !== "public",
      });
      byReport.set(row.report_id, attachments);
    }
  }
  return byReport;
}

async function hydrateEvidence(database: D1Database, reports: ScamReport[], publicOnly: boolean) {
  const evidence = await evidenceForReports(
    database,
    reports.map((report) => report.id),
    publicOnly,
  );
  return reports.map((report) => ({
    ...report,
    evidence: evidence.get(report.id) ?? [],
  }));
}

async function statusHistoryForReports(database: D1Database, reportIds: string[]) {
  const uniqueIds = [...new Set(reportIds)];
  const byReport = new Map<string, ScamReport["statusHistory"]>();
  const chunkSize = 80;
  for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
    const chunk = uniqueIds.slice(offset, offset + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const rows = await database
      .prepare(
        `SELECT e.report_id, e.status, e.public_note, e.created_at,
        a.handle AS actor_handle
        FROM report_status_events e
        LEFT JOIN accounts a ON a.id = e.actor_account_id
        WHERE e.report_id IN (${placeholders})
        ORDER BY e.created_at ASC, e.id ASC`,
      )
      .bind(...chunk)
      .all<StatusEventRow>();
    for (const row of rows.results) {
      const history = byReport.get(row.report_id) ?? [];
      history.push({
        status: row.status as ScamReport["status"],
        date: row.created_at,
        note: row.public_note,
        moderator: row.actor_handle ?? "Moderation team",
      });
      byReport.set(row.report_id, history);
    }
  }
  return byReport;
}

async function hydrateStatusHistory(database: D1Database, reports: ScamReport[]) {
  const history = await statusHistoryForReports(
    database,
    reports.map((report) => report.id),
  );
  return reports.map((report) => ({
    ...report,
    statusHistory: history.get(report.id) ?? [],
  }));
}

async function loadExactReport(database: D1Database, id: string): Promise<ScamReport | null> {
  const row = await database
    .prepare(`SELECT ${REPORT_SELECT} FROM reports WHERE id = ?`)
    .bind(id)
    .first<DatabaseReportRow>();
  if (!row) return null;
  const [withEvidence] = await hydrateEvidence(database, [fromRow(row)], false);
  const [hydrated] = await hydrateStatusHistory(database, [withEvidence]);
  return hydrated;
}

export async function listReports(options?: {
  includeUnpublished?: boolean;
  includeMerged?: boolean;
}) {
  const database = getD1();
  await ensureDatabase();
  const conditions: string[] = [];
  if (!options?.includeUnpublished) conditions.push("is_published = 1");
  if (!options?.includeMerged) conditions.push("merged_into_report_id IS NULL");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await database
    .prepare(`SELECT ${REPORT_SELECT} FROM reports ${where} ORDER BY date_added DESC, id DESC`)
    .all<DatabaseReportRow>();
  const reports = result.results.map(fromRow);
  const withEvidence = await hydrateEvidence(database, reports, !options?.includeUnpublished);
  const hydrated = await hydrateStatusHistory(database, withEvidence);
  return hydrated.map((report) => (options?.includeUnpublished ? report : forPublic(report)));
}

export async function listAdminReports(
  options: {
    page?: number;
    pageSize?: number;
    q?: string;
  } = {},
): Promise<PaginatedResult<ScamReport>> {
  const requestedPage = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 25)));
  const q = options.q?.trim().slice(0, 100) ?? "";
  const database = getD1();
  await ensureDatabase();
  const where = q
    ? "WHERE id LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' OR discord_id LIKE ? ESCAPE '\\'"
    : "";
  const escaped = `%${q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const values = q ? [escaped, escaped, escaped] : [];
  const count = await database
    .prepare(`SELECT COUNT(*) AS count FROM reports ${where}`)
    .bind(...values)
    .first<{ count: number }>();
  const totalItems = Number(count?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const rows = await database
    .prepare(
      `SELECT ${REPORT_SELECT} FROM reports ${where}
      ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...values, pageSize, (page - 1) * pageSize)
    .all<DatabaseReportRow>();
  const withEvidence = await hydrateEvidence(database, rows.results.map(fromRow), false);
  const items = await hydrateStatusHistory(database, withEvidence);
  return {
    items,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
    },
  };
}

export async function findReport(id: string, includeUnpublished = false) {
  const database = getD1();
  await ensureDatabase();
  const row = await database
    .prepare(
      `SELECT ${REPORT_SELECT} FROM reports WHERE id = ? ${includeUnpublished ? "" : "AND is_published = 1"}`,
    )
    .bind(id)
    .first<DatabaseReportRow>();
  if (!row) return null;
  const base = fromRow(row);
  const familyIds = base.mergedIntoReportId ? [base.id] : await listReportFamilyIds(base.id);
  const evidence = await evidenceForReports(database, familyIds, !includeUnpublished);
  const mergedEvidence = familyIds
    .flatMap((reportId) => evidence.get(reportId) ?? [])
    .filter(
      (attachment, index, items) =>
        items.findIndex((candidate) => candidate.id === attachment.id) === index,
    );
  const [hydrated] = await hydrateStatusHistory(database, [{ ...base, evidence: mergedEvidence }]);
  return includeUnpublished ? hydrated : forPublic(hydrated);
}

export async function listReportFamilyIds(canonicalId: string): Promise<string[]> {
  const database = getD1();
  await ensureDatabase();
  const aliases = await database
    .prepare("SELECT id FROM reports WHERE merged_into_report_id = ? ORDER BY id")
    .bind(canonicalId)
    .all<{ id: string }>();
  return [canonicalId, ...aliases.results.map((row) => row.id)];
}

export async function resolveReport(id: string, includeUnpublished = false) {
  let requestedId = id;
  const seen = new Set<string>();
  for (let depth = 0; depth < 10; depth += 1) {
    if (seen.has(requestedId)) return null;
    seen.add(requestedId);
    const report = await findReport(requestedId, includeUnpublished);
    if (!report) return null;
    if (!report.mergedIntoReportId) {
      return {
        requestedId: id,
        canonicalId: report.id,
        redirected: report.id !== id,
        report,
      };
    }
    requestedId = report.mergedIntoReportId;
  }
  return null;
}

export async function createReport(report: ReportInput, actor: AuditActor | string) {
  const database = getD1();
  const auditActor = actorValues(actor);
  const now = new Date().toISOString();
  const completeReport: ScamReport = {
    ...report,
    views: report.views ?? 0,
    mergedIntoReportId: report.mergedIntoReportId ?? null,
    statusHistory: [
      {
        status: report.status,
        date: now,
        note: statusEventNote(report, "Report created."),
        moderator: auditActor.handle,
      },
    ],
  };

  await ensureDatabase();
  const duplicate = await database
    .prepare("SELECT id FROM reports WHERE discord_id = ? LIMIT 1")
    .bind(report.discordId)
    .first<{ id: string }>();
  const evidenceStatements = await buildReportEvidenceLinkStatements(
    report.id,
    report.evidence,
    auditActor.label,
  );
  await database.batch([
    database
      .prepare(
        `INSERT INTO reports (
        id, username, discord_id, game, category, reason, description, status, notes,
        moderator_notes, evidence_json, status_history_json, date_added,
        updated_at, views, is_published, merged_into_report_id, created_by_account_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .bind(...reportBindings(completeReport), auditActor.accountId),
    database
      .prepare(
        `INSERT INTO report_status_events
        (id, report_id, status, public_note, actor_account_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `RSE-${crypto.randomUUID()}`,
        report.id,
        report.status,
        statusEventNote(report, "Report created."),
        auditActor.accountId,
        now,
      ),
    database
      .prepare(
        `INSERT INTO audit_logs
        (report_id, action, actor, actor_account_id, created_at, detail)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        report.id,
        "report.created",
        auditActor.label,
        auditActor.accountId,
        now,
        duplicate ? `Possible duplicate of ${duplicate.id}` : "Report created",
      ),
    ...evidenceStatements,
  ]);
  return (await loadExactReport(database, report.id)) ?? completeReport;
}

export async function updateReport(report: ReportInput, actor: AuditActor | string) {
  const database = getD1();
  const auditActor = actorValues(actor);
  const now = new Date().toISOString();
  const completeReport: ScamReport = { ...report, views: report.views ?? 0 };
  await ensureDatabase();
  const existing = await database
    .prepare("SELECT status FROM reports WHERE id = ?")
    .bind(report.id)
    .first<{ status: string }>();
  if (!existing) return null;
  const values = reportBindings(completeReport);
  const evidenceStatements = await buildReportEvidenceLinkStatements(
    report.id,
    report.evidence,
    auditActor.label,
  );
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE reports SET
        username = ?, discord_id = ?, game = ?, category = ?, reason = ?, description = ?,
        status = ?, notes = ?, moderator_notes = ?, evidence_json = ?,
        date_added = ?, updated_at = ?, views = ?,
        is_published = ? WHERE id = ?`,
      )
      .bind(
        values[1],
        values[2],
        values[3],
        values[4],
        values[5],
        values[6],
        values[7],
        values[8],
        values[9],
        values[10],
        values[12],
        values[13],
        values[14],
        values[15],
        values[0],
      ),
    database
      .prepare(
        `INSERT INTO audit_logs
        (report_id, action, actor, actor_account_id, created_at, detail)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        report.id,
        "report.updated",
        auditActor.label,
        auditActor.accountId,
        now,
        `Status: ${report.status}`,
      ),
  ];
  if (existing.status !== report.status) {
    statements.push(
      database
        .prepare(
          `INSERT INTO report_status_events
          (id, report_id, status, public_note, actor_account_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `RSE-${crypto.randomUUID()}`,
          report.id,
          report.status,
          statusEventNote(report, `Status changed to ${report.status}.`),
          auditActor.accountId,
          now,
        ),
    );
  }
  statements.push(...evidenceStatements);
  await database.batch(statements);
  return (await loadExactReport(database, report.id)) ?? completeReport;
}

export async function removeReport(id: string, actor: AuditActor | string) {
  const database = getD1();
  await ensureDatabase();
  const auditActor = actorValues(actor);
  const report = await database
    .prepare("SELECT id FROM reports WHERE id = ?")
    .bind(id)
    .first<{ id: string }>();
  if (!report) return false;
  const aliases = await database
    .prepare("SELECT COUNT(*) AS count FROM reports WHERE merged_into_report_id = ?")
    .bind(id)
    .first<{ count: number }>();
  if (Number(aliases?.count)) {
    throw new Error("Unmerge or reassign duplicate reports before deleting the canonical report.");
  }

  const linked = await database
    .prepare(
      `SELECT ea.id, ea.legal_hold,
      (SELECT COUNT(*) FROM report_evidence all_links WHERE all_links.evidence_id = ea.id) AS link_count
      FROM report_evidence re
      INNER JOIN evidence_assets ea ON ea.id = re.evidence_id
      WHERE re.report_id = ? AND ea.state != 'deleted'`,
    )
    .bind(id)
    .all<{ id: string; legal_hold: number; link_count: number }>();
  const exclusive = linked.results.filter((asset) => Number(asset.link_count) === 1);
  if (exclusive.some((asset) => Boolean(asset.legal_hold))) {
    throw new Error("This report contains evidence under legal hold and cannot be deleted.");
  }
  for (const asset of exclusive) {
    await deleteEvidenceAsset(asset.id, auditActor.label);
  }

  const now = new Date().toISOString();
  const [, deleted] = await database.batch([
    database
      .prepare(
        `INSERT INTO audit_logs
        (report_id, action, actor, actor_account_id, created_at, detail)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        "report.deleted",
        auditActor.label,
        auditActor.accountId,
        now,
        "Report and exclusive evidence removed.",
      ),
    database.prepare("DELETE FROM reports WHERE id = ?").bind(id),
  ]);
  return Boolean(deleted.meta.changes);
}

export async function setReportMergeTarget(
  duplicateId: string,
  canonicalId: string | null,
  actor: AuditActor,
) {
  const database = getD1();
  await ensureDatabase();
  const now = new Date().toISOString();
  const action = canonicalId ? "merged" : "unmerged";
  const canonicalForEvent = canonicalId ?? duplicateId;
  const [updated] = await database.batch([
    database
      .prepare("UPDATE reports SET merged_into_report_id = ?, updated_at = ? WHERE id = ?")
      .bind(canonicalId, now, duplicateId),
    database
      .prepare(
        `INSERT INTO report_merge_events
        (id, duplicate_report_id, canonical_report_id, actor_account_id, action, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        `RME-${crypto.randomUUID()}`,
        duplicateId,
        canonicalForEvent,
        actor.accountId,
        action,
        now,
      ),
    database
      .prepare(
        `INSERT INTO audit_logs
        (report_id, action, actor, actor_account_id, created_at, detail)
        VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        duplicateId,
        `report.${action}`,
        `${actor.handle} (${actor.accountId})`,
        actor.accountId,
        now,
        canonicalId
          ? `Merged into canonical report ${canonicalId}.`
          : "Removed canonical merge assignment.",
      ),
  ]);
  return Boolean(updated.meta.changes);
}

function escapedLike(value: string) {
  return `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function auditListItem(row: AuditRow): AuditLog {
  const unverifiedLegacyAppeal = row.action === "appeal-submitted" && !row.actor_account_id;
  return {
    id: row.id,
    reportId: row.report_id,
    action: row.action,
    actor: unverifiedLegacyAppeal
      ? "Anonymous appellant"
      : row.actor.replace(/\s+\([^)]*\)\s*$/u, "").slice(0, 100),
    actorVerified: !unverifiedLegacyAppeal,
    createdAt: row.created_at,
  };
}

export async function listAuditLogsPage(
  options: AuditLogListOptions = {},
): Promise<PaginatedResult<AuditLog>> {
  const requestedPage = Math.max(1, Math.trunc(options.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(options.pageSize ?? 25)));
  const q = options.q?.trim().slice(0, 100) ?? "";
  const reportId = options.reportId?.trim().slice(0, 160) ?? "";
  const action = options.action?.trim().slice(0, 100) ?? "";
  const database = getD1();
  await ensureDatabase();
  const conditions: string[] = [];
  const values: string[] = [];
  if (q) {
    conditions.push(
      "(report_id LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\')",
    );
    const value = escapedLike(q);
    values.push(value, value, value);
  }
  if (reportId) {
    conditions.push("report_id = ?");
    values.push(reportId);
  }
  if (action) {
    conditions.push("action = ?");
    values.push(action);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const count = await database
    .prepare(`SELECT COUNT(*) AS count FROM audit_logs ${where}`)
    .bind(...values)
    .first<{ count: number }>();
  const totalItems = Number(count?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const rows = await database
    .prepare(
      `SELECT id, report_id, action, actor, actor_account_id, created_at FROM audit_logs ${where}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...values, pageSize, (page - 1) * pageSize)
    .all<AuditRow>();
  return {
    items: rows.results.map(auditListItem),
    pagination: { page, pageSize, totalItems, totalPages },
  };
}

export function nextReportId() {
  return `SR-${new Date().getUTCFullYear()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}
