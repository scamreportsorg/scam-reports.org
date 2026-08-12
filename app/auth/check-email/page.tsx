import { SafeLink as Link } from "@/components/safe-link";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";

export default function CheckEmailPage() {
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Check your email" }]} />
      <div className="page-heading">
        <div>
          <small>One-time sign-in link</small>
          <h1>Check your inbox</h1>
        </div>
      </div>
      <SectionBox title="What to do next" className="admin-login">
        <p>
          If the address can receive mail, the link is on its way. It works once and expires after
          15 minutes.
        </p>
        <p className="compact-copy">
          Check spam before requesting another one. We don&apos;t confirm whether an address already
          has an account.
        </p>
        <Link className="forum-button" href="/auth/sign-in">
          Back to sign in
        </Link>
      </SectionBox>
    </SiteShell>
  );
}
