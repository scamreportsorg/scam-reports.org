import type { AccountStatus, AuthRole } from "./auth-accounts";
import { createAuthId } from "./auth-crypto";
import { getAuthDatabase } from "./auth-db";
import { AuthError } from "./auth-errors";
import { requireRecentDualProviderConfirmation } from "./admin-mutation-auth";
import type { AuthPrincipal } from "./auth-session";

export { requireRecentDualProviderConfirmation } from "./admin-mutation-auth";

const ACCOUNT_ID = /^account_[a-f0-9]{32}$/u;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

type AccountAdminRow = {
  id: string;
  handle: string;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_authenticated_at: string | null;
  has_discord: number;
  has_email: number;
  approved_reviews: number;
  approved_comments: number;
  accepted_reports: number;
};

export type AdminAccountItem = {
  id: string;
  handle: string;
  role: AuthRole;
  status: AccountStatus;
  createdAt: string;
  updatedAt: string;
  lastAuthenticatedAt: string | null;
  linkedProviders: { discord: boolean; email: boolean };
  contributions: { reviews: number; comments: number; reports: number };
};

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}

function mapAccount(row: AccountAdminRow): AdminAccountItem {
  if (
    !["member", "moderator", "admin"].includes(row.role) ||
    !["active", "suspended"].includes(row.status)
  ) {
    throw new Error("The accounts table contains an invalid role or status.");
  }
  return {
    id: row.id,
    handle: row.handle,
    role: row.role as AuthRole,
    status: row.status as AccountStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAuthenticatedAt: row.last_authenticated_at,
    linkedProviders: {
      discord: Boolean(row.has_discord),
      email: Boolean(row.has_email),
    },
    contributions: {
      reviews: Number(row.approved_reviews) || 0,
      comments: Number(row.approved_comments) || 0,
      reports: Number(row.accepted_reports) || 0,
    },
  };
}

const ACCOUNT_SELECT = `a.id, a.handle, a.role, a.status, a.created_at,
  a.updated_at, a.last_authenticated_at,
  EXISTS(SELECT 1 FROM account_identities i WHERE i.account_id = a.id AND i.provider = 'discord') AS has_discord,
  EXISTS(SELECT 1 FROM account_identities i WHERE i.account_id = a.id AND i.provider = 'email') AS has_email,
  (SELECT COUNT(*) FROM reviews r WHERE r.account_id = a.id AND r.status = 'Approved') AS approved_reviews,
  (SELECT COUNT(*) FROM comments c WHERE c.account_id = a.id AND c.status = 'Approved') AS approved_comments,
  (SELECT COUNT(*) FROM report_submissions s WHERE s.account_id = a.id AND s.status = 'Accepted') AS accepted_reports`;

