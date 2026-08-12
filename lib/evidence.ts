import { env } from "cloudflare:workers";
import type { EvidenceProcessingState, PublicEvidenceAsset } from "./types";
import {
  EVIDENCE_LIMITS,
  EvidenceValidationError,
  normalizeEvidenceFilename,
  readAndValidateEvidenceFile,
  sniffEvidenceContentType,
  validateEvidenceDimensions,
  validateEvidenceFiles,
  type EvidenceContentType,
} from "./evidence-validation";

export type EvidenceIntakeKind = "report_submission" | "appeal" | "moderator_upload" | "legacy";

export type EvidenceAsset = {
  id: string;
  intakeId: string | null;
  intakeKind: EvidenceIntakeKind;
  state: EvidenceProcessingState;
  originalKey: string;
  derivativeKey: string | null;
  originalFilename: string;
  originalContentType: EvidenceContentType;
  originalSize: number;
  originalSha256: string;
  derivativeContentType: string | null;
  derivativeSize: number | null;
  derivativeSha256: string | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  width: number | null;
  height: number | null;
  visiblePiiReviewed: boolean;
  privacyWithheld: boolean;
  replacesEvidenceId: string | null;
  legalHold: boolean;
  processingError: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  deletedAt: string | null;
};

export type AdminEvidenceAsset = Omit<EvidenceAsset, "originalKey" | "derivativeKey">;

export function toAdminEvidenceAsset(asset: EvidenceAsset): AdminEvidenceAsset {
  return {
    id: asset.id,
    intakeId: asset.intakeId,
    intakeKind: asset.intakeKind,
    state: asset.state,
    originalFilename: asset.originalFilename,
    originalContentType: asset.originalContentType,
    originalSize: asset.originalSize,
    originalSha256: asset.originalSha256,
    derivativeContentType: asset.derivativeContentType,
    derivativeSize: asset.derivativeSize,
    derivativeSha256: asset.derivativeSha256,
    sourceWidth: asset.sourceWidth,
    sourceHeight: asset.sourceHeight,
    width: asset.width,
    height: asset.height,
    visiblePiiReviewed: asset.visiblePiiReviewed,
    privacyWithheld: asset.privacyWithheld,
    replacesEvidenceId: asset.replacesEvidenceId,
    legalHold: asset.legalHold,
    processingError: asset.processingError,
    createdBy: asset.createdBy,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    publishedAt: asset.publishedAt,
    deletedAt: asset.deletedAt,
  };
}

export type EvidenceLink = {
  reportId: string;
  evidenceId: string;
  caption: string;
  displayOrder: number;
  createdAt: string;
};

export type StoredEvidence = {
  asset: EvidenceAsset;
  publicAttachment: {
    id: string;
    filename: string;
    url: string;
    caption: string;
    uploadedAt: string;
    fileSize: number;
    contentType: string;
    redacted: boolean;
  };
};

type EvidenceAssetRow = {
  id: string;
  intake_id: string | null;
  intake_kind: string;
  state: string;
  original_key: string;
  derivative_key: string | null;
  original_filename: string;
  original_content_type: string;
  original_size: number;
  original_sha256: string;
  derivative_content_type: string | null;
  derivative_size: number | null;
  derivative_sha256: string | null;
  source_width: number | null;
  source_height: number | null;
  width: number | null;
  height: number | null;
  visible_pii_reviewed: number;
  privacy_withheld: number;
  replaces_evidence_id: string | null;
  legal_hold: number;
  processing_error: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  deleted_at: string | null;
};

type RuntimeBindings = {
  DB?: D1Database;
  EVIDENCE_ORIGINALS?: R2Bucket;
  EVIDENCE_DERIVATIVES?: R2Bucket;
  BACKUPS?: R2Bucket;
  IMAGES?: ImagesBinding;
  APP_ENVIRONMENT?: string;
  AUTH_RUNTIME_ENV?: string;
  EVIDENCE_TEST_SANITIZER?: string;
};

type SanitizedImage = {
  bytes: Uint8Array;
  contentType: EvidenceContentType;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
};

const TRANSITIONS: Record<EvidenceProcessingState, EvidenceProcessingState[]> = {
  uploading: ["private_ready", "failed", "deleted"],
  private_ready: ["public", "withheld", "deleted"],
  public: ["withheld", "deleted"],
  withheld: ["private_ready", "public", "deleted"],
  failed: ["deleted"],
  deleted: [],
};

const DELETION_LEASE_PREFIX = "deletion-pending:";
const DELETION_LEASE_TIMEOUT_MS = 10 * 60 * 1000;

export class EvidenceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = "evidence_error") {
    super(message);
    this.name = "EvidenceError";
    this.status = status;
    this.code = code;
  }
}

function bindings(): RuntimeBindings {
  try {
    return env as unknown as RuntimeBindings;
  } catch {
    return {};
  }
}

function requireDatabase() {
  const database = bindings().DB;
  if (!database) {
    throw new EvidenceError(
      "Evidence metadata storage is not configured.",
      503,
      "database_unavailable",
    );
  }
  return database;
}

function requireBuckets() {
  const runtime = bindings();
  if (!runtime.EVIDENCE_ORIGINALS || !runtime.EVIDENCE_DERIVATIVES || !runtime.BACKUPS) {
    throw new EvidenceError(
      "Private evidence storage is not configured.",
      503,
      "storage_unavailable",
    );
  }
  return {
    originals: runtime.EVIDENCE_ORIGINALS,
    derivatives: runtime.EVIDENCE_DERIVATIVES,
    backups: runtime.BACKUPS,
  };
}

type EvidenceRollbackStorage = {
  originals: Pick<R2Bucket, "delete">;
  derivatives: Pick<R2Bucket, "delete">;
  backups: Pick<R2Bucket, "delete">;
};

function bytesStream(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer]).stream();
}

async function sha256Hex(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
}

