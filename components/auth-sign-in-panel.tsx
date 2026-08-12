import { SafeLink as Link } from "./safe-link";
import { AuthTurnstile } from "./auth-turnstile";
import { TurnstileSubmitButton } from "./turnstile-submit-button";

export function AuthSignInPanel({
  returnTo,
  stepUp = false,
  providers,
}: {
  returnTo: string;
  stepUp?: boolean;
  providers: { discord: boolean; email: boolean };
}) {
  return (
    <section className="forum-box admin-login auth-sign-in-panel">
      <div className="forum-box-title">
        <h1>Sign in</h1>
        <span>No password</span>
      </div>
      <div className="forum-box-body">
        <div className="auth-provider-block">
          <h2>Use Discord or email</h2>
          <p>
            {stepUp
              ? "Sign in again to open the staff area."
              : "You need an account to post. Reading stays public."}
          </p>
          {providers.discord ? (
            <Link
              className="forum-button full"
              href={`/api/auth/discord/start?returnTo=${encodeURIComponent(returnTo)}`}
            >
              Continue with Discord
            </Link>
          ) : (
            <button className="forum-button full" type="button" disabled>
              Discord sign-in unavailable
            </button>
          )}
        </div>
        {providers.email ? (
          <form method="post" action="/api/auth/magic/request" className="review-form">
            <input type="hidden" name="purpose" value="login" />
            <input type="hidden" name="returnTo" value={returnTo} />
            <label>
              Or get a one-time email link
              <input
                required
                type="email"
                name="email"
                autoComplete="email"
                maxLength={254}
                placeholder="you@example.com"
              />
            </label>
            <AuthTurnstile action="magic_link" />
            <TurnstileSubmitButton>Email me a sign-in link</TurnstileSubmitButton>
          </form>
        ) : (
          <p className="thread-notice" role="status">
            Email sign-in is currently unavailable.
          </p>
        )}
        <p className="compact-copy">
          Email links work once and expire after 15 minutes. By continuing, you agree to the{" "}
          <Link href="/rules">community rules</Link>.
        </p>
      </div>
    </section>
  );
}
