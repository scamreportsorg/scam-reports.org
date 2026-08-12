import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireMember,
  updateAccountHandle,
} from "@/lib/auth";
import { readAuthForm, readAuthJson } from "@/lib/auth-request";
import { requestMediaType } from "@/lib/bounded-json";

const MAXIMUM_ACCOUNT_BODY_BYTES = 4 * 1024;

async function update(request: Request) {
  try {
    await requireMember(request);
    const contentType = requestMediaType(request);
    let handle = "";
    let csrfToken: string | null = request.headers.get("x-csrf-token");
    let isForm = false;
    if (contentType === "application/json") {
      const body = await readAuthJson(request, MAXIMUM_ACCOUNT_BODY_BYTES);
      handle = typeof body.handle === "string" ? body.handle : "";
      csrfToken = typeof body.csrfToken === "string" ? body.csrfToken : csrfToken;
    } else if (contentType === "application/x-www-form-urlencoded") {
      const form = await readAuthForm(request, MAXIMUM_ACCOUNT_BODY_BYTES);
      handle = typeof form.get("handle") === "string" ? String(form.get("handle")) : "";
      csrfToken = typeof form.get("csrfToken") === "string" ? String(form.get("csrfToken")) : null;
      isForm = true;
    } else {
      throw new AuthError(
        415,
        "invalid_content_type",
        "Use JSON or the account form to update the account.",
      );
    }
    const principal = await assertCsrf(request, csrfToken);
    const account = await updateAccountHandle(principal.account.id, handle);
    if (isForm) {
      return new Response(null, {
        status: 303,
        headers: noStoreHeaders({ Location: "/account?updated=handle" }),
      });
    }
    return Response.json({ account }, { headers: noStoreHeaders() });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export const POST = update;
export const PATCH = update;
