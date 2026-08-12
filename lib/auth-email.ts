import {
  identitySubjectHash,
  maskEmail,
  normalizeEmail,
  resolveIdentity,
  safeReturnTo,
} from "./auth-accounts";
import { getEmailAuthConfig } from "./auth-config";
import {
  encryptIdentity,
  decryptIdentity,
  randomToken,
  sha256,
  timingSafeEqual,
} from "./auth-crypto";
import { getAuthDatabase } from "./auth-db";
import { AuthError } from "./auth-errors";
import { sendOutboundRequest } from "./outbound-http";
import {
  createSession,
  requireMember,
  rotateSessionsForAccount,
  type CreatedSession,
} from "./auth-session";

const MAGIC_LINK_SECONDS = 15 * 60;
const SECURE_LOGIN_CONTEXT_COOKIE = "__Host-sr_magic_login";
const LOCAL_LOGIN_CONTEXT_COOKIE = "sr_magic_login";

type MagicLinkRow = {
  account_id: string | null;
  initiating_session_id: string | null;
  login_context_hash: string | null;
  purpose: string;
  subject_encrypted: string;
  return_to: string;
};

function loginContextCookieName(secure: boolean) {
  return secure ? SECURE_LOGIN_CONTEXT_COOKIE : LOCAL_LOGIN_CONTEXT_COOKIE;
}

