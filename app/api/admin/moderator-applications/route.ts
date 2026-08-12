import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireModerator,
} from "@/lib/auth";
import { requireRecentDualProviderConfirmation } from "@/lib/admin-accounts";
import { BoundedJsonError, readBoundedJson } from "@/lib/bounded-json";
import { moderatorApplicationModerationSchema } from "@/lib/moderator-application-validation";
import {
  MODERATOR_APPLICATION_STATUSES,
  type ModeratorApplicationStatus,
} from "@/lib/moderator-application-contract";
import {
  listModeratorApplicationsPage,
  moderateModeratorApplication,
} from "@/lib/moderator-applications";
import { positiveInteger } from "@/lib/pagination";

function failure(error: unknown) {
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof BoundedJsonError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStoreHeaders() },
    );
  }
  console.error("Unable to process the moderator application queue.", error);
  return Response.json(
    { error: "We couldn't update this moderator application." },
    { status: 500, headers: noStoreHeaders() },
  );
}

export async function GET(request: Request) {
  try {
    await requireModerator(request, { fresh: true });
    const url = new URL(request.url);
    const requestedStatus = url.searchParams.get("status") ?? "";
    if (
      requestedStatus &&
      !MODERATOR_APPLICATION_STATUSES.includes(requestedStatus as ModeratorApplicationStatus)
    ) {
      throw new AuthError(400, "invalid_application_status", "Invalid application status filter.");
    }
    const result = await listModeratorApplicationsPage({
      page: positiveInteger(url.searchParams.get("page"), 1),
      pageSize: 25,
      status: requestedStatus as ModeratorApplicationStatus | "",
    });
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const principal = await requireModerator(request, { fresh: true });
    const body = await readBoundedJson(request, 8 * 1024);
    await assertCsrf(request, typeof body.csrfToken === "string" ? body.csrfToken : null);
    const parsed = moderatorApplicationModerationSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "This application update is invalid.", issues: parsed.error.flatten() },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    if (parsed.data.status === "Accepted") {
      if (principal.account.role !== "admin") {
        throw new AuthError(
          403,
          "admin_required",
          "Only an administrator can accept an application and grant the moderator role.",
        );
      }
      await requireRecentDualProviderConfirmation(principal);
    }
    const application = await moderateModeratorApplication({
      id: parsed.data.id,
      status: parsed.data.status,
      moderatorNotes: parsed.data.moderatorNotes,
      reviewerAccountId: principal.account.id,
    });
    return Response.json({ application }, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}
