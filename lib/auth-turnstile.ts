import { authRuntime, readAuthEnv } from "./auth-config";
import { AuthError } from "./auth-errors";
import { readJsonWithinLimit, sendOutboundRequest } from "./outbound-http";

type TurnstileVerification = {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  "error-codes"?: unknown;
};

export type TurnstileResult = {
  hostname: string;
  action: string;
};

function turnstileUnavailable(): never {
  throw new AuthError(
    503,
    "turnstile_unavailable",
    "The anti-abuse check is unavailable right now.",
  );
}

export async function verifyTurnstile(
  requestToken: string | null | undefined,
  expectedAction: string,
  request: Request,
): Promise<TurnstileResult> {
  if (
    !requestToken ||
    requestToken.length > 2048 ||
    !/^[a-zA-Z0-9._-]{1,64}$/u.test(expectedAction)
  ) {
    throw new AuthError(403, "turnstile_required", "Complete the anti-abuse check.");
  }

  const runtime = authRuntime();
  const explicitBypass = readAuthEnv("TURNSTILE_TEST_BYPASS_TOKEN");
  const applicationEnvironment = readAuthEnv("APP_ENVIRONMENT");
  if (
    runtime === "test" &&
    applicationEnvironment === "test" &&
    explicitBypass &&
    requestToken === explicitBypass
  ) {
    return { hostname: "test.invalid", action: expectedAction };
  }

  const secret = readAuthEnv("TURNSTILE_SECRET_KEY");
  if (!secret || secret.length < 20) {
    turnstileUnavailable();
  }
  const appOrigin = readAuthEnv("AUTH_APP_ORIGIN");
  if (!appOrigin) {
    turnstileUnavailable();
  }
  let expectedHostname: string;
  try {
    expectedHostname = new URL(appOrigin).hostname;
  } catch {
    turnstileUnavailable();
  }
  const form = new FormData();
  form.set("secret", secret);
  form.set("response", requestToken);
  const address = request.headers.get("cf-connecting-ip")?.trim();
  if (address) form.set("remoteip", address);

  let response: Response;
  try {
    response = await sendOutboundRequest(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form },
      {
        origin: "https://challenges.cloudflare.com",
        pathname: "/turnstile/v0/siteverify",
        timeoutMs: 10_000,
      },
    );
  } catch {
    turnstileUnavailable();
  }
  if (!response.ok) {
    turnstileUnavailable();
  }
  const result = await readJsonWithinLimit<TurnstileVerification>(response, 32 * 1024);
  if (!result) turnstileUnavailable();
  if (
    result.success !== true ||
    result.action !== expectedAction ||
    result.hostname !== expectedHostname
  ) {
    throw new AuthError(
      403,
      "turnstile_failed",
      "The anti-abuse check failed. Reload the page and try again.",
    );
  }
  return { hostname: result.hostname, action: result.action };
}