function testSanitizerEnabled(runtime: RuntimeBindings) {
  return (
    runtime.APP_ENVIRONMENT === "test" &&
    runtime.AUTH_RUNTIME_ENV === "test" &&
    runtime.EVIDENCE_TEST_SANITIZER === "unsafe-copy"
  );
}

async function sanitizeImage(
  bytes: Uint8Array,
  inputContentType: EvidenceContentType,
): Promise<SanitizedImage> {
  const runtime = bindings();
  if (!runtime.IMAGES) {
    if (testSanitizerEnabled(runtime)) {
      return {
        bytes,
        contentType: inputContentType,
        sourceWidth: 1,
        sourceHeight: 1,
        width: 1,
        height: 1,
      };
    }
    throw new EvidenceError(
      "Evidence image processing is not configured.",
      503,
      "sanitizer_unavailable",
    );
  }

  let sourceInfo: ImageInfoResponse;
  try {
    sourceInfo = await runtime.IMAGES.info(bytesStream(bytes));
  } catch {
    throw new EvidenceValidationError("The uploaded file is not a decodable image.", 415);
  }
  if (!("width" in sourceInfo) || !("height" in sourceInfo)) {
    throw new EvidenceValidationError("Only raster PNG, JPEG, and WebP images are accepted.", 415);
  }
  validateEvidenceDimensions(sourceInfo.width, sourceInfo.height);

  let result: ImageTransformationResult;
  try {
    const transformOptions = {
      width: EVIDENCE_LIMITS.derivativeMaxEdge,
      height: EVIDENCE_LIMITS.derivativeMaxEdge,
      fit: "scale-down",
      metadata: "none",
    } as ImageTransform & { metadata: "none" };
    result = await runtime.IMAGES.input(bytesStream(bytes))
      .transform(transformOptions)
      .output({ format: "image/webp", quality: 85, anim: false });
  } catch {
    throw new EvidenceError(
      "The evidence image could not be sanitized.",
      422,
      "sanitization_failed",
    );
  }

  const output = new Uint8Array(await new Response(result.image()).arrayBuffer());
  if (sniffEvidenceContentType(output) !== "image/webp") {
    throw new EvidenceError(
      "The evidence sanitizer returned an invalid derivative.",
      502,
      "invalid_derivative",
    );
  }

  let outputInfo: ImageInfoResponse;
  try {
    outputInfo = await runtime.IMAGES.info(bytesStream(output));
  } catch {
    throw new EvidenceError(
      "The sanitized evidence derivative could not be verified.",
      502,
      "invalid_derivative",
    );
  }
  if (!("width" in outputInfo) || !("height" in outputInfo)) {
    throw new EvidenceError(
      "The evidence sanitizer returned a non-raster derivative.",
      502,
      "invalid_derivative",
    );
  }
  validateEvidenceDimensions(outputInfo.width, outputInfo.height);
  if (
    outputInfo.width > EVIDENCE_LIMITS.derivativeMaxEdge ||
    outputInfo.height > EVIDENCE_LIMITS.derivativeMaxEdge
  ) {
    throw new EvidenceError(
      "The sanitized evidence derivative exceeds the publication size limit.",
      502,
      "invalid_derivative",
    );
  }

  return {
    bytes: output,
    contentType: "image/webp",
    sourceWidth: sourceInfo.width,
    sourceHeight: sourceInfo.height,
    width: outputInfo.width,
    height: outputInfo.height,
  };
}

function fromRow(row: EvidenceAssetRow): EvidenceAsset {
  return {
    id: row.id,
    intakeId: row.intake_id,
    intakeKind: row.intake_kind as EvidenceIntakeKind,
    state: row.state as EvidenceProcessingState,
    originalKey: row.original_key,
    derivativeKey: row.derivative_key,
    originalFilename: row.original_filename,
    originalContentType: row.original_content_type as EvidenceContentType,
    originalSize: row.original_size,
    originalSha256: row.original_sha256,
    derivativeContentType: row.derivative_content_type,
    derivativeSize: row.derivative_size,
    derivativeSha256: row.derivative_sha256,
    sourceWidth: row.source_width,
    sourceHeight: row.source_height,
    width: row.width,
    height: row.height,
    visiblePiiReviewed: Boolean(row.visible_pii_reviewed),
    privacyWithheld: Boolean(row.privacy_withheld),
    replacesEvidenceId: row.replaces_evidence_id,
    legalHold: Boolean(row.legal_hold),
    processingError: row.processing_error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    deletedAt: row.deleted_at,
  };
}

export function evidenceIntakeKind(intakeId: string): EvidenceIntakeKind {
  if (intakeId.startsWith("APL-")) return "appeal";
  if (intakeId.startsWith("SUB-")) return "report_submission";
  return "moderator_upload";
}

