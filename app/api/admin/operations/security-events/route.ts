import { authErrorResponse, AuthError, noStoreHeaders, requireAdmin } from "@/lib/auth";
import { listOperationalSecurityEvents } from "@/lib/admin-operations";

function failure(error: unknown) {
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("Security event operations queue failed", error);
  return Response.json(
    { error: "Couldn't load security events." },
    { status: 500, headers: noStoreHeaders() },
  );
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request, { fresh: true });
    const page = Number(new URL(request.url).searchParams.get("page"));
    const result = await listOperationalSecurityEvents({ page });
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}
