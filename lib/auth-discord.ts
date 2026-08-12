import { resolveIdentity, safeReturnTo } from "./auth-accounts";
import { getDiscordAuthConfig } from "./auth-config";
import { decryptIdentity, encryptIdentity, randomToken, sha256 } from "./auth-crypto";
import { getAuthDatabase } from "./auth-db";
import { AuthError } from "./auth-errors";
import { readJsonWithinLimit, sendOutboundRequest } from "./outbound-http";
import {
  createSession,
  requireMember,
  rotateSessionsForAccount,
  type CreatedSession,
} from "./auth-session";

const TRANSACTION_SECONDS = 10 * 60;
const DISCORD_ORIGIN = "https://discord.com";
const SECURE_TRANSACTION_COOKIE = "__Host-sr_oauth_tx";
const LOCAL_TRANSACTION_COOKIE = "sr_oauth_tx";

type TransactionRow = {
  mode: string;
  account_id: string | null;
  initiating_session_id: string | null;
  return_to: string;
  code_verifier_encrypted: string;
};

type DiscordUser = {
  id?: unknown;
  username?: unknown;
  global_name?: unknown;
};

async function discordRequest(pathname: string, init: Omit<RequestInit, "redirect" | "signal">) {
  try {
    return await sendOutboundRequest(`${DISCORD_ORIGIN}${pathname}`, init, {
      origin: DISCORD_ORIGIN,
      pathname,
      timeoutMs: 10_000,
    });
  } catch {
    throw new AuthError(502, "discord_unavailable", "Discord sign-in failed. Try again.");
  }
}

function transactionCookieName(secure: boolean) {
  return secure ? SECURE_TRANSACTION_COOKIE : LOCAL_TRANSACTION_COOKIE;
}

