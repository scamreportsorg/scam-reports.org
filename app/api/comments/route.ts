import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  requireMember,
  verifyTurnstile,
} from "@/lib/auth";
import { readAuthJson } from "@/lib/auth-request";
import { abuseErrorResponse, accountRateSubject, consumeRateLimit } from "@/lib/abuse-protection";
import {
  allocateIntakeId,
  createComment,
  listPublicCommentsPage,
  publicCommentExists,
} from "@/lib/community-intake";
import { listReportFamilyIds, resolveReport } from "@/lib/reports";
import { pageFromRequest } from "@/lib/pagination";
import { commentSubmissionSchema } from "@/lib/validation";

function failure(error: unknown) {
  return (
    abuseErrorResponse(error) ??
    (error instanceof AuthError
      ? authErrorResponse(error)
      : Response.json({ error: "We couldn't process this reply." }, { status: 500 }))
  );
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const requestedReportId = url.searchParams.get("reportId");
    let reportIds: string[] | undefined;
    if (requestedReportId) {
      const resolution = await resolveReport(requestedReportId);
      if (!resolution) {
        return Response.json({ error: "Published report not found." }, { status: 404 });
      }
      reportIds = await listReportFamilyIds(resolution.canonicalId);
    }
    const result = await listPublicCommentsPage({
      reportIds,
      page: pageFromRequest(request),
      pageSize: 25,
    });
    return Response.json(
      { comments: result.items, pagination: result.pagination },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireMember(request);
    if (!request.headers.get("content-type")?.includes("application/json")) {
      throw new AuthError(415, "invalid_content_type", "Discussion replies must use JSON.");
    }
    const body = await readAuthJson(request, 32 * 1024);
    await assertCsrf(request, typeof body?.csrfToken === "string" ? body.csrfToken : null);
    const parsed = commentSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "Some reply fields are invalid.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const resolution = await resolveReport(parsed.data.reportId);
    if (!resolution) {
      return Response.json({ error: "Published report not found." }, { status: 404 });
    }
    if (parsed.data.parentId) {
      if (!(await publicCommentExists(resolution.canonicalId, parsed.data.parentId))) {
        return Response.json({ error: "Parent reply not found." }, { status: 404 });
      }
    }
    await verifyTurnstile(
      typeof body?.turnstileToken === "string" ? body.turnstileToken : null,
      "comment",
      request,
    );
    const rateSubject = await accountRateSubject(principal.account.id);
    await consumeRateLimit({
      scope: "comment",
      subjectHash: rateSubject,
      limit: 5,
      windowSeconds: 24 * 60 * 60,
    });
    const timestamp = new Date().toISOString();
    const comment = await createComment({
      id: await allocateIntakeId("COM"),
      reportId: resolution.canonicalId,
      parentId: parsed.data.parentId || null,
      accountId: principal.account.id,
      displayName: principal.account.handle,
      body: parsed.data.body,
      status: "Pending",
      moderatorNotes: "",
      authorFingerprint: rateSubject,
      reviewerVerified: true,
      authorHandle: principal.account.handle,
      authorAccountId: principal.account.id,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return Response.json(
      {
        comment: { id: comment.id, status: comment.status },
        message: "Reply received. It is waiting for approval.",
      },
      { status: 201 },
    );
  } catch (error) {
    return failure(error);
  }
}
