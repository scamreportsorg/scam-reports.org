import { assertCsrf, authErrorResponse, AuthError, noStoreHeaders, requireAdmin } from "@/lib/auth";
import { retryOperationalNotification } from "@/lib/admin-operations";

function failure(error: unknown) {
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("Notification retry failed", error);
  return Response.json(
    { error: "Couldn't retry the notification." },
    { status: 500, headers: noStoreHeaders() },
  );
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const principal = await requireAdmin(request, { fresh: true });
    await assertCsrf(request);
    const { id } = await params;
    const result = await retryOperationalNotification({
      notificationId: id,
      actorAccountId: principal.account.id,
    });
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}
