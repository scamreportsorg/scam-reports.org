import { getCoreAuthConfig, optionalBootstrapConfig } from "./auth-config";
import {
  communityActivityFromDatabaseRow,
  EMPTY_COMMUNITY_ACTIVITY,
  type CommunityActivityDatabaseRow,
} from "./community-ranks";
import { createAuthId, encryptIdentity, hmacSha256 } from "./auth-crypto";
import { getAuthDatabase } from "./auth-db";
import { AuthError } from "./auth-errors";

export type AuthRole = "member" | "moderator" | "admin";
export type AccountStatus = "active" | "suspended";
export type IdentityProvider = "discord" | "email";

export type AuthAccount = {
  id: string;
  handle: string;
  role: AuthRole;
  status: AccountStatus;
  roleVersion: number;
  createdAt: string;
  updatedAt: string;
};

export type AccountIdentity = {
  provider: IdentityProvider;
  displayHint: string;
  verifiedAt: string;
};

type AccountRow = {
  id: string;
  handle: string;
  role: string;
  status: string;
  role_version: number;
  created_at: string;
  updated_at: string;
};

type IdentityRow = {
  account_id: string;
  provider: string;
  display_hint: string;
  verified_at: string;
};

const HANDLE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{2,23}$/u;
const RESERVED_HANDLES = new Set([
  "admin",
  "administrator",
  "api",
  "appeals",
  "auth",
  "moderator",
  "root",
  "scam-reports",
  "staff",
  "support",
  "system",
]);

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new AuthError(400, "invalid_email", "Enter a valid email address.");
  }
  return email;
}

export function normalizeHandle(value: string): string {
  const handle = value.trim();
  if (!HANDLE_PATTERN.test(handle) || RESERVED_HANDLES.has(handle.toLowerCase())) {
    throw new AuthError(
      400,
      "invalid_handle",
      "Handles must be 3-24 characters and use only letters, numbers, underscores, or hyphens.",
    );
  }
  return handle;
}

