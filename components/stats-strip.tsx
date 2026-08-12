import type { PublicReportStats } from "@/lib/public-analytics";

export function StatsStrip({ stats }: { stats: PublicReportStats }) {
  const items = [
    ["Public reports", stats.total, "Currently in the archive"],
    ["Confirmed", stats.confirmed, "Moderators found supporting evidence"],
    ["Pending review", stats.pending, "No final decision"],
    ["Rejected", stats.rejected, "Closed without confirmation"],
  ] as const;

  return (
    <section className="stats-strip" aria-label="Database statistics">
      {items.map(([label, value, detail]) => (
        <div className="stat-cell" key={label}>
          <span>{label}</span>
          <strong>{value.toLocaleString("en-GB")}</strong>
          <small>{detail}</small>
        </div>
      ))}
    </section>
  );
}
