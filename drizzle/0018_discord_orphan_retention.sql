ALTER TABLE `discord_rank_sync` ADD `orphan_purge_after` text;--> statement-breakpoint
CREATE INDEX `idx_discord_rank_sync_orphan_purge` ON `discord_rank_sync` (`account_id`,`orphan_purge_after`);--> statement-breakpoint

UPDATE `discord_rank_sync`
SET `orphan_purge_after` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')
WHERE `account_id` IS NULL AND `orphan_purge_after` IS NULL;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_orphan_deadline_insert`
AFTER INSERT ON `discord_rank_sync`
WHEN NEW.`account_id` IS NULL AND NEW.`orphan_purge_after` IS NULL
BEGIN
	UPDATE `discord_rank_sync`
	SET `orphan_purge_after` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')
	WHERE `id` = NEW.`id`;
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_orphan_deadline_set`
AFTER UPDATE OF `account_id` ON `discord_rank_sync`
WHEN NEW.`account_id` IS NULL AND NEW.`orphan_purge_after` IS NULL
BEGIN
	UPDATE `discord_rank_sync`
	SET `orphan_purge_after` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days')
	WHERE `id` = NEW.`id`;
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_orphan_deadline_clear`
AFTER UPDATE OF `account_id` ON `discord_rank_sync`
WHEN NEW.`account_id` IS NOT NULL AND NEW.`orphan_purge_after` IS NOT NULL
BEGIN
	UPDATE `discord_rank_sync`
	SET `orphan_purge_after` = NULL
	WHERE `id` = NEW.`id`;
END;
