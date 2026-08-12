import { formatDate } from "@/lib/format";
import type { CommunityComment } from "@/lib/types";
import { CommunityRankBadge } from "./community-rank";
import { SafeLink as Link } from "./safe-link";

export function DiscussionThread({ comments }: { comments: CommunityComment[] }) {
  const approvedComments = comments
    .filter((comment) => comment.status === "Approved")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  if (!approvedComments.length) {
    return (
      <div className="empty-state discussion-empty-state">
        <strong>No approved replies yet.</strong>
        <span>New replies stay private until a moderator approves them.</span>
      </div>
    );
  }

  const commentsById = new Map(approvedComments.map((comment) => [comment.id, comment]));

  return (
    <div className="discussion-thread">
      {approvedComments.map((comment) => {
        const parent = comment.parentId ? commentsById.get(comment.parentId) : undefined;
        const parentDisplayName = parent?.displayName ?? comment.parentDisplayName;
        const memberHandle = comment.authorHandle ?? comment.displayName;
        const initials = memberHandle.slice(0, 2).toUpperCase();

        return (
          <article
            className={`forum-post discussion-post${parentDisplayName ? " discussion-post-reply" : ""}`}
            key={comment.id}
          >
            <aside className="post-author discussion-author">
              <div className="avatar-placeholder discussion-avatar" aria-hidden="true">
                {initials}
              </div>
              <strong>
                {comment.authorActivity && comment.authorHandle ? (
                  <Link href={`/members/${encodeURIComponent(comment.authorHandle)}`}>
                    {memberHandle}
                  </Link>
                ) : (
                  memberHandle
                )}
              </strong>
              {comment.reviewerVerified && (
                <span className="verified-reviewer">Signed-in member</span>
              )}
              {comment.authorActivity ? (
                <>
                  <CommunityRankBadge activity={comment.authorActivity} />
                  <small>
                    {comment.authorActivity.approvedContributionCount} approved contribution
                    {comment.authorActivity.approvedContributionCount === 1 ? "" : "s"}
                  </small>
                </>
              ) : (
                <small>Community member</small>
              )}
            </aside>
            <div className="post-content discussion-content">
              <header className="post-header">
                <span>
                  {parentDisplayName ? `Reply to ${parentDisplayName}` : "Discussion reply"}
                </span>
                <time dateTime={comment.createdAt}>{formatDate(comment.createdAt, true)} UTC</time>
              </header>
              <p className="discussion-body">{comment.body}</p>
              <footer className="discussion-meta">
                <span>{comment.id}</span>
                <span>Moderator approved</span>
              </footer>
            </div>
          </article>
        );
      })}
    </div>
  );
}
