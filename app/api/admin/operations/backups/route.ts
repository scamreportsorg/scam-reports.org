import { authErrorResponse, AuthError, noStoreHeaders, requireAdmin } from "@/lib/auth";
import { listOperationalBackupRuns } from "@/lib/admin-operations";

function failure(error: unknown) {
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("Backup operations queue failed", error);
  return Response.json(
    { error: "Couldn't load backup runs." },
    { status: 500, headers: noStoreHeaders() },
  );
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request, { fresh: true });
    const page = Number(new URL(request.url).searchParams.get("page"));
    const result = await listOperationalBackupRuns({ page });
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}
