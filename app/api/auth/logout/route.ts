import {
  appendSessionCookies,
  assertCsrf,
  authErrorResponse,
  AuthError,
  destroySession,
  noStoreHeaders,
  requireMember,
} from "@/lib/auth";
import { readAuthForm } from "@/lib/auth-request";
import { requestMediaType } from "@/lib/bounded-json";

export async function POST(request: Request) {
  try {
    await requireMember(request);
    const contentType = requestMediaType(request);
    let csrfToken = request.headers.get("x-csrf-token");
    if (contentType === "application/x-www-form-urlencoded") {
      const form = await readAuthForm(request, 4 * 1024);
      csrfToken = typeof form.get("csrfToken") === "string" ? String(form.get("csrfToken")) : null;
    } else if (contentType !== "application/json") {
      throw new AuthError(415, "invalid_content_type", "Use JSON or the sign-out form.");
    }
    await assertCsrf(request, csrfToken);
    const cookies = await destroySession(request);
    const wantsJson = contentType === "application/json";
    const headers = noStoreHeaders(wantsJson ? undefined : { Location: "/" });
    appendSessionCookies(headers, cookies);
    return wantsJson
      ? Response.json({ ok: true }, { headers })
      : new Response(null, { status: 303, headers });
  } catch (error) {
    return authErrorResponse(error);
  }
}
