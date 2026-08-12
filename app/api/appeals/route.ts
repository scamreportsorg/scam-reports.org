import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  invalidCsrfError,
  verifyTurnstile,
} from "@/lib/auth";
import { abuseErrorResponse, accountRateSubject, consumeRateLimit } from "@/lib/abuse-protection";
import { allocateIntakeId, createAppeal, listAppeals } from "@/lib/community-intake";
import {
  cleanupQuarantineFilesBestEffort,
  IntakeError,
  storeQuarantineFiles,
} from "@/lib/intake-security";
import { listReportFamilyIds, resolveReport } from "@/lib/reports";
import type { QuarantineAttachment } from "@/lib/types";
import { appealSubmissionSchema } from "@/lib/validation";
import {
  INTAKE_MULTIPART_LIMITS,
  MultipartRequestError,
  parseBoundedMultipartFormDataAfterPreflight,
} from "@/lib/bounded-multipart";

const APPEAL_MULTIPART_POLICY = {
  ...INTAKE_MULTIPART_LIMITS,
  fields: {
    csrfToken: { kind: "text" },
    "cf-turnstile-response": { kind: "text" },
    reportId: { kind: "text" },
    requestType: { kind: "text" },
    submitterName: { kind: "text" },
    relationship: { kind: "text" },
    contactEmail: { kind: "text" },
    body: { kind: "text" },
    consent: { kind: "text" },
    website: { kind: "text" },
    files: { kind: "file", maxValues: 5 },
  },
} as const;

function formValue(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function failure(error: unknown) {
  const abuse = abuseErrorResponse(error);
  if (abuse) return abuse;
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof IntakeError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof MultipartRequestError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return Response.json({ error: "We couldn't save this appeal." }, { status: 500 });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const publicReportId = url.searchParams.get("reportId");
  if (!publicReportId) {
    return Response.json({ error: "A published report ID is required." }, { status: 400 });
  }
  const resolution = await resolveReport(publicReportId);
  if (!resolution) {
    return Response.json({ error: "Published report not found." }, { status: 404 });
  }
  const reportIds = await listReportFamilyIds(resolution.canonicalId);
  const appeals = await listAppeals({ reportIds, publicOnly: true });
  return Response.json({
    resolutions: appeals.map((appeal) => ({
      id: appeal.id,
      reportId: appeal.reportId,
      requestType: appeal.requestType,
      publicResolution: appeal.publicResolution,
      updatedAt: appeal.updatedAt,
    })),
  });
}

export async function POST(request: Request) {
  let evidence: QuarantineAttachment[] = [];
  let intakeId: string | null = null;
  let persisted = false;
  try {
    const { formData, preflightResult } = await parseBoundedMultipartFormDataAfterPreflight(
      request,
      APPEAL_MULTIPART_POLICY,
      async () => {
        const csrfToken = request.headers.get("x-csrf-token");
        const principal = await assertCsrf(request, csrfToken);
        const turnstileToken = request.headers.get("x-turnstile-token");
        await verifyTurnstile(turnstileToken, "appeal", request);
        const rateSubject = await accountRateSubject(principal.account.id);
        await consumeRateLimit({
          scope: "appeal",
          subjectHash: rateSubject,
          limit: 3,
          windowSeconds: 24 * 60 * 60,
        });
        return { csrfToken, principal, rateSubject, turnstileToken };
      },
    );
    const { csrfToken, principal, rateSubject, turnstileToken } = preflightResult;
    if (formValue(formData, "csrfToken") !== csrfToken) {
      throw invalidCsrfError();
    }
    if (formValue(formData, "cf-turnstile-response") !== turnstileToken) {
      throw new AuthError(403, "turnstile_required", "Complete the anti-abuse check.");
    }
    const parsed = appealSubmissionSchema.safeParse({
      reportId: formValue(formData, "reportId"),
      requestType: formValue(formData, "requestType"),
      submitterName: formValue(formData, "submitterName"),
      relationship: formValue(formData, "relationship"),
      contactEmail: formValue(formData, "contactEmail"),
      body: formValue(formData, "body"),
      consent: formValue(formData, "consent"),
      website: formValue(formData, "website"),
    });
    if (!parsed.success) {
      return Response.json(
        {
          error: "Check the appeal details and try again.",
          issues: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }
    const resolution = await resolveReport(parsed.data.reportId);
    if (!resolution) {
      return Response.json({ error: "Published report not found." }, { status: 404 });
    }

    intakeId = await allocateIntakeId("APL");
    evidence = await storeQuarantineFiles(formData, intakeId);
    const timestamp = new Date().toISOString();
    const appeal = await createAppeal({
      id: intakeId,
      accountId: principal.account.id,
      reportId: resolution.canonicalId,
      requestType: parsed.data.requestType,
      submitterName: principal.account.handle,
      relationship: parsed.data.relationship,
      contactEmail: parsed.data.contactEmail,
      body: parsed.data.body,
      evidence,
      status: "Pending",
      moderatorNotes: "",
      publicResolution: "",
      authorFingerprint: rateSubject,
      submitterVerified: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    persisted = true;
    return Response.json(
      {
        appeal: { id: appeal.id, status: appeal.status },
        message: "Appeal sent. It stays private while moderators review it.",
      },
      { status: 201 },
    );
  } catch (error) {
    if (!persisted && evidence.length && intakeId) {
      await cleanupQuarantineFilesBestEffort(evidence, intakeId);
    }
    return failure(error);
  }
}
