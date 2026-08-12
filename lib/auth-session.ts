import type { AuthAccount, AuthRole, IdentityProvider } from "./auth-accounts";
import { findAccountById } from "./auth-accounts";
import { getCoreAuthConfig } from "./auth-config";
import { createAuthId, randomToken, sha256, timingSafeEqual } from "./auth-crypto";
import { getAuthDatabase } from "./auth-db";
import { AuthError } from "./auth-errors";
import { assertSameOrigin } from "./auth-origin";

const IDLE_SECONDS = 7 * 24 * 60 * 60;
const ABSOLUTE_SECONDS = 30 * 24 * 60 * 60;
const TOUCH_AFTER_SECONDS = 5 * 60;

const SECURE_SESSION_COOKIE = "__Host-sr_session";
const SECURE_CSRF_COOKIE = "__Host-sr_csrf";
const LOCAL_SESSION_COOKIE = "sr_session";
const LOCAL_CSRF_COOKIE = "sr_csrf";

type SessionRow = {
  session_id: string;
  account_id: string;
  token_hash: string;
  csrf_token_hash: string;
  session_role_version: number;
  authenticated_at: string;
  discord_confirmed_at: string | null;
  email_confirmed_at: string | null;
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  account_handle: string;
  account_role: string;
  account_status: string;
  account_role_version: number;
  account_created_at: string;
  account_updated_at: string;
  has_discord: number;
  has_email: number;
};

export type AuthPrincipal = {
  account: AuthAccount;
  session: {
    id: string;
    authenticatedAt: string;
    absoluteExpiresAt: string;
    providerConfirmations: {
      discordAt: string | null;
      emailAt: string | null;
    };
  };
  linkedProviders: {
    discord: boolean;
    email: boolean;
  };
};

export type CreatedSession = AuthPrincipal & {
  csrfToken: string;
  setCookies: string[];
};

function cookiesForSecureOrigin(secure: boolean) {
  return secure
    ? { session: SECURE_SESSION_COOKIE, csrf: SECURE_CSRF_COOKIE }
    : { session: LOCAL_SESSION_COOKIE, csrf: LOCAL_CSRF_COOKIE };
}

function cookieMap(cookieHeader: string | null): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      result.set(name, decodeURIComponent(value));
    } catch {
      continue;
    }
  }
  return result;
}

function configuredOriginIsSecure(): boolean {
  return new URL(getCoreAuthConfig().appOrigin).protocol === "https:";
}

function configuredCookiePolicy() {
  const secure = configuredOriginIsSecure();
  return { secure, names: cookiesForSecureOrigin(secure) };
}

function cookiePolicyForRequest(request: Request) {
  const policy = configuredCookiePolicy();
  const requestIsSecure = new URL(request.url).protocol === "https:";
  return requestIsSecure === policy.secure ? policy : null;
}

