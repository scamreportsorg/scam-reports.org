export class AuthError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStoreHeaders() },
    );
  }
  return Response.json(
    { error: "Sign-in is unavailable right now. Try again soon.", code: "auth_unavailable" },
    { status: 503, headers: noStoreHeaders() },
  );
}

export function safeAuthErrorCode(value: string | null): string {
  const allowed = new Set([
    "access_denied",
    "browser_context_required",
    "discord_unavailable",
    "email_unavailable",
    "expired_link",
    "identity_conflict",
    "invalid_callback",
    "invalid_link",
    "session_required",
    "turnstile_failed",
    "turnstile_required",
  ]);
  return value && allowed.has(value) ? value : "auth_unavailable";
}
