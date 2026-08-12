CREATE TABLE `discord_rank_sync` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`subject_hash` text NOT NULL,
	`subject_encrypted` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`desired_rank_level` integer DEFAULT 0 NOT NULL,
	`applied_rank_level` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`next_reconcile_at` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`last_error_code` text DEFAULT '' NOT NULL,
	`last_checked_at` text,
	`last_synced_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "discord_rank_sync_generation_check" CHECK("discord_rank_sync"."generation" > 0 AND "discord_rank_sync"."attempts" >= 0),
	CONSTRAINT "discord_rank_sync_desired_level_check" CHECK("discord_rank_sync"."desired_rank_level" BETWEEN 0 AND 6),
	CONSTRAINT "discord_rank_sync_applied_level_check" CHECK("discord_rank_sync"."applied_rank_level" IS NULL OR "discord_rank_sync"."applied_rank_level" BETWEEN 0 AND 6),
	CONSTRAINT "discord_rank_sync_status_check" CHECK("discord_rank_sync"."status" IN ('pending', 'leased', 'synced', 'not_in_guild', 'failed', 'terminal', 'disabled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_discord_rank_sync_subject` ON `discord_rank_sync` (`subject_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_discord_rank_sync_account` ON `discord_rank_sync` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_discord_rank_sync_delivery` ON `discord_rank_sync` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_discord_rank_sync_reconcile` ON `discord_rank_sync` (`next_reconcile_at`);--> statement-breakpoint
CREATE TABLE `discord_rank_sync_control` (
	`id` text PRIMARY KEY NOT NULL,
	`circuit_open_until` text,
	`last_error_code` text DEFAULT '' NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "discord_rank_sync_control_id_check" CHECK("discord_rank_sync_control"."id" = 'global')
);--> statement-breakpoint
INSERT INTO `discord_rank_sync_control` (`id`, `circuit_open_until`, `last_error_code`, `updated_at`)
VALUES ('global', NULL, '', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));--> statement-breakpoint
INSERT INTO `discord_rank_sync` (
	`id`, `account_id`, `subject_hash`, `subject_encrypted`, `generation`,
	`desired_rank_level`, `applied_rank_level`, `status`, `attempts`,
	`next_attempt_at`, `next_reconcile_at`, `lease_token`, `lease_expires_at`,
	`last_error_code`, `last_checked_at`, `last_synced_at`, `created_at`, `updated_at`
)
SELECT 'drs_' || lower(hex(randomblob(16))), `account_id`, `subject_hash`, `subject_encrypted`, 1,
	0, NULL, 'pending', 0,
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL,
	'', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `account_identities`
