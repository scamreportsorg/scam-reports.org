import { Breadcrumbs } from "@/components/breadcrumbs";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { publicPageMetadata } from "@/lib/site-metadata";

export const metadata = publicPageMetadata({
  title: "Evidence and Publication Rules",
  description: "The evidence, privacy, review, and publication rules for Scam-Reports.org.",
  path: "/rules",
});

export default function RulesPage() {
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Reporting Rules" }]} />
      <div className="page-heading">
        <div>
          <small>Before you post</small>
          <h1>Evidence and Publication Rules</h1>
        </div>
      </div>
      <div className="content-columns">
        <SectionBox title="Every report needs this">
          <ol className="rule-list">
            <li>
              <b>Explain what happened.</b> Put events in order and say what each attachment shows.
            </li>
            <li>
              <b>Pick the right category.</b> Cheating, cheat sales, scams, malware, impersonation
              and ban evasion are separate things.
            </li>
            <li>
              <b>Keep the originals.</b> Do not crop out details that change the meaning.
            </li>
            <li>
              <b>Remove private data.</b> Leave out addresses, emails, tokens, payment details, and
              anything unrelated.
            </li>
            <li>
              <b>Don&apos;t call it proven.</b> A claim stays an allegation until moderators check
              it.
            </li>
            <li>
              <b>Leave room for a reply.</b> Anyone named can send a correction, context or appeal.
            </li>
          </ol>
        </SectionBox>
        <SectionBox title="We reject these">
          <ul className="rule-list danger-list">
            <li>
              Threats, revenge reports, coordinated harassment, or knowingly false information.
            </li>
            <li>
              Unrelated doxxing, private credentials, intimate content, or financial account
              details.
            </li>
            <li>Screenshots with no identifiable timeline or explanation.</li>
            <li>Duplicate submissions that add no new evidence.</li>
            <li>Demands to label someone guilty before review.</li>
          </ul>
        </SectionBox>
      </div>
      <SectionBox title="Reviews and reputation">
        <ol className="rule-list review-rules-grid">
          <li>
            <b>Say how you know.</b> Were you the buyer, a player, server staff, a researcher, or
            somebody else involved?
          </li>
          <li>
            <b>Separate fact from opinion.</b> Say what you saw yourself and what you could not
            verify.
          </li>
          <li>
            <b>No vote brigading.</b> Coordinated reviews, duplicate accounts, and copied text are
            removed.
          </li>
          <li>
            <b>Moderation first.</b> Reviews do not affect reputation until a moderator approves
            them.
          </li>
          <li>
            <b>Corrections stay open.</b> Anyone named in a report can add context or appeal it.
          </li>
          <li>
            <b>No personal data.</b> Never include real-world addresses, private contact details,
            credentials, or unrelated identities.
          </li>
        </ol>
      </SectionBox>
    </SiteShell>
  );
}
