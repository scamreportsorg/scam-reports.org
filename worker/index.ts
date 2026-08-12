import {
  DEFAULT_DEVICE_SIZES,
  DEFAULT_IMAGE_SIZES,
  handleImageOptimization,
} from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { sha256, timingSafeEqual } from "../lib/auth-crypto";
import { BoundedFormError, readBoundedUrlEncodedForm } from "../lib/bounded-form";
import { runMinuteDiscordIntegrations } from "../lib/discord-integrations";
import {
  IMAGE_OPTIMIZATION_QUALITIES,
  ImageTransformCapacityError,
  imageOptimizationCacheKey,
  imageOptimizationCoordinator,
  imageOptimizationPolicy,
} from "../lib/image-optimization";
import { purgeDeletedEvidenceBackups, runFrequentMaintenance } from "../lib/maintenance";
import { D1BackupWorkflow, type BackupParams } from "./backup-workflow";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  EVIDENCE_ORIGINALS: R2Bucket;
  EVIDENCE_DERIVATIVES: R2Bucket;
  BACKUPS: R2Bucket;
  BACKUP_WORKFLOW: Workflow<BackupParams>;
  ENVIRONMENT?: string;
  STAGING_ACCESS_TOKEN?: string;
  SECURITY_MONITOR_ENABLED?: string;
  INTAKE_PEPPER?: string;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

const STAGING_COOKIE = "__Host-sr_staging";
const STAGING_PLACEHOLDER_SEGMENT =
  /(?:^|[-_.\s])(?:placeholder|replace[-_]?with|change[-_]?me|not[-_]?set|test|testing|fixture|synthetic|example|sample|dummy|redacted|unset)(?:$|[-_.\s])/iu;
const CONTENT_SECURITY_POLICY =
  [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    "frame-src https://challenges.cloudflare.com",
    "connect-src 'self' https://challenges.cloudflare.com",
  ].join("; ") + ";";

function isConfiguredStagingAccessToken(value: string | undefined): value is string {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (candidate.length < 32) return false;
  if (/^<[^<>\r\n]+>$/u.test(candidate) || /^\$\{[\s\S]+\}$/u.test(candidate)) return false;
  if (/^\*+$/u.test(candidate) || STAGING_PLACEHOLDER_SEGMENT.test(candidate)) return false;
  return true;
}

