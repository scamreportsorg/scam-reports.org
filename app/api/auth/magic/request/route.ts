import {
  assertCsrf,
  assertSameOrigin,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireMember,
  safeAuthErrorCode,
  verifyTurnstile,
} from "@/lib/auth";
import { normalizeEmail, safeReturnTo } from "@/lib/auth-accounts";
import { issueMagicLink, prepareMagicLoginContext } from "@/lib/auth-email";
import {
  abuseErrorResponse,
  consumeRateLimit,
  emailRateSubject,
  networkRateSubject,
} from "@/lib/abuse-protection";
import { readAuthForm, readAuthJson } from "@/lib/auth-request";
import { requestMediaType } from "@/lib/bounded-json";

const MAXIMUM_AUTH_BODY_BYTES = 8 * 1024;

type Submission = {
  email: string;
  purpose: "login" | "link";
  returnTo: string;
  csrfToken: string | null;
  turnstileToken: string | null;
  isForm: boolean;
};

async function submission(request: Request): Promise<Submission> {
  const contentType = requestMediaType(request);
  if (contentType === "application/json") {
    const body = await readAuthJson(request, MAXIMUM_AUTH_BODY_BYTES);
    return {
      email: typeof body.email === "string" ? body.email : "",
      purpose: body.purpose === "link" ? "link" : "login",
      returnTo: safeReturnTo(typeof body.returnTo === "string" ? body.returnTo : null),
      csrfToken: typeof body.csrfToken === "string" ? body.csrfToken : null,
      turnstileToken: typeof body.turnstileToken === "string" ? body.turnstileToken : null,
      isForm: false,
    };
  }
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new AuthError(415, "invalid_content_type", "Use the sign-in form to request a link.");
  }
  const form = await readAuthForm(request, MAXIMUM_AUTH_BODY_BYTES);
  return {
    email: typeof form.get("email") === "string" ? String(form.get("email")) : "",
    purpose: form.get("purpose") === "link" ? "link" : "login",
    returnTo: safeReturnTo(
      typeof form.get("returnTo") === "string" ? String(form.get("returnTo")) : null,
    ),
    csrfToken: typeof form.get("csrfToken") === "string" ? String(form.get("csrfToken")) : null,
    turnstileToken:
      typeof form.get("cf-turnstile-response") === "string"
        ? String(form.get("cf-turnstile-response"))
        : null,
    isForm: true,
  };
}

export async function POST(request: Request) {
  const contentType = requestMediaType(request);
  const browserForm = contentType === "application/x-www-form-urlencoded";
  try {
    assertSameOrigin(request);
    const input = await submission(request);
    const email = normalizeEmail(input.email);
    await verifyTurnstile(input.turnstileToken, "magic_link", request);
    let accountId: string | null = null;
    let sessionId: string | null = null;
    let loginContext: Awaited<ReturnType<typeof prepareMagicLoginContext>> | null = null;
    if (input.purpose === "link") {
      const principal = await requireMember(request);
      await assertCsrf(request, input.csrfToken);
      accountId = principal.account.id;
      sessionId = principal.session.id;
    } else {
      loginContext = await prepareMagicLoginContext(request);
    }
    await consumeRateLimit({
      scope: "magic_email",
      subjectHash: await emailRateSubject(email),
      limit: 5,
      windowSeconds: 60 * 60,
    });
    await consumeRateLimit({
      scope: "magic_network",
      subjectHash: await networkRateSubject(request),
      limit: 10,
      windowSeconds: 60 * 60,
    });
    await issueMagicLink({
      email,
      purpose: input.purpose,
      accountId,
      sessionId,
      loginContextHash: loginContext?.hash ?? null,
      returnTo: input.returnTo,
    });
    if (input.isForm) {
      const headers = noStoreHeaders({ Location: "/auth/check-email" });
      if (loginContext) headers.append("Set-Cookie", loginContext.setCookie);
      return new Response(null, {
        status: 303,
        headers,
      });
    }
    const headers = noStoreHeaders();
    if (loginContext) headers.append("Set-Cookie", loginContext.setCookie);
    return Response.json(
      { ok: true, message: "If the address can receive mail, the sign-in link is on its way." },
      { status: 202, headers },
    );
  } catch (error) {
    if (browserForm && !(error instanceof AuthError && error.status === 413)) {
      const code = safeAuthErrorCode(error instanceof AuthError ? error.code : null);
      return new Response(null, {
        status: 303,
        headers: noStoreHeaders({ Location: `/auth/error?code=${encodeURIComponent(code)}` }),
      });
    }
    return abuseErrorResponse(error) ?? authErrorResponse(error);
  }
}
