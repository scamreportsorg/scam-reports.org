import { SafeLink as Link } from "@/components/safe-link";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { safeAuthErrorCode } from "@/lib/auth-errors";

const messages: Record<string, string> = {
  access_denied: "Sign-in was cancelled. Nothing changed on your account.",
  browser_context_required:
    "Open this link in the browser where you requested it, or request a new one here.",
  discord_unavailable: "Discord couldn't verify this sign-in. Try again in a moment.",
  email_unavailable: "We couldn't send the sign-in email. Try again in a moment.",
  expired_link: "This link expired or has already been used.",
  identity_conflict: "That identity is already linked to a different account.",
  invalid_callback: "This sign-in request is invalid or expired.",
  invalid_link: "This sign-in link is invalid.",
  session_required: "Sign in before linking another identity.",
  turnstile_failed: "The anti-abuse check failed. Reload the page and try again.",
  turnstile_required: "Complete the anti-abuse check before requesting a sign-in link.",
  auth_unavailable: "Sign-in is unavailable right now. Try again soon.",
};

export default async function AuthErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const params = await searchParams;
  const code = safeAuthErrorCode(params.code ?? null);
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Authentication error" }]} />
      <div className="page-heading">
        <div>
          <small>Sign-in failed</small>
          <h1>Couldn&apos;t sign you in</h1>
        </div>
      </div>
      <SectionBox title="What happened" className="admin-login">
        <div className="form-error">{messages[code] ?? messages.auth_unavailable}</div>
        <Link className="forum-button" href="/auth/sign-in">
          Try again
        </Link>
      </SectionBox>
    </SiteShell>
  );
}
