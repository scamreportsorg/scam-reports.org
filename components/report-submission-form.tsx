"use client";

import { FormEvent, useState } from "react";
import { EVIDENCE_ACCEPT, validateEvidenceFiles } from "@/lib/evidence-constraints";
import { REPORT_CATEGORIES } from "@/lib/types";
import { AuthTurnstile } from "./auth-turnstile";
import { resetTurnstile, useMemberFormAuth } from "./member-form-auth";

type SubmissionResult = {
  submission?: { id: string; status: string };
  message?: string;
  error?: string;
};

export function ReportSubmissionForm({
  initialRelatedReportId = "",
}: {
  initialRelatedReportId?: string;
}) {
  const auth = useMemberFormAuth();
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<{
    id: string;
    status: string;
    message: string;
  } | null>(null);

  function selectFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    const validationError = validateEvidenceFiles(selected);
    if (validationError) {
      event.currentTarget.value = "";
      setFiles([]);
      setError(validationError);
      return;
    }
    setFiles(selected);
    setError("");
  }

  async function submitReport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.authenticated || !auth.csrfToken) {
      setError("Sign in before sending a report.");
      return;
    }
    const form = event.currentTarget;
    const validationError = validateEvidenceFiles(files);
    if (validationError) {
      setError(validationError);
      return;
    }

    setSubmitting(true);
    setError("");
    setReceipt(null);
    try {
      const formData = new FormData(form);
      const turnstileToken = formData.get("cf-turnstile-response");
      const response = await fetch("/api/report-submissions", {
        method: "POST",
        headers: {
          "x-csrf-token": auth.csrfToken,
          "x-turnstile-token": typeof turnstileToken === "string" ? turnstileToken : "",
        },
        body: formData,
        credentials: "same-origin",
      });
      const payload = (await response.json()) as SubmissionResult;
      if (!response.ok || !payload.submission) {
        throw new Error(payload.error ?? "We couldn't send the report.");
      }

      setReceipt({
        id: payload.submission.id,
        status: payload.submission.status,
        message: payload.message ?? "Your report is in the moderation queue.",
      });
      form.reset();
      setFiles([]);
    } catch (submissionError) {
      setError(
        submissionError instanceof Error ? submissionError.message : "We couldn't send the report.",
      );
    } finally {
      resetTurnstile();
      setSubmitting(false);
    }
  }

  return (
    <section className="forum-box intake-panel">
      <div className="forum-box-title">
        <h2>Submit a report</h2>
        <span>Private until reviewed</span>
      </div>
      <form className="intake-form" onSubmit={submitReport}>
        <input type="hidden" name="csrfToken" value={auth.csrfToken} />
        <div className="intake-notice">
          <strong>Nothing is posted yet</strong>
          <span>The report and files stay private until a moderator checks them.</span>
        </div>

        {!auth.loading && !auth.authenticated && (
          <div className="form-error" role="alert">
            You need an account to send this. <a href="/auth/sign-in?returnTo=/submit">Sign in.</a>
          </div>
        )}
        {auth.error && (
          <div className="form-error" role="alert">
            {auth.error}
          </div>
        )}

        <fieldset>
          <legend>Reporter details</legend>
          <div className="intake-fields">
            <label>
              <span>Submitting as</span>
              <input name="submitterName" value={auth.handle} readOnly required />
            </label>
            <label>
              <span>
                Contact email <em>optional</em>
              </span>
              <input name="contactEmail" type="email" maxLength={160} autoComplete="email" />
              <small>Private. We only use it if a moderator needs to ask something.</small>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Reported identity</legend>
          <div className="intake-fields">
            <label>
              <span>Discord username</span>
              <input name="username" minLength={2} maxLength={80} autoComplete="off" required />
            </label>
            <label>
              <span>Discord user ID</span>
              <input
                name="discordId"
                inputMode="numeric"
                pattern="[0-9]{17,20}"
                minLength={17}
                maxLength={20}
                placeholder="17–20 digit ID"
                autoComplete="off"
                required
              />
            </label>
            <label>
              <span>Game, product, or community</span>
              <input name="game" minLength={2} maxLength={80} required />
            </label>
            <label>
              <span>Report category</span>
              <select name="category" defaultValue="" required>
                <option value="" disabled>
                  Select a category
                </option>
                {REPORT_CATEGORIES.map((category) => (
                  <option value={category} key={category}>
                    {category}
                  </option>
                ))}
              </select>
            </label>
            <label className="intake-field-wide">
              <span>
                Related report ID <em>optional</em>
              </span>
              <input
                name="relatedReportId"
                defaultValue={initialRelatedReportId}
                maxLength={50}
                placeholder="Example: SR-2026-0009"
                autoComplete="off"
                onInput={(event) => {
                  event.currentTarget.value = event.currentTarget.value.toUpperCase();
                }}
              />
              <small>Fill this in when you&apos;re adding evidence to an existing report.</small>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Claim and context</legend>
          <div className="intake-fields">
            <label className="intake-field-wide">
              <span>Short summary</span>
              <textarea name="reason" minLength={10} maxLength={500} rows={3} required />
              <small>Keep it factual. Don&apos;t claim more than the evidence shows.</small>
            </label>
            <label className="intake-field-wide">
              <span>Full timeline</span>
              <textarea
                name="description"
                minLength={40}
                maxLength={8000}
                rows={9}
                placeholder="Walk through what happened, including when it happened, what you saw yourself, and what each file shows."
                required
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="intake-files">
          <legend>Evidence screenshots</legend>
          <input
            name="files"
            type="file"
            accept={EVIDENCE_ACCEPT}
            multiple
            onChange={selectFiles}
          />
          <small>Optional: up to 5 PNG, JPEG or WebP files, 5 MB each.</small>
          {files.length > 0 && (
            <ul className="intake-file-list">
              {files.map((file) => (
                <li key={`${file.name}-${file.size}`}>
                  <span>{file.name}</span>
                  <small>{(file.size / 1024 / 1024).toFixed(2)} MB</small>
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        <label className="honeypot-field" aria-hidden="true">
          <span>Website</span>
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>

        <label className="intake-consent">
          <input name="consent" type="checkbox" value="true" required />
          <span>
            I&apos;m submitting this in good faith. I removed unrelated personal data, and
            moderators may contact me to check the material.
          </span>
        </label>

        <AuthTurnstile action="report" />

        <div className="intake-actions">
          <small>Sending this does not publish it or guarantee that it will be published.</small>
          <button
            className="forum-button"
            type="submit"
            disabled={submitting || auth.loading || !auth.authenticated}
          >
            {submitting ? "Uploading and submitting…" : "Submit report for review"}
          </button>
        </div>

        <div aria-live="polite">
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {receipt && (
            <div className="submission-receipt">
              <span>Submission received</span>
              <strong>{receipt.id}</strong>
              <p>{receipt.message}</p>
              <small>Status: {receipt.status}. Keep this ID.</small>
            </div>
          )}
        </div>
      </form>
    </section>
  );
}
