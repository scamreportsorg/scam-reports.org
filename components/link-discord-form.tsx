"use client";

import { FormEvent, useState } from "react";

type DiscordStartResponse = {
  authorizationUrl?: unknown;
  error?: unknown;
};

export function LinkDiscordForm({
  csrfToken,
  label = "Link Discord",
  returnTo = "/account?updated=identity",
}: {
  csrfToken: string;
  label?: string;
  returnTo?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function beginLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError("");

    try {
      const body = new URLSearchParams({
        csrfToken,
        returnTo,
      });
      const response = await fetch("/api/auth/discord/start", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body,
      });
      const payload = (await response.json().catch(() => ({}))) as DiscordStartResponse;
      if (!response.ok) {
        throw new Error(
          typeof payload.error === "string" ? payload.error : "We couldn't start Discord linking.",
        );
      }

      if (typeof payload.authorizationUrl !== "string") {
        throw new Error("Discord returned an invalid sign-in address.");
      }
      const authorizationUrl = new URL(payload.authorizationUrl);
      if (
        authorizationUrl.origin !== "https://discord.com" ||
        authorizationUrl.pathname !== "/oauth2/authorize"
      ) {
        throw new Error("Discord returned an invalid sign-in address.");
      }

      window.location.assign(authorizationUrl.toString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "We couldn't start Discord linking.");
      setBusy(false);
    }
  }

  return (
    <form
      method="post"
      action="/api/auth/discord/start"
      className="review-form"
      onSubmit={beginLink}
    >
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <button className="forum-button" type="submit" disabled={busy}>
        {busy ? "Opening Discord..." : label}
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