export async function storeEvidenceFile(options: {
  file: File;
  intakeId?: string | null;
  intakeKind: EvidenceIntakeKind;
  actor: string;
  caption?: string;
  replacesEvidenceId?: string | null;
}): Promise<StoredEvidence> {
  const database = requireDatabase();
  const storage = requireBuckets();
  if (options.replacesEvidenceId) {
    const source = await getEvidenceAsset(options.replacesEvidenceId);
    if (!source || !source.privacyWithheld || source.state !== "withheld") {
      throw new EvidenceError(
        "A redacted replacement must reference a visible-PII-withheld source asset.",
        409,
        "replacement_source_invalid",
      );
    }
  }
  const { bytes, contentType } = await readAndValidateEvidenceFile(options.file);
  const now = new Date().toISOString();
  const id = `EVA-${crypto.randomUUID()}`;
  const opaqueKey = crypto.randomUUID();
  const originalKey = `originals/${opaqueKey}`;
  const derivativeKey = `derivatives/${opaqueKey}.webp`;
  const backupKey = `evidence-originals/${opaqueKey}`;
  const originalSha256 = await sha256Hex(bytes);
  const originalFilename = normalizeEvidenceFilename(options.file.name);

  // D1 and R2 cannot commit together. Keep this row as the recovery marker until both sides finish.
  await database
    .prepare(
      `INSERT INTO evidence_assets (
      id, intake_id, intake_kind, state, original_key, derivative_key,
      original_filename, original_content_type, original_size, original_sha256,
      derivative_content_type, derivative_size, derivative_sha256,
      source_width, source_height, width, height, visible_pii_reviewed,
      privacy_withheld, replaces_evidence_id, legal_hold, processing_error,
      created_by, created_at, updated_at,
      published_at, deleted_at
    ) VALUES (?, ?, ?, 'uploading', ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, 0, 0, ?, 0, '', ?, ?, ?, NULL, NULL)`,
    )
    .bind(
      id,
      options.intakeId ?? null,
      options.intakeKind,
      originalKey,
      originalFilename,
      contentType,
      bytes.byteLength,
      originalSha256,
      options.replacesEvidenceId ?? null,
      options.actor,
      now,
      now,
    )
    .run();

  let originalStored = false;
  let derivativeStored = false;
  let backupStored = false;
  try {
    const sanitized = await sanitizeImage(bytes, contentType);
    const derivativeSha256 = await sha256Hex(sanitized.bytes);

    await storage.originals.put(originalKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: {
        assetId: id,
        sha256: originalSha256,
        private: "true",
      },
    });
    originalStored = true;

    await storage.backups.put(backupKey, bytes, {
      httpMetadata: { contentType },
      customMetadata: { assetId: id, sha256: originalSha256 },
    });
    backupStored = true;

    await storage.derivatives.put(derivativeKey, sanitized.bytes, {
      httpMetadata: { contentType: sanitized.contentType },
      customMetadata: {
        assetId: id,
        sourceSha256: originalSha256,
        sha256: derivativeSha256,
        sanitized: testSanitizerEnabled(bindings())
          ? "test-only-unsafe-copy"
          : "cloudflare-images-webp",
      },
    });
    derivativeStored = true;

    const updatedAt = new Date().toISOString();
    const completionStatements = [
      database
        .prepare(
          `UPDATE evidence_assets SET
          state = 'private_ready', derivative_key = ?,
          derivative_content_type = ?, derivative_size = ?,
          derivative_sha256 = ?, source_width = ?, source_height = ?,
          width = ?, height = ?, updated_at = ?, processing_error = ''
          WHERE id = ? AND state = 'uploading'`,
        )
        .bind(
          derivativeKey,
          sanitized.contentType,
          sanitized.bytes.byteLength,
          derivativeSha256,
          sanitized.sourceWidth,
          sanitized.sourceHeight,
          sanitized.width,
          sanitized.height,
          updatedAt,
          id,
        ),
      database
        .prepare(
          `INSERT INTO audit_logs
          (report_id, action, actor, created_at, detail) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(
          options.intakeId ?? id,
          "evidence.uploaded",
          options.actor,
          updatedAt,
          JSON.stringify({
            evidenceId: id,
            intakeKind: options.intakeKind,
            replacesEvidenceId: options.replacesEvidenceId ?? null,
            originalSha256,
            derivativeSha256,
          }),
        ),
    ];
    if (options.intakeKind === "moderator_upload") {
      completionStatements.push(
        database
          .prepare(
            `INSERT OR IGNORE INTO notification_outbox
            (id, event_key, channel, case_id, event_type, queue_path, status,
             attempts, next_attempt_at, last_error, created_at)
            VALUES (?, ?, 'discord', ?, 'evidence', '/admin?queue=evidence',
              'pending', 0, ?, '', ?)`,
          )
          .bind(crypto.randomUUID(), `evidence:${id}:discord`, id, updatedAt, updatedAt),
      );
    }
    await database.batch(completionStatements);

    const asset = await getEvidenceAsset(id);
    if (!asset || asset.state !== "private_ready") {
      throw new EvidenceError(
        "The evidence record could not be loaded after processing.",
        500,
        "metadata_write_failed",
      );
    }

    return {
      asset,
      publicAttachment: {
        id,
        filename: originalFilename,
        url: `/api/evidence/${encodeURIComponent(id)}`,
        caption: options.caption?.trim() || "Evidence attachment pending privacy review.",
        uploadedAt: now,
        fileSize: sanitized.bytes.byteLength,
        contentType: sanitized.contentType,
        redacted: false,
      },
    };
  } catch (error) {
    const cleanupResults = await Promise.allSettled([
      originalStored ? storage.originals.delete(originalKey) : Promise.resolve(),
      derivativeStored ? storage.derivatives.delete(derivativeKey) : Promise.resolve(),
      backupStored ? storage.backups.delete(backupKey) : Promise.resolve(),
    ]);
    const message =
      error instanceof Error ? error.message.slice(0, 500) : "Evidence processing failed.";
    const cleanupComplete = cleanupResults.every((result) => result.status === "fulfilled");
    const uncommittedIntake =
      options.intakeId &&
      (options.intakeKind === "report_submission" || options.intakeKind === "appeal") &&
      options.actor === `intake:${options.intakeId}` &&
      !options.replacesEvidenceId;
    let metadataCleared = false;
    if (cleanupComplete && uncommittedIntake) {
      const deleted = await database
        .prepare(
          `DELETE FROM evidence_assets
           WHERE id = ? AND intake_id = ? AND intake_kind = ? AND created_by = ?
             AND state = 'uploading' AND replaces_evidence_id IS NULL
             AND published_at IS NULL AND deleted_at IS NULL`,
        )
        .bind(id, options.intakeId, options.intakeKind, options.actor)
        .run()
        .catch(() => null);
      metadataCleared = Boolean(deleted?.meta.changes);
    }
    if (!metadataCleared) {
      await database
        .prepare(
          `UPDATE evidence_assets SET
          state = 'failed', processing_error = ?, updated_at = ?
          WHERE id = ? AND state = 'uploading'`,
        )
        .bind(message, new Date().toISOString(), id)
        .run()
        .catch(() => undefined);
    }
    throw error;
  }
}

export async function storeEvidenceFiles(options: {
  files: File[];
  intakeId: string;
  intakeKind: "report_submission" | "appeal";
  actor: string;
  caption?: string;
}) {
  validateEvidenceFiles(options.files);
  const stored: StoredEvidence[] = [];
  try {
    for (const file of options.files) {
      stored.push(
        await storeEvidenceFile({
          file,
          intakeId: options.intakeId,
          intakeKind: options.intakeKind,
          actor: options.actor,
          caption: options.caption,
        }),
      );
    }
    return stored;
  } catch (error) {
    if (stored.length) {
      await rollbackUncommittedEvidenceAssets({
        evidenceIds: stored.map(({ asset }) => asset.id),
        intakeId: options.intakeId,
        createdBy: options.actor,
      });
    }
    throw error;
  }
}

export async function getEvidenceAsset(id: string) {
  return getEvidenceAssetFromDatabase(requireDatabase(), id);
}

async function getEvidenceAssetFromDatabase(database: D1Database, id: string) {
  const result = await database
    .prepare("SELECT * FROM evidence_assets WHERE id = ?")
    .bind(id)
    .first<EvidenceAssetRow>();
  return result ? fromRow(result) : null;
}

function intakeRollbackContext(intakeId: string) {
  if (/^SUB-\d{4}-[0-9A-F]{8}$/u.test(intakeId)) {
    return { intakeKind: "report_submission" as const, caseTable: "report_submissions" as const };
  }
  if (/^APL-\d{4}-[0-9A-F]{8}$/u.test(intakeId)) {
    return { intakeKind: "appeal" as const, caseTable: "appeals" as const };
  }
  throw new EvidenceError(
    "The uncommitted evidence owner is invalid.",
    409,
    "rollback_owner_invalid",
  );
}

function uncommittedObjectKeys(asset: EvidenceAsset) {
  const original = /^originals\/([0-9a-f-]{36})$/iu.exec(asset.originalKey);
  if (!original || asset.derivativeKey !== `derivatives/${original[1]}.webp`) {
    throw new EvidenceError(
      "The uncommitted evidence keys are invalid.",
      409,
      "rollback_key_invalid",
    );
  }
  return {
    originalKey: asset.originalKey,
    derivativeKey: asset.derivativeKey,
    backupKey: `evidence-originals/${original[1]}`,
  };
}

export async function rollbackUncommittedEvidenceAssets(
  options: {
    evidenceIds: string[];
    intakeId: string;
    createdBy: string;
  },
  dependencies?: { database?: D1Database; storage?: EvidenceRollbackStorage },
) {
  const evidenceIds = [...new Set(options.evidenceIds)];
  if (!evidenceIds.length) return;
  if (evidenceIds.some((id) => !/^EVA-[0-9a-f-]{36}$/iu.test(id))) {
    throw new EvidenceError(
      "The uncommitted evidence reference is invalid.",
      409,
      "rollback_reference_invalid",
    );
  }

  const database = dependencies?.database ?? requireDatabase();
  const storage = dependencies?.storage ?? requireBuckets();
  const context = intakeRollbackContext(options.intakeId);
  if (options.createdBy !== `intake:${options.intakeId}`) {
    throw new EvidenceError(
      "The uncommitted evidence creator is invalid.",
      409,
      "rollback_owner_invalid",
    );
  }
  const committed = await database
    .prepare(`SELECT 1 AS present FROM ${context.caseTable} WHERE id = ? LIMIT 1`)
    .bind(options.intakeId)
    .first<{ present: number }>();
  if (committed) {
    throw new EvidenceError(
      "Committed evidence cannot use the intake rollback path.",
      409,
      "rollback_committed",
    );
  }

  const assets: EvidenceAsset[] = [];
  for (const id of evidenceIds) {
    const asset = await getEvidenceAssetFromDatabase(database, id);
    if (!asset) continue;
    if (
      asset.intakeId !== options.intakeId ||
      asset.intakeKind !== context.intakeKind ||
      asset.createdBy !== options.createdBy ||
      asset.state !== "private_ready" ||
      asset.legalHold ||
      asset.privacyWithheld ||
      asset.replacesEvidenceId ||
      asset.publishedAt ||
      asset.deletedAt
    ) {
      throw new EvidenceError(
        "Evidence is not eligible for uncommitted intake rollback.",
        409,
        "rollback_owner_invalid",
      );
    }
    const linked = await database
      .prepare(`SELECT 1 AS present FROM report_evidence WHERE evidence_id = ? LIMIT 1`)
      .bind(id)
      .first<{ present: number }>();
    const replacement = await database
      .prepare(`SELECT 1 AS present FROM evidence_assets WHERE replaces_evidence_id = ? LIMIT 1`)
      .bind(id)
      .first<{ present: number }>();
    if (linked || replacement) {
      throw new EvidenceError(
        "Linked evidence cannot use the intake rollback path.",
        409,
        "rollback_committed",
      );
    }
    uncommittedObjectKeys(asset);
    assets.push(asset);
  }
  if (!assets.length) return;

  const storageResults = await Promise.allSettled(
    assets.flatMap((asset) => {
      const keys = uncommittedObjectKeys(asset);
      return [
        storage.originals.delete(keys.originalKey),
        storage.derivatives.delete(keys.derivativeKey),
        storage.backups.delete(keys.backupKey),
      ];
    }),
  );
  if (storageResults.some((result) => result.status === "rejected")) {
    throw new EvidenceError(
      "Uncommitted evidence storage cleanup is incomplete.",
      503,
      "rollback_storage_delete_failed",
    );
  }

  const statements: D1PreparedStatement[] = [];
  for (const asset of assets) {
    statements.push(
      database
        .prepare(
          `DELETE FROM audit_logs
           WHERE report_id = ? AND action = 'evidence.uploaded' AND instr(detail, ?) > 0`,
        )
        .bind(options.intakeId, `"evidenceId":"${asset.id}"`),
      database
        .prepare(
          `DELETE FROM evidence_assets
           WHERE id = ? AND intake_id = ? AND intake_kind = ? AND created_by = ?
             AND state = 'private_ready' AND legal_hold = 0 AND privacy_withheld = 0
             AND replaces_evidence_id IS NULL AND published_at IS NULL AND deleted_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM report_evidence WHERE evidence_id = ?)
             AND NOT EXISTS (SELECT 1 FROM evidence_assets WHERE replaces_evidence_id = ?)
             AND NOT EXISTS (SELECT 1 FROM ${context.caseTable} WHERE id = ?)`,
        )
        .bind(
          asset.id,
          options.intakeId,
          context.intakeKind,
          options.createdBy,
          asset.id,
          asset.id,
          options.intakeId,
        ),
    );
  }
  await database.batch(statements);
  for (const id of evidenceIds) {
    if (await getEvidenceAssetFromDatabase(database, id)) {
      throw new EvidenceError(
        "Uncommitted evidence metadata cleanup conflicted with a committed record.",
        409,
        "rollback_conflict",
      );
    }
  }
}

export async function listEvidenceAssets(
  filters: {
    state?: EvidenceProcessingState;
    intakeId?: string;
    reportId?: string;
    page?: number;
    pageSize?: number;
  } = {},
) {
  const database = requireDatabase();
  const requestedPage = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(filters.pageSize ?? 25)));
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (filters.state) {
    conditions.push("ea.state = ?");
    values.push(filters.state);
  }
  if (filters.intakeId) {
    conditions.push("ea.intake_id = ?");
    values.push(filters.intakeId);
  }
  if (filters.reportId) {
    conditions.push("re.report_id = ?");
    values.push(filters.reportId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const join = filters.reportId
    ? "INNER JOIN report_evidence re ON re.evidence_id = ea.id"
    : "LEFT JOIN report_evidence re ON re.evidence_id = ea.id";
  const count = await database
    .prepare(`SELECT COUNT(DISTINCT ea.id) AS count FROM evidence_assets ea ${join} ${where}`)
    .bind(...values)
    .first<{ count: number }>();
  const totalItems = Number(count?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const result = await database
    .prepare(
      `SELECT DISTINCT ea.* FROM evidence_assets ea ${join} ${where}
      ORDER BY ea.created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...values, pageSize, (page - 1) * pageSize)
    .all<EvidenceAssetRow>();
  return {
    items: result.results.map(fromRow),
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
    },
  };
}

