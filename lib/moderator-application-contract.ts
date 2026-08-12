export const MODERATOR_APPLICATION_STATUSES = [
  "Pending",
  "Under Review",
  "Accepted",
  "Rejected",
  "Withdrawn",
  "Expired",
] as const;

export type ModeratorApplicationStatus = (typeof MODERATOR_APPLICATION_STATUSES)[number];

export type ApplicantModeratorApplication = {
  id: string;
  motivation: string;
  experience: string;
  timezone: string;
  availability: string;
  languages: string;
  conflicts: string;
  confirmationAccepted: boolean;
  status: ModeratorApplicationStatus;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  withdrawnAt: string | null;
  purgeAfter: string | null;
  answersErasedAt: string | null;
};

export type AdminModeratorApplication = ApplicantModeratorApplication & {
  accountId: string;
  applicantHandle: string;
  applicantRole: "member" | "moderator" | "admin";
  applicantStatus: "active" | "suspended";
  linkedProviders: { discord: boolean; email: boolean };
  moderatorNotes: string;
  reviewedByAccountId: string | null;
  reviewerHandle: string | null;
};