function cookieValue(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function stagingSignInDocument(message: string) {
  const notice = message ? `<p role="alert">${message}</p>` : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Private staging</title>
  </head>
  <body>
    <main>
      <h1>Private staging</h1>
      <p>This pre-release environment is restricted to maintainers.</p>
      ${notice}
      <form method="post" action="/__staging/access">
        <label>
          Staging access token
          <input name="token" type="password" autocomplete="current-password" required>
        </label>
        <button type="submit">Continue</button>
      </form>
    </main>
  </body>
</html>`;
}

function stagingSignInPage(message = "") {
  return new Response(stagingSignInDocument(message), {
    status: 401,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function stagingAccess(request: Request, env: Env) {
  if (env.ENVIRONMENT !== "staging" || new URL(request.url).pathname !== "/__staging/access") {
    return null;
  }
  const accessToken = env.STAGING_ACCESS_TOKEN;
  if (!isConfiguredStagingAccessToken(accessToken)) {
    return new Response("Private staging is not configured.", { status: 503 });
  }
  if (request.method === "GET") return stagingSignInPage();
  if (request.method !== "POST" || request.headers.get("origin") !== new URL(request.url).origin) {
    return new Response("Invalid staging access request.", { status: 403 });
  }
  let form: URLSearchParams;
  try {
    form = await readBoundedUrlEncodedForm(request, 4 * 1024);
  } catch (error) {
    if (error instanceof BoundedFormError) {
      return new Response(error.message, { status: error.status });
    }
    return new Response("Invalid staging access request.", { status: 400 });
  }
  const supplied = form?.get("token");
  if (typeof supplied !== "string" || !timingSafeEqual(supplied, accessToken)) {
    return stagingSignInPage("The access token was not accepted.");
  }
  const digest = await sha256(accessToken);
  const stagingCookie = [
    `${STAGING_COOKIE}=${encodeURIComponent(digest)}`,
    "Path=/",
    "Max-Age=28800",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");

  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Cache-Control": "no-store",
      "Set-Cookie": stagingCookie,
    },
  });
}

async function stagingGate(request: Request, env: Env) {
  if (env.ENVIRONMENT !== "staging") return null;
  const accessToken = env.STAGING_ACCESS_TOKEN;
  if (!isConfiguredStagingAccessToken(accessToken)) {
    return new Response("Private staging is not configured.", { status: 503 });
  }
  const authorization = request.headers.get("authorization");
  const supplied = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : null;
  const validBearer = Boolean(supplied && timingSafeEqual(supplied, accessToken));
  const expectedCookie = await sha256(accessToken);
  const stagedCookie = cookieValue(request, STAGING_COOKIE);
  const validCookie = Boolean(stagedCookie && timingSafeEqual(stagedCookie, expectedCookie));
  if (!validBearer && !validCookie) return stagingSignInPage();
  return null;
}

function secureHeaders(response: Response, request: Request, environment?: string) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set(
    "Referrer-Policy",
    new URL(request.url).pathname.startsWith("/api/evidence/")
      ? "no-referrer"
      : "strict-origin-when-cross-origin",
  );
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  if (environment === "production" && new URL(request.url).protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);
    if (
      env.ENVIRONMENT === "production" &&
      (requestUrl.protocol !== "https:" || requestUrl.hostname !== "scam-reports.org")
    ) {
      const canonicalUrl = new URL("https://scam-reports.org/");
      canonicalUrl.pathname = requestUrl.pathname;
      canonicalUrl.search = requestUrl.search;
      return secureHeaders(
        Response.redirect(canonicalUrl.toString(), 308),
        request,
        env.ENVIRONMENT,
      );
    }
    const access = await stagingAccess(request, env);
    if (access) return secureHeaders(access, request, env.ENVIRONMENT);
    const denied = await stagingGate(request, env);
    if (denied) return secureHeaders(denied, request, env.ENVIRONMENT);
    const url = requestUrl;

    if (
      url.pathname === "/_next/image" ||
      url.pathname === "/_next/image/" ||
      url.pathname === "/_vinext/image/"
    ) {
      return secureHeaders(
        new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } }),
        request,
        env.ENVIRONMENT,
      );
    }

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const policy = imageOptimizationPolicy(request, allowedWidths);
      if (!policy.accepted) {
        const headers = new Headers({ "Cache-Control": "no-store" });
        if (policy.status === 405) headers.set("Allow", "GET, HEAD");
        return secureHeaders(
          new Response(policy.message, { status: policy.status, headers }),
          request,
          env.ENVIRONMENT,
        );
      }

      const optimizationHeaders = new Headers(request.headers);
      optimizationHeaders.set("Accept", policy.format);
      const optimizationRequest = new Request(policy.canonicalUrl, {
        method: "GET",
        headers: optimizationHeaders,
      });
      let response: Response;
      try {
        let imageCache: Cache;
        try {
          imageCache = await caches.open("sr-image-optimization-v1");
        } catch {
          throw new ImageTransformCapacityError();
        }
        response = await imageOptimizationCoordinator.run(
          imageCache,
          imageOptimizationCacheKey(policy),
          () =>
            handleImageOptimization(
              optimizationRequest,
              {
                fetchAsset: (path) =>
                  env.ASSETS.fetch(new Request(new URL(path, policy.canonicalUrl))),
                transformImage: async (body, { width, format, quality }) => {
                  const result = await env.IMAGES.input(body)
                    .transform(width > 0 ? { width } : {})
                    .output({ format, quality });
                  return result.response();
                },
              },
              allowedWidths,
              { qualities: [...IMAGE_OPTIMIZATION_QUALITIES] },
            ),
        );
      } catch (error) {
        if (!(error instanceof ImageTransformCapacityError)) throw error;
        response = new Response("Image service busy", {
          status: 503,
          headers: { "Cache-Control": "no-store", "Retry-After": "2" },
        });
      }
      if (policy.headOnly) {
        response = new Response(null, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
      return secureHeaders(response, request, env.ENVIRONMENT);
    }

    const response = await handler.fetch(request, env, ctx);
    return secureHeaders(response, request, env.ENVIRONMENT);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "* * * * *") {
      ctx.waitUntil(runMinuteDiscordIntegrations());
      return;
    }
    if (controller.cron === "*/5 * * * *") {
      ctx.waitUntil(runFrequentMaintenance());
      return;
    }
    if (controller.cron !== "17 3 * * SUN") return;

    const requestedAt = new Date(controller.scheduledTime);
    const date = requestedAt.toISOString().slice(0, 10);
    ctx.waitUntil(
      env.BACKUP_WORKFLOW.create({
        id: `weekly-${date}`,
        params: { kind: "weekly", requestedAt: requestedAt.toISOString() },
      }),
    );
    if (requestedAt.getUTCDate() <= 7) {
      ctx.waitUntil(
        env.BACKUP_WORKFLOW.create({
          id: `monthly-${requestedAt.toISOString().slice(0, 7)}`,
          params: { kind: "monthly", requestedAt: requestedAt.toISOString() },
        }),
      );
    }
    ctx.waitUntil(purgeDeletedEvidenceBackups(250));
  },
};

export { D1BackupWorkflow };
export default worker;
