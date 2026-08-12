import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireMember,
  verifyTurnstile,
} from "@/lib/auth";
import { abuseErrorResponse, accountRateSubject, consumeRateLimit } from "@/lib/abuse-protection";
import { BoundedJsonError, readBoundedJson } from "@/lib/bounded-json";
import {
  createModeratorApplication,
  createModeratorApplicationId,
  findActiveModeratorApplicationForAccount,
  findLatestModeratorApplicationForAccount,
  withdrawModeratorApplication,
} from "@/lib/moderator-applications";
import {
  moderatorApplicationSubmissionSchema,
  moderatorApplicationWithdrawalSchema,
} from "@/lib/moderator-application-validation";

function failure(error: unknown) {
  const abuse = abuseErrorResponse(error);
  if (abuse) return abuse;
  if (error instanceof AuthError) return authErrorResponse(error);
  if (error instanceof BoundedJsonError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: noStoreHeaders() },
    );
  }
  console.error("Unable to process the moderator application request.", error);
  return Response.json(
    { error: "We couldn't submit your application. Try again." },
    { status: 500, headers: noStoreHeaders() },
  );
}

function requireEligibleApplicant(principal: Awaited<ReturnType<typeof requireMember>>) {
  if (principal.account.role !== "member") {
    throw new AuthError(
      409,
      "moderator_application_member_required",
      "Only community members can submit a moderator application.",
    );
  }
  if (!principal.linkedProviders.discord || !principal.linkedProviders.email) {
    throw new AuthError(
      409,
      "moderator_application_identities_required",
      "Link both Discord and email before applying for the moderation team.",
    );
  }
}

export async function GET(request: Request) {
  try {
    const principal = await requireMember(request);
    const application = await findLatestModeratorApplicationForAccount(principal.account.id);
    return Response.json({ application }, { headers: noStoreHeaders() });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request, 64 * 1024);
    const principal = await assertCsrf(
      request,
      typeof body.csrfToken === "string" ? body.csrfToken : null,
    );
    requireEligibleApplicant(principal);
    const parsed = moderatorApplicationSubmissionSchema.safeParse({
      motivation: body.motivation,
      experience: body.experience,
      timezone: body.timezone,
      availability: body.availability,
      languages: body.languages,
      conflicts: body.conflicts,
      confirmationAccepted: body.confirmationAccepted,
      website: body.website,
    });
    if (!parsed.success) {
      return Response.json(
        {
          error: "Check the highlighted application fields.",
          issues: parsed.error.flatten(),
        },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const active = await findActiveModeratorApplicationForAccount(principal.account.id);
    if (active) {
      throw new AuthError(
        409,
        "moderator_application_exists",
        "You already have an active moderator application.",
      );
    }
    await verifyTurnstile(
      typeof body.turnstileToken === "string" ? body.turnstileToken : null,
      "moderator_application",
      request,
    );
    const rateSubject = await accountRateSubject(principal.account.id);
    await consumeRateLimit({
      scope: "moderator_application",
      subjectHash: rateSubject,
      limit: 2,
      windowSeconds: 30 * 24 * 60 * 60,
    });
    const timestamp = new Date().toISOString();
    const application = await createModeratorApplication({
      id: createModeratorApplicationId(),
      accountId: principal.account.id,
      motivation: parsed.data.motivation,
      experience: parsed.data.experience,
      timezone: parsed.data.timezone,
      availability: parsed.data.availability,
      languages: parsed.data.languages,
      conflicts: parsed.data.conflicts,
      confirmationAccepted: true,
      createdAt: timestamp,
    });
    return Response.json(
      {
        application,
        message: "Application sent. Only you and staff can read it.",
      },
      { status: 201, headers: noStoreHeaders() },
    );
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await readBoundedJson(request, 4 * 1024);
    const parsed = moderatorApplicationWithdrawalSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { error: "A valid active application and security token are required." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const principal = await assertCsrf(request, parsed.data.csrfToken);
    const application = await withdrawModeratorApplication(principal.account.id, parsed.data.id);
    return Response.json(
      { application, message: "Your moderator application was withdrawn." },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    return failure(error);
  }
}
