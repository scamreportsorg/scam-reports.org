import { appendSessionCookies, noStoreHeaders } from "@/lib/auth";
import { AuthError } from "@/lib/auth-errors";
import { clearDiscordTransactionCookie, completeDiscordAuthorization } from "@/lib/auth-discord";

export async function GET(request: Request) {
  try {
    const completed = await completeDiscordAuthorization(request);
    const headers = noStoreHeaders({ Location: completed.returnTo });
    headers.append("Set-Cookie", completed.clearCookie);
    appendSessionCookies(headers, completed.session.setCookies);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    const code = error instanceof AuthError ? error.code : "auth_unavailable";
    const allowed = new Set([
      "access_denied",
      "discord_unavailable",
      "identity_conflict",
      "invalid_callback",
    ]);
    const headers = noStoreHeaders({
      Location: `/auth/error?code=${encodeURIComponent(allowed.has(code) ? code : "auth_unavailable")}`,
    });
    try {
      headers.append("Set-Cookie", clearDiscordTransactionCookie());
    } catch (error) {
      void error;
    }
    return new Response(null, { status: 303, headers });
  }
}
