"use client";

import { useEffect, useState } from "react";

type MemberFormAuth = {
  loading: boolean;
  authenticated: boolean;
  csrfToken: string;
  handle: string;
  error: string;
};

type SessionPayload = {
  authenticated?: boolean;
  csrfToken?: string | null;
  account?: { handle?: string };
};

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: { sitekey: string; action: string; theme: "dark" },
      ) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId?: string | HTMLElement) => void;
    };
  }
}

export function useMemberFormAuth(): MemberFormAuth {
  const [state, setState] = useState<MemberFormAuth>({
    loading: true,
    authenticated: false,
    csrfToken: "",
    handle: "",
    error: "",
  });

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/auth/session", {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as SessionPayload;
        if (
          !response.ok ||
          payload.authenticated !== true ||
          !payload.csrfToken ||
          !payload.account?.handle
        ) {
          setState({
            loading: false,
            authenticated: false,
            csrfToken: "",
            handle: "",
            error: "",
          });
          return;
        }
        setState({
          loading: false,
          authenticated: true,
          csrfToken: payload.csrfToken,
          handle: payload.account.handle,
          error: "",
        });
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          loading: false,
          authenticated: false,
          csrfToken: "",
          handle: "",
          error: "We couldn't check your session.",
        });
      });
    return () => controller.abort();
  }, []);

  return state;
}

export function resetTurnstile() {
  window.turnstile?.reset();
}
