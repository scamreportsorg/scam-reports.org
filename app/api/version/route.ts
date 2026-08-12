import { getPublicVersion } from "@/lib/version";

export const dynamic = "force-dynamic";

export async function GET() {
  const version = getPublicVersion();
  return Response.json(
    {
      version: version.version,
      commit: version.commit,
      buildTime: version.buildTime,
      schemaVersion: version.schemaVersion,
    },
    {
      headers: {
        "cache-control": "public, max-age=60, stale-while-revalidate=300",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
