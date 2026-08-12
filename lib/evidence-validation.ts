import { EVIDENCE_ACCEPTED_TYPES, EVIDENCE_UPLOAD_LIMITS } from "./evidence-constraints";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

export const EVIDENCE_LIMITS = {
  ...EVIDENCE_UPLOAD_LIMITS,
  maxPixels: 12_000_000,
  maxEdge: 4096,
  derivativeMaxEdge: 2560,
} as const;

export const EVIDENCE_CONTENT_TYPES = EVIDENCE_ACCEPTED_TYPES;

export type EvidenceContentType = (typeof EVIDENCE_CONTENT_TYPES)[number];

const ALLOWED_CONTENT_TYPES = new Set<string>(EVIDENCE_CONTENT_TYPES);

function chunkName(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length) return "";
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3],
  );
}

function uint32BigEndian(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return (
    bytes[offset] * 0x1000000 +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function uint32LittleEndian(bytes: Uint8Array, offset: number) {
  if (offset < 0 || offset + 4 > bytes.length) return null;
  return (
    bytes[offset] +
    (bytes[offset + 1] << 8) +
    (bytes[offset + 2] << 16) +
    bytes[offset + 3] * 0x1000000
  );
}

export function isAnimatedEvidence(bytes: Uint8Array, contentType: EvidenceContentType) {
  if (contentType === "image/png") {
    for (let offset = PNG_SIGNATURE.length; offset + 12 <= bytes.length; ) {
      const length = uint32BigEndian(bytes, offset);
      if (length === null || length > bytes.length - offset - 12) break;
      const type = chunkName(bytes, offset + 4);
      if (type === "acTL") return true;
      if (type === "IEND") break;
      offset += 12 + length;
    }
    return false;
  }

  if (contentType === "image/webp") {
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const type = chunkName(bytes, offset);
      const length = uint32LittleEndian(bytes, offset + 4);
      if (length === null || length > bytes.length - offset - 8) break;
      if (type === "ANIM" || type === "ANMF") return true;
      if (type === "VP8X" && length > 0 && (bytes[offset + 8] & 0x02) !== 0) {
        return true;
      }
      offset += 8 + length + (length % 2);
    }
  }
  return false;
}

export class EvidenceValidationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "EvidenceValidationError";
    this.status = status;
  }
}

export function normalizeEvidenceFilename(filename: string) {
  const cleaned = Array.from(filename.normalize("NFKC"))
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join("")
    .trim();
  return Array.from(cleaned || "evidence-image")
    .slice(0, 160)
    .join("");
}

export function sniffEvidenceContentType(bytes: Uint8Array): EvidenceContentType | null {
  if (
    bytes.length >= PNG_SIGNATURE.length &&
    PNG_SIGNATURE.every((value, index) => bytes[index] === value)
  ) {
    return "image/png";
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

export function validateEvidenceFiles(files: File[]) {
  if (files.length > EVIDENCE_LIMITS.maxFiles) {
    throw new EvidenceValidationError(
      `Upload no more than ${EVIDENCE_LIMITS.maxFiles} images.`,
      413,
    );
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > EVIDENCE_LIMITS.maxTotalSize) {
    throw new EvidenceValidationError("The combined upload must be 20 MB or smaller.", 413);
  }

  for (const file of files) {
    if (!ALLOWED_CONTENT_TYPES.has(file.type)) {
      throw new EvidenceValidationError(
        "Only PNG, JPEG, and WebP evidence images are accepted.",
        415,
      );
    }
    if (file.size > EVIDENCE_LIMITS.maxFileSize) {
      throw new EvidenceValidationError("Each evidence image must be 5 MB or smaller.", 413);
    }
  }
}

export async function readAndValidateEvidenceFile(file: File) {
  validateEvidenceFiles([file]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const detectedContentType = sniffEvidenceContentType(bytes);
  if (!detectedContentType || detectedContentType !== file.type) {
    throw new EvidenceValidationError(
      `The file signature for ${file.name || "this upload"} does not match its image type.`,
      415,
    );
  }
  if (isAnimatedEvidence(bytes, detectedContentType)) {
    throw new EvidenceValidationError(
      "Animated evidence images are not supported. Upload a static screenshot.",
      415,
    );
  }

  return { bytes, contentType: detectedContentType };
}

export function validateEvidenceDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new EvidenceValidationError("The image dimensions could not be verified.", 415);
  }
  if (
    width > EVIDENCE_LIMITS.maxEdge ||
    height > EVIDENCE_LIMITS.maxEdge ||
    width * height > EVIDENCE_LIMITS.maxPixels
  ) {
    throw new EvidenceValidationError(
      "Evidence images may be at most 4096 pixels per edge and 12 megapixels.",
      413,
    );
  }
}
