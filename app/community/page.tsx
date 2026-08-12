import { Breadcrumbs } from "@/components/breadcrumbs";
import { SafeLink as Link } from "@/components/safe-link";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { getPublicVersion } from "@/lib/version";
import { publicPageMetadata } from "@/lib/site-metadata";

export const metadata = publicPageMetadata({
  title: "Community and Open Source",
  description: "Ways to help with reports, code, moderation, and the site.",
  path: "/community",
});

export default function CommunityPage() {
  const version = getPublicVersion();

  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Community" }]} />
      <div className="page-heading">
        <div>
          <small>Get involved</small>
          <h1>Community and Open Source</h1>
        </div>
        <span>Free to use, with no paid ranks or moderation.</span>
      </div>

      <section className="forum-notice" aria-label="Community purpose">
        <strong>The point:</strong>
        <span>
          Build a useful record of scams and abuse. Don&apos;t brigade anyone, post private data,
          buy influence, or treat an unchecked claim as fact.
        </span>
      </section>

      <div className="content-columns">
        <SectionBox title="Help with the archive">
          <ul className="rule-list">
            <li>
              <b>Send the useful parts.</b> Tell us what happened, when, and where the evidence came
              from. Leave unrelated stuff out.
            </li>
            <li>
              <b>Stick to what you know.</b> First-hand details are best. If you add research, make
              it easy for someone else to check.
            </li>
            <li>
              <b>See a mistake?</b> Flag duplicates or send an appeal. That covers corrections,
              identity mix-ups, and replies from the person named.
            </li>
            <li>
              <b>Share, don&apos;t mob.</b> Linking a report is fine. Sending a crowd after someone
              or calling an open report proven isn&apos;t.
            </li>
          </ul>
          <div className="thread-actions">
            <Link className="forum-button" href="/submit">
              Submit a report
            </Link>
            <Link className="forum-button subtle" href="/appeals">
              Corrections &amp; appeals
            </Link>
            <Link className="forum-button subtle" href="/rules">
              Read the rules
            </Link>
          </div>
        </SectionBox>

        <SectionBox title="Help with the code">
          <p className="compact-copy">
            Code, tests, docs, design, accessibility, translations and policy work are all useful.
            GitHub is for the software. Real cases and private data stay on the site.
          </p>
          <ul className="rule-list">
            <li>Keep pull requests small enough to review.</li>
            <li>Use made-up test data, never real case material.</li>
            <li>Add tests when you change how something works.</li>
            <li>Read the Code of Conduct and security notes first.</li>
            <li>
              Add a DCO sign-off to non-merge commits with <code>git commit --signoff</code>.
            </li>
            <li>Contributions must be compatible with AGPL-3.0-or-later.</li>
          </ul>
          {version.sourceAvailable ? (
            <p className="compact-copy">
              <a href={version.sourceUrl} rel="noreferrer">
                Open the source repository
              </a>
              {" / "}
              <a href={version.sourceUrl + "/blob/main/CONTRIBUTING.md"} rel="noreferrer">
                Contribution guide
              </a>
              {" / "}
              <a href={version.sourceUrl + "/security/advisories/new"} rel="noreferrer">
                Report a security issue privately
              </a>
            </p>
          ) : (
            <p className="thread-notice">
              Source links will appear once the repo and its matching release archive are public.
            </p>
          )}
        </SectionBox>
      </div>

      <SectionBox title="Ranks, roles and access">
        <div className="report-table-wrap">
          <table className="report-table community-systems-table">
            <tbody>
              <tr>
                <th scope="row">Account role</th>
                <td>
                  Member, moderator, or administrator. This controls site access. It can&apos;t be
                  bought or unlocked by posting more.
                </td>
              </tr>
              <tr>
                <th scope="row">Community rank</th>
                <td>
                  Tracks approved public contributions. It doesn&apos;t add review weight, prove
                  trust, or unlock staff tools.{" "}
                  <Link href="/community/ranks">Rank ladder and points.</Link>
                </td>
              </tr>
              <tr>
                <th scope="row">Report reputation</th>
                <td>
                  A score on a reported profile, based on case status and approved reviews. It is
                  not a member rank or legal verdict.{" "}
                  <Link href="/rankings">How scoring works.</Link>
                </td>
              </tr>
              <tr>
                <th scope="row">Repository role</th>
                <td>
                  Contributor or maintainer access to the code. It never includes private cases or
                  production access.
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </SectionBox>

      <div className="content-columns">
        <SectionBox title="Moderation applications">
          <p className="compact-copy">
            Applications stay private. You&apos;ll need an active account with email and Discord
            linked. We want people who stay calm, handle private data properly, apply the rules
            consistently, explain decisions clearly and disclose conflicts.
          </p>
          <ul className="rule-list">
            <li>A high rank shows activity. It does not grant staff access.</li>
            <li>There&apos;s no fast lane, automatic promotion or guaranteed acceptance.</li>
            <li>
              Moderators can start or reject a review. Only an administrator can accept an
              application and grant access.
            </li>
            <li>
              Admin is a separate role for experienced moderators when another operator is needed.
              It isn&apos;t a badge.
            </li>
          </ul>
          <Link className="forum-button" href="/account">
            View moderator application
          </Link>
        </SectionBox>

        <SectionBox title="No paywalls or paid influence">
          <p className="compact-copy">
            The official site is free. We don&apos;t sell premium accounts, ranks, moderation,
            evidence access or user data. If donations ever open, we&apos;ll say so publicly. Donors
            still won&apos;t get special access or a say in cases.
          </p>
          <p className="compact-copy">
            We don&apos;t make a profit from the project. Scam-Reports.org is not a registered
            charity.
          </p>
          {version.sourceAvailable && (
            <a
              className="forum-button subtle"
              href={version.sourceUrl + "/blob/main/docs/FREE_ACCESS.md"}
              rel="noreferrer"
            >
              Read the permanent policy
            </a>
          )}
        </SectionBox>
      </div>

      <SectionBox title="About the AGPL license">
        <p>
          The AGPL lets you inspect, run, change and share the software, including commercially. If
          you run a modified version as an online service, you generally need to offer that source
          to its users.
        </p>
        <p>
          The license covers code, not our live data. Production databases, private evidence,
          identities, staff notes, backups and secrets are not part of the source release. Free
          access and non-profit operation are separate policies for the official site.
        </p>
        {version.sourceAvailable && (
          <p className="compact-copy">
            <a href={version.sourceUrl + "/blob/main/docs/LICENSING.md"} rel="noreferrer">
              Practical license guide
            </a>
            {" / "}
            <a href={version.sourceUrl + "/blob/main/LICENSE"} rel="noreferrer">
              Full license text
            </a>
          </p>
        )}
      </SectionBox>
    </SiteShell>
  );
}
