import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireMember,
} from "@/lib/auth";
import { readAuthForm } from "@/lib/auth-request";
import { requestMediaType } from "@/lib/bounded-json";
import { requestDiscordRankSync } from "@/lib/discord-rank-sync";

export async function POST(request: Request) {
  try {
    await requireMember(request);
    const contentType = requestMediaType(request);
    let csrfToken = request.headers.get("x-csrf-token");
    const wantsJson = contentType === "application/json";

    if (contentType === "application/x-www-form-urlencoded") {
      const form = await readAuthForm(request, 4 * 1024);
      csrfToken = typeof form.get("csrfToken") === "string" ? String(form.get("csrfToken")) : null;
    } else if (!wantsJson) {
      throw new AuthError(415, "invalid_content_type", "Use JSON or the Discord sync form.");
    }

    const principal = await assertCsrf(request, csrfToken);
    const queued = await requestDiscordRankSync(principal.account.id);
    if (!queued) {
      throw new AuthError(409, "discord_not_linked", "Link Discord before syncing your role.");
    }

    return wantsJson
      ? Response.json({ queued: true }, { headers: noStoreHeaders() })
      : new Response(null, {
          status: 303,
          headers: noStoreHeaders({ Location: "/account?updated=discord-rank" }),
        });
  } catch (error) {
    return authErrorResponse(error);
  }
}
