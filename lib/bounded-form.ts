export class BoundedFormError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BoundedFormError";
    this.status = status;
    this.code = code;
  }
}

function declaredLength(request: Request, maximumBytes: number) {
  const raw = request.headers.get("content-length");
  if (raw === null) return;
  if (!/^\d+$/u.test(raw.trim())) {
    throw new BoundedFormError(400, "invalid_form", "The form body is invalid.");
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw new BoundedFormError(400, "invalid_form", "The form body is invalid.");
  }
  if (length > maximumBytes) {
    throw new BoundedFormError(413, "request_too_large", "The request body is too large.");
  }
}

export async function readBoundedUrlEncodedForm(request: Request, maximumBytes = 8 * 1024) {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new BoundedFormError(415, "invalid_content_type", "A URL-encoded form body is required.");
  }
  declaredLength(request, maximumBytes);
  if (!request.body) {
    throw new BoundedFormError(400, "invalid_form", "A form body is required.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("form body limit exceeded").catch(() => undefined);
        throw new BoundedFormError(413, "request_too_large", "The request body is too large.");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BoundedFormError) throw error;
    throw new BoundedFormError(400, "invalid_form", "The form body is invalid.");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BoundedFormError(400, "invalid_form", "The form body is invalid.");
  }
}
