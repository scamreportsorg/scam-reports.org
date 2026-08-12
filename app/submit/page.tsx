import { SafeLink as Link } from "@/components/safe-link";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { ReportSubmissionForm } from "@/components/report-submission-form";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { publicPageMetadata } from "@/lib/site-metadata";

export const metadata = publicPageMetadata({
  title: "Submit a Report",
  description: "Send a scam or cheating report to the moderation queue.",
  path: "/submit",
});

export default async function SubmitPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string }>;
}) {
  const params = await searchParams;
  const relatedReportId = /^SR-[A-Z0-9-]{4,40}$/.test(params.report ?? "") ? params.report! : "";
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Submit Report" }]} />
      <div className="page-heading">
        <div>
          <small>New case</small>
          <h1>Submit a report</h1>
        </div>
        <span>Nothing goes public before review</span>
      </div>
      <div className="intake-layout">
        <ReportSubmissionForm initialRelatedReportId={relatedReportId} />
        <aside className="intake-sidebar">
          <SectionBox title="Before you submit">
            <ul className="checklist">
              <li>Use the exact Discord username and numeric user ID.</li>
              <li>Separate what you saw from what you&apos;re assuming.</li>
              <li>Write events in order and include dates.</li>
              <li>Use original screenshots, not reposted collages.</li>
              <li>Remove unrelated names, emails, payment data, and private messages.</li>
              <li>Do not submit revenge reports, spam, or harassment.</li>
            </ul>
          </SectionBox>
          <SectionBox title="What happens next">
            <ol className="intake-process">
              <li>
                <b>Queued</b>
                <span>You receive a tracking ID.</span>
              </li>
              <li>
                <b>Reviewed</b>
                <span>A moderator checks context and removes private data.</span>
              </li>
              <li>
                <b>Decision</b>
                <span>The report may be rejected, held, or published.</span>
              </li>
            </ol>
          </SectionBox>
          <SectionBox title="Important">
            <div className="prose-block">
              <p>A submission is not proof. It stays private unless a moderator publishes it.</p>
              <Link className="text-link" href="/rules">
                Read the evidence rules
              </Link>
              <Link className="text-link" href="/appeals">
                Corrections and right of reply
              </Link>
            </div>
          </SectionBox>
        </aside>
      </div>
    </SiteShell>
  );
}