export async function getEvidenceLinks(evidenceId: string) {
  const result = await requireDatabase()
    .prepare(
      `SELECT report_id, evidence_id, caption, display_order, created_at
      FROM report_evidence WHERE evidence_id = ? ORDER BY display_order, report_id`,
    )
    .bind(evidenceId)
    .all<{
      report_id: string;
      evidence_id: string;
      caption: string;
      display_order: number;
      created_at: string;
    }>();
  return result.results.map((row) => ({
    reportId: row.report_id,
    evidenceId: row.evidence_id,
    caption: row.caption,
    displayOrder: row.display_order,
    createdAt: row.created_at,
  }));
}

export async function getPublicEvidenceAsset(
  id: string,
): Promise<{ asset: PublicEvidenceAsset; derivativeKey: string; derivativeSha256: string } | null> {
  // Merged reports can borrow publication only from a published root report.
  const row = await requireDatabase()
    .prepare(
      `SELECT ea.id, ea.derivative_key, ea.derivative_content_type,
        ea.derivative_size, ea.derivative_sha256, ea.width, ea.height, ea.created_at, re.caption
      FROM evidence_assets ea
      INNER JOIN report_evidence re ON re.evidence_id = ea.id
      INNER JOIN reports r ON r.id = re.report_id
      WHERE ea.id = ? AND ea.state = 'public' AND ea.visible_pii_reviewed = 1
        AND ea.privacy_withheld = 0
        AND ea.deleted_at IS NULL
        AND ea.derivative_key IS NOT NULL
        AND ea.derivative_content_type = 'image/webp'
        AND ea.derivative_size IS NOT NULL
        AND ea.derivative_sha256 IS NOT NULL
        AND ea.width IS NOT NULL AND ea.height IS NOT NULL
        AND (
          r.is_published = 1 OR EXISTS (
            SELECT 1 FROM reports canonical
            WHERE canonical.id = r.merged_into_report_id
              AND canonical.is_published = 1
              AND canonical.merged_into_report_id IS NULL
          )
        )
      ORDER BY re.display_order, re.report_id LIMIT 1`,
    )
    .bind(id)
    .first<{
      id: string;
      derivative_key: string;
      derivative_content_type: string;
      derivative_size: number;
      derivative_sha256: string;
      width: number;
      height: number;
      created_at: string;
      caption: string;
    }>();
  if (!row) return null;
  return {
    derivativeKey: row.derivative_key,
    derivativeSha256: row.derivative_sha256,
    asset: {
      id: row.id,
      url: `/api/evidence/${encodeURIComponent(row.id)}`,
      caption: row.caption,
      width: row.width,
      height: row.height,
      contentType: row.derivative_content_type,
      fileSize: row.derivative_size,
      uploadedAt: row.created_at,
    },
  };
}

