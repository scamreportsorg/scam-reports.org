import { appendSessionCookies, noStoreHeaders } from "@/lib/auth";
import { consumeMagicLink } from "@/lib/auth-email";
import { AuthError } from "@/lib/auth-errors";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  try {
    const completed = await consumeMagicLink(token, request);
    const headers = noStoreHeaders({ Location: completed.returnTo });
    appendSessionCookies(headers, completed.session.setCookies);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    const code = error instanceof AuthError ? error.code : "auth_unavailable";
    const safeCode =
      code === "expired_link" ||
      code === "invalid_link" ||
      code === "identity_conflict" ||
      code === "browser_context_required"
        ? code
        : "auth_unavailable";
    return new Response(null, {
      status: 303,
      headers: noStoreHeaders({
        Location: `/auth/error?code=${encodeURIComponent(safeCode)}`,
      }),
    });
  }
}