WHERE `provider` = 'discord';--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_identity_insert`
AFTER INSERT ON `account_identities`
WHEN NEW.`provider` = 'discord'
BEGIN
	INSERT INTO `discord_rank_sync` (
		`id`, `account_id`, `subject_hash`, `subject_encrypted`, `generation`,
		`desired_rank_level`, `applied_rank_level`, `status`, `attempts`,
		`next_attempt_at`, `next_reconcile_at`, `lease_token`, `lease_expires_at`,
		`last_error_code`, `last_checked_at`, `last_synced_at`, `created_at`, `updated_at`
	) VALUES (
		'drs_' || lower(hex(randomblob(16))), NEW.`account_id`, NEW.`subject_hash`, NEW.`subject_encrypted`, 1,
		0, NULL, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL,
		'', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	)
	ON CONFLICT(`subject_hash`) DO UPDATE SET
		`account_id` = excluded.`account_id`,
		`subject_encrypted` = excluded.`subject_encrypted`,
		`generation` = `discord_rank_sync`.`generation` + 1,
		`status` = 'pending', `attempts` = 0,
		`next_attempt_at` = excluded.`next_attempt_at`, `next_reconcile_at` = excluded.`next_reconcile_at`,
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '',
		`updated_at` = excluded.`updated_at`;
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_identity_update`
AFTER UPDATE OF `account_id`, `provider`, `subject_hash`, `subject_encrypted` ON `account_identities`
BEGIN
	UPDATE `discord_rank_sync`
	SET `account_id` = NULL, `desired_rank_level` = 0,
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '',
		`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE OLD.`provider` = 'discord' AND `subject_hash` = OLD.`subject_hash`
		AND (NEW.`provider` != 'discord' OR NEW.`subject_hash` != OLD.`subject_hash` OR NEW.`account_id` != OLD.`account_id`);

	UPDATE `discord_rank_sync`
	SET `account_id` = NULL, `desired_rank_level` = 0,
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '',
		`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE NEW.`provider` = 'discord' AND `account_id` = NEW.`account_id`
		AND `subject_hash` != NEW.`subject_hash`;

	INSERT INTO `discord_rank_sync` (
		`id`, `account_id`, `subject_hash`, `subject_encrypted`, `generation`,
		`desired_rank_level`, `applied_rank_level`, `status`, `attempts`,
		`next_attempt_at`, `next_reconcile_at`, `lease_token`, `lease_expires_at`,
		`last_error_code`, `last_checked_at`, `last_synced_at`, `created_at`, `updated_at`
	)
	SELECT 'drs_' || lower(hex(randomblob(16))), NEW.`account_id`, NEW.`subject_hash`, NEW.`subject_encrypted`, 1,
		0, NULL, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL,
		'', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE NEW.`provider` = 'discord'
	ON CONFLICT(`subject_hash`) DO UPDATE SET
		`account_id` = excluded.`account_id`,
		`subject_encrypted` = excluded.`subject_encrypted`,
		`generation` = `discord_rank_sync`.`generation` + 1,
		`status` = 'pending', `attempts` = 0,
		`next_attempt_at` = excluded.`next_attempt_at`, `next_reconcile_at` = excluded.`next_reconcile_at`,
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '',
		`updated_at` = excluded.`updated_at`;
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_identity_delete`
AFTER DELETE ON `account_identities`
WHEN OLD.`provider` = 'discord'
BEGIN
	INSERT INTO `discord_rank_sync` (
		`id`, `account_id`, `subject_hash`, `subject_encrypted`, `generation`,
		`desired_rank_level`, `applied_rank_level`, `status`, `attempts`,
		`next_attempt_at`, `next_reconcile_at`, `lease_token`, `lease_expires_at`,
		`last_error_code`, `last_checked_at`, `last_synced_at`, `created_at`, `updated_at`
	) VALUES (
		'drs_' || lower(hex(randomblob(16))), NULL, OLD.`subject_hash`, OLD.`subject_encrypted`, 1,
		0, NULL, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL,
		'', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	)
	ON CONFLICT(`subject_hash`) DO UPDATE SET
		`account_id` = NULL, `subject_encrypted` = excluded.`subject_encrypted`,
		`desired_rank_level` = 0, `generation` = `discord_rank_sync`.`generation` + 1,
		`status` = 'pending', `attempts` = 0,
		`next_attempt_at` = excluded.`next_attempt_at`, `next_reconcile_at` = excluded.`next_reconcile_at`,
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '',
		`updated_at` = excluded.`updated_at`;
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_account_delete`
BEFORE DELETE ON `accounts`
BEGIN
	INSERT INTO `discord_rank_sync` (
		`id`, `account_id`, `subject_hash`, `subject_encrypted`, `generation`,
		`desired_rank_level`, `applied_rank_level`, `status`, `attempts`,
		`next_attempt_at`, `next_reconcile_at`, `lease_token`, `lease_expires_at`,
		`last_error_code`, `last_checked_at`, `last_synced_at`, `created_at`, `updated_at`
	)
	SELECT 'drs_' || lower(hex(randomblob(16))), NULL, identity.`subject_hash`, identity.`subject_encrypted`, 1,
		0, NULL, 'pending', 0,
		strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL, NULL,
		'', NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	FROM `account_identities` identity
	WHERE identity.`account_id` = OLD.`id` AND identity.`provider` = 'discord'
	ON CONFLICT(`subject_hash`) DO UPDATE SET
		`account_id` = NULL, `subject_encrypted` = excluded.`subject_encrypted`,
		`desired_rank_level` = 0, `generation` = `discord_rank_sync`.`generation` + 1,
		`status` = 'pending', `attempts` = 0,
		`next_attempt_at` = excluded.`next_attempt_at`, `next_reconcile_at` = excluded.`next_reconcile_at`,
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '',
		`updated_at` = excluded.`updated_at`;
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_account_status`
AFTER UPDATE OF `status` ON `accounts`
WHEN NEW.`status` != OLD.`status`
BEGIN
	UPDATE `discord_rank_sync`
	SET `desired_rank_level` = CASE WHEN NEW.`status` = 'active' THEN `desired_rank_level` ELSE 0 END,
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '',
		`updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` = NEW.`id`;
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_submission_insert`
AFTER INSERT ON `report_submissions`
WHEN NEW.`account_id` IS NOT NULL AND NEW.`status` = 'Accepted'
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` = NEW.`account_id`;
END;--> statement-breakpoint
CREATE TRIGGER `discord_rank_sync_submission_update`
AFTER UPDATE OF `account_id`, `status`, `result_report_id` ON `report_submissions`
WHEN (OLD.`status` = 'Accepted' OR NEW.`status` = 'Accepted') AND
	(OLD.`account_id` IS NOT NEW.`account_id` OR OLD.`status` IS NOT NEW.`status` OR OLD.`result_report_id` IS NOT NEW.`result_report_id`)
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` IN (OLD.`account_id`, NEW.`account_id`);
END;--> statement-breakpoint
CREATE TRIGGER `discord_rank_sync_submission_delete`
AFTER DELETE ON `report_submissions`
WHEN OLD.`account_id` IS NOT NULL AND OLD.`status` = 'Accepted'
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` = OLD.`account_id`;
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_review_insert`
AFTER INSERT ON `reviews`
WHEN NEW.`account_id` IS NOT NULL AND NEW.`status` = 'Approved'
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` = NEW.`account_id`;
END;--> statement-breakpoint
CREATE TRIGGER `discord_rank_sync_review_update`
AFTER UPDATE OF `account_id`, `status`, `report_id` ON `reviews`
WHEN (OLD.`status` = 'Approved' OR NEW.`status` = 'Approved') AND
	(OLD.`account_id` IS NOT NEW.`account_id` OR OLD.`status` IS NOT NEW.`status` OR OLD.`report_id` IS NOT NEW.`report_id`)
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` IN (OLD.`account_id`, NEW.`account_id`);
END;--> statement-breakpoint
CREATE TRIGGER `discord_rank_sync_review_delete`
AFTER DELETE ON `reviews`
WHEN OLD.`account_id` IS NOT NULL AND OLD.`status` = 'Approved'
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` = OLD.`account_id`;
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_comment_insert`
AFTER INSERT ON `comments`
WHEN NEW.`account_id` IS NOT NULL AND NEW.`status` = 'Approved'
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` = NEW.`account_id`;
END;--> statement-breakpoint
CREATE TRIGGER `discord_rank_sync_comment_update`
AFTER UPDATE OF `account_id`, `status`, `report_id`, `created_at` ON `comments`
WHEN (OLD.`status` = 'Approved' OR NEW.`status` = 'Approved') AND
	(OLD.`account_id` IS NOT NEW.`account_id` OR OLD.`status` IS NOT NEW.`status` OR OLD.`report_id` IS NOT NEW.`report_id` OR OLD.`created_at` IS NOT NEW.`created_at`)
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` IN (OLD.`account_id`, NEW.`account_id`);
END;--> statement-breakpoint
CREATE TRIGGER `discord_rank_sync_comment_delete`
AFTER DELETE ON `comments`
WHEN OLD.`account_id` IS NOT NULL AND OLD.`status` = 'Approved'
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` = OLD.`account_id`;
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_report_family_update`
AFTER UPDATE OF `is_published`, `merged_into_report_id` ON `reports`
WHEN OLD.`is_published` IS NOT NEW.`is_published` OR OLD.`merged_into_report_id` IS NOT NEW.`merged_into_report_id`
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` IN (
		SELECT `account_id` FROM `report_submissions`
		WHERE `account_id` IS NOT NULL AND `result_report_id` IN (
			SELECT `id` FROM `reports` WHERE `id` IN (OLD.`id`, NEW.`id`, OLD.`merged_into_report_id`, NEW.`merged_into_report_id`)
				OR `merged_into_report_id` IN (OLD.`id`, NEW.`id`, OLD.`merged_into_report_id`, NEW.`merged_into_report_id`)
		)
		UNION SELECT `account_id` FROM `reviews`
		WHERE `account_id` IS NOT NULL AND `report_id` IN (
			SELECT `id` FROM `reports` WHERE `id` IN (OLD.`id`, NEW.`id`, OLD.`merged_into_report_id`, NEW.`merged_into_report_id`)
				OR `merged_into_report_id` IN (OLD.`id`, NEW.`id`, OLD.`merged_into_report_id`, NEW.`merged_into_report_id`)
		)
		UNION SELECT `account_id` FROM `comments`
		WHERE `account_id` IS NOT NULL AND `report_id` IN (
			SELECT `id` FROM `reports` WHERE `id` IN (OLD.`id`, NEW.`id`, OLD.`merged_into_report_id`, NEW.`merged_into_report_id`)
				OR `merged_into_report_id` IN (OLD.`id`, NEW.`id`, OLD.`merged_into_report_id`, NEW.`merged_into_report_id`)
		)
	);
END;--> statement-breakpoint

CREATE TRIGGER `discord_rank_sync_report_delete`
BEFORE DELETE ON `reports`
BEGIN
	UPDATE `discord_rank_sync` SET
		`generation` = `generation` + 1, `status` = 'pending', `attempts` = 0,
		`next_attempt_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), `next_reconcile_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
		`lease_token` = NULL, `lease_expires_at` = NULL, `last_error_code` = '', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE `account_id` IN (
		SELECT `account_id` FROM `report_submissions` WHERE `account_id` IS NOT NULL AND `result_report_id` = OLD.`id`
		UNION SELECT `account_id` FROM `reviews` WHERE `account_id` IS NOT NULL AND `report_id` = OLD.`id`
		UNION SELECT `account_id` FROM `comments` WHERE `account_id` IS NOT NULL AND `report_id` = OLD.`id`
	);
END;
