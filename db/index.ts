import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  const database = (env as unknown as { DB?: D1Database }).DB;
  if (!database) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Configure it in wrangler.jsonc and apply all migrations before starting the Worker.",
    );
  }

  return drizzle(database, { schema });
}
