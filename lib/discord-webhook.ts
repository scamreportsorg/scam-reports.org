import {
  OutboundRequestError,
  type OutboundFetch,
  readJsonWithinLimit,
  sendOutboundRequest,
} from "./outbound-http";

export type DiscordWebhookPurpose = "moderation" | "status";

export type DiscordWebhookEnvironment = {
  DISCORD_STATUS_WEBHOOK_URL?: string;
  MODERATOR_DISCORD_WEBHOOK_URL?: string;
};

export type DiscordWebhookPayload = Readonly<Record<string, unknown>>;

export type DiscordWebhookRequestOptions = {
  fetchImpl?: OutboundFetch;
  random?: () => number;
  timeoutMs?: number;
};

export type DiscordWebhookErrorCode =
  | "not_configured"
  | "invalid_destination"
  | "rate_limited"
  | "provider_unavailable"
  | "request_rejected"
  | "not_found"
  | "network_error"
  | "timeout"
  | "invalid_response";

const WEBHOOK_PATTERN =
  /^https:\/\/discord\.com\/api\/webhooks\/([0-9]{15,22})\/([A-Za-z0-9._-]{30,200})$/u;
const MESSAGE_ID_PATTERN = /^[0-9]{15,22}$/u;
const DEFAULT_TIMEOUT_MS = 10_000;
const ERROR_RESPONSE_BYTES = 16 * 1_024;
const MESSAGE_RESPONSE_BYTES = 256 * 1_024;
const DISCORD_ORIGIN = "https://discord.com";
const DISCORD_WEBHOOK_PREFIX = "/api/webhooks/";
export const DISCORD_RATE_LIMIT_JITTER_MS = 250;

export class DiscordWebhookError extends Error {
  readonly code: DiscordWebhookErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;
  readonly status: number | null;

  constructor(
    code: DiscordWebhookErrorCode,
    message: string,
    options: { retryable?: boolean; retryAfterMs?: number | null; status?: number | null } = {},
  ) {
    super(message);
    this.name = "DiscordWebhookError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.status = options.status ?? null;
  }
}

export function isDiscordWebhookUrl(value: string): boolean {
  return WEBHOOK_PATTERN.test(value);
}

export function requireDiscordWebhookUrl(value: string | undefined): string {
  if (!value || !isDiscordWebhookUrl(value)) {
    throw new DiscordWebhookError(
      value ? "invalid_destination" : "not_configured",
      value ? "The Discord webhook destination is invalid." : "Discord delivery is not configured.",
    );
  }
  return value;
}

export function discordWebhookDestination(
  values: DiscordWebhookEnvironment,
  purpose: DiscordWebhookPurpose,
): string {
  if (purpose === "status") {
    return requireDiscordWebhookUrl(values.DISCORD_STATUS_WEBHOOK_URL);
  }

  return requireDiscordWebhookUrl(values.MODERATOR_DISCORD_WEBHOOK_URL);
}

function timeoutMs(value: number | undefined): number {
  if (!Number.isFinite(value) || Number(value) <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.floor(Number(value)), 30_000);
}

function safeRandom(random: () => number): number {
  const value = random();
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 0.999_999)) : 0;
}

async function retryAfterMilliseconds(response: Response, random: () => number): Promise<number> {
  let seconds: number | null = null;
  const body = await readJsonWithinLimit<{ retry_after?: unknown }>(response, ERROR_RESPONSE_BYTES);
  const raw = body?.retry_after;
  const parsed =
    typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) seconds = parsed;

  if (seconds === null) {
    const header = response.headers.get("retry-after");
    const parsed = header === null || !header.trim() ? NaN : Number(header);
    if (Number.isFinite(parsed) && parsed >= 0) seconds = parsed;
  }

  const base = Math.min(24 * 60 * 60_000, Math.round((seconds ?? 1) * 1000));
  const jitter = Math.floor(safeRandom(random) * DISCORD_RATE_LIMIT_JITTER_MS);
  return base + jitter;
}

async function responseError(
  response: Response,
  operation: "execute" | "edit",
  random: () => number,
): Promise<DiscordWebhookError> {
  if (response.status === 429) {
    return new DiscordWebhookError("rate_limited", "Discord rate-limited the delivery.", {
      retryable: true,
      retryAfterMs: await retryAfterMilliseconds(response, random),
      status: response.status,
    });
  }
  if (response.status >= 500 && response.status <= 599) {
    return new DiscordWebhookError("provider_unavailable", "Discord is temporarily unavailable.", {
      retryable: true,
      status: response.status,
    });
  }
  if (response.status === 404 && operation === "edit") {
    return new DiscordWebhookError("not_found", "The Discord status message no longer exists.", {
      status: response.status,
    });
  }
  return new DiscordWebhookError("request_rejected", "Discord rejected the webhook delivery.", {
    status: response.status,
  });
}

async function requestDiscord(
  destination: string,
  operation: "execute" | "edit",
  messageId: string | null,
  payload: DiscordWebhookPayload,
  options: DiscordWebhookRequestOptions,
): Promise<Response> {
  const webhook = requireDiscordWebhookUrl(destination);
  if (messageId !== null && !MESSAGE_ID_PATTERN.test(messageId)) {
    throw new DiscordWebhookError("invalid_destination", "The Discord message ID is invalid.");
  }

  const endpoint =
    operation === "execute"
      ? `${webhook}?wait=true`
      : `${webhook}/messages/${encodeURIComponent(messageId as string)}`;
  let response: Response;
  try {
    response = await sendOutboundRequest(
      endpoint,
      {
        method: operation === "execute" ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, allowed_mentions: { parse: [] } }),
      },
      {
        origin: DISCORD_ORIGIN,
        pathPrefix: DISCORD_WEBHOOK_PREFIX,
        fetchImpl: options.fetchImpl,
        timeoutMs: timeoutMs(options.timeoutMs),
      },
    );
  } catch (error) {
    if (error instanceof OutboundRequestError && error.reason instanceof DiscordWebhookError) {
      throw error.reason;
    }
    if (error instanceof OutboundRequestError && error.problem === "invalid_destination") {
      throw new DiscordWebhookError("invalid_destination", "The Discord destination is invalid.");
    }
    if (error instanceof OutboundRequestError && error.problem === "timeout") {
      throw new DiscordWebhookError("timeout", "Discord delivery timed out.", {
        retryable: true,
      });
    }
    throw new DiscordWebhookError("network_error", "Discord delivery could not connect.", {
      retryable: true,
    });
  }

  if (!response.ok) {
    throw await responseError(response, operation, options.random ?? Math.random);
  }
  return response;
}

async function discordMessageId(response: Response): Promise<string> {
  const body = await readJsonWithinLimit<{ id?: unknown }>(response, MESSAGE_RESPONSE_BYTES);
  if (typeof body?.id === "string" && MESSAGE_ID_PATTERN.test(body.id)) return body.id;
  throw new DiscordWebhookError(
    "invalid_response",
    "Discord returned an invalid webhook response.",
  );
}

export async function executeDiscordWebhook(
  destination: string,
  payload: DiscordWebhookPayload,
  options: DiscordWebhookRequestOptions = {},
): Promise<string> {
  return discordMessageId(await requestDiscord(destination, "execute", null, payload, options));
}

export async function editDiscordWebhookMessage(
  destination: string,
  messageId: string,
  payload: DiscordWebhookPayload,
  options: DiscordWebhookRequestOptions = {},
): Promise<string> {
  return discordMessageId(await requestDiscord(destination, "edit", messageId, payload, options));
}
