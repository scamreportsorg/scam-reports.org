import {
  assertCsrf,
  authErrorResponse,
  AuthError,
  noStoreHeaders,
  requireModerator,
} from "@/lib/auth";
import { EvidenceError, storeEvidenceFile, toAdminEvidenceAsset } from "@/lib/evidence";
import { EvidenceValidationError } from "@/lib/evidence-validation";
import {
  MODERATOR_UPLOAD_MULTIPART_LIMITS,
  MultipartRequestError,
  parseBoundedMultipartFormData,
} from "@/lib/bounded-multipart";

const MODERATOR_UPLOAD_POLICY = {
  ...MODERATOR_UPLOAD_MULTIPART_LIMITS,
  fields: {
    file: { kind: "file" },
    caption: { kind: "text" },
    replacesEvidenceId: { kind: "text" },
  },
} as const;

export async function POST(request: Request) {
  try {
    const principal = await requireModerator(request, { fresh: true });
    await assertCsrf(request);
    const formData = await parseBoundedMultipartFormData(request, MODERATOR_UPLOAD_POLICY);
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return Response.json(
        { error: "Select an image to upload." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const caption = formData.get("caption");
    const replacesEvidenceId = formData.get("replacesEvidenceId");
    if (
      replacesEvidenceId !== null &&
      (typeof replacesEvidenceId !== "string" || !/^EVA-[0-9a-f-]{36}$/iu.test(replacesEvidenceId))
    ) {
      return Response.json(
        { error: "Invalid replacement source." },
        { status: 400, headers: noStoreHeaders() },
      );
    }
    const stored = await storeEvidenceFile({
      file,
      intakeKind: "moderator_upload",
      actor: `${principal.account.handle} (${principal.account.id})`,
      caption: typeof caption === "string" ? caption : undefined,
      replacesEvidenceId: typeof replacesEvidenceId === "string" ? replacesEvidenceId : undefined,
    });
    return Response.json(
      {
        attachment: stored.publicAttachment,
        evidence: toAdminEvidenceAsset(stored.asset),
        message: replacesEvidenceId
          ? "Sanitized replacement saved. It stays private until another privacy review."
          : "Evidence sanitized. It stays private until a moderator reviews it.",
      },
      { status: 201, headers: noStoreHeaders() },
    );
  } catch (error) {
    if (error instanceof AuthError) return authErrorResponse(error);
    if (error instanceof MultipartRequestError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    if (error instanceof EvidenceError || error instanceof EvidenceValidationError) {
      return Response.json(
        { error: error.message, code: "code" in error ? error.code : "invalid_image" },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    console.error("Moderator evidence upload failed", error);
    return Response.json(
      { error: "Couldn't store the evidence image." },
      { status: 500, headers: noStoreHeaders() },
    );
  }
}
