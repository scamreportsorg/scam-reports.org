import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireModerator,
} from "@/lib/auth";
import { readAuthJson } from "@/lib/auth-request";
import { EvidenceError } from "@/lib/evidence";
import { requireConfirmedAdminMutation } from "@/lib/admin-mutation-auth";
import {
  createReport,
  listAdminReports,
  removeReport,
  updateReport,
  type AuditActor,
} from "@/lib/reports";
import { positiveInteger } from "@/lib/pagination";
import { reportSchema } from "@/lib/validation";

function actor(principal: Awaited<ReturnType<typeof requireModerator>>): AuditActor {
  return {
    accountId: principal.account.id,
    handle: principal.account.handle,
  };
}

async function parseReportRequest(request: Request) {
  const body = await readAuthJson(request, 1024 * 1024);
  const parsed = reportSchema.safeParse(body);
  if (!parsed.success) {
    return {
      response: Response.json(
        {
          error: "The report contains invalid fields.",
          issues: parsed.error.flatten(),
        },
        { status: 400, headers: noStoreHeaders() },
      ),
    } as const;
  }
  return { data: parsed.data } as const;
}

function reportFailure(error: unknown, fallback: string) {
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof EvidenceError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStoreHeaders() },
    );
  }
  const conflict =
    error instanceof Error && /unique constraint failed:\s*reports\.id/i.test(error.message);
  console.error(fallback, error);
  return Response.json(
    { error: conflict ? "A report with that identifier already exists." : fallback },
    { status: conflict ? 409 : 500, headers: noStoreHeaders() },
  );
}

export async function GET(request: Request) {
  try {
    await requireModerator(request, { fresh: true });
    const url = new URL(request.url);
    const reports = await listAdminReports({
      page: positiveInteger(url.searchParams.get("page"), 1),
      pageSize: positiveInteger(url.searchParams.get("pageSize"), 25),
      q: url.searchParams.get("q") ?? "",
    });
    return Response.json(reports, { headers: noStoreHeaders() });
  } catch (error) {
    return reportFailure(error, "Couldn't load the report queue.");
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireModerator(request, { fresh: true });
    await assertCsrf(request);
    const parsed = await parseReportRequest(request);
    if ("response" in parsed) return parsed.response;
    const auditActor = actor(principal);
    const report = await createReport(parsed.data, auditActor);
    return Response.json(
      { report },
      {
        status: 201,
        headers: noStoreHeaders(),
      },
    );
  } catch (error) {
    return reportFailure(error, "Couldn't create the report.");
  }
}

export async function PATCH(request: Request) {
  try {
    const principal = await requireModerator(request, { fresh: true });
    await assertCsrf(request);
    const parsed = await parseReportRequest(request);
    if ("response" in parsed) return parsed.response;
    const auditActor = actor(principal);
    const report = await updateReport(parsed.data, auditActor);
    if (!report) {
      return Response.json(
        { error: "Report not found." },
        { status: 404, headers: noStoreHeaders() },
      );
    }
    return Response.json({ report }, { headers: noStoreHeaders() });
  } catch (error) {
    return reportFailure(error, "Couldn't update the report.");
  }
}

export async function DELETE(request: Request) {
  try {
    const principal = await requireConfirmedAdminMutation(request);
    const id = new URL(request.url).searchParams.get("id");
    if (!id) {
      return Response.json(
        { error: "A report ID is required." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const removed = await removeReport(id, actor(principal));
    if (!removed) {
      return Response.json(
        { error: "Report not found." },
        { status: 404, headers: noStoreHeaders() },
      );
    }
    return Response.json({ ok: true }, { headers: noStoreHeaders() });
  } catch (error) {
    return reportFailure(error, "Couldn't delete the report.");
  }
}
