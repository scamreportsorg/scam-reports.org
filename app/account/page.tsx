import { AccountPanel } from "@/components/account-panel";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { ModeratorApplicationPanel } from "@/components/moderator-application-panel";
import { SiteShell } from "@/components/site-shell";
import { listAccountIdentities } from "@/lib/auth";
import { requireServerMember } from "@/lib/auth-server";
import { getDiscordRankSyncStatus } from "@/lib/discord-rank-sync";
import { findLatestModeratorApplicationForAccount } from "@/lib/moderator-applications";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<{ updated?: string }>;
}) {
  const [context, params] = await Promise.all([requireServerMember("/account"), searchParams]);
  const [identities, moderatorApplication, discordRankSync] = await Promise.all([
    listAccountIdentities(context.principal.account.id),
    findLatestModeratorApplicationForAccount(context.principal.account.id),
    getDiscordRankSyncStatus(context.principal.account.id),
  ]);
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Account" }]} />
      <div className="page-heading">
        <div>
          <small>Your account</small>
          <h1>{context.principal.account.handle}</h1>
        </div>
        <span>Contact details and provider IDs stay private</span>
      </div>
      <AccountPanel
        account={context.principal.account}
        identities={identities}
        csrfToken={context.csrfToken}
        discordRankSync={discordRankSync}
        updated={params.updated}
      />
      <ModeratorApplicationPanel
        csrfToken={context.csrfToken}
        role={context.principal.account.role}
        linkedProviders={context.principal.linkedProviders}
        initialApplication={moderatorApplication}
      />
    </SiteShell>
  );
}