function loginContextCookie(value: string, secure: boolean) {
  return [
    `${loginContextCookieName(secure)}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${MAGIC_LINK_SECONDS}`,
    "SameSite=Lax",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [rawName, ...rest] = part.trim().split("=");
    if (rawName !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export async function prepareMagicLoginContext(request: Request) {
  const secure = new URL(getEmailAuthConfig().appOrigin).protocol === "https:";
  const cookieName = loginContextCookieName(secure);
  const existing = readCookie(request, cookieName);
  const secret =
    existing && existing.length >= 40 && existing.length <= 100 ? existing : randomToken(32);
  return {
    hash: await sha256(secret),
    setCookie: loginContextCookie(secret, secure),
  };
}

async function loginContextHash(request: Request): Promise<string | null> {
  const secure = new URL(getEmailAuthConfig().appOrigin).protocol === "https:";
  const secret = readCookie(request, loginContextCookieName(secure));
  return secret && secret.length >= 40 && secret.length <= 100 ? sha256(secret) : null;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export async function issueMagicLink(input: {
  email: string;
  purpose: "login" | "link";
  accountId?: string | null;
  sessionId?: string | null;
  loginContextHash?: string | null;
  returnTo?: string | null;
}) {
  if (input.purpose === "link" && (!input.accountId || !input.sessionId)) {
    throw new AuthError(401, "session_required", "Sign in before linking email.");
  }
  if (input.purpose === "login" && !input.loginContextHash) {
    throw new AuthError(400, "browser_context_required", "Start sign-in again in this browser.");
  }
  const config = getEmailAuthConfig();
  const email = normalizeEmail(input.email);
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MAGIC_LINK_SECONDS * 1000);
  await getAuthDatabase()
    .prepare(
      `INSERT INTO auth_magic_links
        (token_hash, account_id, initiating_session_id, login_context_hash, purpose, subject_hash,
         subject_encrypted, return_to, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      tokenHash,
      input.accountId ?? null,
      input.sessionId ?? null,
      input.purpose === "login" ? input.loginContextHash : null,
      input.purpose,
      await identitySubjectHash("email", email),
      await encryptIdentity(config.identityEncryptionKey, email),
      safeReturnTo(input.returnTo),
      now.toISOString(),
      expiresAt.toISOString(),
    )
    .run();

  const link = `${config.appOrigin}/api/auth/magic/verify?token=${encodeURIComponent(token)}`;
  let response: Response;
  try {
    response = await sendOutboundRequest(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: config.resendFrom,
          to: [email],
          subject: "Your Scam-Reports.org sign-in link",
          text: `Open this one-time link to sign in to Scam-Reports.org:\n\n${link}\n\nIt expires in 15 minutes. If you did not request it, ignore this email.`,
          html: `<p>Open this one-time link to sign in to Scam-Reports.org:</p><p><a href="${escapeHtml(link)}">Sign in securely</a></p><p>This link expires in 15 minutes. If you did not request it, ignore this email.</p>`,
        }),
      },
      {
        origin: "https://api.resend.com",
        pathname: "/emails",
        timeoutMs: 10_000,
      },
    );
  } catch {
    await getAuthDatabase()
      .prepare("DELETE FROM auth_magic_links WHERE token_hash = ?1")
      .bind(tokenHash)
      .run();
    throw new AuthError(503, "email_unavailable", "Email sign-in is unavailable right now.");
  }
  if (!response.ok) {
    await getAuthDatabase()
      .prepare("DELETE FROM auth_magic_links WHERE token_hash = ?1")
      .bind(tokenHash)
      .run();
    throw new AuthError(503, "email_unavailable", "Email sign-in is unavailable right now.");
  }
}

export async function consumeMagicLink(
  token: string,
  request: Request,
): Promise<{
  session: CreatedSession;
  returnTo: string;
}> {
  if (token.length < 40 || token.length > 100) {
    throw new AuthError(400, "invalid_link", "This sign-in link is invalid.");
  }
  const config = getEmailAuthConfig();
  const tokenHash = await sha256(token);
  const pending = await getAuthDatabase()
    .prepare(
      `SELECT account_id, initiating_session_id, login_context_hash, purpose, subject_encrypted, return_to
       FROM auth_magic_links
       WHERE token_hash = ?1 AND expires_at > ?2
       LIMIT 1`,
    )
    .bind(tokenHash, new Date().toISOString())
    .first<MagicLinkRow>();
  if (!pending || (pending.purpose !== "login" && pending.purpose !== "link")) {
    throw new AuthError(400, "expired_link", "This sign-in link expired or was already used.");
  }
  let linkingPrincipal: Awaited<ReturnType<typeof requireMember>> | null = null;
  let verifiedLoginContextHash: string | null = null;
  if (pending.purpose === "link") {
    linkingPrincipal = await requireMember(request);
    if (
      !pending.account_id ||
      !pending.initiating_session_id ||
      pending.account_id !== linkingPrincipal.account.id ||
      pending.initiating_session_id !== linkingPrincipal.session.id
    ) {
      throw new AuthError(
        403,
        "session_required",
        "Open this link in the account that requested the identity change.",
      );
    }
  } else {
    verifiedLoginContextHash = await loginContextHash(request);
    if (
      !pending.login_context_hash ||
      !verifiedLoginContextHash ||
      !timingSafeEqual(pending.login_context_hash, verifiedLoginContextHash)
    ) {
      throw new AuthError(
        403,
        "browser_context_required",
        "Open this link in the browser that requested it, or request a new link on this device.",
      );
    }
  }
  const row = await getAuthDatabase()
    .prepare(
      `DELETE FROM auth_magic_links
       WHERE token_hash = ?1 AND expires_at > ?2
         AND (purpose = 'link' OR login_context_hash = ?3)
       RETURNING account_id, initiating_session_id, login_context_hash, purpose, subject_encrypted, return_to`,
    )
    .bind(tokenHash, new Date().toISOString(), verifiedLoginContextHash)
    .first<MagicLinkRow>();
  if (!row || (row.purpose !== "login" && row.purpose !== "link")) {
    throw new AuthError(400, "expired_link", "This sign-in link expired or was already used.");
  }
  const email = await decryptIdentity(config.identityEncryptionKey, row.subject_encrypted);
  const account = await resolveIdentity({
    provider: "email",
    subject: email,
    displayHint: maskEmail(email),
    targetAccountId: row.purpose === "link" ? row.account_id : null,
  });
  return {
    session:
      row.purpose === "link"
        ? await rotateSessionsForAccount(account.id, {
            confirmedProvider: "email",
            inheritFrom: linkingPrincipal ?? undefined,
          })
        : await createSession(account.id, { confirmedProvider: "email" }),
    returnTo: safeReturnTo(row.return_to),
  };
}