export async function listAdminAccounts(
  input: {
    page?: number;
    pageSize?: number;
    q?: string;
  } = {},
) {
  const database = getAuthDatabase();
  const page = positiveInteger(input.page, 1, 10_000);
  const pageSize = positiveInteger(input.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const query = input.q?.trim().slice(0, 100) ?? "";
  const where = query ? "WHERE a.id = ?1 OR a.handle LIKE ?2 ESCAPE '\\'" : "";
  const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
  const values = query ? [query, `%${escaped}%`] : [];
  const count = await database
    .prepare(`SELECT COUNT(*) AS count FROM accounts a ${where}`)
    .bind(...values)
    .first<{ count: number }>();
  const totalItems = Number(count?.count) || 0;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(page, totalPages);
  const result = await database
    .prepare(
      `SELECT ${ACCOUNT_SELECT} FROM accounts a ${where}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...values, pageSize, (safePage - 1) * pageSize)
    .all<AccountAdminRow>();
  return {
    items: result.results.map(mapAccount),
    pagination: { page: safePage, pageSize, totalItems, totalPages },
  };
}

async function recordSecurityEvent(input: {
  accountId: string | null;
  eventType: string;
  actorId: string;
  targetId: string;
  detail: Record<string, unknown>;
}) {
  await getAuthDatabase()
    .prepare(
      `INSERT INTO auth_security_events
      (id, account_id, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      createAuthId("security"),
      input.accountId,
      input.eventType,
      JSON.stringify({
        actorAccountId: input.actorId,
        targetAccountId: input.targetId,
        ...input.detail,
      }),
      new Date().toISOString(),
    )
    .run();
}

export async function updateAdminAccount(input: {
  targetId: string;
  actor: AuthPrincipal;
  role: AuthRole;
  status: AccountStatus;
}) {
  await requireRecentDualProviderConfirmation(input.actor);
  if (!ACCOUNT_ID.test(input.targetId)) {
    throw new AuthError(400, "invalid_account", "The account identifier is invalid.");
  }
  const actorId = input.actor.account.id;
  const database = getAuthDatabase();
  const before = await database
    .prepare("SELECT id, role, status FROM accounts WHERE id = ?")
    .bind(input.targetId)
    .first<{ id: string; role: AuthRole; status: AccountStatus }>();
  if (!before) throw new AuthError(404, "account_not_found", "Account not found.");
  if (input.role !== "member") {
    const providers = await database
      .prepare(
        `SELECT COUNT(DISTINCT provider) AS count FROM account_identities
        WHERE account_id = ? AND provider IN ('discord', 'email')`,
      )
      .bind(input.targetId)
      .first<{ count: number }>();
    if (Number(providers?.count) !== 2) {
      throw new AuthError(
        409,
        "staff_identity_required",
        "Staff accounts need both Discord and email linked.",
      );
    }
  }
  if (before.role === input.role && before.status === input.status) {
    const current = await listAdminAccounts({ q: input.targetId, pageSize: 1 });
    return current.items[0] ?? null;
  }

  const now = new Date().toISOString();
  const updated = await database
    .prepare(
      `UPDATE accounts SET role = ?, status = ?,
      role_version = role_version + 1, updated_at = ?
      WHERE id = ?
        AND (
          NOT (role = 'admin' AND status = 'active')
          OR (? = 'admin' AND ? = 'active')
          OR EXISTS (
            SELECT 1 FROM accounts other
            WHERE other.id != accounts.id AND other.role = 'admin' AND other.status = 'active'
          )
        )
        AND (
          ? = 'member' OR (
            EXISTS (SELECT 1 FROM account_identities i WHERE i.account_id = accounts.id AND i.provider = 'discord')
            AND EXISTS (SELECT 1 FROM account_identities i WHERE i.account_id = accounts.id AND i.provider = 'email')
          )
        )
      RETURNING id`,
    )
    .bind(input.role, input.status, now, input.targetId, input.role, input.status, input.role)
    .first<{ id: string }>();
  if (!updated) {
    throw new AuthError(409, "last_admin", "You cannot suspend or demote the last active admin.");
  }
  await recordSecurityEvent({
    accountId: input.targetId,
    eventType: "account.access_changed",
    actorId,
    targetId: input.targetId,
    detail: {
      fromRole: before.role,
      toRole: input.role,
      fromStatus: before.status,
      toStatus: input.status,
    },
  });
  const current = await listAdminAccounts({ q: input.targetId, pageSize: 1 });
  return current.items[0] ?? null;
}

export async function deleteAdminAccount(input: { targetId: string; actor: AuthPrincipal }) {
  await requireRecentDualProviderConfirmation(input.actor);
  if (!ACCOUNT_ID.test(input.targetId)) {
    throw new AuthError(400, "invalid_account", "The account identifier is invalid.");
  }
  const actorId = input.actor.account.id;
  const database = getAuthDatabase();
  const existing = await database
    .prepare("SELECT id, role, status FROM accounts WHERE id = ?")
    .bind(input.targetId)
    .first<{ id: string; role: AuthRole; status: AccountStatus }>();
  if (!existing) throw new AuthError(404, "account_not_found", "Account not found.");
  const removed = await database
    .prepare(
      `DELETE FROM accounts WHERE id = ? AND (
      NOT (role = 'admin' AND status = 'active') OR EXISTS (
        SELECT 1 FROM accounts other
        WHERE other.id != accounts.id AND other.role = 'admin' AND other.status = 'active'
      )
    ) RETURNING id`,
    )
    .bind(input.targetId)
    .first<{ id: string }>();
  if (!removed) {
    throw new AuthError(409, "last_admin", "You cannot delete the last active admin.");
  }
  await recordSecurityEvent({
    accountId: null,
    eventType: "account.deleted",
    actorId,
    targetId: input.targetId,
    detail: { formerRole: existing.role, formerStatus: existing.status },
  });
}
