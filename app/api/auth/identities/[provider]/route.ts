import {
  appendSessionCookies,
  assertCsrf,
  authErrorResponse,
  noStoreHeaders,
  requireMember,
  rotateSessionsForAccount,
  unlinkIdentity,
} from "@/lib/auth";
import { readAuthForm } from "@/lib/auth-request";

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await context.params;
    if (provider !== "discord" && provider !== "email") {
      return Response.json(
        { error: "Unknown identity provider." },
        { status: 404, headers: noStoreHeaders() },
      );
    }
    await requireMember(request);
    const form = await readAuthForm(request, 4 * 1024);
    const csrfToken =
      typeof form.get("csrfToken") === "string" ? String(form.get("csrfToken")) : null;
    const principal = await assertCsrf(request, csrfToken);
    await unlinkIdentity(principal.account, provider);
    const session = await rotateSessionsForAccount(principal.account.id, {
      inheritFrom: principal,
      removedProvider: provider,
    });
    const headers = noStoreHeaders({ Location: "/account?updated=identity" });
    appendSessionCookies(headers, session.setCookies);
    return new Response(null, {
      status: 303,
      headers,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export const DELETE = POST;
