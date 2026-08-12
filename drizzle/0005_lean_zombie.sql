CREATE TABLE `account_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`subject_hash` text NOT NULL,
	`subject_encrypted` text NOT NULL,
	`display_hint` text NOT NULL,
	`verified_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_identities_provider_check" CHECK("account_identities"."provider" IN ('discord', 'email'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_identities_provider_subject` ON `account_identities` (`provider`,`subject_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_identities_account_provider` ON `account_identities` (`account_id`,`provider`);--> statement-breakpoint
CREATE INDEX `idx_account_identities_account` ON `account_identities` (`account_id`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`handle_normalized` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`role_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_authenticated_at` text,
	CONSTRAINT "accounts_role_check" CHECK("accounts"."role" IN ('member', 'moderator', 'admin')),
	CONSTRAINT "accounts_status_check" CHECK("accounts"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_accounts_handle_normalized` ON `accounts` (`handle_normalized`);--> statement-breakpoint
CREATE INDEX `idx_accounts_role_status` ON `accounts` (`role`,`status`);--> statement-breakpoint
CREATE TABLE `auth_magic_links` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`purpose` text NOT NULL,
	`subject_hash` text NOT NULL,
	`subject_encrypted` text NOT NULL,
	`return_to` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_auth_magic_expiry` ON `auth_magic_links` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_oauth_transactions` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`mode` text NOT NULL,
	`account_id` text,
	`browser_hash` text NOT NULL,
	`return_to` text NOT NULL,
	`code_verifier_encrypted` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_oauth_provider_check" CHECK("auth_oauth_transactions"."provider" IN ('discord')),
	CONSTRAINT "auth_oauth_mode_check" CHECK("auth_oauth_transactions"."mode" IN ('login', 'link'))
);
--> statement-breakpoint
CREATE INDEX `idx_auth_oauth_expiry` ON `auth_oauth_transactions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_security_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`event_type` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_auth_security_account_created` ON `auth_security_events` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token_hash` text NOT NULL,
	`role_version` integer NOT NULL,
	`authenticated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`idle_expires_at` text NOT NULL,
	`absolute_expires_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_sessions_token_hash_unique` ON `auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_account` ON `auth_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_idle_expiry` ON `auth_sessions` (`idle_expires_at`);--> statement-breakpoint
CREATE INDEX `idx_auth_sessions_absolute_expiry` ON `auth_sessions` (`absolute_expires_at`);--> statement-breakpoint
CREATE TABLE `auth_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`object_key` text,
	`sha256` text,
	`size` integer,
	`bookmark` text,
	`error` text DEFAULT '' NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_backup_runs_started` ON `backup_runs` (`started_at`,`id`);--> statement-breakpoint
CREATE TABLE `evidence_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`intake_id` text,
	`intake_kind` text NOT NULL,
	`state` text DEFAULT 'uploading' NOT NULL,
	`original_key` text NOT NULL,
	`derivative_key` text,
	`original_filename` text NOT NULL,
	`original_content_type` text NOT NULL,
	`original_size` integer NOT NULL,
	`original_sha256` text NOT NULL,
	`derivative_content_type` text,
	`derivative_size` integer,
	`derivative_sha256` text,
	`source_width` integer,
	`source_height` integer,
	`width` integer,
	`height` integer,
	`visible_pii_reviewed` integer DEFAULT false NOT NULL,
	`legal_hold` integer DEFAULT false NOT NULL,
	`processing_error` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`published_at` text,
	`deleted_at` text,
	CONSTRAINT "evidence_assets_intake_kind_check" CHECK("evidence_assets"."intake_kind" IN ('report_submission', 'appeal', 'moderator_upload', 'legacy')),
	CONSTRAINT "evidence_assets_state_check" CHECK("evidence_assets"."state" IN ('uploading', 'private_ready', 'public', 'withheld', 'failed', 'deleted')),
	CONSTRAINT "evidence_assets_mime_check" CHECK("evidence_assets"."original_content_type" IN ('image/png', 'image/jpeg', 'image/webp'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_assets_original_key_unique` ON `evidence_assets` (`original_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_assets_derivative_key_unique` ON `evidence_assets` (`derivative_key`);--> statement-breakpoint
CREATE INDEX `idx_evidence_assets_state_created` ON `evidence_assets` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_evidence_assets_intake` ON `evidence_assets` (`intake_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`event_key` text NOT NULL,
	`channel` text NOT NULL,
	`case_id` text NOT NULL,
	`event_type` text NOT NULL,
	`queue_path` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	CONSTRAINT "notification_outbox_channel_check" CHECK("notification_outbox"."channel" IN ('email', 'discord'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_outbox_event_key_unique` ON `notification_outbox` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_notification_outbox_delivery` ON `notification_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `rate_events` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`subject_hash` text NOT NULL,
	`occurred_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rate_events_scope_subject_time` ON `rate_events` (`scope`,`subject_hash`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_rate_events_expiry` ON `rate_events` (`expires_at`);--> statement-breakpoint
CREATE TABLE `report_evidence` (
	`report_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`report_id`, `evidence_id`),
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evidence_id`) REFERENCES `evidence_assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_report_evidence_asset` ON `report_evidence` (`evidence_id`);--> statement-breakpoint
CREATE INDEX `idx_report_evidence_order` ON `report_evidence` (`report_id`,`display_order`);--> statement-breakpoint
CREATE TABLE `report_merge_events` (
	`id` text PRIMARY KEY NOT NULL,
	`duplicate_report_id` text NOT NULL,
	`canonical_report_id` text NOT NULL,
	`actor_account_id` text,
	`action` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`duplicate_report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`canonical_report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_report_merge_duplicate_created` ON `report_merge_events` (`duplicate_report_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `report_status_events` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`status` text NOT NULL,
	`public_note` text DEFAULT '' NOT NULL,
	`actor_account_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_report_status_events_report_created` ON `report_status_events` (`report_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `review_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`review_id` text NOT NULL,
	`account_id` text,
	`rating` integer NOT NULL,
	`relationship` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`moderator_notes` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`moderated_at` text,
	`moderated_by_account_id` text,
	FOREIGN KEY (`review_id`) REFERENCES `reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`moderated_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "review_revisions_rating_check" CHECK("review_revisions"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE INDEX `idx_review_revisions_review_created` ON `review_revisions` (`review_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_review_revisions_status_created` ON `review_revisions` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `appeals` ADD `account_id` text REFERENCES accounts(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `comments` ADD `account_id` text REFERENCES accounts(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `report_submissions` ADD `account_id` text REFERENCES accounts(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `merged_into_report_id` text;--> statement-breakpoint
ALTER TABLE `reports` ADD `created_by_account_id` text REFERENCES accounts(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `evidence_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `approved_review_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD `approved_rating_sum` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `reviews` ADD `account_id` text REFERENCES accounts(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `reviews` ADD `approved_revision_id` text;--> statement-breakpoint
ALTER TABLE `reviews` ADD `pending_revision_id` text;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD `actor_account_id` text REFERENCES accounts(id) ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX `idx_appeals_account_created` ON `appeals` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_comments_account_created` ON `comments` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_report_submissions_account_created` ON `report_submissions` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reports_public_date` ON `reports` (`is_published`,`date_added`,`id`);--> statement-breakpoint
CREATE INDEX `idx_reports_public_status_date` ON `reports` (`is_published`,`status`,`date_added`,`id`);--> statement-breakpoint
CREATE INDEX `idx_reports_public_category_date` ON `reports` (`is_published`,`category`,`date_added`,`id`);--> statement-breakpoint
CREATE INDEX `idx_reports_public_views` ON `reports` (`is_published`,`views`,`id`);--> statement-breakpoint
CREATE INDEX `idx_reports_public_evidence` ON `reports` (`is_published`,`evidence_count`,`id`);--> statement-breakpoint
CREATE INDEX `idx_reports_merged_into` ON `reports` (`merged_into_report_id`);--> statement-breakpoint
CREATE INDEX `idx_reviews_report_status_created` ON `reviews` (`report_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reviews_status_created` ON `reviews` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reviews_account_report` ON `reviews` (`account_id`,`report_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_created` ON `audit_logs` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_audit_logs_actor` ON `audit_logs` (`actor_account_id`,`created_at`);--> statement-breakpoint

UPDATE `reports`
SET `evidence_count` = CASE
  WHEN json_valid(`evidence_json`) THEN json_array_length(`evidence_json`)
  ELSE 0
END;--> statement-breakpoint
UPDATE `reports`
SET `approved_review_count` = (
      SELECT COUNT(*) FROM `reviews`
      WHERE `reviews`.`report_id` = `reports`.`id`
        AND `reviews`.`status` = 'Approved'
    ),
    `approved_rating_sum` = COALESCE((
      SELECT SUM(`rating`) FROM `reviews`
      WHERE `reviews`.`report_id` = `reports`.`id`
        AND `reviews`.`status` = 'Approved'
    ), 0);--> statement-breakpoint

CREATE VIRTUAL TABLE `reports_fts` USING fts5(
  `username`, `discord_id`, `game`, `category`, `reason`, `description`,
  content='reports', content_rowid='rowid', tokenize='trigram'
);--> statement-breakpoint
INSERT INTO `reports_fts`(`reports_fts`) VALUES('rebuild');--> statement-breakpoint
CREATE TRIGGER `reports_fts_insert` AFTER INSERT ON `reports` BEGIN
  INSERT INTO `reports_fts`(rowid, username, discord_id, game, category, reason, description)
  VALUES (NEW.rowid, NEW.username, NEW.discord_id, NEW.game, NEW.category, NEW.reason, NEW.description);
END;--> statement-breakpoint
CREATE TRIGGER `reports_fts_delete` AFTER DELETE ON `reports` BEGIN
  INSERT INTO `reports_fts`(`reports_fts`, rowid, username, discord_id, game, category, reason, description)
  VALUES ('delete', OLD.rowid, OLD.username, OLD.discord_id, OLD.game, OLD.category, OLD.reason, OLD.description);
END;--> statement-breakpoint
CREATE TRIGGER `reports_fts_update` AFTER UPDATE OF username, discord_id, game, category, reason, description ON `reports` BEGIN
  INSERT INTO `reports_fts`(`reports_fts`, rowid, username, discord_id, game, category, reason, description)
  VALUES ('delete', OLD.rowid, OLD.username, OLD.discord_id, OLD.game, OLD.category, OLD.reason, OLD.description);
  INSERT INTO `reports_fts`(rowid, username, discord_id, game, category, reason, description)
  VALUES (NEW.rowid, NEW.username, NEW.discord_id, NEW.game, NEW.category, NEW.reason, NEW.description);
END;--> statement-breakpoint

CREATE TRIGGER `reviews_report_aggregate_insert` AFTER INSERT ON `reviews` BEGIN
  UPDATE `reports` SET
    `approved_review_count` = (SELECT COUNT(*) FROM `reviews` WHERE `report_id` = NEW.`report_id` AND `status` = 'Approved'),
    `approved_rating_sum` = COALESCE((SELECT SUM(`rating`) FROM `reviews` WHERE `report_id` = NEW.`report_id` AND `status` = 'Approved'), 0)
  WHERE `id` = NEW.`report_id`;
END;--> statement-breakpoint
CREATE TRIGGER `reviews_report_aggregate_update` AFTER UPDATE OF report_id, status, rating ON `reviews` BEGIN
  UPDATE `reports` SET
    `approved_review_count` = (SELECT COUNT(*) FROM `reviews` WHERE `report_id` = OLD.`report_id` AND `status` = 'Approved'),
    `approved_rating_sum` = COALESCE((SELECT SUM(`rating`) FROM `reviews` WHERE `report_id` = OLD.`report_id` AND `status` = 'Approved'), 0)
  WHERE `id` = OLD.`report_id`;
  UPDATE `reports` SET
    `approved_review_count` = (SELECT COUNT(*) FROM `reviews` WHERE `report_id` = NEW.`report_id` AND `status` = 'Approved'),
    `approved_rating_sum` = COALESCE((SELECT SUM(`rating`) FROM `reviews` WHERE `report_id` = NEW.`report_id` AND `status` = 'Approved'), 0)
  WHERE `id` = NEW.`report_id`;
END;--> statement-breakpoint
CREATE TRIGGER `reviews_report_aggregate_delete` AFTER DELETE ON `reviews` BEGIN
  UPDATE `reports` SET
    `approved_review_count` = (SELECT COUNT(*) FROM `reviews` WHERE `report_id` = OLD.`report_id` AND `status` = 'Approved'),
    `approved_rating_sum` = COALESCE((SELECT SUM(`rating`) FROM `reviews` WHERE `report_id` = OLD.`report_id` AND `status` = 'Approved'), 0)
  WHERE `id` = OLD.`report_id`;
END;--> statement-breakpoint

CREATE TRIGGER `report_evidence_count_insert` AFTER INSERT ON `report_evidence` BEGIN
  UPDATE `reports` SET `evidence_count` = (
    SELECT COUNT(*) FROM `report_evidence`
    JOIN `evidence_assets` ON `evidence_assets`.`id` = `report_evidence`.`evidence_id`
    WHERE `report_evidence`.`report_id` = NEW.`report_id`
      AND `evidence_assets`.`state` = 'public'
  ) WHERE `id` = NEW.`report_id`;
END;--> statement-breakpoint
CREATE TRIGGER `report_evidence_count_delete` AFTER DELETE ON `report_evidence` BEGIN
  UPDATE `reports` SET `evidence_count` = (
    SELECT COUNT(*) FROM `report_evidence`
    JOIN `evidence_assets` ON `evidence_assets`.`id` = `report_evidence`.`evidence_id`
    WHERE `report_evidence`.`report_id` = OLD.`report_id`
      AND `evidence_assets`.`state` = 'public'
  ) WHERE `id` = OLD.`report_id`;
END;--> statement-breakpoint
CREATE TRIGGER `evidence_asset_count_update` AFTER UPDATE OF state ON `evidence_assets` BEGIN
  UPDATE `reports` SET `evidence_count` = (
    SELECT COUNT(*) FROM `report_evidence`
    JOIN `evidence_assets` ON `evidence_assets`.`id` = `report_evidence`.`evidence_id`
    WHERE `report_evidence`.`report_id` = `reports`.`id`
      AND `evidence_assets`.`state` = 'public'
  ) WHERE `id` IN (SELECT `report_id` FROM `report_evidence` WHERE `evidence_id` = NEW.`id`);
END;
