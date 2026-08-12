import { authErrorResponse, AuthError, noStoreHeaders, requireAdmin } from "@/lib/auth";
import { readAuthJson } from "@/lib/auth-request";
import { deleteAdminAccount, listAdminAccounts, updateAdminAccount } from "@/lib/admin-accounts";
import { requireConfirmedAdminMutation } from "@/lib/admin-mutation-auth";
import type { AccountStatus, AuthRole } from "@/lib/auth-accounts";
import { positiveInteger } from "@/lib/pagination";

function failure(error: unknown) {
  if (error instanceof AuthError) return authErrorResponse(error);
  console.error("Account administration failed", error);
  return Response.json(
    { error: "We couldn't complete the account change." },
    { status: 500, headers: noStoreHeaders() },
  );
}

export async function GET(request: Request) {
  try {
    await requireAdmin(request, { fresh: true });
    const url = new URL(request.url);
    const result = await listAdminAccounts({
      q: url.searchParams.get("q") ?? "",
      page: positiveInteger(url.searchParams.get("page"), 1),
      pageSize: positiveInteger(url.searchParams.get("pageSize"), 25),
    });
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const principal = await requireConfirmedAdminMutation(request);
    const body = await readAuthJson(request, 8 * 1024);
    const role = body?.role;
    const status = body?.status;
    if (
      typeof body?.id !== "string" ||
      (role !== "member" && role !== "moderator" && role !== "admin") ||
      (status !== "active" && status !== "suspended")
    ) {
      throw new AuthError(
        400,
        "invalid_account_change",
        "Account ID, role, and status are required.",
      );
    }
    const account = await updateAdminAccount({
      targetId: body.id,
      actor: principal,
      role: role as AuthRole,
      status: status as AccountStatus,
    });
    return Response.json({ account }, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const principal = await requireConfirmedAdminMutation(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) throw new AuthError(400, "invalid_account", "An account ID is required.");
    await deleteAdminAccount({ targetId: id, actor: principal });
    return Response.json({ ok: true }, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}
