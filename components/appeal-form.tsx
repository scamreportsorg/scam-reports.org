"use client";

import { FormEvent, useState } from "react";
import { EVIDENCE_ACCEPT, validateEvidenceFiles } from "@/lib/evidence-constraints";
import { APPEAL_RELATIONSHIPS, APPEAL_REQUEST_TYPES } from "@/lib/types";
import { AuthTurnstile } from "./auth-turnstile";
import { resetTurnstile, useMemberFormAuth } from "./member-form-auth";

type SubmissionResult = {
  appeal?: { id: string; status: string };
  message?: string;
  error?: string;
};

export function AppealForm({ initialReportId = "" }: { initialReportId?: string }) {
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

  async function submitAppeal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.authenticated || !auth.csrfToken) {
      setError("Sign in before sending an appeal.");
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
      const response = await fetch("/api/appeals", {
        method: "POST",
        headers: {
          "x-csrf-token": auth.csrfToken,
          "x-turnstile-token": typeof turnstileToken === "string" ? turnstileToken : "",
        },
        body: formData,
        credentials: "same-origin",
      });
      const payload = (await response.json()) as SubmissionResult;
      if (!response.ok || !payload.appeal) {
        throw new Error(payload.error ?? "We couldn't send the appeal.");
      }

      setReceipt({
        id: payload.appeal.id,
        status: payload.appeal.status,
        message: payload.message ?? "Your request is in the moderation queue.",
      });
      form.reset();
      setFiles([]);
    } catch (submissionError) {
      setError(
        submissionError instanceof Error ? submissionError.message : "We couldn't send the appeal.",
      );
    } finally {
      resetTurnstile();
      setSubmitting(false);
    }
  }

  return (
    <section className="forum-box intake-panel">
      <div className="forum-box-title">
        <h2>Send a correction or appeal</h2>
        <span>Private until reviewed</span>
      </div>
      <form className="intake-form" onSubmit={submitAppeal}>
        <input type="hidden" name="csrfToken" value={auth.csrfToken} />
        <div className="intake-notice">
          <strong>What this form is for</strong>
          <span>
            Correct a factual error, dispute an identity, reply to a report or ask us to check
            evidence again. Sending a request does not remove the report.
          </span>
        </div>

        {!auth.loading && !auth.authenticated && (
          <div className="form-error" role="alert">
            You need an account to send this. <a href="/auth/sign-in?returnTo=/appeals">Sign in.</a>
          </div>
        )}
        {auth.error && (
          <div className="form-error" role="alert">
            {auth.error}
          </div>
        )}

        <fieldset>
          <legend>Record and request</legend>
          <div className="intake-fields">
            <label>
              <span>Report ID</span>
              <input
                name="reportId"
                defaultValue={initialReportId}
                minLength={8}
                maxLength={50}
                placeholder="Example: SR-2026-0009"
                autoComplete="off"
                onInput={(event) => {
                  event.currentTarget.value = event.currentTarget.value.toUpperCase();
                }}
                required
              />
            </label>
            <label>
              <span>Request type</span>
              <select name="requestType" defaultValue="" required>
                <option value="" disabled>
                  Select a request
                </option>
                {APPEAL_REQUEST_TYPES.map((requestType) => (
                  <option value={requestType} key={requestType}>
                    {requestType}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Contact details</legend>
          <div className="intake-fields">
            <label>
              <span>Submitting as</span>
              <input name="submitterName" value={auth.handle} readOnly required />
            </label>
            <label>
              <span>Relationship to the report</span>
              <select name="relationship" defaultValue="" required>
                <option value="" disabled>
                  Select your relationship
                </option>
                {APPEAL_RELATIONSHIPS.map((relationship) => (
                  <option value={relationship} key={relationship}>
                    {relationship}
                  </option>
                ))}
              </select>
            </label>
            <label className="intake-field-wide">
              <span>Contact email</span>
              <input
                name="contactEmail"
                type="email"
                maxLength={160}
                autoComplete="email"
                required
              />
              <small>Private. Used to verify the request and send you the outcome.</small>
            </label>
          </div>
        </fieldset>

        <fieldset>
          <legend>Your correction or response</legend>
          <label>
            <span>What needs another look?</span>
            <textarea
              name="body"
              minLength={40}
              maxLength={8000}
              rows={10}
              placeholder="Point to the exact text or file, tell us what's wrong or missing, and what should change."
              required
            />
          </label>
        </fieldset>

        <fieldset className="intake-files">
          <legend>Supporting screenshots</legend>
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
            I&apos;m making this request in good faith. I removed unrelated personal data, and
            moderators may contact me to verify my connection to the report.
          </span>
        </label>

        <AuthTurnstile action="appeal" />

        <div className="intake-actions">
          <small>A moderator may ask for the original files before deciding.</small>
          <button
            className="forum-button"
            type="submit"
            disabled={submitting || auth.loading || !auth.authenticated}
          >
            {submitting ? "Uploading and submitting..." : "Submit correction or appeal"}
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
              <span>Request received</span>
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
