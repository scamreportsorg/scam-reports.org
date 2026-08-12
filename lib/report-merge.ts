import { findReport, getD1, setReportMergeTarget, type AuditActor } from "./reports";

export class ReportMergeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 409, code = "merge_conflict") {
    super(message);
    this.name = "ReportMergeError";
    this.status = status;
    this.code = code;
  }
}

export type ReportMergePreflight = {
  duplicate: {
    id: string;
    username: string;
    discordId: string;
    status: string;
    published: boolean;
    evidenceCount: number;
    reviewCount: number;
    commentCount: number;
    appealCount: number;
  };
  canonical: {
    id: string;
    username: string;
    discordId: string;
    status: string;
    published: boolean;
    evidenceCount: number;
    reviewCount: number;
    commentCount: number;
    appealCount: number;
  };
  conflicts: string[];
  warnings: string[];
};

type RelatedCounts = {
  evidence_count: number;
  review_count: number;
  comment_count: number;
  appeal_count: number;
};

function assertIds(duplicateId: string, canonicalId: string) {
  if (!/^SR-[A-Z0-9-]{4,40}$/.test(duplicateId) || !/^SR-[A-Z0-9-]{4,40}$/.test(canonicalId)) {
    throw new ReportMergeError("Both report IDs are invalid.", 400, "invalid_report_id");
  }
  if (duplicateId === canonicalId) {
    throw new ReportMergeError("A report cannot be merged into itself.", 400, "same_report");
  }
}

function isReportMergeIntegrityError(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message.includes("report_merge_integrity_")) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

async function relatedCounts(reportId: string): Promise<RelatedCounts> {
  const database = getD1();
  const row = await database
    .prepare(
      `SELECT
      (SELECT COUNT(*) FROM report_evidence WHERE report_id = ?1) AS evidence_count,
      (SELECT COUNT(*) FROM reviews WHERE report_id = ?1) AS review_count,
      (SELECT COUNT(*) FROM comments WHERE report_id = ?1) AS comment_count,
      (SELECT COUNT(*) FROM appeals WHERE report_id = ?1) AS appeal_count`,
    )
    .bind(reportId)
    .first<RelatedCounts>();
  return (
    row ?? {
      evidence_count: 0,
      review_count: 0,
      comment_count: 0,
      appeal_count: 0,
    }
  );
}

export async function preflightReportMerge(
  duplicateId: string,
  canonicalId: string,
): Promise<ReportMergePreflight> {
  assertIds(duplicateId, canonicalId);
  const [duplicate, canonical, duplicateCounts, canonicalCounts] = await Promise.all([
    findReport(duplicateId, true),
    findReport(canonicalId, true),
    relatedCounts(duplicateId),
    relatedCounts(canonicalId),
  ]);
  if (!duplicate || !canonical) {
    throw new ReportMergeError("One or both reports do not exist.", 404, "report_not_found");
  }

  const conflicts: string[] = [];
  const warnings: string[] = [];
  if (duplicate.mergedIntoReportId) {
    conflicts.push(`The duplicate is already merged into ${duplicate.mergedIntoReportId}.`);
  }
  if (canonical.mergedIntoReportId) {
    conflicts.push(
      `The chosen canonical report is itself merged into ${canonical.mergedIntoReportId}.`,
    );
  }
  const database = getD1();
  if (database) {
    const children = await database
      .prepare("SELECT COUNT(*) AS count FROM reports WHERE merged_into_report_id = ?")
      .bind(duplicateId)
      .first<{ count: number }>();
    if (Number(children?.count)) {
      conflicts.push("The duplicate is currently canonical for other merged reports.");
    }
    const overlappingReviewers = await database
      .prepare(
        `SELECT COUNT(DISTINCT duplicate_review.account_id) AS count
        FROM reviews duplicate_review
        JOIN reviews family_review
          ON family_review.account_id = duplicate_review.account_id
        JOIN reports family_report ON family_report.id = family_review.report_id
        WHERE duplicate_review.report_id = ?
          AND duplicate_review.account_id IS NOT NULL
          AND (
            family_review.report_id = ?
            OR family_report.merged_into_report_id = ?
          )`,
      )
      .bind(duplicateId, canonicalId, canonicalId)
      .first<{ count: number }>();
    if (Number(overlappingReviewers?.count)) {
      conflicts.push(
        "One or more members reviewed both records. Resolve those duplicate reviews before merging.",
      );
    }
  }
  if (duplicate.discordId !== canonical.discordId) {
    warnings.push("Discord IDs differ; confirm the identity match manually.");
  }
  if (duplicate.status !== canonical.status) {
    warnings.push("The reports have different moderation statuses.");
  }
  if (duplicate.isPublished && !canonical.isPublished) {
    conflicts.push("A published duplicate cannot be merged into an unpublished canonical report.");
  } else if (duplicate.isPublished !== canonical.isPublished) {
    warnings.push("The reports have different publication states.");
  }

  const summary = (report: typeof duplicate, counts: RelatedCounts) => ({
    id: report.id,
    username: report.username,
    discordId: report.discordId,
    status: report.status,
    published: report.isPublished,
    evidenceCount: Number(counts.evidence_count),
    reviewCount: Number(counts.review_count),
    commentCount: Number(counts.comment_count),
    appealCount: Number(counts.appeal_count),
  });
  return {
    duplicate: summary(duplicate, duplicateCounts),
    canonical: summary(canonical, canonicalCounts),
    conflicts,
    warnings,
  };
}

export async function mergeReports(duplicateId: string, canonicalId: string, actor: AuditActor) {
  const preflight = await preflightReportMerge(duplicateId, canonicalId);
  if (preflight.conflicts.length) {
    throw new ReportMergeError(preflight.conflicts.join(" "));
  }
  // The preview can race. D1 constraints make the final call.
  let changed: boolean;
  try {
    changed = await setReportMergeTarget(duplicateId, canonicalId, actor);
  } catch (error) {
    if (isReportMergeIntegrityError(error)) {
      throw new ReportMergeError(
        "The report family changed after preflight. Refresh the merge preview and try again.",
        409,
        "merge_state_changed",
      );
    }
    throw error;
  }
  if (!changed) {
    throw new ReportMergeError("The duplicate report no longer exists.", 404, "report_not_found");
  }
  return { preflight, duplicateId, canonicalId };
}

export async function unmergeReport(duplicateId: string, actor: AuditActor) {
  if (!/^SR-[A-Z0-9-]{4,40}$/.test(duplicateId)) {
    throw new ReportMergeError("The report ID is invalid.", 400, "invalid_report_id");
  }
  const duplicate = await findReport(duplicateId, true);
  if (!duplicate) {
    throw new ReportMergeError("The report does not exist.", 404, "report_not_found");
  }
  if (!duplicate.mergedIntoReportId) {
    throw new ReportMergeError("The report is not currently merged.", 409, "not_merged");
  }
  const previousCanonicalId = duplicate.mergedIntoReportId;
  await setReportMergeTarget(duplicateId, null, actor);
  return { duplicateId, previousCanonicalId };
}
