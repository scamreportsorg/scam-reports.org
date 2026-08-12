"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  AppealRecord,
  AuditLog,
  CommunityComment,
  CommunityReview,
  IntakeStatus,
  QuarantineAttachment,
  ReportSubmissionRecord,
  ReviewStatus,
  ScamReport,
} from "@/lib/types";
import { AdminSummary } from "./admin/admin-summary";
import { AdminActionDialog, useAdminActionDialog } from "./admin/admin-action-dialog";
import { AuditQueue } from "./admin/audit-queue";
import { AppealQueue, CommentQueue, ReportSubmissionQueue } from "./admin/community-intake-queues";
import { EvidenceQueue } from "./admin/evidence-queue";
import type { EvidenceQueueItem, QueuePagination } from "./admin/moderation-queue-types";
import { ReportEditor } from "./admin/report-editor";
import { ReportQueue } from "./admin/report-queue";
import { ReviewQueue } from "./admin/review-queue";

type ModeratorSession = {
  id: string;
  handle: string;
  role: "member" | "moderator" | "admin";
};

type AdminQueue =
  | "reports"
  | "evidence"
  | "reviews"
  | "submissions"
  | "appeals"
  | "comments"
  | "audit";

function AdminQueueDisclosure({
  label,
  count,
  initiallyOpen,
  children,
}: {
  label: string;
  count: string;
  initiallyOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      className="admin-queue-disclosure"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span>{label}</span>
        <strong>{count}</strong>
      </summary>
      {children}
    </details>
  );
}

