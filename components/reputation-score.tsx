import type { ReputationSummary } from "@/lib/reputation";

export function ReputationScore({
  summary,
  compact = false,
}: {
  summary: ReputationSummary;
  compact?: boolean;
}) {
  return (
    <div
      className={`reputation-score reputation-${summary.tone}${compact ? " compact" : ""}`}
      aria-label={`Reputation ${summary.score} out of 100, ${summary.label}`}
    >
      <div className="reputation-value">
        <strong>{summary.score}</strong>
        <span>/ 100</span>
      </div>
      <div className="reputation-detail">
        <b>{summary.label}</b>
        {!compact && (
          <span>
            {summary.reviewCount} approved review
            {summary.reviewCount === 1 ? "" : "s"} · {summary.confidence} confidence
          </span>
        )}
        <div className="reputation-track" aria-hidden="true">
          <i style={{ width: `${summary.score}%` }} />
        </div>
      </div>
    </div>
  );
}
