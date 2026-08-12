import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  invalidCsrfError,
  verifyTurnstile,
} from "@/lib/auth";
import { abuseErrorResponse, accountRateSubject, consumeRateLimit } from "@/lib/abuse-protection";
import { allocateIntakeId, createReportSubmission } from "@/lib/community-intake";
import {
  cleanupQuarantineFilesBestEffort,
  IntakeError,
  storeQuarantineFiles,
} from "@/lib/intake-security";
import { resolveReport } from "@/lib/reports";
import type { QuarantineAttachment } from "@/lib/types";
import { reportSubmissionSchema } from "@/lib/validation";
import {
  INTAKE_MULTIPART_LIMITS,
  MultipartRequestError,
  parseBoundedMultipartFormDataAfterPreflight,
} from "@/lib/bounded-multipart";

const REPORT_MULTIPART_POLICY = {
  ...INTAKE_MULTIPART_LIMITS,
  fields: {
    csrfToken: { kind: "text" },
    "cf-turnstile-response": { kind: "text" },
    submitterName: { kind: "text" },
    contactEmail: { kind: "text" },
    username: { kind: "text" },
    discordId: { kind: "text" },
    game: { kind: "text" },
    category: { kind: "text" },
    reason: { kind: "text" },
    description: { kind: "text" },
    relatedReportId: { kind: "text" },
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
  return Response.json({ error: "We couldn't submit this report. Try again." }, { status: 500 });
}

export async function POST(request: Request) {
  let evidence: QuarantineAttachment[] = [];
  let intakeId: string | null = null;
  let persisted = false;
  try {
    const { formData, preflightResult } = await parseBoundedMultipartFormDataAfterPreflight(
      request,
      REPORT_MULTIPART_POLICY,
      async () => {
        const csrfToken = request.headers.get("x-csrf-token");
        const principal = await assertCsrf(request, csrfToken);
        const turnstileToken = request.headers.get("x-turnstile-token");
        await verifyTurnstile(turnstileToken, "report", request);
        const rateSubject = await accountRateSubject(principal.account.id);
        await consumeRateLimit({
          scope: "report_upload",
          subjectHash: rateSubject,
          limit: 10,
          windowSeconds: 60 * 60,
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

    const parsed = reportSubmissionSchema.safeParse({
      submitterName: formValue(formData, "submitterName"),
      contactEmail: formValue(formData, "contactEmail"),
      username: formValue(formData, "username"),
      discordId: formValue(formData, "discordId"),
      game: formValue(formData, "game"),
      category: formValue(formData, "category"),
      reason: formValue(formData, "reason"),
      description: formValue(formData, "description"),
      relatedReportId: formValue(formData, "relatedReportId"),
      consent: formValue(formData, "consent"),
      website: formValue(formData, "website"),
    });
    if (!parsed.success) {
      return Response.json(
        {
          error: "Review the highlighted report fields.",
          issues: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }
    const relatedResolution = parsed.data.relatedReportId
      ? await resolveReport(parsed.data.relatedReportId)
      : null;
    if (parsed.data.relatedReportId && !relatedResolution) {
      return Response.json(
        { error: "The related published report does not exist." },
        { status: 404 },
      );
    }

    await consumeRateLimit({
      scope: "report",
      subjectHash: rateSubject,
      limit: 2,
      windowSeconds: 24 * 60 * 60,
    });

    intakeId = await allocateIntakeId("SUB");
    evidence = await storeQuarantineFiles(formData, intakeId);
    const timestamp = new Date().toISOString();
    const submission = await createReportSubmission({
      id: intakeId,
      accountId: principal.account.id,
      relatedReportId: relatedResolution?.canonicalId ?? null,
      submitterName: principal.account.handle,
      contactEmail: parsed.data.contactEmail,
      username: parsed.data.username,
      discordId: parsed.data.discordId,
      game: parsed.data.game,
      category: parsed.data.category,
      reason: parsed.data.reason,
      description: parsed.data.description,
      evidence,
      status: "Pending",
      moderatorNotes: "",
      authorFingerprint: rateSubject,
      submitterVerified: true,
      resultReportId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    persisted = true;
    return Response.json(
      {
        submission: { id: submission.id, status: submission.status },
        message: "Report sent. It stays private while moderators review it.",
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
