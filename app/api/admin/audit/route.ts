import { authErrorResponse, AuthError, noStoreHeaders, requireModerator } from "@/lib/auth";
import { positiveInteger } from "@/lib/pagination";
import { listAuditLogsPage } from "@/lib/reports";

export async function GET(request: Request) {
  try {
    await requireModerator(request, { fresh: true });
    const url = new URL(request.url);
    const result = await listAuditLogsPage({
      page: positiveInteger(url.searchParams.get("page"), 1),
      pageSize: positiveInteger(url.searchParams.get("pageSize"), 25),
      q: url.searchParams.get("q") ?? "",
      reportId: url.searchParams.get("report") ?? "",
      action: url.searchParams.get("action") ?? "",
    });
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    console.error("Unable to load the audit queue.", error);
    return Response.json(
      { error: "Couldn't load the audit queue." },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}
