import {
  deleteEvidenceAsset,
  EvidenceError,
  evidenceIntakeKind,
  getEvidenceAsset,
  rollbackUncommittedEvidenceAssets,
  storeEvidenceFiles,
} from "./evidence";
import { EvidenceValidationError, validateEvidenceFiles } from "./evidence-validation";
import type { QuarantineAttachment } from "./types";

export class IntakeError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "intake_error") {
    super(message);
    this.name = "IntakeError";
    this.status = status;
    this.code = code;
  }
}

export async function storeQuarantineFiles(formData: FormData, intakeId: string) {
  const files = formData
    .getAll("files")
    .filter((value): value is File => value instanceof File && value.size > 0);
  try {
    validateEvidenceFiles(files);
    if (!files.length) return [];
    const intakeKind = evidenceIntakeKind(intakeId);
    if (intakeKind !== "report_submission" && intakeKind !== "appeal") {
      throw new IntakeError(
        "This evidence does not belong to the intake.",
        409,
        "invalid_intake_owner",
      );
    }
    const stored = await storeEvidenceFiles({
      files,
      intakeId,
      intakeKind,
      actor: `intake:${intakeId}`,
    });
    return stored.map(({ asset }) => ({
      id: asset.id,
      filename: asset.originalFilename,
      storageKey: `asset/${asset.id}`,
      adminUrl: `/api/intake-files/asset/${encodeURIComponent(asset.id)}`,
      uploadedAt: asset.createdAt,
      fileSize: asset.derivativeSize ?? asset.originalSize,
      contentType: asset.derivativeContentType ?? asset.originalContentType,
    }));
  } catch (error) {
    if (error instanceof EvidenceValidationError || error instanceof EvidenceError) {
      throw new IntakeError(
        error.message,
        error.status,
        error instanceof EvidenceError ? error.code : "invalid_evidence",
      );
    }
    throw error;
  }
}

export async function deleteQuarantineFiles(
  attachments: QuarantineAttachment[],
  actor = "system:intake-cleanup",
  expectedIntakeId?: string,
) {
  if (!attachments.length) return;
  const evidenceIds = [...new Set(attachments.map((attachment) => attachment.id))];
  if (evidenceIds.some((id) => !/^EVA-[0-9a-f-]{36}$/iu.test(id))) {
    throw new IntakeError(
      "This case has an old or invalid evidence reference and cannot be deleted yet.",
      409,
      "invalid_evidence_reference",
    );
  }

  try {
    const assets = await Promise.all(evidenceIds.map((id) => getEvidenceAsset(id)));
    if (assets.some((asset) => !asset)) {
      throw new IntakeError(
        "Evidence metadata is missing. The case was not deleted.",
        409,
        "evidence_not_found",
      );
    }
    if (expectedIntakeId && assets.some((asset) => asset?.intakeId !== expectedIntakeId)) {
      throw new IntakeError(
        "The evidence belongs to another case. This case was not deleted.",
        409,
        "invalid_evidence_reference",
      );
    }
    if (assets.some((asset) => asset?.legalHold)) {
      throw new IntakeError(
        "Evidence under legal hold blocks permanent deletion.",
        409,
        "legal_hold",
      );
    }

    for (const id of evidenceIds) {
      const deleted = await deleteEvidenceAsset(id, actor);
      if (!deleted) {
        throw new IntakeError(
          "Evidence changed during deletion. The case was not deleted.",
          409,
          "evidence_not_found",
        );
      }
    }
  } catch (error) {
    if (error instanceof IntakeError) throw error;
    if (error instanceof EvidenceError) {
      throw new IntakeError(error.message, error.status, error.code);
    }
    throw error;
  }
}

export async function cleanupQuarantineFilesBestEffort(
  attachments: QuarantineAttachment[],
  expectedIntakeId: string,
) {
  try {
    await rollbackUncommittedEvidenceAssets({
      evidenceIds: attachments.map((attachment) => attachment.id),
      intakeId: expectedIntakeId,
      createdBy: `intake:${expectedIntakeId}`,
    });
  } catch (error) {
    console.error("Unable to roll back quarantined evidence; operator cleanup is required.", error);
  }
}

export function validQuarantineKey(segments: string[]) {
  const key = segments.join("/");
  return /^asset\/EVA-[0-9a-f-]{36}$/i.test(key) ? key : null;
}
