export const REPORT_STATUSES = ["Reported", "Under Review", "Confirmed", "Rejected"] as const;

export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_CATEGORIES = [
  "Cheating",
  "Cheat Sales",
  "Marketplace Scam",
  "Malware / Unsafe Files",
  "Impersonation",
  "Ban Evasion",
  "Other",
] as const;

export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REVIEW_STATUSES = ["Pending", "Approved", "Rejected"] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_RELATIONSHIPS = [
  "Buyer",
  "Player",
  "Server Member",
  "Researcher",
  "Other",
] as const;

export type ReviewRelationship = (typeof REVIEW_RELATIONSHIPS)[number];

export type EvidenceAttachment = {
  id: string;
  filename: string;
  url: string | null;
  caption: string;
  uploadedAt: string;
  fileSize: number;
  contentType: string;
  redacted: boolean;
};

export type StatusHistoryEntry = {
  status: ReportStatus;
  date: string;
  note: string;
  moderator: string;
};

export type ScamReport = {
  id: string;
  username: string;
  discordId: string;
  game: string;
  category: ReportCategory;
  reason: string;
  description: string;
  status: ReportStatus;
  notes: string;
  moderatorNotes: string;
  evidence: EvidenceAttachment[];
  statusHistory: StatusHistoryEntry[];
  dateAdded: string;
  updatedAt: string;
  views: number;
  isPublished: boolean;
  mergedIntoReportId?: string | null;
};

export type ReportInput = Omit<ScamReport, "views"> & { views?: number };

export type AuditLog = {
  id: number;
  reportId: string;
  action: string;
  actor: string;
  actorVerified: boolean;
  createdAt: string;
};

export type CommunityReview = {
  id: string;
  reportId: string;
  displayName: string;
  rating: number;
  relationship: ReviewRelationship;
  title: string;
  body: string;
  status: ReviewStatus;
  moderatorNotes: string;
  createdAt: string;
  updatedAt: string;
  reviewerVerified: boolean;
  authorHandle?: string | null;
  authorAccountId?: string | null;
  authorActivity?: CommunityActivity | null;
};

export type ReviewSubmission = Pick<
  CommunityReview,
  "reportId" | "displayName" | "rating" | "relationship" | "title" | "body"
>;

export const INTAKE_STATUSES = ["Pending", "Needs Info", "Accepted", "Rejected"] as const;

export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

export const APPEAL_REQUEST_TYPES = [
  "Correction",
  "Identity dispute",
  "Right of reply",
  "Evidence/privacy request",
  "Status review",
] as const;

export type AppealRequestType = (typeof APPEAL_REQUEST_TYPES)[number];

export const APPEAL_RELATIONSHIPS = [
  "Named person",
  "Server owner / staff",
  "Authorized representative",
  "Reporter",
  "Other",
] as const;

export type AppealRelationship = (typeof APPEAL_RELATIONSHIPS)[number];

export type QuarantineAttachment = {
  id: string;
  filename: string;
  storageKey: string;
  adminUrl: string;
  uploadedAt: string;
  fileSize: number;
  contentType: string;
};

export type ReportSubmissionRecord = {
  id: string;
  relatedReportId: string | null;
  submitterName: string;
  contactEmail: string;
  username: string;
  discordId: string;
  game: string;
  category: ReportCategory;
  reason: string;
  description: string;
  evidence: QuarantineAttachment[];
  status: IntakeStatus;
  moderatorNotes: string;
  submitterVerified: boolean;
  resultReportId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AppealRecord = {
  id: string;
  reportId: string;
  requestType: AppealRequestType;
  submitterName: string;
  relationship: AppealRelationship;
  contactEmail: string;
  body: string;
  evidence: QuarantineAttachment[];
  status: IntakeStatus;
  moderatorNotes: string;
  publicResolution: string;
  submitterVerified: boolean;
  createdAt: string;
  updatedAt: string;
};

export const COMMENT_STATUSES = ["Pending", "Approved", "Rejected"] as const;

export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export type CommunityComment = {
  id: string;
  reportId: string;
  parentId: string | null;
  parentDisplayName?: string | null;
  displayName: string;
  body: string;
  status: CommentStatus;
  moderatorNotes: string;
  reviewerVerified: boolean;
  authorHandle?: string | null;
  authorAccountId?: string | null;
  authorActivity?: CommunityActivity | null;
  createdAt: string;
  updatedAt: string;
};

export type CommunityRankName =
  | "Newcomer"
  | "Contributor"
  | "Regular"
  | "Senior Contributor"
  | "Veteran"
  | "Community Guardian";

export type CommunityRank = {
  level: number;
  name: CommunityRankName;
  minimumPoints: number;
  nextName: CommunityRankName | null;
  nextMinimumPoints: number | null;
  pointsToNext: number;
  progressPercent: number;
};

export type CommunityActivity = {
  approvedReportCount: number;
  approvedReviewCount: number;
  approvedCommentCount: number;
  approvedContributionCount: number;
  contributionPoints: number;
  rank: CommunityRank;
};

export type AccountRole = "member" | "moderator" | "admin";
export type AccountStatus = "active" | "suspended" | "deleted";

export type PublicAccount = {
  id: string;
  handle: string;
  role: AccountRole;
  joinedAt: string;
  approvedReviewCount: number;
  approvedCommentCount: number;
  verifiedAccount: boolean;
};

export type ReportSort = "newest" | "oldest" | "evidence" | "risk" | "reputation" | "reviews";

export type ReportListItem = Pick<
  ScamReport,
  | "id"
  | "username"
  | "discordId"
  | "game"
  | "category"
  | "reason"
  | "status"
  | "dateAdded"
  | "updatedAt"
> & {
  evidenceCount: number;
  reputation: {
    score: number;
    label: string;
    tone: "critical" | "poor" | "mixed" | "good" | "trusted";
    averageRating: number | null;
    reviewCount: number;
    confidence: "Low" | "Medium" | "High";
  };
};

export type ReportDirectoryQuery = {
  q?: string;
  status?: ReportStatus | "";
  category?: ReportCategory | "";
  sort?: ReportSort;
  page?: number;
  pageSize?: number;
};

export type PaginatedResult<T> = {
  items: T[];
  pagination: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
};

export type EvidenceProcessingState =
  | "uploading"
  | "private_ready"
  | "public"
  | "withheld"
  | "failed"
  | "deleted";

export type PublicEvidenceAsset = {
  id: string;
  url: string;
  caption: string;
  width: number;
  height: number;
  contentType: string;
  fileSize: number;
  uploadedAt: string;
};
