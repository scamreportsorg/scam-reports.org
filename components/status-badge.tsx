import type { ReportStatus } from "@/lib/types";
import { statusSlug } from "@/lib/format";

export function StatusBadge({
  status,
  compact = false,
}: {
  status: ReportStatus;
  compact?: boolean;
}) {
  return (
    <span
      className={`status-badge status-${statusSlug(status)} ${compact ? "status-compact" : ""}`}
    >
      <span className="status-light" aria-hidden="true" />
      {status}
    </span>
  );
}