export function safeReturnTo(value: string | null | undefined, fallback = "/account") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  try {
    const parsed = new URL(value, "https://auth.invalid");
    if (parsed.origin !== "https://auth.invalid") return fallback;
    if (parsed.pathname.startsWith("/api/auth/")) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}${"*".repeat(Math.min(3, Math.max(1, local.length - 1)))}@${domain}`;
}

export async function identitySubjectHash(
  provider: IdentityProvider,
  subject: string,
): Promise<string> {
  const { identityHashKey } = getCoreAuthConfig();
  const normalized = provider === "email" ? normalizeEmail(subject) : subject.trim();
  return hmacSha256(identityHashKey, `${provider}:${normalized}`);
}

function mapAccount(row: AccountRow): AuthAccount {
  if (
    (row.role !== "member" && row.role !== "moderator" && row.role !== "admin") ||
    (row.status !== "active" && row.status !== "suspended")
  ) {
    throw new Error("Authentication database contains an invalid account state.");
  }
  return {
    id: row.id,
    handle: row.handle,
    role: row.role,
    status: row.status,
    roleVersion: row.role_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isHandleUniquenessViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const message =
      current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (/UNIQUE constraint failed:\s*accounts\.handle_normalized\b/iu.test(message)) {
      return true;
    }
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

export async function findAccountById(id: string): Promise<AuthAccount | null> {
  const row = await getAuthDatabase()
    .prepare(
      `SELECT id, handle, role, status, role_version, created_at, updated_at
       FROM accounts WHERE id = ?1 LIMIT 1`,
    )
    .bind(id)
    .first<AccountRow>();
  return row ? mapAccount(row) : null;
}

export async function findPublicAccountByHandle(handle: string): Promise<AuthAccount | null> {
  const row = await getAuthDatabase()
    .prepare(
      `SELECT id, handle, role, status, role_version, created_at, updated_at
       FROM accounts
       WHERE handle_normalized = ?1 AND status = 'active'
       LIMIT 1`,
    )
    .bind(handle.trim().toLowerCase())
    .first<AccountRow>();
  return row ? mapAccount(row) : null;
}

export async function listAccountIdentities(accountId: string): Promise<AccountIdentity[]> {
  const result = await getAuthDatabase()
    .prepare(
      `SELECT account_id, provider, display_hint, verified_at
       FROM account_identities
       WHERE account_id = ?1
       ORDER BY provider ASC`,
    )
    .bind(accountId)
    .all<IdentityRow>();
  return result.results.flatMap((row) => {
    if (row.provider !== "discord" && row.provider !== "email") return [];
    return [
      {
        provider: row.provider,
        displayHint: row.display_hint,
        verifiedAt: row.verified_at,
      },
    ];
  });
}

async function neutralHandle(): Promise<{ handle: string; normalized: string }> {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const handle = `member-${suffix}`;
  return { handle, normalized: handle.toLowerCase() };
}

export async function resolveIdentity(input: {
  provider: IdentityProvider;
  subject: string;
  displayHint: string;
  targetAccountId?: string | null;
}): Promise<AuthAccount> {
  const database = getAuthDatabase();
  const config = getCoreAuthConfig();
  const subject = input.provider === "email" ? normalizeEmail(input.subject) : input.subject.trim();
  if (!subject) throw new AuthError(400, "invalid_identity", "The identity is invalid.");
  const displayHint = input.displayHint.trim().slice(0, 160);
  if (!displayHint) {
    throw new AuthError(400, "invalid_identity", "The identity display value is invalid.");
  }
  const subjectHash = await identitySubjectHash(input.provider, subject);
  const existing = await database
    .prepare(
      `SELECT account_id, provider, display_hint, verified_at
       FROM account_identities
       WHERE provider = ?1 AND subject_hash = ?2
       LIMIT 1`,
    )
    .bind(input.provider, subjectHash)
    .first<IdentityRow>();

  if (existing) {
    if (input.targetAccountId && existing.account_id !== input.targetAccountId) {
      throw new AuthError(
        409,
        "identity_conflict",
        "That identity is already linked to another account.",
      );
    }
    await database
      .prepare(
        `UPDATE account_identities
         SET display_hint = ?1, last_used_at = ?2
         WHERE account_id = ?3 AND provider = ?4`,
      )
      .bind(displayHint, new Date().toISOString(), existing.account_id, input.provider)
      .run();
    const account = await findAccountById(existing.account_id);
    if (!account) throw new Error("Linked authentication account is missing.");
    await maybeClaimBootstrapAdmin(account.id);
    return (await findAccountById(account.id)) ?? account;
  }

  const encryptedSubject = await encryptIdentity(config.identityEncryptionKey, subject);
  const now = new Date().toISOString();

  if (input.targetAccountId) {
    const account = await findAccountById(input.targetAccountId);
    if (!account || account.status !== "active") {
      throw new AuthError(401, "session_required", "Sign in again to link this identity.");
    }
    try {
      await database
        .prepare(
          `INSERT INTO account_identities
            (id, account_id, provider, subject_hash, subject_encrypted, display_hint,
             verified_at, created_at, last_used_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)`,
        )
        .bind(
          createAuthId("identity"),
          account.id,
          input.provider,
          subjectHash,
          encryptedSubject,
          displayHint,
          now,
        )
        .run();
    } catch {
      throw new AuthError(
        409,
        "identity_conflict",
        "That sign-in method is already linked to this account.",
      );
    }
    await maybeClaimBootstrapAdmin(account.id);
    return (await findAccountById(account.id)) ?? account;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const id = createAuthId("account");
    const { handle, normalized } = await neutralHandle();
    try {
      await database.batch([
        database
          .prepare(
            `INSERT INTO accounts
              (id, handle, handle_normalized, role, status, role_version,
               created_at, updated_at, last_authenticated_at)
             VALUES (?1, ?2, ?3, 'member', 'active', 1, ?4, ?4, ?4)`,
          )
          .bind(id, handle, normalized, now),
        database
          .prepare(
            `INSERT INTO account_identities
              (id, account_id, provider, subject_hash, subject_encrypted, display_hint,
               verified_at, created_at, last_used_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?7)`,
          )
          .bind(
            createAuthId("identity"),
            id,
            input.provider,
            subjectHash,
            encryptedSubject,
            displayHint,
            now,
          ),
      ]);
      await maybeClaimBootstrapAdmin(id);
      const account = await findAccountById(id);
      if (!account) throw new Error("New authentication account was not persisted.");
      return account;
    } catch (error) {
      const racedIdentity = await database
        .prepare(
          `SELECT account_id, provider, display_hint, verified_at
           FROM account_identities
           WHERE provider = ?1 AND subject_hash = ?2 LIMIT 1`,
        )
        .bind(input.provider, subjectHash)
        .first<IdentityRow>();
      if (racedIdentity) {
        const account = await findAccountById(racedIdentity.account_id);
        if (account) return account;
      }
      if (attempt === 3) throw error;
    }
  }
  throw new Error("Unable to create an authentication account.");
}

export async function updateAccountHandle(accountId: string, requested: string) {
  const handle = normalizeHandle(requested);
  const now = new Date().toISOString();
  try {
    const result = await getAuthDatabase()
      .prepare(
        `UPDATE accounts
         SET handle = ?1, handle_normalized = ?2, updated_at = ?3
         WHERE id = ?4 AND status = 'active'
         RETURNING id, handle, role, status, role_version, created_at, updated_at`,
      )
      .bind(handle, handle.toLowerCase(), now, accountId)
      .first<AccountRow>();
    if (!result) throw new AuthError(404, "account_not_found", "Account not found.");
    return mapAccount(result);
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (isHandleUniquenessViolation(error)) {
      throw new AuthError(409, "handle_taken", "That public handle is already in use.");
    }
    throw error;
  }
}

export async function unlinkIdentity(account: AuthAccount, provider: IdentityProvider) {
  const identities = await listAccountIdentities(account.id);
  if (!identities.some((identity) => identity.provider === provider)) {
    throw new AuthError(404, "identity_not_found", "That identity is not linked.");
  }
  if (identities.length <= 1) {
    throw new AuthError(409, "last_identity", "An account must keep at least one sign-in method.");
  }
  if (account.role !== "member") {
    throw new AuthError(
      409,
      "staff_identity_required",
      "Staff accounts must keep both sign-in methods.",
    );
  }
  await getAuthDatabase()
    .prepare("DELETE FROM account_identities WHERE account_id = ?1 AND provider = ?2")
    .bind(account.id, provider)
    .run();
}

async function maybeClaimBootstrapAdmin(accountId: string) {
  const bootstrap = optionalBootstrapConfig();
  if (!bootstrap) return;
  const discordHash = await identitySubjectHash("discord", bootstrap.discordId);
  const emailHash = await identitySubjectHash("email", bootstrap.email);
  const database = getAuthDatabase();
  const now = new Date().toISOString();
  const updated = await database
    .prepare(
      `UPDATE accounts
       SET role = 'admin', role_version = role_version + 1, updated_at = ?1
       WHERE id = ?2
         AND status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM auth_settings WHERE key = 'bootstrap_admin_claimed'
         )
         AND EXISTS (
           SELECT 1 FROM account_identities
           WHERE account_id = ?2 AND provider = 'discord' AND subject_hash = ?3
         )
         AND EXISTS (
           SELECT 1 FROM account_identities
           WHERE account_id = ?2 AND provider = 'email' AND subject_hash = ?4
         )
       RETURNING id`,
    )
    .bind(now, accountId, discordHash, emailHash)
    .first<{ id: string }>();
  if (updated) {
    await database
      .prepare(
        `INSERT OR IGNORE INTO auth_settings (key, value, updated_at)
         VALUES ('bootstrap_admin_claimed', ?1, ?1)`,
      )
      .bind(now)
      .run();
  }
}

export async function publicContributionCounts(accountId: string) {
  const activity = await publicCommunityActivity(accountId);
  return {
    reviews: activity.approvedReviewCount,
    comments: activity.approvedCommentCount,
    reports: activity.approvedReportCount,
  };
}

export async function publicCommunityActivity(accountId: string) {
  const row = await getAuthDatabase()
    .prepare(
      `SELECT
         account_id AS activity_account_id,
         approved_report_count,
         approved_review_count,
         approved_comment_count,
         score_eligible_comment_count
       FROM public_member_activity
       WHERE account_id = ?1
       LIMIT 1`,
    )
    .bind(accountId)
    .first<CommunityActivityDatabaseRow>();
  return communityActivityFromDatabaseRow(row) ?? EMPTY_COMMUNITY_ACTIVITY;
}
