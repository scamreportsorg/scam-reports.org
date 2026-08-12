import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { safeReturnTo } from "./auth-accounts";
import {
  csrfFromCookieHeader,
  getOptionalSessionFromCookieHeader,
  type AuthPrincipal,
} from "./auth-session";

export type ServerAuthContext = {
  principal: AuthPrincipal;
  csrfToken: string;
};

export async function getOptionalServerAuth(): Promise<ServerAuthContext | null> {
  const requestHeaders = await headers();
  const cookieHeader = requestHeaders.get("cookie");
  const principal = await getOptionalSessionFromCookieHeader(cookieHeader);
  const csrfToken = csrfFromCookieHeader(cookieHeader);
  if (!principal || !csrfToken) return null;
  return { principal, csrfToken };
}

export async function requireServerMember(returnTo = "/account"): Promise<ServerAuthContext> {
  const context = await getOptionalServerAuth();
  if (context) return context;
  redirect(`/auth/sign-in?returnTo=${encodeURIComponent(safeReturnTo(returnTo))}`);
}

export function isFreshServerAuth(context: ServerAuthContext, maxAgeSeconds = 600) {
  return Date.parse(context.principal.session.authenticatedAt) >= Date.now() - maxAgeSeconds * 1000;
}
