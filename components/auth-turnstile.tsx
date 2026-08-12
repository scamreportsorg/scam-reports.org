"use client";

import { useEffect, useRef, useState } from "react";

type TurnstileApi = NonNullable<Window["turnstile"]>;

const scriptId = "cloudflare-turnstile-script";
const scriptSource = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise: Promise<TurnstileApi> | null = null;

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.getElementById(scriptId) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    const loaded = () => {
      script.dataset.loaded = "true";
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Cloudflare Turnstile loaded without exposing its browser API."));
    };
    const failed = () => reject(new Error("Cloudflare Turnstile could not be loaded."));

    if (existing) {
      if (existing.dataset.loaded === "true") loaded();
      else {
        existing.addEventListener("load", loaded, { once: true });
        existing.addEventListener("error", failed, { once: true });
      }
      return;
    }

    script.id = scriptId;
    script.src = scriptSource;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });

  return scriptPromise;
}

export function AuthTurnstile({ action }: { action: string }) {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const container = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!siteKey || !container.current) return;

    let cancelled = false;
    let widgetId: string | null = null;
    setFailed(false);
    void loadTurnstile()
      .then((turnstile) => {
        if (cancelled || !container.current) return;
        widgetId = turnstile.render(container.current, {
          sitekey: siteKey,
          action,
          theme: "dark",
        });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [action, siteKey]);

  if (!siteKey) {
    return (
      <p className="form-error" role="alert">
        The anti-abuse check isn&apos;t configured, so sign-in is disabled for now.
      </p>
    );
  }
  return (
    <div className="auth-turnstile">
      <div className="cf-turnstile" ref={container} />
      {failed && (
        <p className="form-error" role="alert">
          The anti-abuse check didn&apos;t load. Disable content blocking for this page, then
          reload.
        </p>
      )}
    </div>
  );
}
