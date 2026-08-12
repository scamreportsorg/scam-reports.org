import type { ReportStatus, ScamReport } from "./types";

export function formatDate(value: string, includeTime = false) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
    timeZone: "UTC",
  }).format(new Date(value));
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function statusSlug(status: ReportStatus) {
  return status.toLowerCase().replaceAll(" ", "-");
}

export function reportStats(reports: ScamReport[]) {
  const total = reports.length;
  const confirmed = reports.filter((report) => report.status === "Confirmed").length;
  const underReview = reports.filter((report) => report.status === "Under Review").length;
  const reported = reports.filter((report) => report.status === "Reported").length;
  const rejected = reports.filter((report) => report.status === "Rejected").length;
  return { total, confirmed, underReview, reported, rejected, pending: underReview + reported };
}
