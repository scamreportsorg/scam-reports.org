import { noStoreHeaders } from "./auth-errors";

export function privateEvidenceHeaders(base?: HeadersInit) {
  const headers = noStoreHeaders(base);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Security-Policy", "sandbox");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return headers;
}
