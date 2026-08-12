export class BoundedJsonError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BoundedJsonError";
    this.status = status;
    this.code = code;
  }
}

export function requestMediaType(request: Request) {
  return (request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

export async function readBoundedJson(
  request: Request,
  maximumBytes = 16 * 1024,
): Promise<Record<string, unknown>> {
  if (requestMediaType(request) !== "application/json") {
    throw new BoundedJsonError(415, "unsupported_media_type", "A JSON request body is required.");
  }
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new BoundedJsonError(413, "request_too_large", "The request body is too large.");
  }
  if (!request.body) {
    throw new BoundedJsonError(400, "invalid_json", "A JSON request body is required.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel("JSON body limit exceeded").catch(() => undefined);
      throw new BoundedJsonError(413, "request_too_large", "The request body is too large.");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BoundedJsonError(400, "invalid_json", "The JSON request body is invalid.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoundedJsonError(400, "invalid_json", "The JSON request body is invalid.");
  }
  return value as Record<string, unknown>;
}
