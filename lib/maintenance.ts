import { env } from "cloudflare:workers";
import { deleteExpiredRateEvents } from "./abuse-protection";
import {
  expireStaleModeratorApplications,
  purgeExpiredModeratorApplicationAnswers,
} from "./moderator-applications";
import { purgeExpiredDiscordRankOrphans } from "./discord-rank-sync";
import { getD1 } from "./reports";

type MaintenanceEnv = {
  BACKUPS?: R2Bucket;
};

export async function purgeExpiredAuthArtifacts() {
  const database = getD1();
  const now = new Date().toISOString();
  await database.batch([
    database.prepare("DELETE FROM auth_oauth_transactions WHERE expires_at < ?").bind(now),
    database.prepare("DELETE FROM auth_magic_links WHERE expires_at < ?").bind(now),
    database
      .prepare("DELETE FROM auth_sessions WHERE absolute_expires_at < ? OR idle_expires_at < ?")
      .bind(now, now),
  ]);
}

export async function purgeDeletedEvidenceBackups(limit = 100) {
  const database = getD1();
  const bucket = (env as unknown as MaintenanceEnv).BACKUPS;
  if (!database || !bucket) return { purged: 0 };
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await database
    .prepare(
      `SELECT id, original_key FROM evidence_assets
    WHERE state = 'deleted' AND legal_hold = 0 AND deleted_at IS NOT NULL AND deleted_at < ?
      AND processing_error NOT LIKE '%backup-purged%'
    ORDER BY deleted_at ASC LIMIT ?`,
    )
    .bind(cutoff, Math.max(1, Math.min(limit, 500)))
    .all<{ id: string; original_key: string }>();
  for (const row of rows.results) {
    const suffix = row.original_key.replace(/^originals\//u, "");
    await bucket.delete(`evidence-originals/${suffix}`);
    await database
      .prepare(
        `UPDATE evidence_assets
      SET processing_error = CASE WHEN processing_error = '' THEN 'backup-purged'
        ELSE processing_error || ';backup-purged' END, updated_at = ? WHERE id = ?`,
      )
      .bind(new Date().toISOString(), row.id)
      .run();
  }
  return { purged: rows.results.length };
}

export async function runFrequentMaintenance() {
  await Promise.all([
    deleteExpiredRateEvents(),
    purgeExpiredAuthArtifacts(),
    expireStaleModeratorApplications(),
    purgeExpiredModeratorApplicationAnswers(),
    purgeExpiredDiscordRankOrphans(),
  ]);
}
