import { SafeLink as Link } from "@/components/safe-link";
import { AppealForm } from "@/components/appeal-form";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { SectionBox } from "@/components/section-box";
import { SiteShell } from "@/components/site-shell";
import { publicPageMetadata } from "@/lib/site-metadata";

export const metadata = publicPageMetadata({
  title: "Corrections and Appeals",
  description: "Ask moderators to correct a report or add a right of reply.",
  path: "/appeals",
});

export default async function AppealsPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string }>;
}) {
  const params = await searchParams;
  const reportId = /^SR-[A-Z0-9-]{4,40}$/.test(params.report ?? "") ? params.report! : "";
  return (
    <SiteShell>
      <Breadcrumbs items={[{ label: "Corrections & Appeals" }]} />
      <div className="page-heading">
        <div>
          <small>Fix the record</small>
          <h1>Corrections and appeals</h1>
        </div>
        <span>Private while it&apos;s reviewed</span>
      </div>
      <div className="intake-layout">
        <AppealForm initialReportId={reportId} />
        <aside className="intake-sidebar">
          <SectionBox title="What we need">
            <ul className="checklist">
              <li>The report ID shown on the public record.</li>
              <li>The exact claim or attachment being disputed.</li>
              <li>A clear explanation of what should change and why.</li>
              <li>Something we can check against the report.</li>
              <li>No unrelated personal information.</li>
            </ul>
          </SectionBox>
          <SectionBox title="Review process">
            <ol className="intake-process">
              <li>
                <b>Received</b>
                <span>You get a tracking ID.</span>
              </li>
              <li>
                <b>Verified</b>
                <span>We check the identity and supporting files.</span>
              </li>
              <li>
                <b>Resolved</b>
                <span>The report may be corrected, given a note, or left as it is.</span>
              </li>
            </ol>
          </SectionBox>
          <SectionBox title="Need the report ID?">
            <div className="prose-block">
              <p>
                Open the relevant profile and copy the ID beginning with <code>SR-</code>.
              </p>
              <Link className="forum-button full" href="/#database">
                Find a report
              </Link>
              <Link className="text-link" href="/rules">
                Read the publication rules
              </Link>
            </div>
          </SectionBox>
        </aside>
      </div>
    </SiteShell>
  );
}
