import type { ModeratorApplicationRow as SchemaModeratorApplicationRow } from "@/db/schema";
import { AuthError } from "./auth-errors";
import {
  type AdminModeratorApplication,
  type ApplicantModeratorApplication,
  MODERATOR_APPLICATION_STATUSES,
  type ModeratorApplicationStatus,
} from "./moderator-application-contract";
import { moderatorNotificationStatements } from "./notifications";
import { pageBounds } from "./pagination";
import { ensureDatabase, getD1 } from "./reports";

type ModeratorApplicationRow = Omit<SchemaModeratorApplicationRow, "confirmationAccepted"> & {
  confirmationAccepted: number | boolean;
};

type AdminModeratorApplicationRow = ModeratorApplicationRow & {
  applicant_handle: string;
  applicant_role: string;
  applicant_status: string;
  has_discord: number;
  has_email: number;
  reviewer_handle: string | null;
};

type NewModeratorApplication = {
  id: string;
  accountId: string;
  motivation: string;
  experience: string;
  timezone: string;
  availability: string;
  languages: string;
  conflicts: string;
  confirmationAccepted: true;
  createdAt: string;
};

const ACTIVE_APPLICATION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function status(value: string): ModeratorApplicationStatus {
  if (!MODERATOR_APPLICATION_STATUSES.includes(value as ModeratorApplicationStatus)) {
    throw new Error("The moderator application table contains an invalid status.");
  }
  return value as ModeratorApplicationStatus;
}

function applicantView(row: ModeratorApplicationRow): ApplicantModeratorApplication {
  return {
    id: row.id,
    motivation: row.motivation,
    experience: row.experience,
    timezone: row.timezone,
    availability: row.availability,
    languages: row.languages,
    conflicts: row.conflicts,
    confirmationAccepted: Boolean(row.confirmationAccepted),
    status: status(row.status),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    reviewedAt: row.reviewedAt,
    withdrawnAt: row.withdrawnAt,
    purgeAfter: row.purgeAfter,
    answersErasedAt: row.answersErasedAt,
  };
}

function adminView(row: AdminModeratorApplicationRow): AdminModeratorApplication {
  if (
    !["member", "moderator", "admin"].includes(row.applicant_role) ||
    !["active", "suspended"].includes(row.applicant_status)
  ) {
    throw new Error("The moderator application references an invalid account state.");
  }
  return {
    ...applicantView(row),
    accountId: row.accountId,
    applicantHandle: row.applicant_handle,
    applicantRole: row.applicant_role as AdminModeratorApplication["applicantRole"],
    applicantStatus: row.applicant_status as AdminModeratorApplication["applicantStatus"],
    linkedProviders: {
      discord: Boolean(row.has_discord),
      email: Boolean(row.has_email),
    },
    moderatorNotes: row.moderatorNotes,
    reviewedByAccountId: row.reviewedByAccountId,
    reviewerHandle: row.reviewer_handle,
  };
}

function knownConstraint(error: unknown, marker: string) {
  return error instanceof Error && error.message.includes(marker);
}

export function createModeratorApplicationId() {
  return `MODAPP-${crypto.randomUUID().replaceAll("-", "").slice(0, 20).toUpperCase()}`;
}

