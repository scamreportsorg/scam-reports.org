import { SafeLink as Link } from "@/components/safe-link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/breadcrumbs";
import { CommunityReviews } from "@/components/community-reviews";
import { DiscussionForm } from "@/components/discussion-form";
import { DiscussionThread } from "@/components/discussion-thread";
import { EvidenceGallery } from "@/components/evidence-gallery";
import { ReputationScore } from "@/components/reputation-score";
import { ReviewForm } from "@/components/review-form";
import { SiteShell } from "@/components/site-shell";
import { StatusBadge } from "@/components/status-badge";
import { listAppeals, listPublicCommentsPage } from "@/lib/community-intake";
import { formatDate } from "@/lib/format";
import { listReportFamilyIds, resolveReport } from "@/lib/reports";
import { findAdjacentPublicReports } from "@/lib/report-query";
import { calculateReputationFromAggregates } from "@/lib/reputation";
import { approvedReviewAggregate, listPublicReviewsPage } from "@/lib/reviews";
import { publicPageMetadata } from "@/lib/site-metadata";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const resolution = await resolveReport(id);
  if (!resolution) {
    return {
      ...publicPageMetadata({
        title: "Report not found",
        description: "This report is not available in the public archive.",
        path: `/reports/${encodeURIComponent(id)}`,
      }),
      robots: { index: false, follow: false },
    };
  }

  const { report, canonicalId } = resolution;
  return publicPageMetadata({
    title: `${report.username} | report`,
    description: `${report.category} report for ${report.username}. Current status: ${report.status}.`,
    path: `/reports/${encodeURIComponent(canonicalId)}`,
  });
}

function positivePage(value: string | string[] | undefined) {
  const parsed = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 1;
}

