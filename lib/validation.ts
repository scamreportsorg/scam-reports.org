import { z } from "zod";
import {
  REPORT_CATEGORIES,
  REPORT_STATUSES,
  APPEAL_RELATIONSHIPS,
  APPEAL_REQUEST_TYPES,
  INTAKE_STATUSES,
  REVIEW_RELATIONSHIPS,
} from "./types";
import { EVIDENCE_LIMITS } from "./evidence-validation";

export const evidenceSchema = z.object({
  id: z.string().min(1).max(100),
  filename: z.string().min(1).max(180),
  url: z.string().max(2048).nullable(),
  caption: z.string().max(500),
  uploadedAt: z.string().min(1).max(64),
  fileSize: z.number().int().nonnegative(),
  contentType: z.string().min(1).max(128),
  redacted: z.boolean(),
});

export const statusHistorySchema = z.object({
  status: z.enum(REPORT_STATUSES),
  date: z.string().min(1).max(64),
  note: z.string().max(1000),
  moderator: z.string().max(120),
});

export const reportSchema = z.object({
  id: z.string().regex(/^SR-[A-Z0-9-]{4,40}$/),
  username: z.string().trim().min(2).max(80),
  discordId: z
    .string()
    .trim()
    .regex(/^\d{17,20}$/),
  game: z.string().trim().min(2).max(80),
  category: z.enum(REPORT_CATEGORIES),
  reason: z.string().trim().min(10).max(500),
  description: z.string().trim().min(20).max(8000),
  status: z.enum(REPORT_STATUSES),
  notes: z.string().trim().max(3000),
  moderatorNotes: z.string().trim().max(3000),
  evidence: z.array(evidenceSchema).max(EVIDENCE_LIMITS.maxFiles),
  statusHistory: z.array(statusHistorySchema).max(50),
  dateAdded: z.string().min(1).max(64),
  updatedAt: z.string().min(1).max(64),
  views: z.number().int().nonnegative().optional(),
  isPublished: z.boolean(),
});

export type ValidatedReportInput = z.infer<typeof reportSchema>;

export const reviewSubmissionSchema = z.object({
  reportId: z.string().regex(/^SR-[A-Z0-9-]{4,40}$/),
  displayName: z.string().trim().min(2).max(50),
  rating: z.number().int().min(1).max(5),
  relationship: z.enum(REVIEW_RELATIONSHIPS),
  title: z.string().trim().min(5).max(100),
  body: z.string().trim().min(30).max(2000),
  website: z.string().max(0).optional().default(""),
});

export const reviewModerationSchema = z.object({
  id: z.string().regex(/^REV-[A-Z0-9-]{4,40}$/),
  status: z.enum(["Approved", "Rejected"]),
  moderatorNotes: z.string().trim().max(1000).default(""),
});

const optionalEmailSchema = z.union([z.literal(""), z.string().trim().email().max(200)]);

const optionalReportIdSchema = z.union([z.literal(""), z.string().regex(/^SR-[A-Z0-9-]{4,40}$/)]);

export const reportSubmissionSchema = z.object({
  submitterName: z.string().trim().min(2).max(80),
  contactEmail: optionalEmailSchema,
  username: z.string().trim().min(2).max(80),
  discordId: z
    .string()
    .trim()
    .regex(/^\d{17,20}$/),
  game: z.string().trim().min(2).max(80),
  category: z.enum(REPORT_CATEGORIES),
  reason: z.string().trim().min(10).max(500),
  description: z.string().trim().min(40).max(8000),
  relatedReportId: optionalReportIdSchema.default(""),
  consent: z.literal("true"),
  website: z.string().max(0).default(""),
});

export const reportSubmissionModerationSchema = z.object({
  id: z.string().regex(/^SUB-[A-Z0-9-]{4,50}$/),
  status: z.enum(INTAKE_STATUSES),
  moderatorNotes: z.string().trim().max(2000).default(""),
  resultReportId: optionalReportIdSchema.default(""),
});

export const appealSubmissionSchema = z.object({
  reportId: z.string().regex(/^SR-[A-Z0-9-]{4,40}$/),
  requestType: z.enum(APPEAL_REQUEST_TYPES),
  submitterName: z.string().trim().min(2).max(80),
  relationship: z.enum(APPEAL_RELATIONSHIPS),
  contactEmail: optionalEmailSchema,
  body: z.string().trim().min(40).max(8000),
  consent: z.literal("true"),
  website: z.string().max(0).default(""),
});

export const appealModerationSchema = z.object({
  id: z.string().regex(/^APL-[A-Z0-9-]{4,50}$/),
  status: z.enum(INTAKE_STATUSES),
  moderatorNotes: z.string().trim().max(2000).default(""),
  publicResolution: z.string().trim().max(3000).default(""),
});

export const commentSubmissionSchema = z.object({
  reportId: z.string().regex(/^SR-[A-Z0-9-]{4,40}$/),
  parentId: z
    .union([z.literal(""), z.string().regex(/^COM-[A-Z0-9-]{4,50}$/)])
    .nullable()
    .default(null),
  displayName: z.string().trim().min(2).max(50),
  body: z.string().trim().min(20).max(2000),
  website: z.string().max(0).default(""),
});

export const commentModerationSchema = z.object({
  id: z.string().regex(/^COM-[A-Z0-9-]{4,50}$/),
  status: z.enum(["Approved", "Rejected"]),
  moderatorNotes: z.string().trim().max(1000).default(""),
});
