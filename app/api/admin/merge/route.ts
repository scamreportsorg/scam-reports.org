import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireModerator,
} from "@/lib/auth";
import { readAuthJson } from "@/lib/auth-request";
import {
  mergeReports,
  preflightReportMerge,
  ReportMergeError,
  unmergeReport,
} from "@/lib/report-merge";

function mergeError(error: unknown) {
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof ReportMergeError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStoreHeaders() },
    );
  }
  console.error("Report merge operation failed", error);
  return Response.json(
    { error: "Couldn't complete the merge." },
    { status: 500, headers: noStoreHeaders() },
  );
}

function idsFromUrl(request: Request) {
  const url = new URL(request.url);
  return {
    duplicateId: url.searchParams.get("duplicateId") ?? "",
    canonicalId: url.searchParams.get("canonicalId") ?? "",
  };
}

export async function GET(request: Request) {
  try {
    await requireModerator(request, { fresh: true });
    const { duplicateId, canonicalId } = idsFromUrl(request);
    return Response.json(
      { preflight: await preflightReportMerge(duplicateId, canonicalId) },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    return mergeError(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireModerator(request, { fresh: true });
    await assertCsrf(request);
    const body = await readAuthJson(request, 8 * 1024);
    if (!body || typeof body.duplicateId !== "string" || typeof body.canonicalId !== "string") {
      return Response.json(
        { error: "Duplicate and canonical report IDs are required." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const result = await mergeReports(body.duplicateId, body.canonicalId, {
      accountId: principal.account.id,
      handle: principal.account.handle,
    });
    return Response.json({ ok: true, ...result }, { headers: noStoreHeaders() });
  } catch (error) {
    return mergeError(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const principal = await requireModerator(request, { fresh: true });
    await assertCsrf(request);
    const duplicateId = new URL(request.url).searchParams.get("duplicateId") ?? "";
    const result = await unmergeReport(duplicateId, {
      accountId: principal.account.id,
      handle: principal.account.handle,
    });
    return Response.json({ ok: true, ...result }, { headers: noStoreHeaders() });
  } catch (error) {
    return mergeError(error);
  }
}
