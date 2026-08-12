export const IMAGE_OPTIMIZATION_QUALITIES = [75] as const;

export type ImageOptimizationPolicy =
  | {
      accepted: true;
      canonicalUrl: URL;
      format: "image/avif" | "image/webp" | "image/jpeg";
      headOnly: boolean;
    }
  | {
      accepted: false;
      status: 400 | 405;
      message: string;
    };

const IMAGE_QUERY_NAMES = new Set(["url", "w", "q"]);
const IMAGE_QUALITY_SET = new Set<number>(IMAGE_OPTIMIZATION_QUALITIES);

function preferredImageFormat(accept: string | null) {
  const value = accept?.toLowerCase() ?? "";
  if (value.includes("image/avif")) return "image/avif" as const;
  if (value.includes("image/webp")) return "image/webp" as const;
  return "image/jpeg" as const;
}

export function imageOptimizationPolicy(
  request: Request,
  allowedWidths: readonly number[],
): ImageOptimizationPolicy {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return { accepted: false, status: 405, message: "Method not allowed" };
  }

  const url = new URL(request.url);
  for (const name of url.searchParams.keys()) {
    if (!IMAGE_QUERY_NAMES.has(name) || url.searchParams.getAll(name).length !== 1) {
      return { accepted: false, status: 400, message: "Invalid image request" };
    }
  }
  if ([...IMAGE_QUERY_NAMES].some((name) => url.searchParams.getAll(name).length !== 1)) {
    return { accepted: false, status: 400, message: "Invalid image request" };
  }

  const sourceValue = url.searchParams.get("url") ?? "";
  const widthValue = url.searchParams.get("w") ?? "";
  const qualityValue = url.searchParams.get("q") ?? "";
  if (
    !sourceValue.startsWith("/") ||
    sourceValue.startsWith("//") ||
    sourceValue.includes("\\") ||
    sourceValue.length > 1_024 ||
    !/^[0-9]+$/u.test(widthValue) ||
    !/^[0-9]+$/u.test(qualityValue)
  ) {
    return { accepted: false, status: 400, message: "Invalid image request" };
  }

  const width = Number(widthValue);
  const quality = Number(qualityValue);
  if (
    String(width) !== widthValue ||
    String(quality) !== qualityValue ||
    !allowedWidths.includes(width) ||
    !IMAGE_QUALITY_SET.has(quality)
  ) {
    return { accepted: false, status: 400, message: "Invalid image request" };
  }

  let source: URL;
  try {
    source = new URL(sourceValue, url.origin);
  } catch {
    return { accepted: false, status: 400, message: "Invalid image request" };
  }
  if (
    source.origin !== url.origin ||
    source.search ||
    source.hash ||
    source.pathname !== sourceValue ||
    !/^\/(?:[A-Za-z0-9._~-]+\/)*[A-Za-z0-9._~-]+$/u.test(source.pathname)
  ) {
    return { accepted: false, status: 400, message: "Invalid image request" };
  }

  const canonicalUrl = new URL(url.pathname, url.origin);
  canonicalUrl.searchParams.set("url", source.pathname);
  canonicalUrl.searchParams.set("w", widthValue);
  canonicalUrl.searchParams.set("q", qualityValue);
  return {
    accepted: true,
    canonicalUrl,
    format: preferredImageFormat(request.headers.get("accept")),
    headOnly: request.method === "HEAD",
  };
}

export function imageOptimizationCacheKey(
  policy: Extract<ImageOptimizationPolicy, { accepted: true }>,
) {
  const cacheKey = new URL("/__sr-cache/image/v1", policy.canonicalUrl.origin);
  cacheKey.search = policy.canonicalUrl.search;
  cacheKey.searchParams.set("format", policy.format);
  return new Request(cacheKey, { method: "GET" });
}

export class ImageTransformCapacityError extends Error {
  constructor() {
    super("image_transform_capacity_exceeded");
    this.name = "ImageTransformCapacityError";
  }
}

export class ImageOptimizationCoordinator {
  readonly #maximumConcurrentTransforms: number;
  readonly #cacheFailureCooldownMs: number;
  readonly #inFlight = new Map<string, Promise<Response>>();
  #activeTransforms = 0;
  #cacheUnavailableUntil = 0;

  constructor(maximumConcurrentTransforms = 4, cacheFailureCooldownMs = 60_000) {
    this.#maximumConcurrentTransforms = Math.max(1, Math.floor(maximumConcurrentTransforms));
    this.#cacheFailureCooldownMs = Math.max(1, Math.floor(cacheFailureCooldownMs));
  }

  async run(
    cache: Pick<Cache, "match" | "put">,
    cacheKey: Request,
    optimize: () => Promise<Response>,
  ) {
    if (Date.now() < this.#cacheUnavailableUntil) {
      throw new ImageTransformCapacityError();
    }
    try {
      const cached = await cache.match(cacheKey);
      if (cached) return cached;
    } catch {
      this.#cacheUnavailableUntil = Date.now() + this.#cacheFailureCooldownMs;
      throw new ImageTransformCapacityError();
    }

    const key = cacheKey.url;
    let task = this.#inFlight.get(key);
    let created = false;
    if (!task) {
      if (this.#activeTransforms >= this.#maximumConcurrentTransforms) {
        throw new ImageTransformCapacityError();
      }
      created = true;
      this.#activeTransforms += 1;
      task = (async () => {
        const response = await optimize();
        if (response.ok) {
          try {
            await cache.put(cacheKey, response.clone());
          } catch {
            this.#cacheUnavailableUntil = Date.now() + this.#cacheFailureCooldownMs;
            throw new ImageTransformCapacityError();
          }
        }
        return response;
      })();
      this.#inFlight.set(key, task);
    }

    try {
      return (await task).clone();
    } finally {
      if (created && this.#inFlight.get(key) === task) {
        this.#inFlight.delete(key);
        this.#activeTransforms -= 1;
      }
    }
  }
}

export const imageOptimizationCoordinator = new ImageOptimizationCoordinator();
