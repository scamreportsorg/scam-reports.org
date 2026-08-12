import { env } from "cloudflare:workers";
import { getD1 } from "./reports";

type AbuseEnv = {
  INTAKE_PEPPER?: string;
};

export type RateLimitScope =
  | "report"
  | "report_upload"
  | "appeal"
  | "review"
  | "comment"
  | "moderator_application"
  | "magic_email"
  | "magic_network"
  | "discord_start_network";

export class AbuseProtectionError extends Error {
  status: number;
  retryAfter?: number;

  constructor(message: string, status: number, retryAfter?: number) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

function readPepper() {
  let value: string | undefined;
  try {
    value = (env as unknown as AbuseEnv).INTAKE_PEPPER;
  } catch {
    value = process.env.INTAKE_PEPPER;
  }
  if (!value || value.length < 32 || value.startsWith("replace-with")) {
    throw new AbuseProtectionError("Submissions are paused right now.", 503);
  }
  return value;
}

async function hmac(value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(readPepper()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function trustedClientAddress(request: Request) {
  return request.headers.get("cf-connecting-ip")?.trim() || "local-unavailable";
}

export async function accountRateSubject(accountId: string) {
  return hmac(`account:${accountId}`);
}

export async function networkRateSubject(request: Request) {
  return hmac(`network:${trustedClientAddress(request)}`);
}

export async function emailRateSubject(email: string) {
  return hmac(`email:${email.trim().toLowerCase()}`);
}

export async function consumeRateLimit({
  scope,
  subjectHash,
  limit,
  windowSeconds,
}: {
  scope: RateLimitScope;
  subjectHash: string;
  limit: number;
  windowSeconds: number;
}) {
  const database = getD1();
  const now = new Date();
  const occurredAt = now.toISOString();
  const since = new Date(now.getTime() - windowSeconds * 1000).toISOString();
  const expiresAt = new Date(now.getTime() + windowSeconds * 1000).toISOString();
  const id = crypto.randomUUID();
  const result = await database
    .prepare(
      `INSERT INTO rate_events
      (id, scope, subject_hash, occurred_at, expires_at)
    SELECT ?, ?, ?, ?, ?
    WHERE (SELECT COUNT(*) FROM rate_events
      WHERE scope = ? AND subject_hash = ? AND occurred_at >= ?) < ?
    RETURNING id`,
    )
    .bind(id, scope, subjectHash, occurredAt, expiresAt, scope, subjectHash, since, limit)
    .first<{ id: string }>();
  if (result?.id) return;

  const oldest = await database
    .prepare(
      `SELECT occurred_at FROM rate_events
    WHERE scope = ? AND subject_hash = ? AND occurred_at >= ?
    ORDER BY occurred_at ASC LIMIT 1`,
    )
    .bind(scope, subjectHash, since)
    .first<{ occurred_at: string }>();
  const elapsed = oldest ? now.getTime() - new Date(oldest.occurred_at).getTime() : 0;
  const retryAfter = Math.max(1, Math.ceil((windowSeconds * 1000 - elapsed) / 1000));
  throw new AbuseProtectionError(
    "You've hit the submission limit. Try again later.",
    429,
    retryAfter,
  );
}

export function abuseErrorResponse(error: unknown) {
  if (!(error instanceof AbuseProtectionError)) return null;
  const headers = new Headers({
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  if (error.retryAfter) headers.set("Retry-After", String(error.retryAfter));
  return Response.json({ error: error.message }, { status: error.status, headers });
}

export async function deleteExpiredRateEvents(database = getD1()) {
  const result = await database
    .prepare("DELETE FROM rate_events WHERE expires_at < ?")
    .bind(new Date().toISOString())
    .run();
  return result.meta.changes ?? 0;
}
