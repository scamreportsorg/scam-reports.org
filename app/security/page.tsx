import { Breadcrumbs } from "@/components/breadcrumbs";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { exactSourceUrl, getPublicVersion } from "@/lib/version";
import { publicPageMetadata } from "@/lib/site-metadata";

export const metadata = publicPageMetadata({
  title: "Security",
  description:
    "How to report a security problem to Scam-Reports.org without exposing users or evidence.",
  path: "/security",
});

export default function SecurityPage() {
  const version = getPublicVersion();

  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Security" }]} />
      <div className="page-heading">
        <div>
          <small>Found a bug?</small>
          <h1>Report a security problem</h1>
        </div>
      </div>

      <SectionBox title="Contact">
        <p>
          Email <a href="mailto:scam.reports.org@gmail.com">scam.reports.org@gmail.com</a> with
          <b> [SECURITY]</b> in the subject. Tell us which page or release is affected, what
          happened and the smallest safe way to reproduce it.
        </p>
        {version.sourceAvailable && (
          <p>
            You can also report it through{" "}
            <a href={`${version.sourceUrl}/security/advisories/new`} rel="noreferrer">
              GitHub private vulnerability reporting
            </a>
            . The deployed source is pinned to{" "}
            <a href={exactSourceUrl(version)} rel="noreferrer">
              this exact commit
            </a>
            .
          </p>
        )}
      </SectionBox>

      <div className="content-columns">
        <SectionBox title="Do">
          <ul className="rule-list">
            <li>Use your own account and test data.</li>
            <li>Stop as soon as you can prove the issue.</li>
            <li>Remove tokens, private evidence, and unrelated personal data from the report.</li>
            <li>Give us time to reproduce and fix it before publishing details.</li>
          </ul>
        </SectionBox>

        <SectionBox title="Don't">
          <ul className="rule-list danger-list">
            <li>Access another person&apos;s account, reports, evidence, or moderator data.</li>
            <li>
              Run denial-of-service tests, social engineering, persistence, or destructive tools.
            </li>
            <li>
              Post an unpatched vulnerability in a report, issue, pull request, or public chat.
            </li>
            <li>
              Upload real malware, stolen credentials, or material you are not allowed to share.
            </li>
          </ul>
        </SectionBox>
      </div>

      <SectionBox title="What is in scope">
        <p>
          Auth, account linking, permissions, moderation, evidence handling, D1 and R2, uploads,
          public APIs, notifications, Discord, backups and the release pipeline are in scope.
          Disagreements about a moderation decision or report belong in the appeal form.
        </p>
      </SectionBox>
    </SiteShell>
  );
}
