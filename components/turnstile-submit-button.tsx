"use client";

import { useEffect, useRef, useState } from "react";

function hasTurnstileToken(form: HTMLFormElement) {
  const input = form.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
  return Boolean(input?.value.trim());
}

export function TurnstileSubmitButton({ children }: { children: React.ReactNode }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [ready, setReady] = useState(false);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    const form = buttonRef.current?.closest("form");
    if (!form) return;

    const refresh = () => setReady(hasTurnstileToken(form));
    const stopEarlySubmit = (event: SubmitEvent) => {
      if (hasTurnstileToken(form)) return;
      event.preventDefault();
      setAttempted(true);
      refresh();
    };

    refresh();
    form.addEventListener("submit", stopEarlySubmit, true);
    const observer = new MutationObserver(refresh);
    observer.observe(form, { childList: true, subtree: true, attributes: true });
    const interval = window.setInterval(refresh, 250);

    return () => {
      form.removeEventListener("submit", stopEarlySubmit, true);
      observer.disconnect();
      window.clearInterval(interval);
    };
  }, []);

  return (
    <>
      <button ref={buttonRef} className="forum-button full" type="submit" disabled={!ready}>
        {children}
      </button>
      {!ready && (
        <p
          className={attempted ? "form-error" : "compact-copy"}
          role={attempted ? "alert" : "status"}
        >
          Waiting for the anti-abuse check. If it doesn&apos;t show up, disable content blocking for
          this page and reload.
        </p>
      )}
    </>
  );
}
