export type OutboundFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type OutboundRequestProblem = "invalid_destination" | "network" | "timeout";

export class OutboundRequestError extends Error {
  readonly problem: OutboundRequestProblem;
  readonly detail: string;
  readonly reason: unknown;

  constructor(problem: OutboundRequestProblem, detail: string, reason?: unknown) {
    super(problem);
    this.name = "OutboundRequestError";
    this.problem = problem;
    this.detail = detail;
    this.reason = reason;
  }
}

type OutboundTarget = {
  origin: string;
  pathname?: string;
  pathPrefix?: string;
};

type OutboundRequestOptions = OutboundTarget & {
  fetchImpl?: OutboundFetch;
  timeoutMs: number;
};

export function fetchFailureCode(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("network connection lost")) return "network_connection_lost";
  if (message.includes("subrequest")) return "subrequest_rejected";
  if (message.includes("abort")) return "aborted";
  if (message.includes("redirect")) return "redirect_rejected";
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,39}$/u.test(error.name)
    ? error.name.toLowerCase()
    : "unknown";
}

function checkedUrl(input: string | URL, target: OutboundTarget) {
  let url: URL;
  try {
    url = new URL(input, target.origin);
  } catch (error) {
    throw new OutboundRequestError("invalid_destination", "invalid_url", error);
  }
  const exactPath = target.pathname === undefined || url.pathname === target.pathname;
  const allowedPrefix =
    target.pathPrefix === undefined || url.pathname.startsWith(target.pathPrefix);
  if (
    url.origin !== target.origin ||
    !exactPath ||
    !allowedPrefix ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new OutboundRequestError("invalid_destination", "destination_rejected");
  }
  return url;
}

export async function sendOutboundRequest(
  input: string | URL,
  init: Omit<RequestInit, "redirect" | "signal">,
  options: OutboundRequestOptions,
) {
  const url = checkedUrl(input, options);
  const controller = new AbortController();
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(Math.floor(options.timeoutMs), 120_000))
    : 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await (options.fetchImpl ?? fetch)(url.toString(), {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    throw new OutboundRequestError(
      controller.signal.aborted ? "timeout" : "network",
      fetchFailureCode(error),
      error,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readTextWithinLimit(response: Response, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) return null;
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readJsonWithinLimit<T = unknown>(
  response: Response,
  maximumBytes: number,
): Promise<T | null> {
  const text = await readTextWithinLimit(response, maximumBytes).catch(() => null);
  if (text === null || !text.trim()) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
