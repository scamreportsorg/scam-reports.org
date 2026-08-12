export type EvidenceQueueItem = {
  id: string;
  state: "uploading" | "private_ready" | "public" | "withheld" | "failed" | "deleted";
  originalFilename: string;
  originalSize: number;
  visiblePiiReviewed: boolean;
  privacyWithheld: boolean;
  replacesEvidenceId: string | null;
  legalHold: boolean;
  processingError: string;
  createdAt: string;
  previewUrl: string;
  originalDownloadUrl: string;
  links: Array<{ reportId: string; caption: string; displayOrder: number }>;
};

export type QueuePagination = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};