export async function getEvidenceDerivativeObject(asset: EvidenceAsset) {
  if (!asset.derivativeKey || asset.state === "failed" || asset.state === "deleted") {
    return null;
  }
  return (await requireBuckets().derivatives.get(asset.derivativeKey)) ?? null;
}

export async function getEvidenceOriginalObject(asset: EvidenceAsset) {
  if (asset.state === "deleted") return null;
  return (await requireBuckets().originals.get(asset.originalKey)) ?? null;
}

async function writeAudit(
  database: D1Database,
  targetId: string,
  action: string,
  actor: string,
  detail: string,
) {
  await database
    .prepare(
      `INSERT INTO audit_logs
      (report_id, action, actor, created_at, detail) VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(targetId, action, actor, new Date().toISOString(), detail)
    .run();
}

export async function auditEvidenceAccess(
  asset: EvidenceAsset,
  action: string,
  actor: string,
  detail = "",
) {
  await writeAudit(
    requireDatabase(),
    asset.intakeId ?? asset.id,
    action,
    actor,
    detail || `Evidence asset ${asset.id}.`,
  );
}

async function assertReportEvidenceInvariant(
  database: D1Database,
  reportId: string,
  asset: EvidenceAsset,
  replacingEvidenceId: string | null,
) {
  const aggregate = await database
    .prepare(
      `SELECT COUNT(*) AS file_count,
        COALESCE(SUM(ea.original_size), 0) AS total_size
      FROM report_evidence re
      INNER JOIN evidence_assets ea ON ea.id = re.evidence_id
      WHERE re.report_id = ? AND re.evidence_id != ?
        AND (? IS NULL OR re.evidence_id != ?)`,
    )
    .bind(reportId, asset.id, replacingEvidenceId, replacingEvidenceId)
    .first<{ file_count: number; total_size: number }>();
  if (Number(aggregate?.file_count ?? 0) + 1 > EVIDENCE_LIMITS.maxFiles) {
    throw new EvidenceError(
      `A report may link at most ${EVIDENCE_LIMITS.maxFiles} evidence images.`,
      413,
      "too_many_evidence_files",
    );
  }
  if (Number(aggregate?.total_size ?? 0) + asset.originalSize > EVIDENCE_LIMITS.maxTotalSize) {
    throw new EvidenceError(
      "A report may link at most 20 MB of original evidence images.",
      413,
      "evidence_total_too_large",
    );
  }
}

function evidenceLinkConstraintError(error: unknown): EvidenceError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("report_evidence_file_limit")) {
    return new EvidenceError(
      `A report may link at most ${EVIDENCE_LIMITS.maxFiles} evidence images.`,
      413,
      "too_many_evidence_files",
    );
  }
  if (message.includes("report_evidence_size_limit")) {
    return new EvidenceError(
      "A report may link at most 20 MB of original evidence images.",
      413,
      "evidence_total_too_large",
    );
  }
  return null;
}

function evidenceDeletionConstraintError(error: unknown): EvidenceError | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("evidence_deletion_in_progress")) {
    return new EvidenceError(
      "Evidence deletion is already in progress.",
      409,
      "deletion_in_progress",
    );
  }
  if (message.includes("evidence_legal_hold_delete_forbidden")) {
    return new EvidenceError("Evidence under legal hold cannot be deleted.", 409, "legal_hold");
  }
  return null;
}

function deletionLeaseStartedAt(value: string | null) {
  if (!value?.startsWith(DELETION_LEASE_PREFIX)) return null;
  const timestamp = Number(value.slice(DELETION_LEASE_PREFIX.length).split(":", 1)[0]);
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

function createDeletionLease() {
  return `${DELETION_LEASE_PREFIX}${Date.now()}:${crypto.randomUUID()}`;
}

export async function moderateEvidenceAsset(
  id: string,
  input: {
    state?: EvidenceProcessingState;
    reportId?: string | null;
    caption?: string;
    displayOrder?: number;
    visiblePiiReviewed?: boolean;
    visiblePiiDetected?: boolean;
    legalHold?: boolean;
  },
  actor: string,
) {
  const database = requireDatabase();
  const current = await getEvidenceAsset(id);
  if (!current) return null;
  if (deletionLeaseStartedAt(current.deletedAt) !== null) {
    throw new EvidenceError(
      "Evidence deletion is already in progress.",
      409,
      "deletion_in_progress",
    );
  }
  if (current.state === "deleted") {
    throw new EvidenceError("Deleted evidence cannot be changed.", 409, "invalid_state");
  }

  // PII holds stick. A redacted replacement must take over the report link before publishing.
  const privacyWithheld = current.privacyWithheld || input.visiblePiiDetected === true;
  const nextState = input.visiblePiiDetected === true ? "withheld" : (input.state ?? current.state);
  if (nextState !== current.state && !TRANSITIONS[current.state].includes(nextState)) {
    throw new EvidenceError(
      `Evidence cannot transition from ${current.state} to ${nextState}.`,
      409,
      "invalid_state_transition",
    );
  }
  if (privacyWithheld && nextState === "public") {
    throw new EvidenceError(
      "This file contains visible personal information. Upload a separate redacted copy.",
      409,
      "redacted_replacement_required",
    );
  }

  const existingLinks = await getEvidenceLinks(id);
  let futureLinks = existingLinks;
  let transferredSourceLink: EvidenceLink | null = null;
  if (typeof input.reportId === "string") {
    const report = await database
      .prepare("SELECT id FROM reports WHERE id = ?")
      .bind(input.reportId)
      .first<{ id: string }>();
    if (!report) {
      throw new EvidenceError("The report does not exist.", 404, "report_not_found");
    }
    if (
      current.replacesEvidenceId &&
      !existingLinks.some((link) => link.reportId === input.reportId)
    ) {
      const sourceLinks = await getEvidenceLinks(current.replacesEvidenceId);
      transferredSourceLink = sourceLinks.find((link) => link.reportId === input.reportId) ?? null;
      if (!transferredSourceLink) {
        throw new EvidenceError(
          "A redacted file can only replace its withheld source on the same report.",
          409,
          "replacement_source_not_linked",
        );
      }
    }
    const replacement: EvidenceLink = {
      reportId: input.reportId,
      evidenceId: id,
      caption: input.caption?.trim() ?? transferredSourceLink?.caption ?? "",
      displayOrder: Math.max(0, Math.trunc(input.displayOrder ?? 0)),
      createdAt: new Date().toISOString(),
    };
    futureLinks = [
      ...existingLinks.filter((link) => link.reportId !== input.reportId),
      replacement,
    ];
  } else if (input.reportId === null) {
    futureLinks = [];
  } else if (input.caption !== undefined && existingLinks.length === 1) {
    futureLinks = [{ ...existingLinks[0], caption: input.caption.trim() }];
  }

  const visiblePiiReviewed = privacyWithheld
    ? true
    : (input.visiblePiiReviewed ?? current.visiblePiiReviewed);
  if (nextState === "public") {
    if (!visiblePiiReviewed) {
      throw new EvidenceError(
        "Review visible personal information before publishing this file.",
        409,
        "privacy_review_required",
      );
    }
    if (!futureLinks.length || futureLinks.some((link) => !link.caption.trim())) {
      throw new EvidenceError(
        "Public evidence needs a report link and caption.",
        409,
        "report_link_required",
      );
    }
    if (!current.derivativeKey || current.derivativeContentType !== "image/webp") {
      throw new EvidenceError(
        "This file has no sanitized copy to publish.",
        409,
        "derivative_required",
      );
    }
    const derivative = await getEvidenceDerivativeObject(current);
    if (!derivative || derivative.customMetadata?.sanitized !== "cloudflare-images-webp") {
      throw new EvidenceError(
        "The sanitized copy did not pass verification.",
        409,
        "derivative_required",
      );
    }
  }

  const reportsToValidate = new Set<string>();
  if (typeof input.reportId === "string") reportsToValidate.add(input.reportId);
  if (nextState === "public") {
    futureLinks.forEach((link) => reportsToValidate.add(link.reportId));
  }
  for (const reportId of reportsToValidate) {
    await assertReportEvidenceInvariant(
      database,
      reportId,
      current,
      transferredSourceLink?.reportId === reportId ? transferredSourceLink.evidenceId : null,
    );
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE evidence_assets SET state = ?, visible_pii_reviewed = ?,
        privacy_withheld = ?,
        legal_hold = ?, updated_at = ?,
        published_at = CASE WHEN ? = 'public' THEN COALESCE(published_at, ?) ELSE published_at END
        WHERE id = ?`,
      )
      .bind(
        nextState,
        visiblePiiReviewed ? 1 : 0,
        privacyWithheld ? 1 : 0,
        (input.legalHold ?? current.legalHold) ? 1 : 0,
        now,
        nextState,
        now,
        id,
      ),
  ];

  if (input.reportId === null) {
    statements.push(database.prepare("DELETE FROM report_evidence WHERE evidence_id = ?").bind(id));
  } else if (typeof input.reportId === "string") {
    const link = futureLinks.find((entry) => entry.reportId === input.reportId)!;
    if (transferredSourceLink) {
      statements.push(
        database
          .prepare("DELETE FROM report_evidence WHERE report_id = ? AND evidence_id = ?")
          .bind(transferredSourceLink.reportId, transferredSourceLink.evidenceId),
      );
    }
    statements.push(
      database
        .prepare(
          `INSERT INTO report_evidence
          (report_id, evidence_id, caption, display_order, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(report_id, evidence_id) DO UPDATE SET
            caption = excluded.caption, display_order = excluded.display_order`,
        )
        .bind(link.reportId, id, link.caption, link.displayOrder, link.createdAt),
    );
  } else if (input.caption !== undefined && existingLinks.length === 1) {
    statements.push(
      database
        .prepare(
          `UPDATE report_evidence SET caption = ?
          WHERE report_id = ? AND evidence_id = ?`,
        )
        .bind(input.caption.trim(), existingLinks[0].reportId, id),
    );
  }

  statements.push(
    database
      .prepare(
        `INSERT INTO audit_logs
        (report_id, action, actor, created_at, detail) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        futureLinks[0]?.reportId ?? current.intakeId ?? id,
        "evidence.moderated",
        actor,
        now,
        JSON.stringify({
          evidenceId: id,
          from: current.state,
          to: nextState,
          linkedReportId: input.reportId,
          visiblePiiReviewed,
          privacyWithheld,
          replacesEvidenceId: current.replacesEvidenceId,
          transferredSourceEvidenceId: transferredSourceLink?.evidenceId ?? null,
          legalHold: input.legalHold ?? current.legalHold,
        }),
      ),
  );
  try {
    await database.batch(statements);
  } catch (error) {
    const deletionError = evidenceDeletionConstraintError(error);
    if (deletionError) throw deletionError;
    const constraintError = evidenceLinkConstraintError(error);
    if (constraintError) throw constraintError;
    throw error;
  }
  return getEvidenceAsset(id);
}

export async function buildReportEvidenceLinkStatements(
  reportId: string,
  attachments: Array<{
    id: string;
    caption?: string;
    url?: string | null;
    redacted?: boolean;
  }>,
  actor = "system",
) {
  const database = requireDatabase();
  if (attachments.length > EVIDENCE_LIMITS.maxFiles) {
    throw new EvidenceError(
      `A report may link at most ${EVIDENCE_LIMITS.maxFiles} evidence images.`,
      413,
      "too_many_evidence_files",
    );
  }
  const liveAttachments: typeof attachments = [];
  const liveIds = new Set<string>();
  let totalSize = 0;
  for (const attachment of attachments) {
    const exists = await database
      .prepare(
        `SELECT id, original_size FROM evidence_assets
        WHERE id = ? AND state != 'deleted'`,
      )
      .bind(attachment.id)
      .first<{ id: string; original_size: number }>();

    if (!exists) {
      throw new EvidenceError(
        `Evidence attachment ${attachment.id} is missing or deleted.`,
        422,
        "invalid_evidence_reference",
      );
    }
    if (liveIds.has(attachment.id)) {
      throw new EvidenceError(
        `Evidence attachment ${attachment.id} was supplied more than once.`,
        400,
        "duplicate_evidence_reference",
      );
    }
    liveIds.add(attachment.id);
    liveAttachments.push(attachment);
    totalSize += Number(exists.original_size);
  }
  if (totalSize > EVIDENCE_LIMITS.maxTotalSize) {
    throw new EvidenceError(
      "A report may link at most 20 MB of original evidence images.",
      413,
      "evidence_total_too_large",
    );
  }
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    database.prepare("DELETE FROM report_evidence WHERE report_id = ?").bind(reportId),
  ];
  liveAttachments.forEach((attachment, index) => {
    statements.push(
      database
        .prepare(
          `INSERT INTO report_evidence
          (report_id, evidence_id, caption, display_order, created_at)
          VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(reportId, attachment.id, attachment.caption?.trim() ?? "", index, now),
    );
  });
  statements.push(
    database
      .prepare(
        `INSERT INTO audit_logs
        (report_id, action, actor, created_at, detail) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        reportId,
        "evidence.links_synced",
        actor,
        now,
        JSON.stringify({ evidenceIds: [...liveIds] }),
      ),
  );
  return statements;
}

export async function syncReportEvidenceLinks(
  reportId: string,
  attachments: Array<{ id: string; caption?: string }>,
  actor = "system",
) {
  const database = requireDatabase();
  const statements = await buildReportEvidenceLinkStatements(reportId, attachments, actor);
  await database.batch(statements);
}

export async function deleteEvidenceAsset(id: string, actor: string) {
  const database = requireDatabase();
  const initial = await getEvidenceAsset(id);
  if (!initial) return false;
  if (initial.state === "deleted") return true;
  if (initial.legalHold) {
    throw new EvidenceError("Evidence under legal hold cannot be deleted.", 409, "legal_hold");
  }
  const storage = requireBuckets();

  // deleted_at doubles as the deletion lease until the live R2 objects are gone.
  const nowMs = Date.now();
  const lease = createDeletionLease();
  const existingLeaseStartedAt = deletionLeaseStartedAt(initial.deletedAt);
  let claimed: EvidenceAssetRow | null = null;
  if (existingLeaseStartedAt === null) {
    claimed = await database
      .prepare(
        `UPDATE evidence_assets
        SET state = 'withheld', deleted_at = ?, updated_at = ?
        WHERE id = ? AND legal_hold = 0 AND deleted_at IS NULL AND state != 'deleted'
        RETURNING *`,
      )
      .bind(lease, new Date(nowMs).toISOString(), id)
      .first<EvidenceAssetRow>();
  } else if (nowMs - existingLeaseStartedAt >= DELETION_LEASE_TIMEOUT_MS) {
    claimed = await database
      .prepare(
        `UPDATE evidence_assets
        SET state = 'withheld', deleted_at = ?, updated_at = ?
        WHERE id = ? AND legal_hold = 0 AND deleted_at = ? AND state = 'withheld'
        RETURNING *`,
      )
      .bind(lease, new Date(nowMs).toISOString(), id, initial.deletedAt)
      .first<EvidenceAssetRow>();
  } else {
    throw new EvidenceError(
      "Evidence deletion is already in progress.",
      409,
      "deletion_in_progress",
    );
  }

  if (!claimed) {
    const latest = await getEvidenceAsset(id);
    if (!latest) return false;
    if (latest.state === "deleted") return true;
    if (latest.legalHold) {
      throw new EvidenceError("Evidence under legal hold cannot be deleted.", 409, "legal_hold");
    }
    throw new EvidenceError(
      "Evidence changed while deletion was starting; retry the operation.",
      409,
      "deletion_conflict",
    );
  }

  const asset = fromRow(claimed);
  let storageDeletionFailed = false;
  try {
    const deletions = await Promise.allSettled([
      storage.originals.delete(asset.originalKey),
      asset.derivativeKey ? storage.derivatives.delete(asset.derivativeKey) : Promise.resolve(),
    ]);
    storageDeletionFailed = deletions.some((result) => result.status === "rejected");
  } catch {
    storageDeletionFailed = true;
  }
  if (storageDeletionFailed) {
    await database
      .prepare(
        `UPDATE evidence_assets SET deleted_at = NULL, updated_at = ?
        WHERE id = ? AND legal_hold = 0 AND state = 'withheld' AND deleted_at = ?`,
      )
      .bind(new Date().toISOString(), id, lease)
      .run();
    throw new EvidenceError(
      "Some evidence files could not be deleted. Try again before closing the record.",
      503,
      "storage_delete_failed",
    );
  }

  const now = new Date().toISOString();
  await database.batch([
    database
      .prepare(
        `UPDATE evidence_assets SET state = 'deleted', derivative_key = NULL,
        deleted_at = ?, updated_at = ?
        WHERE id = ? AND legal_hold = 0 AND state = 'withheld' AND deleted_at = ?`,
      )
      .bind(now, now, id, lease),
    database
      .prepare(
        `DELETE FROM report_evidence WHERE evidence_id = ? AND EXISTS (
        SELECT 1 FROM evidence_assets
        WHERE id = ? AND state = 'deleted' AND legal_hold = 0 AND deleted_at = ?
      )`,
      )
      .bind(id, id, now),
    database
      .prepare(
        `INSERT INTO audit_logs
        (report_id, action, actor, created_at, detail)
        SELECT ?, ?, ?, ?, ? WHERE EXISTS (
          SELECT 1 FROM evidence_assets
          WHERE id = ? AND state = 'deleted' AND legal_hold = 0 AND deleted_at = ?
        )`,
      )
      .bind(
        asset.intakeId ?? id,
        "evidence.deleted",
        actor,
        now,
        `Evidence asset ${id} was deleted; its backup remains subject to the retention policy.`,
        id,
        now,
      ),
  ]);

  const finalized = await getEvidenceAsset(id);
  if (finalized?.state !== "deleted") {
    throw new EvidenceError(
      "Evidence deletion could not finish. Try again.",
      409,
      "deletion_conflict",
    );
  }
  return true;
}
