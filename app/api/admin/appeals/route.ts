import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireModerator,
} from "@/lib/auth";
import { readAuthJson } from "@/lib/auth-request";
import { requireConfirmedAdminMutation } from "@/lib/admin-mutation-auth";
import { listAppealsPage, moderateAppeal, permanentlyRemoveAppeal } from "@/lib/community-intake";
import { deleteQuarantineFiles, IntakeError } from "@/lib/intake-security";
import { appealModerationSchema } from "@/lib/validation";
import { pageFromRequest } from "@/lib/pagination";

function failure(error: unknown) {
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof IntakeError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStoreHeaders() },
    );
  }
  console.error("Unable to process the appeal moderation request.", error);
  return Response.json(
    { error: "We couldn't update this appeal." },
    { status: 500, headers: noStoreHeaders() },
  );
}

export async function GET(request: Request) {
  try {
    await requireModerator(request, { fresh: true });
    const result = await listAppealsPage(pageFromRequest(request), 25);
    return Response.json(
      { appeals: result.items, pagination: result.pagination },
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
    const parsed = appealModerationSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "This appeal update is invalid.", issues: parsed.error.flatten() },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const appeal = await moderateAppeal(
      parsed.data.id,
      parsed.data.status,
      parsed.data.moderatorNotes,
      parsed.data.publicResolution,
      principal.account.handle,
      principal.account.id,
    );
    return appeal
      ? Response.json({ appeal }, { headers: noStoreHeaders() })
      : Response.json({ error: "Appeal not found." }, { status: 404, headers: noStoreHeaders() });
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
        { error: "An appeal ID is required." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const appeal = await permanentlyRemoveAppeal(
      id,
      principal.account.handle,
      principal.account.id,
      (attachments) => deleteQuarantineFiles(attachments, principal.account.handle, id),
    );
    if (!appeal) {
      return Response.json(
        { error: "Appeal not found." },
        { status: 404, headers: noStoreHeaders() },
      );
    }
    return Response.json({ ok: true }, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}
