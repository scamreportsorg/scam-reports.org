import { Breadcrumbs } from "@/components/breadcrumbs";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { publicPageMetadata } from "@/lib/site-metadata";

export const metadata = publicPageMetadata({
  title: "Privacy",
  description: "What we store, what can go public, and how to request a correction.",
  path: "/privacy",
});

export default function PrivacyPage() {
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Privacy" }]} />
      <div className="page-heading">
        <div>
          <small>What we keep and why</small>
          <h1>Privacy</h1>
        </div>
      </div>

      <SectionBox title="In short">
        <p>
          We keep what&apos;s needed to run accounts, review reports, stop abuse and fix the
          archive. Reports and evidence start private. Nothing is auto-published. We don&apos;t sell
          personal data or run ad trackers.
        </p>
      </SectionBox>

      <div className="content-columns">
        <SectionBox title="What can be public">
          <ul className="rule-list">
            <li>A published report, its status, dates, category, and public moderation notes.</li>
            <li>Evidence that has been sanitized and approved for publication.</li>
            <li>Approved reviews and replies under a member&apos;s chosen public handle.</li>
            <li>Limited contribution totals, community rank, and aggregate site statistics.</li>
          </ul>
          <p>
            Emails, linked Discord IDs, reporter contacts, private evidence, application answers and
            staff notes never appear on public profiles.
          </p>
        </SectionBox>

        <SectionBox title="What stays private">
          <ul className="rule-list">
            <li>Pending or rejected submissions, appeals, reviews, replies, and revisions.</li>
            <li>Original evidence files and anything withheld during privacy review.</li>
            <li>
              Account identities, login records, private contact details, and staff audit data.
            </li>
            <li>Moderator applications, internal review notes, abuse signals, and backups.</li>
          </ul>
          <p>
            Staff access follows account roles. Sensitive actions also require a recent sign-in.
          </p>
        </SectionBox>
      </div>

      <SectionBox title="Accounts and cookies">
        <p>
          Sign-in uses Discord OAuth or a one-time email link. We set session and CSRF cookies, but
          no advertising cookies. Sign-in links and login transactions expire on fixed schedules.
          Rate limits use keyed hashes rather than raw IP addresses. The private attack monitor
          stores short-lived rotating aliases, not raw addresses, request bodies, cookies or full
          user-agent strings.
        </p>
      </SectionBox>

      <SectionBox title="Service providers">
        <p>
          Cloudflare runs the Worker, database, storage, image processing, bot protection and
          monitoring. Discord handles optional sign-in and rank sync. Resend sends login emails and
          private staff alerts. GitHub hosts source and releases once the repo is public. Each
          service gets only what it needs for that job.
        </p>
      </SectionBox>

      <SectionBox title="Retention and corrections">
        <p>
          Authentication and rate-limit records expire on fixed schedules. Private case material
          stays only while it is needed for moderation, appeals, safety or a documented hold.
          Finished and inactive moderator applications are stripped of answers and internal notes
          after 90 days. Backups have their own restricted retention schedule.
        </p>
        <p>
          To correct a public record, dispute an identity, or request deletion of private material,
          use the <a href="/appeals">appeal form</a>. For privacy questions, email{" "}
          <a href="mailto:scam.reports.org@gmail.com">scam.reports.org@gmail.com</a>. We may ask for
          enough detail to find the record and make sure you&apos;re allowed to request the change.
        </p>
      </SectionBox>

      <SectionBox title="Last updated">
        <p>11 August 2026. Any important change goes here before it takes effect.</p>
      </SectionBox>
    </SiteShell>
  );
}
