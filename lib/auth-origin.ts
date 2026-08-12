import { getCoreAuthConfig } from "./auth-config";
import { AuthError } from "./auth-errors";

export function isSameOrigin(request: Request): boolean {
  const configuredOrigin = getCoreAuthConfig().appOrigin;
  const suppliedOrigin = request.headers.get("origin");
  if (!suppliedOrigin) return false;
  try {
    return (
      new URL(suppliedOrigin).origin === configuredOrigin &&
      new URL(request.url).origin === configuredOrigin
    );
  } catch {
    return false;
  }
}

export function assertSameOrigin(request: Request): void {
  if (!isSameOrigin(request)) {
    throw new AuthError(
      403,
      "invalid_origin",
      "This request couldn't be verified. Reload the page and try again.",
    );
  }
}
