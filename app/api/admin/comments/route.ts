import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireModerator,
} from "@/lib/auth";
import { readAuthJson } from "@/lib/auth-request";
import { requireConfirmedAdminMutation } from "@/lib/admin-mutation-auth";
import { listCommentsPage, moderateComment, removeComment } from "@/lib/community-intake";
import { commentModerationSchema } from "@/lib/validation";
import { pageFromRequest } from "@/lib/pagination";

function failure(error: unknown) {
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("Unable to process the comment moderation request.", error);
  return Response.json(
    { error: "We couldn't update this reply." },
    { status: 500, headers: noStoreHeaders() },
  );
}

export async function GET(request: Request) {
  try {
    await requireModerator(request, { fresh: true });
    const result = await listCommentsPage(pageFromRequest(request), 25);
    return Response.json(
      { comments: result.items, pagination: result.pagination },
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
    const parsed = commentModerationSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "This reply update is invalid.", issues: parsed.error.flatten() },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const comment = await moderateComment(
      parsed.data.id,
      parsed.data.status,
      parsed.data.moderatorNotes,
      principal.account.handle,
      principal.account.id,
    );
    return comment
      ? Response.json({ comment }, { headers: noStoreHeaders() })
      : Response.json({ error: "Reply not found." }, { status: 404, headers: noStoreHeaders() });
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
        { error: "A reply ID is required." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const removed = await removeComment(id, principal.account.handle, principal.account.id);
    return removed
      ? Response.json({ ok: true }, { headers: noStoreHeaders() })
      : Response.json({ error: "Reply not found." }, { status: 404, headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}