function transactionCookie(value: string, secure: boolean, maxAge = TRANSACTION_SECONDS) {
  return [
    `${transactionCookieName(secure)}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
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

export async function beginDiscordAuthorization(input: {
  mode: "login" | "link";
  accountId?: string | null;
  sessionId?: string | null;
  returnTo?: string | null;
}) {
  if (input.mode === "link" && (!input.accountId || !input.sessionId)) {
    throw new AuthError(401, "session_required", "Sign in before linking Discord.");
  }
  const config = getDiscordAuthConfig();
  const secure = new URL(config.appOrigin).protocol === "https:";
  const state = randomToken(32);
  const browserSecret = randomToken(32);
  const codeVerifier = randomToken(48);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TRANSACTION_SECONDS * 1000);
  await getAuthDatabase()
    .prepare(
      `INSERT INTO auth_oauth_transactions
        (state_hash, provider, mode, account_id, initiating_session_id,
         browser_hash, return_to, code_verifier_encrypted, created_at, expires_at)
       VALUES (?1, 'discord', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      await sha256(state),
      input.mode,
      input.accountId ?? null,
      input.sessionId ?? null,
      await sha256(browserSecret),
      safeReturnTo(input.returnTo),
      await encryptIdentity(config.identityEncryptionKey, codeVerifier),
      now.toISOString(),
      expiresAt.toISOString(),
    )
    .run();

  const authorization = new URL("https://discord.com/oauth2/authorize");
  authorization.searchParams.set("client_id", config.clientId);
  authorization.searchParams.set("response_type", "code");
  authorization.searchParams.set("redirect_uri", config.redirectUri);
  authorization.searchParams.set("scope", "identify");
  authorization.searchParams.set("state", state);
  authorization.searchParams.set("code_challenge", await sha256(codeVerifier));
  authorization.searchParams.set("code_challenge_method", "S256");
  return {
    authorizationUrl: authorization.toString(),
    setCookie: transactionCookie(browserSecret, secure),
  };
}

export async function completeDiscordAuthorization(
  request: Request,
): Promise<{ session: CreatedSession; returnTo: string; clearCookie: string }> {
  const config = getDiscordAuthConfig();
  const secure = new URL(config.appOrigin).protocol === "https:";
  const url = new URL(request.url);
  if (url.searchParams.get("error")) {
    throw new AuthError(401, "access_denied", "Discord authorization was cancelled.");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const browserSecret = readCookie(request, transactionCookieName(secure));
  if (!code || !state || !browserSecret || code.length > 4096 || state.length > 256) {
    throw new AuthError(400, "invalid_callback", "The Discord callback is invalid.");
  }
  const transaction = await getAuthDatabase()
    .prepare(
      `DELETE FROM auth_oauth_transactions
       WHERE state_hash = ?1
         AND browser_hash = ?2
         AND provider = 'discord'
         AND expires_at > ?3
       RETURNING mode, account_id, initiating_session_id, return_to,
         code_verifier_encrypted`,
    )
    .bind(await sha256(state), await sha256(browserSecret), new Date().toISOString())
    .first<TransactionRow>();
  if (!transaction || (transaction.mode !== "login" && transaction.mode !== "link")) {
    throw new AuthError(
      400,
      "invalid_callback",
      "The Discord sign-in expired or was already used.",
    );
  }
  let linkingPrincipal: Awaited<ReturnType<typeof requireMember>> | null = null;
  if (transaction.mode === "link") {
    linkingPrincipal = await requireMember(request);
    if (
      !transaction.account_id ||
      !transaction.initiating_session_id ||
      linkingPrincipal.account.id !== transaction.account_id ||
      linkingPrincipal.session.id !== transaction.initiating_session_id
    ) {
      throw new AuthError(
        403,
        "session_required",
        "Return to the account that started this Discord link request.",
      );
    }
  }
  const verifier = await decryptIdentity(
    config.identityEncryptionKey,
    transaction.code_verifier_encrypted,
  );
  const exchangeResponse = await discordRequest("/api/v10/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: verifier,
    }),
  });
  if (!exchangeResponse.ok) {
    throw new AuthError(502, "discord_unavailable", "Discord sign-in could not be completed.");
  }
  const exchange = await readJsonWithinLimit<{ access_token?: unknown }>(
    exchangeResponse,
    32 * 1024,
  );
  if (!exchange || typeof exchange.access_token !== "string" || !exchange.access_token) {
    throw new AuthError(
      502,
      "discord_unavailable",
      "Discord returned an invalid sign-in response.",
    );
  }
  const profileResponse = await discordRequest("/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${exchange.access_token}` },
  });
  if (!profileResponse.ok) {
    throw new AuthError(502, "discord_unavailable", "Discord profile verification failed.");
  }
  const profile = await readJsonWithinLimit<DiscordUser>(profileResponse, 64 * 1024);
  if (
    !profile ||
    typeof profile.id !== "string" ||
    !/^\d{15,22}$/u.test(profile.id) ||
    typeof profile.username !== "string" ||
    profile.username.length < 1 ||
    profile.username.length > 80
  ) {
    throw new AuthError(502, "discord_unavailable", "Discord returned an invalid profile.");
  }
  const account = await resolveIdentity({
    provider: "discord",
    subject: profile.id,
    displayHint: `@${profile.username}`,
    targetAccountId: transaction.mode === "link" ? transaction.account_id : null,
  });
  return {
    session:
      transaction.mode === "link"
        ? await rotateSessionsForAccount(account.id, {
            confirmedProvider: "discord",
            inheritFrom: linkingPrincipal ?? undefined,
          })
        : await createSession(account.id, { confirmedProvider: "discord" }),
    returnTo: safeReturnTo(transaction.return_to),
    clearCookie: transactionCookie("", secure, 0),
  };
}

export function clearDiscordTransactionCookie() {
  const secure = new URL(getDiscordAuthConfig().appOrigin).protocol === "https:";
  return transactionCookie("", secure, 0);
}
