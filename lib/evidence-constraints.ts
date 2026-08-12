export const EVIDENCE_ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export const EVIDENCE_ACCEPT = EVIDENCE_ACCEPTED_TYPES.join(",");

export const EVIDENCE_UPLOAD_LIMITS = {
  maxFiles: 5,
  maxFileSize: 5 * 1024 * 1024,
  maxTotalSize: 20 * 1024 * 1024,
} as const;

export type EvidenceFileDescriptor = {
  name: string;
  size: number;
  type: string;
};

const acceptedTypes = new Set<string>(EVIDENCE_ACCEPTED_TYPES);

export function validateEvidenceFiles(files: readonly EvidenceFileDescriptor[]) {
  if (files.length > EVIDENCE_UPLOAD_LIMITS.maxFiles) {
    return `Select no more than ${EVIDENCE_UPLOAD_LIMITS.maxFiles} images.`;
  }

  const unsupported = files.find((file) => !acceptedTypes.has(file.type));
  if (unsupported) {
    return `${unsupported.name} is not a PNG, JPEG, or WebP image.`;
  }

  const oversized = files.find((file) => file.size > EVIDENCE_UPLOAD_LIMITS.maxFileSize);
  if (oversized) return `${oversized.name} is larger than 5 MB.`;

  const totalSize = files.reduce((total, file) => total + file.size, 0);
  if (totalSize > EVIDENCE_UPLOAD_LIMITS.maxTotalSize) {
    return "The selected files are larger than 20 MB in total.";
  }

  return "";
}
