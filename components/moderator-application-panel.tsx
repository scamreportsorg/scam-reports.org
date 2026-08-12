"use client";

import { useState, type FormEvent } from "react";
import { formatDate } from "@/lib/format";
import type { ApplicantModeratorApplication } from "@/lib/moderator-application-contract";
import { AuthTurnstile } from "./auth-turnstile";
import { resetTurnstile } from "./member-form-auth";
import { SectionBox } from "./section-box";
import { TurnstileSubmitButton } from "./turnstile-submit-button";

type ApplicationResponse = {
  application?: ApplicantModeratorApplication;
  message?: string;
  error?: string;
};

function statusClass(status: ApplicantModeratorApplication["status"]) {
  return `application-status application-status-${status.toLowerCase().replaceAll(" ", "-")}`;
}

function ApplicationDetails({ application }: { application: ApplicantModeratorApplication }) {
  return (
    <div className="moderator-application-details">
      <div className="moderator-application-meta">
        <span className={statusClass(application.status)}>{application.status}</span>
        <small>
          {application.id} · submitted {formatDate(application.createdAt, true)}
        </small>
      </div>
      {application.answersErasedAt ? (
        <p className="thread-notice">
          The private answers were erased on {formatDate(application.answersErasedAt)}. Only the
          status and a minimal audit record remain.
        </p>
      ) : (
        <dl>
          <div>
            <dt>Motivation</dt>
            <dd>{application.motivation}</dd>
          </div>
          <div>
            <dt>Relevant experience</dt>
            <dd>{application.experience}</dd>
          </div>
          <div>
            <dt>Timezone</dt>
            <dd>{application.timezone}</dd>
          </div>
          <div>
            <dt>Availability</dt>
            <dd>{application.availability}</dd>
          </div>
          <div>
            <dt>Languages</dt>
            <dd>{application.languages}</dd>
          </div>
          <div>
            <dt>Conflicts of interest</dt>
            <dd>{application.conflicts}</dd>
          </div>
        </dl>
      )}
      {!application.answersErasedAt && application.purgeAfter && (
        <p className="compact-copy">
          Private answers will be erased after {formatDate(application.purgeAfter)}.
        </p>
      )}
      {application.status === "Under Review" && (
        <p className="thread-notice">
          Staff are reviewing this application. You can still withdraw it here. It expires after 90
          days without activity.
        </p>
      )}
      {application.status === "Accepted" && (
        <p className="form-success" role="status" aria-live="polite">
          Accepted. Sign in again to load your moderator access.
        </p>
      )}
      {application.status === "Rejected" && (
        <p className="thread-notice">
          This application wasn&apos;t accepted. Staff notes stay private. You can apply again
          later.
        </p>
      )}
      {application.status === "Withdrawn" && (
        <p className="thread-notice">You withdrew this application.</p>
      )}
      {application.status === "Expired" && (
        <p className="thread-notice">
          This application expired after 90 days without activity. Its private answers were erased.
          You can apply again.
        </p>
      )}
    </div>
  );
}

