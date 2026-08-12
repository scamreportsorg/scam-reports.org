import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireModerator,
} from "@/lib/auth";
import { readAuthJson } from "@/lib/auth-request";
import { requireConfirmedAdminMutation } from "@/lib/admin-mutation-auth";
import { listReviewsPage, moderateReview, removeReview } from "@/lib/reviews";
import { reviewModerationSchema } from "@/lib/validation";
import { pageFromRequest } from "@/lib/pagination";

function failure(error: unknown) {
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("Unable to process the review moderation request.", error);
  return Response.json(
    { error: "We couldn't update this review." },
    { status: 500, headers: noStoreHeaders() },
  );
}

export async function GET(request: Request) {
  try {
    await requireModerator(request, { fresh: true });
    const result = await listReviewsPage(pageFromRequest(request), 25);
    return Response.json(
      { reviews: result.items, pagination: result.pagination },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const principal = await requireModerator(request, { fresh: true });
    const body = await readAuthJson(request, 32 * 1024);
    await assertCsrf(request, typeof body.csrfToken === "string" ? body.csrfToken : null);
    const parsed = reviewModerationSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "This review update is invalid.", issues: parsed.error.flatten() },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const review = await moderateReview(
      parsed.data.id,
      parsed.data.status,
      parsed.data.moderatorNotes,
      principal.account.handle,
      principal.account.id,
    );
    return review
      ? Response.json({ review }, { headers: noStoreHeaders() })
      : Response.json(
          { error: "Pending review revision not found." },
          { status: 404, headers: noStoreHeaders() },
        );
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const principal = await requireConfirmedAdminMutation(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      return Response.json(
        { error: "A review ID is required." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const removed = await removeReview(id, principal.account.handle, principal.account.id);
    return removed
      ? Response.json({ ok: true }, { headers: noStoreHeaders() })
      : Response.json({ error: "Review not found." }, { status: 404, headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}
