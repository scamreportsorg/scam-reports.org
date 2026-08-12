import { z } from "zod";

export const moderatorApplicationSubmissionSchema = z.object({
  motivation: z.string().trim().min(80).max(4000),
  experience: z.string().trim().min(50).max(3000),
  timezone: z.string().trim().min(2).max(80),
  availability: z.string().trim().min(20).max(1000),
  languages: z.string().trim().min(2).max(300),
  conflicts: z.string().trim().min(2).max(2000),
  confirmationAccepted: z.literal(true),
  website: z.string().max(0).default(""),
});

export const moderatorApplicationWithdrawalSchema = z.object({
  id: z.string().regex(/^MODAPP-[A-Z0-9]{16,32}$/u),
  csrfToken: z.string().min(1).max(200),
});

export const moderatorApplicationModerationSchema = z.object({
  id: z.string().regex(/^MODAPP-[A-Z0-9]{16,32}$/u),
  status: z.enum(["Under Review", "Accepted", "Rejected"]),
  moderatorNotes: z.string().trim().max(3000).default(""),
  csrfToken: z.string().min(1).max(200).optional(),
});

export type ModeratorApplicationSubmissionInput = z.infer<
  typeof moderatorApplicationSubmissionSchema
>;