export async function findLatestModeratorApplicationForAccount(accountId: string) {
  await ensureDatabase();
  const row = await getD1()
    .prepare(
      `SELECT
        id,
        account_id AS accountId,
        motivation,
        experience,
        timezone,
        availability,
        languages,
        conflicts,
        confirmation_accepted AS confirmationAccepted,
        status,
        moderator_notes AS moderatorNotes,
        reviewed_by_account_id AS reviewedByAccountId,
        reviewed_at AS reviewedAt,
        withdrawn_at AS withdrawnAt,
        purge_after AS purgeAfter,
        answers_erased_at AS answersErasedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM moderator_applications
      WHERE account_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    )
    .bind(accountId)
    .first<ModeratorApplicationRow>();
  return row ? applicantView(row) : null;
}

export async function findActiveModeratorApplicationForAccount(accountId: string) {
  await ensureDatabase();
  return getD1()
    .prepare(
      `SELECT id, status FROM moderator_applications
      WHERE account_id = ? AND status IN ('Pending', 'Under Review')
      ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(accountId)
    .first<{ id: string; status: "Pending" | "Under Review" }>();
}

export async function createModeratorApplication(input: NewModeratorApplication) {
  await ensureDatabase();
  const database = getD1();
  const active = await findActiveModeratorApplicationForAccount(input.accountId);
  if (active) {
    throw new AuthError(
      409,
      "moderator_application_exists",
      "You already have an active moderator application.",
    );
  }
  try {
    await database.batch([
      database
        .prepare(
          `INSERT INTO moderator_applications (
            id, account_id, motivation, experience, timezone, availability,
            languages, conflicts, confirmation_accepted, status, moderator_notes,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', '', ?, ?)`,
        )
        .bind(
          input.id,
          input.accountId,
          input.motivation,
          input.experience,
          input.timezone,
          input.availability,
          input.languages,
          input.conflicts,
          input.confirmationAccepted ? 1 : 0,
          input.createdAt,
          input.createdAt,
        ),
      ...moderatorNotificationStatements(
        database,
        {
          caseId: input.id,
          eventType: "application",
          queuePath: "/admin?queue=applications",
        },
        input.createdAt,
      ),
    ]);
  } catch (error) {
    if (
      knownConstraint(error, "idx_moderator_applications_one_active") ||
      knownConstraint(error, "moderator_applications.account_id")
    ) {
      throw new AuthError(
        409,
        "moderator_application_exists",
        "You already have an active moderator application.",
      );
    }
    if (knownConstraint(error, "moderator_application_eligibility_required")) {
      throw new AuthError(
        409,
        "moderator_application_ineligible",
        "Link Discord and email to an active member account before applying.",
      );
    }
    throw error;
  }
  const created = await findLatestModeratorApplicationForAccount(input.accountId);
  if (!created || created.id !== input.id) {
    throw new Error("The moderator application could not be read after creation.");
  }
  return created;
}

export async function withdrawModeratorApplication(accountId: string, id: string) {
  await ensureDatabase();
  const timestamp = new Date().toISOString();
  const changed = await getD1()
    .prepare(
      `UPDATE moderator_applications
      SET status = 'Withdrawn', withdrawn_at = ?, updated_at = ?
      WHERE id = ? AND account_id = ? AND status IN ('Pending', 'Under Review')
      RETURNING id`,
    )
    .bind(timestamp, timestamp, id, accountId)
    .first<{ id: string }>();
  if (!changed) {
    const existing = await getD1()
      .prepare("SELECT status FROM moderator_applications WHERE id = ? AND account_id = ? LIMIT 1")
      .bind(id, accountId)
      .first<{ status: string }>();
    if (!existing) {
      throw new AuthError(404, "moderator_application_not_found", "Application not found.");
    }
    throw new AuthError(
      409,
      "moderator_application_not_active",
      "Only pending or under-review applications can be withdrawn.",
    );
  }
  const application = await findLatestModeratorApplicationForAccount(accountId);
  if (!application || application.id !== id) {
    throw new Error("The withdrawn moderator application could not be read.");
  }
  return application;
}

const ADMIN_APPLICATION_SELECT = `
  ma.id,
  ma.account_id AS accountId,
  ma.motivation,
  ma.experience,
  ma.timezone,
  ma.availability,
  ma.languages,
  ma.conflicts,
  ma.confirmation_accepted AS confirmationAccepted,
  ma.status,
  ma.moderator_notes AS moderatorNotes,
  ma.reviewed_by_account_id AS reviewedByAccountId,
  ma.reviewed_at AS reviewedAt,
  ma.withdrawn_at AS withdrawnAt,
  ma.purge_after AS purgeAfter,
  ma.answers_erased_at AS answersErasedAt,
  ma.created_at AS createdAt,
  ma.updated_at AS updatedAt,
  applicant.handle AS applicant_handle,
  applicant.role AS applicant_role,
  applicant.status AS applicant_status,
  EXISTS(
    SELECT 1 FROM account_identities
    WHERE account_id = applicant.id AND provider = 'discord'
  ) AS has_discord,
  EXISTS(
    SELECT 1 FROM account_identities
    WHERE account_id = applicant.id AND provider = 'email'
  ) AS has_email,
  reviewer.handle AS reviewer_handle`;

export async function listModeratorApplicationsPage(input: {
  page?: number;
  pageSize?: number;
  status?: ModeratorApplicationStatus | "";
}) {
  await ensureDatabase();
  const bounds = pageBounds(input.page, input.pageSize);
  const database = getD1();
  const filter = input.status ? "WHERE ma.status = ?" : "";
  const bindings = input.status ? [input.status] : [];
  const count = await database
    .prepare(`SELECT COUNT(*) AS count FROM moderator_applications ma ${filter}`)
    .bind(...bindings)
    .first<{ count: number }>();
  const totalItems = Number(count?.count) || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / bounds.pageSize));
  const page = Math.min(bounds.page, totalPages);
  const rows = await database
    .prepare(
      `SELECT ${ADMIN_APPLICATION_SELECT}
      FROM moderator_applications ma
      INNER JOIN accounts applicant ON applicant.id = ma.account_id
      LEFT JOIN accounts reviewer ON reviewer.id = ma.reviewed_by_account_id
      ${filter}
      ORDER BY CASE ma.status
        WHEN 'Pending' THEN 0
        WHEN 'Under Review' THEN 1
        ELSE 2
      END, ma.created_at DESC, ma.id DESC
      LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, bounds.pageSize, (page - 1) * bounds.pageSize)
    .all<AdminModeratorApplicationRow>();
  return {
    items: rows.results.map(adminView),
    pagination: { page, pageSize: bounds.pageSize, totalItems, totalPages },
  };
}

async function findAdminModeratorApplication(id: string) {
  const row = await getD1()
    .prepare(
      `SELECT ${ADMIN_APPLICATION_SELECT}
      FROM moderator_applications ma
      INNER JOIN accounts applicant ON applicant.id = ma.account_id
      LEFT JOIN accounts reviewer ON reviewer.id = ma.reviewed_by_account_id
      WHERE ma.id = ? LIMIT 1`,
    )
    .bind(id)
    .first<AdminModeratorApplicationRow>();
  return row ? adminView(row) : null;
}

export async function moderateModeratorApplication(input: {
  id: string;
  status: Extract<ModeratorApplicationStatus, "Under Review" | "Accepted" | "Rejected">;
  moderatorNotes: string;
  reviewerAccountId: string;
}) {
  await ensureDatabase();
  const database = getD1();
  const existing = await findAdminModeratorApplication(input.id);
  if (!existing) {
    throw new AuthError(404, "moderator_application_not_found", "Application not found.");
  }
  const allowed =
    existing.status === "Pending"
      ? ["Under Review"]
      : existing.status === "Under Review"
        ? ["Accepted", "Rejected"]
        : [];
  if (!allowed.includes(input.status)) {
    throw new AuthError(
      409,
      "moderator_application_invalid_transition",
      `A ${existing.status.toLowerCase()} application cannot be marked ${input.status.toLowerCase()}.`,
    );
  }
  const timestamp = new Date().toISOString();
  try {
    const changed = await database
      .prepare(
        `UPDATE moderator_applications
        SET status = ?, moderator_notes = ?, reviewed_by_account_id = ?,
          reviewed_at = ?, updated_at = ?
        WHERE id = ? AND status = ?
        RETURNING id`,
      )
      .bind(
        input.status,
        input.moderatorNotes,
        input.reviewerAccountId,
        timestamp,
        timestamp,
        input.id,
        existing.status,
      )
      .first<{ id: string }>();
    if (!changed) {
      throw new AuthError(
        409,
        "moderator_application_changed",
        "Someone else changed this application. Reload the queue.",
      );
    }
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (knownConstraint(error, "moderator_application_invalid_transition")) {
      throw new AuthError(
        409,
        "moderator_application_invalid_transition",
        "This application status transition is not allowed.",
      );
    }
    if (knownConstraint(error, "moderator_application_staff_required")) {
      throw new AuthError(
        403,
        "moderator_application_staff_required",
        "A verified moderator must review this application.",
      );
    }
    if (knownConstraint(error, "moderator_application_acceptance_requirements")) {
      throw new AuthError(
        409,
        "moderator_application_acceptance_requirements",
        "This applicant is no longer an active member with Discord and email linked.",
      );
    }
    throw error;
  }
  const application = await findAdminModeratorApplication(input.id);
  if (!application) throw new Error("The moderated application could not be read.");
  if (input.status === "Accepted" && application.applicantRole !== "moderator") {
    throw new Error("The accepted application did not grant the moderator role.");
  }
  return application;
}

export async function purgeExpiredModeratorApplicationAnswers(limit = 100, now = new Date()) {
  await ensureDatabase();
  const timestamp = now.toISOString();
  const rows = await getD1()
    .prepare(
      `UPDATE moderator_applications
      SET motivation = '', experience = '', timezone = '', availability = '',
        languages = '', conflicts = '', moderator_notes = '',
        reviewed_by_account_id = NULL, answers_erased_at = ?
      WHERE id IN (
        SELECT id FROM moderator_applications
        WHERE status IN ('Accepted', 'Rejected', 'Withdrawn', 'Expired')
          AND purge_after IS NOT NULL AND purge_after <= ?
          AND answers_erased_at IS NULL
        ORDER BY purge_after ASC, id ASC
        LIMIT ?
      )
        AND status IN ('Accepted', 'Rejected', 'Withdrawn', 'Expired')
        AND purge_after IS NOT NULL AND purge_after <= ?
        AND answers_erased_at IS NULL
      RETURNING id`,
    )
    .bind(timestamp, timestamp, Math.max(1, Math.min(Math.trunc(limit), 500)), timestamp)
    .all<{ id: string }>();
  return { purged: rows.results.length, ids: rows.results.map((row) => row.id) };
}

export async function expireStaleModeratorApplications(limit = 100, now = new Date()) {
  await ensureDatabase();
  const timestamp = now.toISOString();
  const inactiveSince = new Date(now.getTime() - ACTIVE_APPLICATION_MAX_AGE_MS).toISOString();
  const rows = await getD1()
    .prepare(
      `UPDATE moderator_applications
      SET status = 'Expired', updated_at = ?
      WHERE id IN (
        SELECT id FROM moderator_applications
        WHERE status IN ('Pending', 'Under Review') AND updated_at <= ?
        ORDER BY updated_at ASC, id ASC
        LIMIT ?
      )
        AND status IN ('Pending', 'Under Review')
        AND updated_at <= ?
      RETURNING id`,
    )
    .bind(timestamp, inactiveSince, Math.max(1, Math.min(Math.trunc(limit), 500)), inactiveSince)
    .all<{ id: string }>();
  return { expired: rows.results.length, ids: rows.results.map((row) => row.id) };
}
