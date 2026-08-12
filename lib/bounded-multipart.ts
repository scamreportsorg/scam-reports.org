export class MultipartRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "invalid_multipart") {
    super(message);
    this.name = "MultipartRequestError";
    this.status = status;
    this.code = code;
  }
}

export const INTAKE_MULTIPART_LIMITS = {
  maxBodyBytes: 20 * 1024 * 1024 + 256 * 1024,
  maxTextBytes: 64 * 1024,
  maxParts: 24,
} as const;

export const MODERATOR_UPLOAD_MULTIPART_LIMITS = {
  maxBodyBytes: 5 * 1024 * 1024 + 128 * 1024,
  maxTextBytes: 16 * 1024,
  maxParts: 3,
} as const;

type MultipartFieldRule = {
  kind: "text" | "file";
  maxValues?: number;
};

export type MultipartPolicy = {
  fields: Readonly<Record<string, MultipartFieldRule>>;
  maxBodyBytes: number;
  maxTextBytes: number;
  maxParts: number;
};

function validateDeclaredLength(request: Request, maxBodyBytes: number) {
  const raw = request.headers.get("content-length");
  if (raw === null) return;
  if (!/^\d+$/u.test(raw.trim())) {
    throw new MultipartRequestError("Invalid request length.");
  }
  const declared = Number(raw);
  if (!Number.isSafeInteger(declared)) {
    throw new MultipartRequestError("Invalid request length.");
  }
  if (declared > maxBodyBytes) {
    throw new MultipartRequestError(
      "The multipart request is too large.",
      413,
      "multipart_too_large",
    );
  }
}

async function readBoundedBody(request: Request, maxBodyBytes: number) {
  validateDeclaredLength(request, maxBodyBytes);
  if (!request.body) {
    throw new MultipartRequestError("Invalid form submission.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel("multipart body limit exceeded").catch(() => undefined);
        throw new MultipartRequestError(
          "The multipart request is too large.",
          413,
          "multipart_too_large",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof MultipartRequestError) throw error;
    throw new MultipartRequestError("Invalid form submission.");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateParts(formData: FormData, policy: MultipartPolicy) {
  const occurrences = new Map<string, number>();
  const encoder = new TextEncoder();
  let parts = 0;
  let textBytes = 0;

  formData.forEach((value, name) => {
    parts += 1;
    if (parts > policy.maxParts) {
      throw new MultipartRequestError("The form has too many fields.");
    }
    const rule = policy.fields[name];
    if (!rule) {
      throw new MultipartRequestError(`Unexpected multipart field: ${name}.`);
    }
    const count = (occurrences.get(name) ?? 0) + 1;
    occurrences.set(name, count);
    if (count > (rule.maxValues ?? 1)) {
      throw new MultipartRequestError(`Too many values for ${name}.`);
    }
    if (rule.kind === "file") {
      if (value === "") return;
      if (!(value instanceof File)) {
        throw new MultipartRequestError(`The ${name} field must contain a file.`);
      }
      return;
    }
    if (typeof value !== "string") {
      throw new MultipartRequestError(`The ${name} field must contain text.`);
    }
    textBytes += encoder.encode(value).byteLength;
    if (textBytes > policy.maxTextBytes) {
      throw new MultipartRequestError(
        "The form text is too large.",
        413,
        "multipart_text_too_large",
      );
    }
  });
}

export async function parseBoundedMultipartFormData(request: Request, policy: MultipartPolicy) {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.length > 256 ||
    !/^multipart\/form-data(?:\s*;|$)/iu.test(contentType) ||
    !/(?:^|;)\s*boundary=(?:"[^"]{1,70}"|[^;\s]{1,70})(?:\s*;|$)/iu.test(contentType)
  ) {
    throw new MultipartRequestError(
      "A valid multipart form is required.",
      415,
      "invalid_content_type",
    );
  }

  const bytes = await readBoundedBody(request, policy.maxBodyBytes);
  let formData: FormData;
  try {
    formData = await new Request("https://multipart.invalid/", {
      method: "POST",
      headers: { "content-type": contentType },
      body: bytes,
    }).formData();
  } catch {
    throw new MultipartRequestError("Invalid form submission.");
  }
  validateParts(formData, policy);
  return formData;
}

export async function parseBoundedMultipartFormDataAfterPreflight<T>(
  request: Request,
  policy: MultipartPolicy,
  preflight: () => Promise<T>,
) {
  const preflightResult = await preflight();
  const formData = await parseBoundedMultipartFormData(request, policy);
  return { formData, preflightResult };
}