function threadPageHref(
  reviewPage: number,
  commentPage: number,
  target: "reviews" | "comments",
  page: number,
) {
  const search = new URLSearchParams();
  const nextReviews = target === "reviews" ? page : reviewPage;
  const nextComments = target === "comments" ? page : commentPage;
  if (nextReviews > 1) search.set("reviewPage", String(nextReviews));
  if (nextComments > 1) search.set("commentPage", String(nextComments));
  const suffix = search.size ? `?${search}` : "";
  return `${suffix}#${target === "reviews" ? "community-reviews" : "discussion"}`;
}

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const requestedReviewPage = positivePage(query.reviewPage);
  const requestedCommentPage = positivePage(query.commentPage);
  const resolution = await resolveReport(id);

  if (!resolution) {
    notFound();
  }
  if (resolution.redirected) {
    const redirectSearch = new URLSearchParams();
    if (requestedReviewPage > 1) {
      redirectSearch.set("reviewPage", String(requestedReviewPage));
    }
    if (requestedCommentPage > 1) {
      redirectSearch.set("commentPage", String(requestedCommentPage));
    }
    const redirectSuffix = redirectSearch.size ? `?${redirectSearch}` : "";
    redirect(`/reports/${encodeURIComponent(resolution.canonicalId)}${redirectSuffix}`);
  }
  const report = resolution.report;

  const familyIds = await listReportFamilyIds(report.id);
  const [adjacent, reviewPage, commentPage, reviewAggregate, publicAppeals] = await Promise.all([
    findAdjacentPublicReports(report.id, report.dateAdded),
    listPublicReviewsPage({ reportIds: familyIds, page: requestedReviewPage, pageSize: 25 }),
    listPublicCommentsPage({ reportIds: familyIds, page: requestedCommentPage, pageSize: 25 }),
    approvedReviewAggregate(familyIds),
    listAppeals({ reportIds: familyIds, publicOnly: true }),
  ]);
  const reviews = reviewPage.items;
  const comments = commentPage.items;
  const reputation = calculateReputationFromAggregates(report, {
    ...reviewAggregate,
    evidenceCount: report.evidence.length,
  });
  const approvedReviewCount = `${reputation.reviewCount} approved review${
    reputation.reviewCount === 1 ? "" : "s"
  }`;
  const communityRating =
    reputation.averageRating === null
      ? "No approved ratings yet"
      : `${reputation.averageRating.toFixed(1)} / 5 from ${approvedReviewCount}`;

  return (
    <SiteShell>
      <Breadcrumbs
        items={[
          { label: "Report Database", href: "/#database" },
          { label: report.game, href: `/?q=${encodeURIComponent(report.game)}` },
          { label: report.username },
        ]}
      />
      <div className="thread-toolbar">
        <div>
          <small>Report thread {report.id}</small>
          <h1>{report.username}: report thread</h1>
        </div>
        <StatusBadge status={report.status} />
      </div>
      <section className="thread-notice">
        This is a community report. Only a Confirmed badge means moderators found enough evidence
        for its main claim.
      </section>
      <section className="reputation-overview">
        <ReputationScore summary={reputation} />
        <div>
          <strong>Community rating</strong>
          <span>{communityRating}</span>
        </div>
        <p>
          The score uses report status and approved reviews. It isn&apos;t a guarantee.{" "}
          <Link href="/rankings">See how it works.</Link>
        </p>
      </section>

      <article className="forum-post original-post">
        <aside className="post-author">
          <div className="avatar-placeholder" aria-hidden="true">
            {report.username.slice(0, 2).toUpperCase()}
          </div>
          <strong>{report.username}</strong>
          <StatusBadge status={report.status} compact />
          <dl>
            <div>
              <dt>Discord ID</dt>
              <dd>{report.discordId}</dd>
            </div>
            <div>
              <dt>Game</dt>
              <dd>{report.game}</dd>
            </div>
            <div>
              <dt>Category</dt>
              <dd>{report.category}</dd>
            </div>
            <div>
              <dt>Report ID</dt>
              <dd>{report.id}</dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd>{report.evidence.length}</dd>
            </div>
          </dl>
        </aside>
        <div className="post-content">
          <header className="post-header">
            <span>Original report</span>
            <time dateTime={report.dateAdded}>{formatDate(report.dateAdded, true)} UTC</time>
          </header>
          <div className="post-section">
            <h2>Why it was reported</h2>
            <p className="report-reason">{report.reason}</p>
          </div>
          <div className="post-section">
            <h2>Account details</h2>
            <div className="identity-table">
              <div>
                <span>Username</span>
                <strong>{report.username}</strong>
              </div>
              <div>
                <span>Discord ID</span>
                <code>{report.discordId}</code>
              </div>
              <div>
                <span>Related game</span>
                <strong>{report.game}</strong>
              </div>
              <div>
                <span>Report category</span>
                <strong>{report.category}</strong>
              </div>
              <div>
                <span>Current status</span>
                <StatusBadge status={report.status} compact />
              </div>
            </div>
          </div>
          <div className="post-section">
            <h2>What happened</h2>
            <p>{report.description}</p>
          </div>
          <div className="post-section">
            <h2>Public moderator notes</h2>
            <div className="moderator-note">{report.notes || "No public moderator note yet."}</div>
          </div>
          <div className="post-section">
            <h2>Evidence attachments</h2>
            <EvidenceGallery evidence={report.evidence} />
          </div>
          <footer className="post-signature">
            Added {formatDate(report.dateAdded)} · Updated {formatDate(report.updatedAt)} · Evidence
            appears only after redaction review.
          </footer>
        </div>
      </article>

      <section className="thread-updates">
        <div className="forum-box-title">
          <h2>Moderator status history</h2>
          <span>
            {report.statusHistory.length} update
            {report.statusHistory.length === 1 ? "" : "s"}
          </span>
        </div>
        {report.statusHistory.map((entry, entryIndex) => (
          <article className="forum-post moderator-post" key={`${entry.date}-${entryIndex}`}>
            <aside className="post-author">
              <div className="avatar-placeholder moderator-avatar" aria-hidden="true">
                MOD
              </div>
              <strong>{entry.moderator}</strong>
              <small>Database moderator</small>
            </aside>
            <div className="post-content">
              <header className="post-header">
                <StatusBadge status={entry.status} compact />
                <time dateTime={entry.date}>{formatDate(entry.date, true)} UTC</time>
              </header>
              <p>{entry.note}</p>
            </div>
          </article>
        ))}
      </section>

      {publicAppeals.length > 0 && (
        <section className="thread-updates public-resolution-thread">
          <div className="forum-box-title">
            <h2>Corrections and rights of reply</h2>
            <span>
              {publicAppeals.length} published resolution{publicAppeals.length === 1 ? "" : "s"}
            </span>
          </div>
          {publicAppeals.map((appeal) => (
            <article className="public-resolution" key={appeal.id}>
              <header>
                <strong>{appeal.requestType}</strong>
                <time dateTime={appeal.updatedAt}>{formatDate(appeal.updatedAt)}</time>
              </header>
              <p>{appeal.publicResolution}</p>
              <small>{appeal.id} · Published by a moderator</small>
            </article>
          ))}
        </section>
      )}

      <section className="thread-updates community-review-thread" id="community-reviews">
        <div className="forum-box-title">
          <h2>Community reputation reviews</h2>
          <span>{reviewPage.pagination.totalItems} approved</span>
        </div>
        <CommunityReviews reviews={reviews} />
        {reviewPage.pagination.totalPages > 1 && (
          <nav className="pagination" aria-label="Review pages">
            {reviewPage.pagination.page > 1 ? (
              <Link
                href={threadPageHref(
                  reviewPage.pagination.page,
                  commentPage.pagination.page,
                  "reviews",
                  reviewPage.pagination.page - 1,
                )}
              >
                ← Previous reviews
              </Link>
            ) : (
              <span />
            )}
            <span>
              Page {reviewPage.pagination.page} of {reviewPage.pagination.totalPages}
            </span>
            {reviewPage.pagination.page < reviewPage.pagination.totalPages ? (
              <Link
                href={threadPageHref(
                  reviewPage.pagination.page,
                  commentPage.pagination.page,
                  "reviews",
                  reviewPage.pagination.page + 1,
                )}
              >
                Next reviews →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
        <ReviewForm reportId={report.id} username={report.username} />
      </section>

      <section className="thread-updates community-discussion-thread" id="discussion">
        <div className="forum-box-title">
          <h2>Report discussion</h2>
          <span>
            {commentPage.pagination.totalItems} approved repl
            {commentPage.pagination.totalItems === 1 ? "y" : "ies"}
          </span>
        </div>
        <DiscussionThread comments={comments} />
        {commentPage.pagination.totalPages > 1 && (
          <nav className="pagination" aria-label="Discussion pages">
            {commentPage.pagination.page > 1 ? (
              <Link
                href={threadPageHref(
                  reviewPage.pagination.page,
                  commentPage.pagination.page,
                  "comments",
                  commentPage.pagination.page - 1,
                )}
              >
                ← Previous replies
              </Link>
            ) : (
              <span />
            )}
            <span>
              Page {commentPage.pagination.page} of {commentPage.pagination.totalPages}
            </span>
            {commentPage.pagination.page < commentPage.pagination.totalPages ? (
              <Link
                href={threadPageHref(
                  reviewPage.pagination.page,
                  commentPage.pagination.page,
                  "comments",
                  commentPage.pagination.page + 1,
                )}
              >
                Next replies →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
        <DiscussionForm reportId={report.id} />
      </section>

      <nav className="thread-navigation" aria-label="Adjacent reports">
        {adjacent.newer ? (
          <Link href={`/reports/${adjacent.newer.id}`}>← Newer: {adjacent.newer.username}</Link>
        ) : (
          <span />
        )}
        {adjacent.older ? (
          <Link href={`/reports/${adjacent.older.id}`}>Older: {adjacent.older.username} →</Link>
        ) : (
          <span />
        )}
      </nav>
      <div className="thread-actions">
        <Link className="forum-button" href={`/submit?report=${encodeURIComponent(report.id)}`}>
          Add evidence
        </Link>
        <Link
          className="forum-button subtle"
          href={`/appeals?report=${encodeURIComponent(report.id)}`}
        >
          Correct or appeal
        </Link>
      </div>
    </SiteShell>
  );
}
