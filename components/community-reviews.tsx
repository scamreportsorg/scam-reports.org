import { formatDate } from "@/lib/format";
import type { CommunityReview } from "@/lib/types";
import { CommunityRankBadge } from "./community-rank";
import { SafeLink as Link } from "./safe-link";

export function CommunityReviews({ reviews }: { reviews: CommunityReview[] }) {
  if (!reviews.length) {
    return (
      <div className="empty-state">
        <strong>No approved reviews yet.</strong>
        <span>Had direct experience or checked the sources? Add a review.</span>
      </div>
    );
  }

  return (
    <div className="community-review-list">
      {reviews.map((review) => (
        <article className="community-review" key={review.id}>
          <header>
            <div>
              <strong>
                {review.authorActivity && review.authorHandle ? (
                  <Link href={`/members/${encodeURIComponent(review.authorHandle)}`}>
                    {review.displayName}
                  </Link>
                ) : (
                  review.displayName
                )}
              </strong>
              {review.reviewerVerified && (
                <span className="verified-reviewer">Signed-in reviewer</span>
              )}
              {review.authorActivity && (
                <span className="community-post-rank">
                  <CommunityRankBadge activity={review.authorActivity} />
                  <small>
                    {review.authorActivity.approvedContributionCount} approved contribution
                    {review.authorActivity.approvedContributionCount === 1 ? "" : "s"}
                  </small>
                </span>
              )}
              <small>{review.relationship}</small>
            </div>
            <div className="review-rating" aria-label={`${review.rating} out of 5`}>
              <b>{"★".repeat(review.rating)}</b>
              <span>{"★".repeat(5 - review.rating)}</span>
              <small>{review.rating}/5</small>
            </div>
          </header>
          <h3>{review.title}</h3>
          <p>{review.body}</p>
          <footer>
            <span>{review.id}</span>
            <time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time>
          </footer>
        </article>
      ))}
    </div>
  );
}
