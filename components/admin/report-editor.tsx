"use client";

import { FormEvent, useMemo, useState } from "react";
import type { EvidenceAttachment, ReportStatus, ScamReport } from "@/lib/types";
import { REPORT_CATEGORIES, REPORT_STATUSES } from "@/lib/types";
import { formatFileSize } from "@/lib/format";

type ReportEditorProps = {
  report: ScamReport;
  allReports: ScamReport[];
  csrfToken: string;
  moderatorHandle: string;
  onCancel: () => void;
  onSaved: (message: string) => Promise<void>;
};

export function ReportEditor({
  report: initialReport,
  allReports,
  csrfToken,
  moderatorHandle,
  onCancel,
  onSaved,
}: ReportEditorProps) {
  const [report, setReport] = useState(initialReport);
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const exists = allReports.some((item) => item.id === report.id);
  const duplicate = useMemo(
    () =>
      allReports.find(
        (item) => item.id !== report.id && item.discordId === report.discordId && report.discordId,
      ),
    [allReports, report.discordId, report.id],
  );

  function update<K extends keyof ScamReport>(key: K, value: ScamReport[K]) {
    setReport((current) => ({ ...current, [key]: value }));
  }

  function updateStatus(status: ReportStatus) {
    if (status === report.status) return;

    const timestamp = new Date().toISOString();
    setReport((current) => ({
      ...current,
      status,
      updatedAt: timestamp,
      statusHistory: [
        ...current.statusHistory,
        {
          status,
          date: timestamp,
          note: `Status changed to ${status}.`,
          moderator: moderatorHandle,
        },
      ],
    }));
  }

  async function uploadFiles(): Promise<EvidenceAttachment[]> {
    const uploaded: EvidenceAttachment[] = [];

    for (const file of files) {
      const formData = new FormData();
      formData.set("file", file);
      const response = await fetch("/api/admin/evidence/upload", {
        method: "POST",
        headers: { "x-csrf-token": csrfToken },
        body: formData,
      });
      const payload = (await response.json()) as {
        attachment?: EvidenceAttachment;
        error?: string;
      };

      if (!response.ok || !payload.attachment) {
        throw new Error(payload.error ?? `Couldn't upload ${file.name}.`);
      }
      uploaded.push(payload.attachment);
    }

    return uploaded;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");

    try {
      const uploaded = await uploadFiles();
      const timestamp = new Date().toISOString();
      const payload = {
        ...report,
        evidence: [...report.evidence, ...uploaded],
        updatedAt: timestamp,
      };
      const response = await fetch("/api/admin/reports", {
        method: exists ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as {
        report?: ScamReport;
        error?: string;
      };

      if (!response.ok || !result.report) {
        throw new Error(result.error ?? "Couldn't save the report.");
      }
      await onSaved(`${result.report.id} was ${exists ? "updated" : "created"}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Couldn't save the report.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="editor-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${report.id}`}
    >
      <form className="report-editor" onSubmit={save}>
        <header>
          <div>
            <small>{exists ? "Editing report" : "Creating draft"}</small>
            <h2>{report.id}</h2>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close editor">
            ×
          </button>
        </header>

        <div className="editor-body">
          <div className="editor-grid">
            <label>
              <span>Username</span>
              <input
                value={report.username}
                onChange={(event) => update("username", event.target.value)}
                minLength={2}
                required
              />
            </label>
            <label>
              <span>Discord ID</span>
              <input
                value={report.discordId}
                onChange={(event) => update("discordId", event.target.value.replace(/\D/g, ""))}
                minLength={17}
                maxLength={20}
                required
              />
            </label>
            <label>
              <span>Game / product</span>
              <input
                value={report.game}
                onChange={(event) => update("game", event.target.value)}
                required
              />
            </label>
            <label>
              <span>Category</span>
              <select
                value={report.category}
                onChange={(event) =>
                  update("category", event.target.value as ScamReport["category"])
                }
              >
                {REPORT_CATEGORIES.map((category) => (
                  <option key={category}>{category}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Status</span>
              <select
                value={report.status}
                onChange={(event) => updateStatus(event.target.value as ReportStatus)}
              >
                {REPORT_STATUSES.map((status) => (
                  <option key={status}>{status}</option>
                ))}
              </select>
            </label>
          </div>

          {duplicate && (
            <div className="duplicate-warning">
              Possible duplicate: Discord ID already appears in {duplicate.id} ({duplicate.username}
              ).
            </div>
          )}

          <label>
            <span>Reason for report</span>
            <textarea
              value={report.reason}
              onChange={(event) => update("reason", event.target.value)}
              rows={3}
              minLength={10}
              required
            />
          </label>
          <label>
            <span>Detailed narrative</span>
            <textarea
              value={report.description}
              onChange={(event) => update("description", event.target.value)}
              rows={7}
              minLength={20}
              required
            />
          </label>
          <label>
            <span>Public moderator notes</span>
            <textarea
              value={report.notes}
              onChange={(event) => update("notes", event.target.value)}
              rows={4}
            />
          </label>
          <label>
            <span>Private moderator notes</span>
            <textarea
              value={report.moderatorNotes}
              onChange={(event) => update("moderatorNotes", event.target.value)}
              rows={4}
            />
          </label>

          <fieldset className="visibility-fieldset">
            <legend>Publication</legend>
            <label>
              <input
                type="checkbox"
                checked={report.isPublished}
                onChange={(event) => update("isPublished", event.target.checked)}
              />{" "}
              Publish after privacy and source review
            </label>
          </fieldset>

          <fieldset className="evidence-editor">
            <legend>Evidence attachments</legend>
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
            />
            <small>
              PNG, JPEG, or WebP. Maximum 5 MB per image. New reports remain unpublished until
              manually approved.
            </small>
            {files.length > 0 && (
              <ul>
                {files.map((file) => (
                  <li key={`${file.name}-${file.size}`}>
                    {file.name} · {formatFileSize(file.size)}
                  </li>
                ))}
              </ul>
            )}
            {report.evidence.length > 0 && (
              <ul className="existing-evidence">
                {report.evidence.map((item) => (
                  <li key={item.id}>
                    <span>
                      {item.filename} · {item.redacted ? "Redacted" : "Public"}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        update(
                          "evidence",
                          report.evidence.filter((evidence) => evidence.id !== item.id),
                        )
                      }
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          {error && <div className="form-error">{error}</div>}
        </div>

        <footer>
          <button className="forum-button subtle" type="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="forum-button" type="submit" disabled={saving}>
            {saving ? "Saving…" : exists ? "Save changes" : "Create report"}
          </button>
        </footer>
      </form>
    </div>
  );
}
