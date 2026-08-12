import { assertCsrf, authErrorResponse, noStoreHeaders, requireMember } from "@/lib/auth";
import { safeReturnTo } from "@/lib/auth-accounts";
import { beginDiscordAuthorization } from "@/lib/auth-discord";
import { readAuthForm } from "@/lib/auth-request";
import { abuseErrorResponse, consumeRateLimit, networkRateSubject } from "@/lib/abuse-protection";

async function limitDiscordStarts(request: Request) {
  await consumeRateLimit({
    scope: "discord_start_network",
    subjectHash: await networkRateSubject(request),
    limit: 20,
    windowSeconds: 10 * 60,
  });
}

export async function GET(request: Request) {
  try {
    await limitDiscordStarts(request);
    const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
    const transaction = await beginDiscordAuthorization({ mode: "login", returnTo });
    const headers = noStoreHeaders({ Location: transaction.authorizationUrl });
    headers.append("Set-Cookie", transaction.setCookie);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return abuseErrorResponse(error) ?? authErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireMember(request);
    const form = await readAuthForm(request, 4 * 1024);
    const csrfToken =
      typeof form.get("csrfToken") === "string" ? String(form.get("csrfToken")) : null;
    await assertCsrf(request, csrfToken);
    await limitDiscordStarts(request);
    const transaction = await beginDiscordAuthorization({
      mode: "link",
      accountId: principal.account.id,
      sessionId: principal.session.id,
      returnTo: safeReturnTo(
        typeof form.get("returnTo") === "string" ? String(form.get("returnTo")) : null,
      ),
    });
    const headers = noStoreHeaders();
    headers.append("Set-Cookie", transaction.setCookie);

    if (request.headers.get("accept")?.includes("application/json")) {
      return Response.json({ authorizationUrl: transaction.authorizationUrl }, { headers });
    }

    headers.set("Location", transaction.authorizationUrl);
    return new Response(null, { status: 303, headers });
  } catch (error) {
    return abuseErrorResponse(error) ?? authErrorResponse(error);
  }
}