function newReportId() {
  return `SR-${new Date().getUTCFullYear()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}

function blankReport(moderatorHandle: string): ScamReport {
  const timestamp = new Date().toISOString();
  return {
    id: newReportId(),
    username: "",
    discordId: "",
    game: "",
    category: "Cheating",
    reason: "",
    description: "",
    status: "Reported",
    notes: "No final decision yet.",
    moderatorNotes: "",
    evidence: [],
    statusHistory: [
      {
        status: "Reported",
        date: timestamp,
        note: "Draft record created.",
        moderator: moderatorHandle,
      },
    ],
    dateAdded: timestamp,
    updatedAt: timestamp,
    views: 0,
    isPublished: false,
  };
}

export function AdminDashboard({ initialCsrfToken }: { initialCsrfToken: string }) {
  const [csrfToken, setCsrfToken] = useState(initialCsrfToken);
  const [session, setSession] = useState<ModeratorSession | null>(null);
  const [reports, setReports] = useState<ScamReport[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [reviews, setReviews] = useState<CommunityReview[]>([]);
  const [reportSubmissions, setReportSubmissions] = useState<ReportSubmissionRecord[]>([]);
  const [appeals, setAppeals] = useState<AppealRecord[]>([]);
  const [comments, setComments] = useState<CommunityComment[]>([]);
  const [evidenceQueue, setEvidenceQueue] = useState<EvidenceQueueItem[]>([]);
  const [reportPagination, setReportPagination] = useState<QueuePagination>({
    page: 1,
    pageSize: 100,
    totalItems: 0,
    totalPages: 1,
  });
  const [evidencePagination, setEvidencePagination] = useState<QueuePagination>({
    page: 1,
    pageSize: 25,
    totalItems: 0,
    totalPages: 1,
  });
  const [reviewPagination, setReviewPagination] = useState<QueuePagination>({
    page: 1,
    pageSize: 25,
    totalItems: 0,
    totalPages: 1,
  });
  const [submissionPagination, setSubmissionPagination] = useState<QueuePagination>({
    page: 1,
    pageSize: 25,
    totalItems: 0,
    totalPages: 1,
  });
  const [appealPagination, setAppealPagination] = useState<QueuePagination>({
    page: 1,
    pageSize: 25,
    totalItems: 0,
    totalPages: 1,
  });
  const [commentPagination, setCommentPagination] = useState<QueuePagination>({
    page: 1,
    pageSize: 25,
    totalItems: 0,
    totalPages: 1,
  });
  const [auditPagination, setAuditPagination] = useState<QueuePagination>({
    page: 1,
    pageSize: 25,
    totalItems: 0,
    totalPages: 1,
  });
  const [accessChecked, setAccessChecked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ScamReport | null>(null);
  const [draftSourceSubmissionId, setDraftSourceSubmissionId] = useState<string | null>(null);
  const currentQueuePages = useRef({
    reports: 1,
    evidence: 1,
    reviews: 1,
    submissions: 1,
    appeals: 1,
    comments: 1,
    audit: 1,
  });
  const actionDialog = useAdminActionDialog();

  function mutationHeaders(json = false): HeadersInit {
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      "x-csrf-token": csrfToken,
    };
  }

  const loadData = useCallback(async (pages: Partial<Record<AdminQueue, number>> = {}) => {
    const reportPage = pages.reports ?? currentQueuePages.current.reports;
    const evidencePage = pages.evidence ?? currentQueuePages.current.evidence;
    const reviewPage = pages.reviews ?? currentQueuePages.current.reviews;
    const submissionPage = pages.submissions ?? currentQueuePages.current.submissions;
    const appealPage = pages.appeals ?? currentQueuePages.current.appeals;
    const commentPage = pages.comments ?? currentQueuePages.current.comments;
    const auditPage = pages.audit ?? currentQueuePages.current.audit;
    setLoading(true);
    setError("");
    try {
      const sessionResponse = await fetch("/api/auth/session", { cache: "no-store" });
      const sessionPayload = (await sessionResponse.json()) as {
        authenticated: boolean;
        account?: ModeratorSession;
        csrfToken?: string;
      };
      if (
        !sessionResponse.ok ||
        !sessionPayload.authenticated ||
        !sessionPayload.account ||
        sessionPayload.account.role === "member"
      ) {
        throw new Error("Use a moderator account to open this panel.");
      }
      if (sessionPayload.csrfToken) setCsrfToken(sessionPayload.csrfToken);
      setSession(sessionPayload.account);
      const [
        reportResponse,
        reviewResponse,
        submissionResponse,
        appealResponse,
        commentResponse,
        evidenceResponse,
        auditResponse,
      ] = await Promise.all([
        fetch(`/api/admin/reports?page=${reportPage}&pageSize=100`, { cache: "no-store" }),
        fetch(`/api/admin/reviews?page=${reviewPage}`, {
          cache: "no-store",
        }),
        fetch(`/api/admin/report-submissions?page=${submissionPage}`, {
          cache: "no-store",
        }),
        fetch(`/api/admin/appeals?page=${appealPage}`, {
          cache: "no-store",
        }),
        fetch(`/api/admin/comments?page=${commentPage}`, {
          cache: "no-store",
        }),
        fetch(`/api/admin/evidence?page=${evidencePage}&pageSize=25`, { cache: "no-store" }),
        fetch(`/api/admin/audit?page=${auditPage}&pageSize=25`, { cache: "no-store" }),
      ]);
      const responses = [
        reportResponse,
        reviewResponse,
        submissionResponse,
        appealResponse,
        commentResponse,
        evidenceResponse,
        auditResponse,
      ];
      if (responses.some((response) => response.status === 401 || response.status === 403)) {
        throw new Error("Your moderator session is missing, expired, or lacks permission.");
      }
      if (responses.some((response) => !response.ok)) {
        throw new Error("Some moderation queues didn't load.");
      }
      const payload = (await reportResponse.json()) as {
        items: ScamReport[];
        pagination: QueuePagination;
      };
      const reviewPayload = (await reviewResponse.json()) as {
        reviews: CommunityReview[];
        pagination: QueuePagination;
      };
      const submissionPayload = (await submissionResponse.json()) as {
        submissions: ReportSubmissionRecord[];
        pagination: QueuePagination;
      };
      const appealPayload = (await appealResponse.json()) as {
        appeals: AppealRecord[];
        pagination: QueuePagination;
      };
      const commentPayload = (await commentResponse.json()) as {
        comments: CommunityComment[];
        pagination: QueuePagination;
      };
      const evidencePayload = (await evidenceResponse.json()) as {
        items: EvidenceQueueItem[];
        pagination: QueuePagination;
      };
      const auditPayload = (await auditResponse.json()) as {
        items: AuditLog[];
        pagination: QueuePagination;
      };
      setReports(payload.items);
      setAuditLogs(auditPayload.items);
      setReviews(reviewPayload.reviews);
      setReportSubmissions(submissionPayload.submissions);
      setAppeals(appealPayload.appeals);
      setComments(commentPayload.comments);
      setEvidenceQueue(evidencePayload.items);
      setReportPagination(payload.pagination);
      setEvidencePagination(evidencePayload.pagination);
      setReviewPagination(reviewPayload.pagination);
      setSubmissionPagination(submissionPayload.pagination);
      setAppealPagination(appealPayload.pagination);
      setCommentPagination(commentPayload.pagination);
      setAuditPagination(auditPayload.pagination);
      currentQueuePages.current = {
        reports: payload.pagination.page,
        evidence: evidencePayload.pagination.page,
        reviews: reviewPayload.pagination.page,
        submissions: submissionPayload.pagination.page,
        appeals: appealPayload.pagination.page,
        comments: commentPayload.pagination.page,
        audit: auditPayload.pagination.page,
      };
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Couldn't open the moderation queue.",
      );
    } finally {
      setAccessChecked(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void loadData());
  }, [loadData]);

  async function deleteReport(report: ScamReport) {
    const confirmed = await actionDialog.confirm({
      eyebrow: "Permanent action",
      title: "Delete report",
      description: `Remove ${report.id} (${report.username}) permanently?`,
      details: ["The delete is permanent and will be logged."],
      confirmLabel: "Delete report",
      tone: "danger",
    });
    if (!confirmed) return;
    setLoading(true);
    setError("");
    const response = await fetch(`/api/admin/reports?id=${encodeURIComponent(report.id)}`, {
      method: "DELETE",
      headers: mutationHeaders(),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "Couldn't delete the report.");
      setLoading(false);
      return;
    }
    setMessage(`${report.id} was removed.`);
    setEditing(null);
    await loadData();
  }

  async function moderateCommunityReview(
    review: CommunityReview,
    status: Extract<ReviewStatus, "Approved" | "Rejected">,
  ) {
    const values = await actionDialog.collect({
      eyebrow: "Review moderation",
      title: `${status} community review`,
      description: `${review.id} by ${review.displayName}. Any note stays private.`,
      confirmLabel: status,
      tone: status === "Rejected" ? "danger" : "standard",
      fields: [
        {
          name: "moderatorNotes",
          label: "Private moderator note",
          initialValue: review.moderatorNotes,
          multiline: true,
          help: "Optional. Staff only.",
        },
      ],
    });
    if (!values) return;
    const moderatorNotes = values.moderatorNotes;
    setLoading(true);
    setError("");
    const response = await fetch("/api/admin/reviews", {
      method: "PATCH",
      headers: mutationHeaders(true),
      body: JSON.stringify({ id: review.id, status, moderatorNotes }),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(payload.error ?? "Couldn't update the review.");
      setLoading(false);
      return;
    }
    setMessage(`${review.id} was ${status.toLowerCase()}.`);
    await loadData();
  }

  async function deleteCommunityReview(review: CommunityReview) {
    const confirmed = await actionDialog.confirm({
      eyebrow: "Permanent action",
      title: "Delete community review",
      description: `Remove ${review.id} by ${review.displayName} permanently?`,
      confirmLabel: "Delete review",
      tone: "danger",
    });
    if (!confirmed) return;
    setLoading(true);
    setError("");
    const response = await fetch(`/api/admin/reviews?id=${encodeURIComponent(review.id)}`, {
      method: "DELETE",
      headers: mutationHeaders(),
    });
    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      setError(payload.error ?? "Couldn't delete the review.");
      setLoading(false);
      return;
    }
    setMessage(`${review.id} was removed.`);
    await loadData();
  }

  async function openPrivateEvidence(attachment: QuarantineAttachment) {
    setError("");
    try {
      const response = await fetch(attachment.adminUrl, { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Couldn't open ${attachment.filename}.`);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = attachment.filename;
      anchor.rel = "noopener";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (evidenceError) {
      setError(
        evidenceError instanceof Error ? evidenceError.message : "Couldn't open private evidence.",
      );
    }
  }

  async function moderateReportSubmission(
    submission: ReportSubmissionRecord,
    status: IntakeStatus,
  ) {
    const values = await actionDialog.collect({
      eyebrow: "Report intake",
      title: `Mark submission ${status}`,
      description: `Update ${submission.id}. Any note stays private.`,
      confirmLabel: `Mark ${status}`,
      tone: status === "Rejected" ? "danger" : "standard",
      fields: [
        {
          name: "moderatorNotes",
          label: "Private moderator note",
          initialValue: submission.moderatorNotes,
          multiline: true,
          help: "Optional. Leave enough context for the next moderator.",
        },
      ],
    });
    if (!values) return;
    const moderatorNotes = values.moderatorNotes;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/report-submissions", {
        method: "PATCH",
        headers: mutationHeaders(true),
        body: JSON.stringify({
          id: submission.id,
          status,
          moderatorNotes,
          resultReportId: submission.resultReportId ?? "",
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't update the report submission.");
      setMessage(`${submission.id} was marked ${status}.`);
      await loadData();
    } catch (moderationError) {
      setError(
        moderationError instanceof Error
          ? moderationError.message
          : "Couldn't update the report submission.",
      );
      setLoading(false);
    }
  }

  async function deleteReportSubmission(submission: ReportSubmissionRecord) {
    const confirmed = await actionDialog.confirm({
      eyebrow: "Permanent action",
      title: "Delete intake submission",
      description: `Remove ${submission.id} and its private evidence permanently?`,
      details: ["Quarantined files attached to this submission are included."],
      confirmLabel: "Delete submission",
      tone: "danger",
    });
    if (!confirmed) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/report-submissions?id=${encodeURIComponent(submission.id)}`,
        {
          method: "DELETE",
          headers: mutationHeaders(),
        },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't delete the report submission.");
      setMessage(`${submission.id} and its quarantine files were removed.`);
      await loadData();
    } catch (deletionError) {
      setError(
        deletionError instanceof Error
          ? deletionError.message
          : "Couldn't delete the report submission.",
      );
      setLoading(false);
    }
  }

  function createDraftFromSubmission(submission: ReportSubmissionRecord) {
    const timestamp = new Date().toISOString();
    const sourceDetails = [
      `Source intake: ${submission.id}`,
      submission.submitterName ? `Submitter: ${submission.submitterName}` : "",
      submission.contactEmail ? `Contact: ${submission.contactEmail}` : "",
      submission.relatedReportId ? `Related report: ${submission.relatedReportId}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    setDraftSourceSubmissionId(submission.id);
    setEditing({
      id: newReportId(),
      username: submission.username,
      discordId: submission.discordId,
      game: submission.game,
      category: submission.category,
      reason: submission.reason,
      description: submission.description,
      status: "Reported",
      notes: "No final decision yet. Moderators are still checking the submitted evidence.",
      moderatorNotes: sourceDetails,
      evidence: [],
      statusHistory: [
        {
          status: "Reported",
          date: timestamp,
          note: "Draft record created from a reviewed community submission.",
          moderator: session?.handle ?? "Moderator",
        },
      ],
      dateAdded: timestamp,
      updatedAt: timestamp,
      views: 0,
      isPublished: false,
    });
  }

  async function moderateAppeal(appeal: AppealRecord, status: IntakeStatus) {
    const values = await actionDialog.collect({
      eyebrow: "Appeal review",
      title: `Mark appeal ${status}`,
      description: `Update ${appeal.id} for report ${appeal.reportId}.`,
      confirmLabel: `Mark ${status}`,
      tone: status === "Rejected" ? "danger" : "standard",
      fields: [
        {
          name: "moderatorNotes",
          label: "Private moderator note",
          initialValue: appeal.moderatorNotes,
          multiline: true,
          help: "Optional. Staff only.",
        },
        ...(status === "Accepted"
          ? [
              {
                name: "publicResolution",
                label: "Public resolution",
                initialValue: appeal.publicResolution,
                multiline: true,
                help: "Optional. This may appear on the public report.",
              },
            ]
          : []),
      ],
    });
    if (!values) return;
    const moderatorNotes = values.moderatorNotes;
    const publicResolution =
      status === "Accepted" ? values.publicResolution : appeal.publicResolution;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/appeals", {
        method: "PATCH",
        headers: mutationHeaders(true),
        body: JSON.stringify({ id: appeal.id, status, moderatorNotes, publicResolution }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't update the appeal.");
      setMessage(`${appeal.id} was marked ${status}.`);
      await loadData();
    } catch (moderationError) {
      setError(
        moderationError instanceof Error ? moderationError.message : "Couldn't update the appeal.",
      );
      setLoading(false);
    }
  }

  async function deleteAppeal(appeal: AppealRecord) {
    const confirmed = await actionDialog.confirm({
      eyebrow: "Permanent action",
      title: "Delete appeal",
      description: `Remove ${appeal.id} and its private evidence permanently?`,
      details: [`Report: ${appeal.reportId}`],
      confirmLabel: "Delete appeal",
      tone: "danger",
    });
    if (!confirmed) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/appeals?id=${encodeURIComponent(appeal.id)}`, {
        method: "DELETE",
        headers: mutationHeaders(),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't delete the appeal.");
      setMessage(`${appeal.id} and its quarantine files were removed.`);
      await loadData();
    } catch (deletionError) {
      setError(
        deletionError instanceof Error ? deletionError.message : "Couldn't delete the appeal.",
      );
      setLoading(false);
    }
  }

  async function moderateComment(
    comment: CommunityComment,
    status: Extract<CommunityComment["status"], "Approved" | "Rejected">,
  ) {
    const values = await actionDialog.collect({
      eyebrow: "Discussion moderation",
      title: `${status} discussion reply`,
      description: `${comment.id} by ${comment.displayName}. Any note stays private.`,
      confirmLabel: status,
      tone: status === "Rejected" ? "danger" : "standard",
      fields: [
        {
          name: "moderatorNotes",
          label: "Private moderator note",
          initialValue: comment.moderatorNotes,
          multiline: true,
          help: "Optional. Staff context only.",
        },
      ],
    });
    if (!values) return;
    const moderatorNotes = values.moderatorNotes;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/comments", {
        method: "PATCH",
        headers: mutationHeaders(true),
        body: JSON.stringify({ id: comment.id, status, moderatorNotes }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't update the reply.");
      setMessage(`${comment.id} was ${status.toLowerCase()}.`);
      await loadData();
    } catch (moderationError) {
      setError(
        moderationError instanceof Error ? moderationError.message : "Couldn't update the reply.",
      );
      setLoading(false);
    }
  }

  async function deleteComment(comment: CommunityComment) {
    const confirmed = await actionDialog.confirm({
      eyebrow: "Permanent action",
      title: "Delete discussion reply",
      description: `Remove ${comment.id} by ${comment.displayName} permanently?`,
      confirmLabel: "Delete reply",
      tone: "danger",
    });
    if (!confirmed) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/comments?id=${encodeURIComponent(comment.id)}`, {
        method: "DELETE",
        headers: mutationHeaders(),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't delete the reply.");
      setMessage(`${comment.id} was removed.`);
      await loadData();
    } catch (deletionError) {
      setError(
        deletionError instanceof Error ? deletionError.message : "Couldn't delete the reply.",
      );
      setLoading(false);
    }
  }

  async function openEvidenceUrl(url: string, filename: string, download = false) {
    const preview = download ? null : window.open("", "_blank");
    if (preview) {
      preview.opener = null;
      preview.document.body.textContent = "Loading protected evidence…";
    }
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? `Couldn't open ${filename}.`);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      if (download) {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        anchor.rel = "noopener";
        anchor.click();
      } else if (preview) preview.location.replace(objectUrl);
      else window.open(objectUrl, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch (evidenceError) {
      preview?.close();
      setError(evidenceError instanceof Error ? evidenceError.message : "Couldn't open evidence.");
    }
  }

  async function updateEvidence(
    item: EvidenceQueueItem,
    update: Record<string, unknown>,
    successMessage: string,
  ) {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/evidence/${encodeURIComponent(item.id)}`, {
        method: "PATCH",
        headers: mutationHeaders(true),
        body: JSON.stringify(update),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't update evidence.");
      setMessage(successMessage);
      await loadData();
    } catch (evidenceError) {
      setError(
        evidenceError instanceof Error ? evidenceError.message : "Couldn't update evidence.",
      );
      setLoading(false);
    }
  }

  async function reviewEvidence(item: EvidenceQueueItem) {
    const replacementSource = item.replacesEvidenceId
      ? evidenceQueue.find((candidate) => candidate.id === item.replacesEvidenceId)
      : undefined;
    const currentLink = item.links[0] ?? replacementSource?.links[0];
    const values = await actionDialog.collect({
      eyebrow: "Evidence privacy review",
      title: "Review and link evidence",
      description: `Link ${item.id} to its report. Only the sanitized copy can go public.`,
      confirmLabel: "Save review",
      fields: [
        {
          name: "reportId",
          label: "Report ID",
          initialValue: currentLink?.reportId ?? "",
          placeholder: "SR-2026-...",
          required: true,
          help: "The report this file belongs to.",
        },
        {
          name: "caption",
          label: "Public caption",
          initialValue: currentLink?.caption ?? "",
          multiline: true,
          required: true,
          help: "Required before publishing. No private contact details.",
        },
      ],
    });
    if (!values) return;
    const reportId = values.reportId.trim();
    const caption = values.caption.trim();
    if (!reportId || !caption) return;
    await updateEvidence(
      item,
      {
        reportId,
        caption,
        visiblePiiReviewed: true,
      },
      `${item.id} passed visible-PII review and was linked to ${reportId}.`,
    );
  }

  async function publishEvidence(item: EvidenceQueueItem) {
    const currentLink = item.links[0];
    if (!currentLink || !currentLink.caption.trim() || !item.visiblePiiReviewed) {
      await reviewEvidence(item);
      return;
    }
    const confirmed = await actionDialog.confirm({
      eyebrow: "Evidence publication",
      title: "Publish sanitized evidence",
      description: `Publish the sanitized derivative for ${item.id}?`,
      details: [
        `Report: ${currentLink.reportId}`,
        `Caption: ${currentLink.caption}`,
        "The original file stays private.",
      ],
      confirmLabel: "Publish derivative",
    });
    if (!confirmed) return;
    await updateEvidence(item, { state: "public" }, `${item.id} was published.`);
  }

  function uploadRedactedReplacement(item: EvidenceQueueItem) {
    const picker = document.createElement("input");
    picker.type = "file";
    picker.accept = "image/png,image/jpeg,image/webp";
    picker.onchange = async () => {
      const file = picker.files?.[0];
      if (!file) return;
      setLoading(true);
      setError("");
      try {
        const form = new FormData();
        form.set("file", file);
        form.set("replacesEvidenceId", item.id);
        const response = await fetch("/api/admin/evidence/upload", {
          method: "POST",
          headers: mutationHeaders(),
          body: form,
        });
        const payload = (await response.json()) as {
          error?: string;
          evidence?: { id?: string };
        };
        if (!response.ok) {
          throw new Error(payload.error ?? "Couldn't upload the redacted replacement.");
        }
        setMessage(
          `${payload.evidence?.id ?? "Replacement"} was uploaded for ${item.id}; review and link it before publication.`,
        );
        await loadData();
      } catch (replacementError) {
        setError(
          replacementError instanceof Error
            ? replacementError.message
            : "Couldn't upload the redacted replacement.",
        );
        setLoading(false);
      }
    };
    picker.click();
  }

  async function deleteEvidence(item: EvidenceQueueItem) {
    const confirmed = await actionDialog.confirm({
      eyebrow: "Permanent action",
      title: "Delete evidence asset",
      description: `Delete ${item.id} permanently?`,
      details: [
        item.originalFilename,
        "The request will be rejected if this asset is under legal hold.",
      ],
      confirmLabel: "Delete evidence",
      tone: "danger",
    });
    if (!confirmed) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/evidence/${encodeURIComponent(item.id)}`, {
        method: "DELETE",
        headers: mutationHeaders(),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't delete evidence.");
      setMessage(`${item.id} was deleted.`);
      await loadData();
    } catch (evidenceError) {
      setError(
        evidenceError instanceof Error ? evidenceError.message : "Couldn't delete evidence.",
      );
      setLoading(false);
    }
  }

  async function mergeReport(report: ScamReport) {
    const values = await actionDialog.collect({
      eyebrow: "Duplicate reports",
      title: "Choose the canonical report",
      description: `${report.id} will become a redirect after the merge.`,
      confirmLabel: "Check merge",
      fields: [
        {
          name: "canonicalId",
          label: "Canonical report ID",
          placeholder: "SR-2026-...",
          required: true,
          help: "Enter the existing report that should remain canonical.",
        },
      ],
    });
    if (!values?.canonicalId.trim()) return;
    const canonicalId = values.canonicalId.trim();
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({
        duplicateId: report.id,
        canonicalId,
      });
      const preflightResponse = await fetch(`/api/admin/merge?${query}`, { cache: "no-store" });
      const preflightPayload = (await preflightResponse.json()) as {
        error?: string;
        preflight?: { conflicts: string[]; warnings: string[] };
      };
      if (!preflightResponse.ok || !preflightPayload.preflight) {
        throw new Error(preflightPayload.error ?? "Couldn't check this merge.");
      }
      if (preflightPayload.preflight.conflicts.length) {
        throw new Error(preflightPayload.preflight.conflicts.join(" "));
      }
      const confirmed = await actionDialog.confirm({
        eyebrow: "Merge preflight passed",
        title: "Confirm report merge",
        description: `Merge ${report.id} into ${canonicalId}? The operation is reversible.`,
        details: preflightPayload.preflight.warnings.length
          ? preflightPayload.preflight.warnings
          : ["No merge conflicts or warnings were reported."],
        confirmLabel: "Merge reports",
      });
      if (!confirmed) {
        setLoading(false);
        return;
      }
      const response = await fetch("/api/admin/merge", {
        method: "POST",
        headers: mutationHeaders(true),
        body: JSON.stringify({ duplicateId: report.id, canonicalId }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't merge the reports.");
      setMessage(`${report.id} now redirects to ${canonicalId}.`);
      await loadData();
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : "Couldn't merge the reports.");
      setLoading(false);
    }
  }

  async function unmergeReport(report: ScamReport) {
    const confirmed = await actionDialog.confirm({
      eyebrow: "Duplicate reports",
      title: "Undo report merge",
      description: `Restore ${report.id} as an independent report?`,
      details: report.mergedIntoReportId
        ? [`Current canonical report: ${report.mergedIntoReportId}`]
        : undefined,
      confirmLabel: "Restore report",
    });
    if (!confirmed) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        `/api/admin/merge?duplicateId=${encodeURIComponent(report.id)}`,
        { method: "DELETE", headers: mutationHeaders() },
      );
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Couldn't undo the merge.");
      setMessage(`${report.id} was restored as an independent report.`);
      await loadData();
    } catch (mergeError) {
      setError(mergeError instanceof Error ? mergeError.message : "Couldn't undo the merge.");
      setLoading(false);
    }
  }

  if (!accessChecked || !session) {
    return (
      <section className="admin-login forum-box">
        <div className="forum-box-title">
          <h2>Moderator session</h2>
          <span>Restricted area</span>
        </div>
        <div>
          <div className="admin-lock" aria-hidden="true">
            ADMIN
          </div>
          <h2>Staff panel</h2>
          <p>
            {accessChecked
              ? "Use a moderator account with Discord and email linked."
              : "Checking your staff session…"}
          </p>
          {error && <div className="form-error">{error}</div>}
          {accessChecked && (
            <a className="forum-button" href="/auth/sign-in?returnTo=%2Fadmin">
              Sign in again
            </a>
          )}
        </div>
      </section>
    );
  }

  const pendingCount = reports.filter(
    (report) => report.status === "Reported" || report.status === "Under Review",
  ).length;
  const unpublishedCount = reports.filter((report) => !report.isPublished).length;
  const pendingReviewCount = reviews.filter((review) => review.status === "Pending").length;
  const pendingSubmissionCount = reportSubmissions.filter(
    (submission) => submission.status === "Pending" || submission.status === "Needs Info",
  ).length;
  const pendingAppealCount = appeals.filter(
    (appeal) => appeal.status === "Pending" || appeal.status === "Needs Info",
  ).length;
  const pendingCommentCount = comments.filter((comment) => comment.status === "Pending").length;
  const reviewQueue = [...reviews].sort((left, right) => {
    if (left.status === "Pending" && right.status !== "Pending") return -1;
    if (right.status === "Pending" && left.status !== "Pending") return 1;
    return right.createdAt.localeCompare(left.createdAt);
  });
  const submissionQueue = [...reportSubmissions].sort((left, right) => {
    const leftOpen = left.status === "Pending" || left.status === "Needs Info";
    const rightOpen = right.status === "Pending" || right.status === "Needs Info";
    if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
    return right.createdAt.localeCompare(left.createdAt);
  });
  const appealQueue = [...appeals].sort((left, right) => {
    const leftOpen = left.status === "Pending" || left.status === "Needs Info";
    const rightOpen = right.status === "Pending" || right.status === "Needs Info";
    if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
    return right.createdAt.localeCompare(left.createdAt);
  });
  const commentQueue = [...comments].sort((left, right) => {
    if (left.status === "Pending" && right.status !== "Pending") return -1;
    if (right.status === "Pending" && left.status !== "Pending") return 1;
    return right.createdAt.localeCompare(left.createdAt);
  });

  return (
    <div className="admin-dashboard">
      <AdminSummary
        totalReports={reportPagination.totalItems}
        pendingReports={pendingCount}
        unpublishedReports={unpublishedCount}
        pendingReviews={pendingReviewCount}
        openSubmissions={pendingSubmissionCount}
        totalSubmissions={submissionPagination.totalItems}
        openAppeals={pendingAppealCount}
        totalAppeals={appealPagination.totalItems}
        pendingComments={pendingCommentCount}
        totalComments={commentPagination.totalItems}
        onAddReport={() => {
          setDraftSourceSubmissionId(null);
          setEditing(blankReport(session.handle));
        }}
      />
      {message && <div className="form-success">{message}</div>}
      {error && <div className="form-error">{error}</div>}

      <div className="admin-queue-stack">
        <AdminQueueDisclosure
          label="Public report intake"
          count={`${pendingSubmissionCount} open`}
          initiallyOpen={pendingSubmissionCount > 0}
        >
          <ReportSubmissionQueue
            submissions={submissionQueue}
            pendingCount={pendingSubmissionCount}
            pagination={submissionPagination}
            loading={loading}
            onPageChange={(page) => void loadData({ submissions: page })}
            onOpenEvidence={(attachment) => void openPrivateEvidence(attachment)}
            onCreateDraft={createDraftFromSubmission}
            onModerate={(submission, status) => void moderateReportSubmission(submission, status)}
            onDelete={(submission) => void deleteReportSubmission(submission)}
          />
        </AdminQueueDisclosure>

        <AdminQueueDisclosure
          label="Corrections and appeals"
          count={`${pendingAppealCount} open`}
          initiallyOpen={pendingAppealCount > 0}
        >
          <AppealQueue
            appeals={appealQueue}
            pendingCount={pendingAppealCount}
            pagination={appealPagination}
            loading={loading}
            onPageChange={(page) => void loadData({ appeals: page })}
            onOpenEvidence={(attachment) => void openPrivateEvidence(attachment)}
            onModerate={(appeal, status) => void moderateAppeal(appeal, status)}
            onDelete={(appeal) => void deleteAppeal(appeal)}
          />
        </AdminQueueDisclosure>

        <AdminQueueDisclosure
          label="Discussion replies"
          count={`${pendingCommentCount} pending`}
          initiallyOpen={pendingCommentCount > 0}
        >
          <CommentQueue
            comments={commentQueue}
            pendingCount={pendingCommentCount}
            pagination={commentPagination}
            loading={loading}
            onPageChange={(page) => void loadData({ comments: page })}
            onModerate={(comment, status) => void moderateComment(comment, status)}
            onDelete={(comment) => void deleteComment(comment)}
          />
        </AdminQueueDisclosure>

        <AdminQueueDisclosure
          label="Community reviews"
          count={`${pendingReviewCount} pending`}
          initiallyOpen={pendingReviewCount > 0}
        >
          <ReviewQueue
            reviews={reviewQueue}
            reports={reports}
            pendingCount={pendingReviewCount}
            pagination={reviewPagination}
            loading={loading}
            onPageChange={(page) => void loadData({ reviews: page })}
            onModerate={(review, status) => void moderateCommunityReview(review, status)}
            onDelete={(review) => void deleteCommunityReview(review)}
          />
        </AdminQueueDisclosure>

        <AdminQueueDisclosure
          label="Private evidence"
          count={`${evidenceQueue.length} shown`}
          initiallyOpen={false}
        >
          <EvidenceQueue
            items={evidenceQueue}
            pagination={evidencePagination}
            loading={loading}
            canDelete={session.role === "admin"}
            onPageChange={(page) => void loadData({ evidence: page })}
            onOpen={(url, filename, download) => void openEvidenceUrl(url, filename, download)}
            onReview={(item) => void reviewEvidence(item)}
            onPublish={(item) => void publishEvidence(item)}
            onUpdate={(item, update, successMessage) => {
              void updateEvidence(item, update, successMessage);
            }}
            onUploadReplacement={uploadRedactedReplacement}
            onDelete={(item) => void deleteEvidence(item)}
          />
        </AdminQueueDisclosure>

        <AdminQueueDisclosure
          label="Report database"
          count={`${reportPagination.totalItems} reports`}
          initiallyOpen={false}
        >
          <ReportQueue
            reports={reports}
            pagination={reportPagination}
            loading={loading}
            canDelete={session.role === "admin"}
            onPageChange={(page) => void loadData({ reports: page })}
            onEdit={(report) => {
              setDraftSourceSubmissionId(null);
              setEditing(structuredClone(report));
            }}
            onMerge={(report) => void mergeReport(report)}
            onUnmerge={(report) => void unmergeReport(report)}
            onDelete={(report) => void deleteReport(report)}
          />
        </AdminQueueDisclosure>

        <AdminQueueDisclosure
          label="Moderator activity"
          count={`${auditPagination.totalItems} entries`}
          initiallyOpen={false}
        >
          <AuditQueue
            logs={auditLogs}
            pagination={auditPagination}
            loading={loading}
            onPageChange={(page) => void loadData({ audit: page })}
          />
        </AdminQueueDisclosure>
      </div>

      {editing && (
        <ReportEditor
          key={editing.id}
          report={editing}
          allReports={reports}
          csrfToken={csrfToken}
          moderatorHandle={session.handle}
          onCancel={() => {
            setEditing(null);
            setDraftSourceSubmissionId(null);
          }}
          onSaved={async (savedMessage) => {
            const sourceSubmission = draftSourceSubmissionId
              ? reportSubmissions.find((submission) => submission.id === draftSourceSubmissionId)
              : null;
            let linkageError = "";
            if (sourceSubmission) {
              try {
                const response = await fetch("/api/admin/report-submissions", {
                  method: "PATCH",
                  headers: mutationHeaders(true),
                  body: JSON.stringify({
                    id: sourceSubmission.id,
                    status: "Accepted",
                    moderatorNotes:
                      sourceSubmission.moderatorNotes || `Draft created as ${editing.id}.`,
                    resultReportId: editing.id,
                  }),
                });
                const payload = (await response.json()) as { error?: string };
                if (!response.ok)
                  throw new Error(payload.error ?? "Couldn't link the intake submission.");
                savedMessage = `${savedMessage} ${sourceSubmission.id} was accepted and linked.`;
              } catch (linkError) {
                linkageError =
                  linkError instanceof Error
                    ? linkError.message
                    : "Couldn't link the intake submission.";
              }
            }
            setEditing(null);
            setDraftSourceSubmissionId(null);
            await loadData();
            setMessage(savedMessage);
            if (linkageError)
              setError(
                `The report was saved, but the source intake was not linked: ${linkageError}`,
              );
          }}
        />
      )}
      <AdminActionDialog controller={actionDialog} />
    </div>
  );
}
