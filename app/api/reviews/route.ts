import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  requireMember,
  verifyTurnstile,
} from "@/lib/auth";
import { readAuthJson } from "@/lib/auth-request";
import { abuseErrorResponse, accountRateSubject, consumeRateLimit } from "@/lib/abuse-protection";
import { listReportFamilyIds, resolveReport } from "@/lib/reports";
import { pageFromRequest } from "@/lib/pagination";
import { createReview, listPublicReviewsPage } from "@/lib/reviews";
import { reviewSubmissionSchema } from "@/lib/validation";

function failure(error: unknown) {
  return (
    abuseErrorResponse(error) ??
    (error instanceof AuthError
      ? authErrorResponse(error)
      : Response.json({ error: "We couldn't process this review." }, { status: 500 }))
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
    const result = await listPublicReviewsPage({
      reportIds,
      page: pageFromRequest(request),
      pageSize: 25,
    });
    return Response.json(
      { reviews: result.items, pagination: result.pagination },
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
      throw new AuthError(415, "invalid_content_type", "Review submissions must use JSON.");
    }
    const body = await readAuthJson(request, 32 * 1024);
    await assertCsrf(request, typeof body?.csrfToken === "string" ? body.csrfToken : null);
    const parsed = reviewSubmissionSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "Some review fields are invalid.", issues: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const resolution = await resolveReport(parsed.data.reportId);
    if (!resolution) {
      return Response.json({ error: "This published report does not exist." }, { status: 404 });
    }
    await verifyTurnstile(
      typeof body?.turnstileToken === "string" ? body.turnstileToken : null,
      "review",
      request,
    );
    const rateSubject = await accountRateSubject(principal.account.id);
    await consumeRateLimit({
      scope: "review",
      subjectHash: rateSubject,
      limit: 3,
      windowSeconds: 24 * 60 * 60,
    });
    const { website: _honeypot, displayName: _ignoredName, ...submission } = parsed.data;
    void _honeypot;
    void _ignoredName;
    const review = await createReview(
      { ...submission, reportId: resolution.canonicalId, displayName: principal.account.handle },
      {
        accountId: principal.account.id,
        accountHandle: principal.account.handle,
        authorFingerprint: rateSubject,
      },
    );
    return Response.json(
      {
        ok: true,
        review: { id: review.id, status: "Pending" },
        message: "Review received. It is waiting for approval.",
      },
      { status: 201 },
    );
  } catch (error) {
    return failure(error);
  }
}
