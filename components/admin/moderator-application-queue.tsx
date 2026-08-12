"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  AdminModeratorApplication,
  ModeratorApplicationStatus,
} from "@/lib/moderator-application-contract";
import { MODERATOR_APPLICATION_STATUSES } from "@/lib/moderator-application-contract";
import { formatDate } from "@/lib/format";
import { AdminActionDialog, useAdminActionDialog } from "./admin-action-dialog";
import type { QueuePagination } from "./moderation-queue-types";
import { QueuePaginationControls } from "./queue-pagination";

type QueueResponse = {
  items?: AdminModeratorApplication[];
  pagination?: QueuePagination;
  error?: string;
};

const emptyPagination: QueuePagination = {
  page: 1,
  pageSize: 25,
  totalItems: 0,
  totalPages: 1,
};

function statusClass(status: ModeratorApplicationStatus) {
  return `application-status application-status-${status.toLowerCase().replaceAll(" ", "-")}`;
}

export function AdminModeratorApplicationQueue({
  csrfToken,
  role,
}: {
  csrfToken: string;
  role: "moderator" | "admin";
}) {
  const [items, setItems] = useState<AdminModeratorApplication[]>([]);
  const [pagination, setPagination] = useState(emptyPagination);
  const [statusFilter, setStatusFilter] = useState<ModeratorApplicationStatus | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const actionDialog = useAdminActionDialog();

  const load = useCallback(
    async (page = 1, status = statusFilter) => {
      setLoading(true);
      setError("");
      try {
        const search = new URLSearchParams({ page: String(page) });
        if (status) search.set("status", status);
        const response = await fetch(`/api/admin/moderator-applications?${search}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        const payload = (await response.json()) as QueueResponse;
        if (!response.ok || !payload.items || !payload.pagination) {
          throw new Error(payload.error ?? "Couldn't load moderator applications.");
        }
        setItems(payload.items);
        setPagination(payload.pagination);
      } catch (loadError) {
        setError(
          loadError instanceof Error ? loadError.message : "Couldn't load moderator applications.",
        );
      } finally {
        setLoading(false);
      }
    },
    [statusFilter],
  );

  useEffect(() => {
    queueMicrotask(() => void load(1));
  }, [load]);

  async function moderate(
    application: AdminModeratorApplication,
    status: Extract<ModeratorApplicationStatus, "Under Review" | "Accepted" | "Rejected">,
  ) {
    const values = await actionDialog.collect({
      eyebrow: status === "Accepted" ? "Grant moderator role" : "Application review",
      title: `${status} ${application.applicantHandle}'s application`,
      description:
        status === "Accepted"
          ? "Accepting grants the moderator role now and signs the applicant out everywhere."
          : "The note stays private. The applicant and public API never see it.",
      details:
        status === "Accepted"
          ? [
              "Admin access is required.",
              "Discord and email must be freshly confirmed.",
              "The applicant must still have both linked.",
            ]
          : undefined,
      confirmLabel: status,
      tone: status === "Rejected" ? "danger" : "standard",
      fields: [
        {
          name: "moderatorNotes",
          label: "Private staff note",
          initialValue: application.moderatorNotes,
          multiline: true,
          help: "Optional. Never copy this into a public report or GitHub issue.",
        },
      ],
    });
    if (!values) return;
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/admin/moderator-applications", {
        method: "PATCH",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          id: application.id,
          status,
          moderatorNotes: values.moderatorNotes,
          csrfToken,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error ?? "Couldn't update the moderator application.");
      }
      setMessage(
        status === "Accepted"
          ? `${application.applicantHandle} is now a moderator.`
          : `${application.id} was marked ${status}.`,
      );
      await load(pagination.page);
    } catch (moderationError) {
      setError(
        moderationError instanceof Error
          ? moderationError.message
          : "Couldn't update the moderator application.",
      );
      setLoading(false);
    }
  }

  return (
    <section className="forum-box moderator-application-admin-box">
      <div className="forum-box-title">
        <h2>Moderator applications</h2>
        <span>{pagination.totalItems} private applications</span>
      </div>
      <div className="moderator-application-toolbar">
        <label>
          Status
          <select
            value={statusFilter}
            disabled={loading}
            onChange={(event) => {
              const next = event.currentTarget.value as ModeratorApplicationStatus | "";
              setStatusFilter(next);
            }}
          >
            <option value="">All statuses</option>
            {MODERATOR_APPLICATION_STATUSES.map((status) => (
              <option value={status} key={status}>
                {status}
              </option>
            ))}
          </select>
        </label>
        <p>
          Private queue. Pending and under-review applications expire after 90 days without
          activity. Text from finished applications is erased 90 days after the decision.
        </p>
      </div>
      {message && (
        <div className="form-success" role="status" aria-live="polite">
          {message}
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="report-table-wrap">
        <table className="report-table moderator-application-table">
          <thead>
            <tr>
              <th>Applicant</th>
              <th>Application</th>
              <th>Availability</th>
              <th>Conflicts</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((application) => {
              const canAccept =
                role === "admin" &&
                application.status === "Under Review" &&
                application.applicantRole === "member" &&
                application.applicantStatus === "active" &&
                application.linkedProviders.discord &&
                application.linkedProviders.email;
              return (
                <tr key={application.id}>
                  <td>
                    <strong>{application.applicantHandle}</strong>
                    <code>{application.accountId}</code>
                    <small>
                      {application.applicantRole} · {application.applicantStatus}
                    </small>
                    <small>
                      Discord {application.linkedProviders.discord ? "linked" : "missing"} · email{" "}
                      {application.linkedProviders.email ? "linked" : "missing"}
                    </small>
                  </td>
                  <td className="moderator-application-copy">
                    <b>{application.id}</b>
                    <small>{formatDate(application.createdAt, true)}</small>
                    {application.answersErasedAt ? (
                      <p>Private answers erased {formatDate(application.answersErasedAt)}.</p>
                    ) : (
                      <>
                        <details>
                          <summary>Motivation</summary>
                          <p>{application.motivation}</p>
                        </details>
                        <details>
                          <summary>Experience</summary>
                          <p>{application.experience}</p>
                        </details>
                        {application.moderatorNotes && (
                          <details>
                            <summary>Private staff note</summary>
                            <p>{application.moderatorNotes}</p>
                          </details>
                        )}
                      </>
                    )}
                  </td>
                  <td className="moderator-application-copy">
                    {application.answersErasedAt ? (
                      <small>Erased after retention period</small>
                    ) : (
                      <>
                        <strong>{application.timezone}</strong>
                        <small>{application.languages}</small>
                        <p>{application.availability}</p>
                      </>
                    )}
                  </td>
                  <td className="moderator-application-copy">
                    {application.answersErasedAt ? (
                      <small>Erased after retention period</small>
                    ) : (
                      <>
                        <p>{application.conflicts}</p>
                        <small>Disclosure confirmed</small>
                      </>
                    )}
                  </td>
                  <td>
                    <span className={statusClass(application.status)}>{application.status}</span>
                    {application.reviewerHandle && <small>By {application.reviewerHandle}</small>}
                    {application.reviewedAt && (
                      <small>{formatDate(application.reviewedAt, true)}</small>
                    )}
                    {!application.answersErasedAt && application.purgeAfter && (
                      <small>Erase after {formatDate(application.purgeAfter)}</small>
                    )}
                  </td>
                  <td className="action-cell intake-action-cell">
                    {application.status === "Pending" && (
                      <button
                        disabled={loading}
                        onClick={() => void moderate(application, "Under Review")}
                      >
                        Start review
                      </button>
                    )}
                    {application.status === "Under Review" && (
                      <button
                        className="danger-action"
                        disabled={loading}
                        onClick={() => void moderate(application, "Rejected")}
                      >
                        Reject
                      </button>
                    )}
                    {canAccept && (
                      <button
                        disabled={loading}
                        onClick={() => void moderate(application, "Accepted")}
                      >
                        Accept + grant role
                      </button>
                    )}
                    {application.status === "Under Review" && role !== "admin" && (
                      <small>Admin accepts and grants role</small>
                    )}
                    {application.status === "Under Review" && role === "admin" && !canAccept && (
                      <small>Applicant is no longer eligible</small>
                    )}
                  </td>
                </tr>
              );
            })}
            {!items.length && !loading && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">Nothing matches this filter.</div>
                </td>
              </tr>
            )}
            {!items.length && loading && (
              <tr>
                <td colSpan={6}>
                  <div className="empty-state">Loading moderator applications…</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <QueuePaginationControls
        pagination={pagination}
        loading={loading}
        label="Moderator application queue pages"
        itemName="applications"
        onPageChange={(page) => void load(page)}
      />
      <AdminActionDialog controller={actionDialog} />
    </section>
  );
}
