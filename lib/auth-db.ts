import { env } from "cloudflare:workers";

export function getAuthDatabase(): D1Database {
  const database = (env as unknown as { DB?: D1Database }).DB;
  if (!database) {
    throw new Error("Cloudflare D1 binding DB is unavailable for authentication.");
  }
  return database;
}
