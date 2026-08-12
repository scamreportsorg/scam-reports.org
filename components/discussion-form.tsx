"use client";

import { FormEvent, useState } from "react";
import { AuthTurnstile } from "./auth-turnstile";
import { resetTurnstile, useMemberFormAuth } from "./member-form-auth";

type CommentResponse = {
  error?: string;
  message?: string;
  comment?: { id: string; status: string };
};

export function DiscussionForm({ reportId }: { reportId: string }) {
  const auth = useMemberFormAuth();
  const [body, setBody] = useState("");
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submitComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.authenticated || !auth.csrfToken) {
      setError("Sign in before posting a reply.");
      return;
    }
    const formData = new FormData(event.currentTarget);
    const turnstileToken = formData.get("cf-turnstile-response");
    setSubmitting(true);
    setMessage("");
    setError("");

    try {
      const response = await fetch("/api/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          reportId,
          parentId: null,
          displayName: auth.handle,
          body,
          website,
          csrfToken: auth.csrfToken,
          turnstileToken: typeof turnstileToken === "string" ? turnstileToken : "",
        }),
      });

      let payload: CommentResponse = {};
      if (response.headers.get("content-type")?.includes("application/json")) {
        payload = (await response.json()) as CommentResponse;
      }

      if (!response.ok) {
        throw new Error(payload.error ?? "We couldn't send this reply.");
      }

      setMessage(payload.message ?? "Your reply is waiting for moderator approval.");
      setBody("");
      setWebsite("");
    } catch (submissionError) {
      setError(
        submissionError instanceof Error ? submissionError.message : "We couldn't send this reply.",
      );
    } finally {
      resetTurnstile();
      setSubmitting(false);
    }
  }

  return (
    <form className="review-form discussion-form" onSubmit={submitComment}>
      <div className="review-form-intro">
        <strong>Reply to this report</strong>
        <span>Replies stay private until approval. Keep it factual and stick to this report.</span>
      </div>

      {!auth.loading && !auth.authenticated && (
        <div className="form-error" role="alert">
          You need an account to reply.{" "}
          <a href={`/auth/sign-in?returnTo=${encodeURIComponent(`/reports/${reportId}`)}`}>
            Sign in.
          </a>
        </div>
      )}
      {auth.error && (
        <div className="form-error" role="alert">
          {auth.error}
        </div>
      )}

      <label className="discussion-name-field">
        <span>Posting as</span>
        <input value={auth.handle} readOnly aria-label="Member handle" />
      </label>

      <AuthTurnstile action="comment" />

      <label>
        <span>Your reply</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          minLength={20}
          maxLength={2000}
          rows={6}
          placeholder="Add useful context. Separate what you saw from what you're assuming."
          required
        />
      </label>

      <label className="honeypot-field" aria-hidden="true">
        <span>Website</span>
        <input
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
          tabIndex={-1}
          autoComplete="off"
        />
      </label>

      <div className="review-form-footer">
        <small>
          Harassment, threats, doxxing, copied claims and unrelated personal data are rejected.
        </small>
        <button
          className="forum-button"
          type="submit"
          disabled={submitting || auth.loading || !auth.authenticated}
        >
          {submitting ? "Submitting…" : "Send reply for review"}
        </button>
      </div>

      <div className="discussion-form-feedback" aria-live="polite">
        {message && <div className="form-success">{message}</div>}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </form>
  );
}
