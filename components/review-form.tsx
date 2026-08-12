"use client";

import { FormEvent, useState } from "react";
import { REVIEW_RELATIONSHIPS } from "@/lib/types";
import type { ReviewRelationship } from "@/lib/types";
import { AuthTurnstile } from "./auth-turnstile";
import { resetTurnstile, useMemberFormAuth } from "./member-form-auth";

export function ReviewForm({ reportId, username }: { reportId: string; username: string }) {
  const auth = useMemberFormAuth();
  const [rating, setRating] = useState(3);
  const [relationship, setRelationship] = useState<ReviewRelationship>("Player");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [website, setWebsite] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth.authenticated || !auth.csrfToken) {
      setError("Sign in before posting a review.");
      return;
    }
    const formData = new FormData(event.currentTarget);
    const turnstileToken = formData.get("cf-turnstile-response");
    setSubmitting(true);
    setMessage("");
    setError("");
    try {
      const response = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          reportId,
          displayName: auth.handle,
          rating,
          relationship,
          title,
          body,
          website,
          csrfToken: auth.csrfToken,
          turnstileToken: typeof turnstileToken === "string" ? turnstileToken : "",
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? "We couldn't send this review.");
      }
      setMessage(payload.message ?? "Your review is waiting for approval.");
      setTitle("");
      setBody("");
      setRating(3);
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "We couldn't send this review.",
      );
    } finally {
      resetTurnstile();
      setSubmitting(false);
    }
  }

  return (
    <form className="review-form" onSubmit={submitReview}>
      <div className="review-form-intro">
        <strong>Write a review about {username}</strong>
        <span>
          Use direct experience or sources you checked yourself. Reviews stay private until
          approval.
        </span>
      </div>
      {!auth.loading && !auth.authenticated && (
        <div className="form-error" role="alert">
          You need an account to post a review.{" "}
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
      <div className="review-form-grid">
        <label>
          <span>Posting as</span>
          <input value={auth.handle} readOnly aria-label="Member handle" />
        </label>
        <label>
          <span>Your relationship</span>
          <select
            value={relationship}
            onChange={(event) => setRelationship(event.target.value as ReviewRelationship)}
          >
            {REVIEW_RELATIONSHIPS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Reputation rating</span>
          <select value={rating} onChange={(event) => setRating(Number(event.target.value))}>
            <option value={1}>1: Very poor</option>
            <option value={2}>2: Poor</option>
            <option value={3}>3: Neutral / unsure</option>
            <option value={4}>4: Good</option>
            <option value={5}>5: Trustworthy</option>
          </select>
        </label>
        <label className="review-title-field">
          <span>Review title</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            minLength={5}
            maxLength={100}
            required
          />
        </label>
      </div>
      <label>
        <span>What happened?</span>
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          minLength={30}
          maxLength={2000}
          rows={6}
          placeholder="Add dates and context. Separate what you saw from what you couldn't verify."
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
      <AuthTurnstile action="review" />
      <div className="review-form-footer">
        <small>
          False reports, harassment, doxxing and copied claims are rejected. Limit: 3 reviews per 24
          hours.
        </small>
        <button
          className="forum-button"
          type="submit"
          disabled={submitting || auth.loading || !auth.authenticated}
        >
          {submitting ? "Submitting…" : "Send for review"}
        </button>
      </div>
      {message && <div className="form-success">{message}</div>}
      {error && <div className="form-error">{error}</div>}
    </form>
  );
}