function serializeCookie(
  name: string,
  value: string,
  options: { httpOnly: boolean; secure: boolean; maxAge: number },
) {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${Math.max(0, Math.floor(options.maxAge))}`,
    "SameSite=Lax",
  ];
  if (options.httpOnly) attributes.push("HttpOnly");
  if (options.secure) attributes.push("Secure");
  return attributes.join("; ");
}

function rawSessionToken(request: Request): string | null {
  const policy = cookiePolicyForRequest(request);
  if (!policy) return null;
  const cookies = cookieMap(request.headers.get("cookie"));
  return cookies.get(policy.names.session) ?? null;
}

function rawCsrfToken(request: Request): string | null {
  const policy = cookiePolicyForRequest(request);
  if (!policy) return null;
  const cookies = cookieMap(request.headers.get("cookie"));
  return cookies.get(policy.names.csrf) ?? null;
}

function mapPrincipal(row: SessionRow): AuthPrincipal {
  if (
    row.account_role !== "member" &&
    row.account_role !== "moderator" &&
    row.account_role !== "admin"
  ) {
    throw new Error("Authentication database contains an invalid role.");
  }
  if (row.account_status !== "active" && row.account_status !== "suspended") {
    throw new Error("Authentication database contains an invalid status.");
  }
  return {
    account: {
      id: row.account_id,
      handle: row.account_handle,
      role: row.account_role,
      status: row.account_status,
      roleVersion: row.account_role_version,
      createdAt: row.account_created_at,
      updatedAt: row.account_updated_at,
    },
    session: {
      id: row.session_id,
      authenticatedAt: row.authenticated_at,
      absoluteExpiresAt: row.absolute_expires_at,
      providerConfirmations: {
        discordAt: row.discord_confirmed_at,
        emailAt: row.email_confirmed_at,
      },
    },
    linkedProviders: {
      discord: Boolean(row.has_discord),
      email: Boolean(row.has_email),
    },
  };
}

async function sessionFromRawToken(token: string | null): Promise<AuthPrincipal | null> {
  if (!token || token.length < 40 || token.length > 100) return null;
  const tokenHash = await sha256(token);
  const row = await getAuthDatabase()
    .prepare(
      `SELECT
         s.id AS session_id, s.account_id, s.token_hash, s.csrf_token_hash,
         s.role_version AS session_role_version, s.authenticated_at,
         s.discord_confirmed_at, s.email_confirmed_at, s.created_at,
         s.last_seen_at, s.idle_expires_at, s.absolute_expires_at,
         a.handle AS account_handle, a.role AS account_role,
         a.status AS account_status, a.role_version AS account_role_version,
         a.created_at AS account_created_at, a.updated_at AS account_updated_at,
         EXISTS(
           SELECT 1 FROM account_identities i
           WHERE i.account_id = a.id AND i.provider = 'discord'
         ) AS has_discord,
         EXISTS(
           SELECT 1 FROM account_identities i
           WHERE i.account_id = a.id AND i.provider = 'email'
         ) AS has_email
       FROM auth_sessions s
       JOIN accounts a ON a.id = s.account_id
       WHERE s.token_hash = ?1
       LIMIT 1`,
    )
    .bind(tokenHash)
    .first<SessionRow>();
  if (!row) return null;

  const now = Date.now();
  // role_version invalidates sessions created before an account role change.
  const invalid =
    row.account_status !== "active" ||
    row.session_role_version !== row.account_role_version ||
    Date.parse(row.idle_expires_at) <= now ||
    Date.parse(row.absolute_expires_at) <= now;
  if (invalid) {
    await getAuthDatabase()
      .prepare("DELETE FROM auth_sessions WHERE id = ?1")
      .bind(row.session_id)
      .run();
    return null;
  }

  if (Date.parse(row.last_seen_at) <= now - TOUCH_AFTER_SECONDS * 1000) {
    const idleExpiry = new Date(
      Math.min(now + IDLE_SECONDS * 1000, Date.parse(row.absolute_expires_at)),
    ).toISOString();
    await getAuthDatabase()
      .prepare(
        `UPDATE auth_sessions
         SET last_seen_at = ?1, idle_expires_at = ?2
         WHERE id = ?3`,
      )
      .bind(new Date(now).toISOString(), idleExpiry, row.session_id)
      .run();
  }
  return mapPrincipal(row);
}

export async function getOptionalSession(request: Request): Promise<AuthPrincipal | null> {
  return sessionFromRawToken(rawSessionToken(request));
}

export async function getOptionalSessionFromCookieHeader(
  cookieHeader: string | null,
): Promise<AuthPrincipal | null> {
  const { names } = configuredCookiePolicy();
  const cookies = cookieMap(cookieHeader);
  return sessionFromRawToken(cookies.get(names.session) ?? null);
}

function roleAllows(actual: AuthRole, required: AuthRole): boolean {
  const rank: Record<AuthRole, number> = { member: 1, moderator: 2, admin: 3 };
  return rank[actual] >= rank[required];
}

async function requireRole(request: Request, role: AuthRole): Promise<AuthPrincipal> {
  const principal = await getOptionalSession(request);
  if (!principal) {
    throw new AuthError(401, "session_required", "Sign in to continue.");
  }
  if (!roleAllows(principal.account.role, role)) {
    throw new AuthError(403, "insufficient_role", "You do not have access to this action.");
  }
  if (
    role !== "member" &&
    (!principal.linkedProviders.discord || !principal.linkedProviders.email)
  ) {
    throw new AuthError(
      403,
      "staff_identity_required",
      "Staff actions need both Discord and email linked.",
    );
  }
  return principal;
}

export function invalidCsrfError() {
  return new AuthError(403, "invalid_csrf", "This form expired. Reload the page and try again.");
}

export function requireMember(request: Request) {
  return requireRole(request, "member");
}

export async function requireModerator(
  request: Request,
  options: { fresh?: boolean; maxAgeSeconds?: number } = {},
) {
  const principal = await requireRole(request, "moderator");
  if (options.fresh) {
    assertFresh(principal, options.maxAgeSeconds ?? 600);
  }
  return principal;
}

export async function requireAdmin(
  request: Request,
  options: { fresh?: boolean; maxAgeSeconds?: number } = {},
) {
  const principal = await requireRole(request, "admin");
  if (options.fresh) {
    assertFresh(principal, options.maxAgeSeconds ?? 600);
  }
  return principal;
}

export async function requireFreshModerator(request: Request, maxAgeSeconds = 600) {
  return requireModerator(request, { fresh: true, maxAgeSeconds });
}

function assertFresh(principal: AuthPrincipal, maxAgeSeconds: number) {
  if (Date.parse(principal.session.authenticatedAt) < Date.now() - maxAgeSeconds * 1000) {
    throw new AuthError(
      401,
      "fresh_auth_required",
      "Sign in again before accessing private evidence.",
    );
  }
}

type SessionCreationOptions = {
  confirmedProvider?: IdentityProvider;
  inheritFrom?: AuthPrincipal;
  removedProvider?: IdentityProvider;
};

export async function createSession(
  accountId: string,
  options: SessionCreationOptions = {},
): Promise<CreatedSession> {
  const account = await findAccountById(accountId);
  if (!account || account.status !== "active") {
    throw new AuthError(403, "account_unavailable", "This account cannot sign in.");
  }
  if (options.inheritFrom && options.inheritFrom.account.id !== account.id) {
    throw new AuthError(403, "session_required", "That confirmation belongs to another account.");
  }
  const database = getAuthDatabase();
  const rawToken = randomToken(32);
  const csrfToken = randomToken(32);
  const now = new Date();
  const absoluteExpiry = new Date(now.getTime() + ABSOLUTE_SECONDS * 1000);
  const idleExpiry = new Date(now.getTime() + IDLE_SECONDS * 1000);
  const sessionId = createAuthId("session");
  // Only carry step-up timestamps during same-account rotation.
  const inherited = options.inheritFrom?.session.providerConfirmations;
  const confirmedAt = now.toISOString();
  const discordConfirmedAt =
    options.removedProvider === "discord"
      ? null
      : options.confirmedProvider === "discord"
        ? confirmedAt
        : (inherited?.discordAt ?? null);
  const emailConfirmedAt =
    options.removedProvider === "email"
      ? null
      : options.confirmedProvider === "email"
        ? confirmedAt
        : (inherited?.emailAt ?? null);
  await database.batch([
    database
      .prepare(
        `INSERT INTO auth_sessions
          (id, account_id, token_hash, csrf_token_hash, role_version,
           authenticated_at, discord_confirmed_at, email_confirmed_at,
           created_at, last_seen_at, idle_expires_at, absolute_expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?6, ?6, ?9, ?10)`,
      )
      .bind(
        sessionId,
        account.id,
        await sha256(rawToken),
        await sha256(csrfToken),
        account.roleVersion,
        confirmedAt,
        discordConfirmedAt,
        emailConfirmedAt,
        idleExpiry.toISOString(),
        absoluteExpiry.toISOString(),
      ),
    database
      .prepare("UPDATE accounts SET last_authenticated_at = ?1 WHERE id = ?2")
      .bind(now.toISOString(), account.id),
  ]);

  const { secure, names } = configuredCookiePolicy();
  const linkedProviders = await listProviderPresence(account.id);
  return {
    account,
    session: {
      id: sessionId,
      authenticatedAt: confirmedAt,
      absoluteExpiresAt: absoluteExpiry.toISOString(),
      providerConfirmations: {
        discordAt: discordConfirmedAt,
        emailAt: emailConfirmedAt,
      },
    },
    linkedProviders,
    csrfToken,
    setCookies: [
      serializeCookie(names.session, rawToken, {
        httpOnly: true,
        secure,
        maxAge: ABSOLUTE_SECONDS,
      }),
      serializeCookie(names.csrf, csrfToken, {
        httpOnly: false,
        secure,
        maxAge: ABSOLUTE_SECONDS,
      }),
    ],
  };
}

async function listProviderPresence(accountId: string) {
  const result = await getAuthDatabase()
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM account_identities WHERE account_id = ?1 AND provider = 'discord') AS has_discord,
         EXISTS(SELECT 1 FROM account_identities WHERE account_id = ?1 AND provider = 'email') AS has_email`,
    )
    .bind(accountId)
    .first<{ has_discord: number; has_email: number }>();
  return {
    discord: Boolean(result?.has_discord),
    email: Boolean(result?.has_email),
  };
}