export function ModeratorApplicationPanel({
  csrfToken,
  role,
  linkedProviders,
  initialApplication,
}: {
  csrfToken: string;
  role: "member" | "moderator" | "admin";
  linkedProviders: { discord: boolean; email: boolean };
  initialApplication: ApplicantModeratorApplication | null;
}) {
  const [application, setApplication] = useState(initialApplication);
  const [loading, setLoading] = useState(false);
  const [confirmWithdrawal, setConfirmWithdrawal] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const active = application?.status === "Pending" || application?.status === "Under Review";
  const eligible = role === "member" && linkedProviders.discord && linkedProviders.email;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setLoading(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/moderator-applications", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({
          csrfToken,
          motivation: fields.get("motivation"),
          experience: fields.get("experience"),
          timezone: fields.get("timezone"),
          availability: fields.get("availability"),
          languages: fields.get("languages"),
          conflicts: fields.get("conflicts"),
          confirmationAccepted: fields.get("confirmationAccepted") === "true",
          website: fields.get("website"),
          turnstileToken: fields.get("cf-turnstile-response"),
        }),
      });
      const payload = (await response.json()) as ApplicationResponse;
      if (!response.ok || !payload.application) {
        throw new Error(payload.error ?? "We couldn't send the moderator application.");
      }
      setApplication(payload.application);
      setMessage(payload.message ?? "Your application was submitted.");
      form.reset();
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "We couldn't send the moderator application.",
      );
    } finally {
      resetTurnstile();
      setLoading(false);
    }
  }

  async function withdraw() {
    if (!application || (application.status !== "Pending" && application.status !== "Under Review"))
      return;
    setLoading(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/moderator-applications", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ id: application.id, csrfToken }),
      });
      const payload = (await response.json()) as ApplicationResponse;
      if (!response.ok || !payload.application) {
        throw new Error(payload.error ?? "We couldn't withdraw the moderator application.");
      }
      setApplication(payload.application);
      setMessage(payload.message ?? "Your application was withdrawn.");
      setConfirmWithdrawal(false);
    } catch (withdrawalError) {
      setError(
        withdrawalError instanceof Error
          ? withdrawalError.message
          : "We couldn't withdraw the moderator application.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionBox title="Moderator applications" className="moderator-application-box">
      <div className="moderator-application-intro">
        <div>
          <strong>Want to help moderate?</strong>
          <p>
            Only you and authorized staff can read your application. Answers, account IDs and review
            notes never go on a public profile or API. Pending and under-review applications expire
            after 90 days without activity. Text from finished applications is erased 90 days after
            the decision.
          </p>
        </div>
        <span>Volunteer role · unpaid</span>
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

      {application && <ApplicationDetails application={application} />}

      {active && (
        <div className="moderator-application-withdrawal">
          {!confirmWithdrawal ? (
            <button
              className="forum-button subtle"
              type="button"
              disabled={loading}
              onClick={() => setConfirmWithdrawal(true)}
            >
              Withdraw application
            </button>
          ) : (
            <div className="thread-actions">
              <button
                className="forum-button danger-action"
                type="button"
                disabled={loading}
                onClick={() => void withdraw()}
              >
                Confirm withdrawal
              </button>
              <button
                className="forum-button subtle"
                type="button"
                disabled={loading}
                onClick={() => setConfirmWithdrawal(false)}
              >
                Keep application
              </button>
            </div>
          )}
        </div>
      )}

      {role !== "member" && (
        <p className="thread-notice">
          This account already has a staff role, so it can&apos;t apply again.
        </p>
      )}
      {role === "member" && (!linkedProviders.discord || !linkedProviders.email) && (
        <p className="thread-notice">Link and verify Discord and email above before applying.</p>
      )}

      {eligible && !active && (
        <form className="review-form moderator-application-form" onSubmit={submit}>
          <div className="review-form-intro">
            <strong>{application ? "Submit a new application" : "Apply for moderator"}</strong>
            <span>Be specific and honest. You can apply twice in any rolling 30-day period.</span>
          </div>
          <label>
            Why do you want to moderate Scam-Reports.org?
            <textarea name="motivation" minLength={80} maxLength={4000} required />
            <small>80–4,000 characters. Tell us what you&apos;d bring to the team.</small>
          </label>
          <label>
            Relevant moderation or community experience
            <textarea name="experience" minLength={50} maxLength={3000} required />
            <small>50–3,000 characters. Links are optional. Never paste private user data.</small>
          </label>
          <div className="moderator-application-grid">
            <label>
              Timezone
              <input
                name="timezone"
                minLength={2}
                maxLength={80}
                placeholder="UTC+2 / Europe/Vienna"
                required
              />
            </label>
            <label>
              Languages
              <input
                name="languages"
                minLength={2}
                maxLength={300}
                placeholder="English, German"
                required
              />
            </label>
          </div>
          <label>
            Typical weekly availability
            <textarea name="availability" minLength={20} maxLength={1000} required />
          </label>
          <label>
            Conflicts of interest
            <textarea
              name="conflicts"
              minLength={2}
              maxLength={2000}
              placeholder="List any vendor, server, team or personal ties. If there are none, write None."
              required
            />
          </label>
          <label className="honeypot-field" aria-hidden="true">
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
          <label className="moderator-application-confirmation">
            <input name="confirmationAccepted" type="checkbox" value="true" required />
            <span>
              These answers are accurate, I disclosed relevant conflicts, and I&apos;ll follow the
              moderation, privacy and evidence rules.
            </span>
          </label>
          <AuthTurnstile action="moderator_application" />
          <TurnstileSubmitButton>
            {loading ? "Submitting…" : "Send private application"}
          </TurnstileSubmitButton>
        </form>
      )}
    </SectionBox>
  );
}
