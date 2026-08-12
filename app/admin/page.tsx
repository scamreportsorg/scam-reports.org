import { AdminDashboard } from "@/components/admin-dashboard";
import { AdminAccountsPanel } from "@/components/admin-accounts-panel";
import { AdminOperationsPanel } from "@/components/admin-operations-panel";
import { AdminModeratorApplicationQueue } from "@/components/admin/moderator-application-queue";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { SiteShell } from "@/components/site-shell";
import { getOptionalServerAuth, isFreshServerAuth } from "@/lib/auth-server";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const auth = await getOptionalServerAuth();
  if (!auth) {
    redirect("/auth/sign-in?returnTo=%2Fadmin");
  }
  if (auth.principal.account.role === "member") {
    return (
      <SiteShell>
        <Breadcrumbs items={[{ label: "Moderator Control Panel" }]} />
        <section className="forum-box admin-login">
          <div className="forum-box-title">
            <h2>Access denied</h2>
            <span>Moderator role required</span>
          </div>
          <div className="empty-state">You don&apos;t have access to the moderation tools.</div>
        </section>
      </SiteShell>
    );
  }
  if (!auth.principal.linkedProviders.discord || !auth.principal.linkedProviders.email) {
    redirect("/account?notice=staff-identities-required");
  }
  if (!isFreshServerAuth(auth)) {
    redirect("/auth/sign-in?returnTo=%2Fadmin&reason=fresh-auth-required");
  }
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Moderator Control Panel" }]} />
      <div className="admin-workspace">
        <header className="forum-box admin-hero">
          <div className="forum-box-title admin-hero-title">
            <h1>Staff panel</h1>
            <span>Moderator tools</span>
          </div>
          <div className="admin-hero-body">
            <p>Review queues, edit reports, and check service operations.</p>
            <div className="admin-hero-status">
              <strong>Role: {auth.principal.account.role}</strong>
              <small>Actions are logged</small>
            </div>
          </div>
        </header>
        <nav className="admin-section-nav" aria-label="Control panel sections">
          <a href="#applications">Applications</a>
          <a href="#moderation">Moderation</a>
          {auth.principal.account.role === "admin" && <a href="#accounts">Accounts</a>}
          {auth.principal.account.role === "admin" && <a href="#operations">Operations</a>}
        </nav>
        <div id="applications" className="admin-anchor-section">
          <AdminModeratorApplicationQueue
            csrfToken={auth.csrfToken}
            role={auth.principal.account.role}
          />
        </div>
        <div id="moderation" className="admin-anchor-section">
          <AdminDashboard initialCsrfToken={auth.csrfToken} />
        </div>
        {auth.principal.account.role === "admin" && (
          <>
            <div id="accounts" className="admin-anchor-section">
              <AdminAccountsPanel csrfToken={auth.csrfToken} />
            </div>
            <div id="operations" className="admin-anchor-section">
              <AdminOperationsPanel csrfToken={auth.csrfToken} />
            </div>
          </>
        )}
      </div>
    </SiteShell>
  );
}