export async function destroySession(request: Request): Promise<string[]> {
  const token = rawSessionToken(request);
  if (token) {
    await getAuthDatabase()
      .prepare("DELETE FROM auth_sessions WHERE token_hash = ?1")
      .bind(await sha256(token))
      .run();
  }
  const { secure, names } = configuredCookiePolicy();
  return [
    serializeCookie(names.session, "", { httpOnly: true, secure, maxAge: 0 }),
    serializeCookie(names.csrf, "", { httpOnly: false, secure, maxAge: 0 }),
  ];
}

export async function rotateSessionsForAccount(
  accountId: string,
  options: SessionCreationOptions = {},
) {
  await getAuthDatabase()
    .prepare("DELETE FROM auth_sessions WHERE account_id = ?1")
    .bind(accountId)
    .run();
  return createSession(accountId, options);
}

export function getCsrfCookie(request: Request): string | null {
  return rawCsrfToken(request);
}

export async function assertCsrf(request: Request, suppliedToken?: string | null) {
  assertSameOrigin(request);
  const principal = await requireMember(request);
  const cookieToken = rawCsrfToken(request);
  const submitted = suppliedToken ?? request.headers.get("x-csrf-token");
  if (!cookieToken || !submitted || !timingSafeEqual(cookieToken, submitted)) {
    throw invalidCsrfError();
  }
  const row = await getAuthDatabase()
    .prepare("SELECT csrf_token_hash FROM auth_sessions WHERE id = ?1 LIMIT 1")
    .bind(principal.session.id)
    .first<{ csrf_token_hash: string }>();
  const submittedHash = await sha256(submitted);
  if (!row || !timingSafeEqual(row.csrf_token_hash, submittedHash)) {
    throw invalidCsrfError();
  }
  return principal;
}

export function csrfFromCookieHeader(cookieHeader: string | null): string | null {
  return cookieMap(cookieHeader).get(configuredCookiePolicy().names.csrf) ?? null;
}

export function appendSessionCookies(headers: Headers, cookies: string[]) {
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
}
