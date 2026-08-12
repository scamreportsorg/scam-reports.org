DROP TABLE IF EXISTS `__migration_0007_preflight`;--> statement-breakpoint
CREATE TABLE `__migration_0007_preflight` (
	`reports_invalid_status` integer NOT NULL CONSTRAINT `migration_0007_reports_invalid_status` CHECK (`reports_invalid_status` = 0),
	`reviews_report_orphans` integer NOT NULL CONSTRAINT `migration_0007_reviews_report_orphans` CHECK (`reviews_report_orphans` = 0),
	`reviews_account_orphans` integer NOT NULL CONSTRAINT `migration_0007_reviews_account_orphans` CHECK (`reviews_account_orphans` = 0),
	`reviews_invalid_rating` integer NOT NULL CONSTRAINT `migration_0007_reviews_invalid_rating` CHECK (`reviews_invalid_rating` = 0),
	`reviews_invalid_status` integer NOT NULL CONSTRAINT `migration_0007_reviews_invalid_status` CHECK (`reviews_invalid_status` = 0),
	`appeals_report_orphans` integer NOT NULL CONSTRAINT `migration_0007_appeals_report_orphans` CHECK (`appeals_report_orphans` = 0),
	`appeals_account_orphans` integer NOT NULL CONSTRAINT `migration_0007_appeals_account_orphans` CHECK (`appeals_account_orphans` = 0),
	`comments_report_orphans` integer NOT NULL CONSTRAINT `migration_0007_comments_report_orphans` CHECK (`comments_report_orphans` = 0),
	`comments_account_orphans` integer NOT NULL CONSTRAINT `migration_0007_comments_account_orphans` CHECK (`comments_account_orphans` = 0),
	`submissions_account_orphans` integer NOT NULL CONSTRAINT `migration_0007_submissions_account_orphans` CHECK (`submissions_account_orphans` = 0),
	`submissions_related_report_orphans` integer NOT NULL CONSTRAINT `migration_0007_submissions_related_report_orphans` CHECK (`submissions_related_report_orphans` = 0),
	`submissions_result_report_orphans` integer NOT NULL CONSTRAINT `migration_0007_submissions_result_report_orphans` CHECK (`submissions_result_report_orphans` = 0),
	`revisions_review_orphans` integer NOT NULL CONSTRAINT `migration_0007_revisions_review_orphans` CHECK (`revisions_review_orphans` = 0),
	`revisions_account_orphans` integer NOT NULL CONSTRAINT `migration_0007_revisions_account_orphans` CHECK (`revisions_account_orphans` = 0),
	`revisions_moderator_orphans` integer NOT NULL CONSTRAINT `migration_0007_revisions_moderator_orphans` CHECK (`revisions_moderator_orphans` = 0),
	`revisions_invalid_rating` integer NOT NULL CONSTRAINT `migration_0007_revisions_invalid_rating` CHECK (`revisions_invalid_rating` = 0)
);--> statement-breakpoint
INSERT INTO `__migration_0007_preflight` (
	`reports_invalid_status`,
	`reviews_report_orphans`, `reviews_account_orphans`, `reviews_invalid_rating`, `reviews_invalid_status`,
	`appeals_report_orphans`, `appeals_account_orphans`, `comments_report_orphans`, `comments_account_orphans`,
	`submissions_account_orphans`, `submissions_related_report_orphans`, `submissions_result_report_orphans`,
	`revisions_review_orphans`, `revisions_account_orphans`, `revisions_moderator_orphans`, `revisions_invalid_rating`
) SELECT
	EXISTS (SELECT 1 FROM `reports` WHERE `status` NOT IN ('Reported', 'Under Review', 'Confirmed', 'Rejected')),
	EXISTS (SELECT 1 FROM `reviews` LEFT JOIN `reports` ON `reports`.`id` = `reviews`.`report_id` WHERE `reports`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `reviews` LEFT JOIN `accounts` ON `accounts`.`id` = `reviews`.`account_id` WHERE `reviews`.`account_id` IS NOT NULL AND `accounts`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `reviews` WHERE `rating` NOT BETWEEN 1 AND 5),
	EXISTS (SELECT 1 FROM `reviews` WHERE `status` NOT IN ('Pending', 'Approved', 'Rejected')),
	EXISTS (SELECT 1 FROM `appeals` LEFT JOIN `reports` ON `reports`.`id` = `appeals`.`report_id` WHERE `reports`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `appeals` LEFT JOIN `accounts` ON `accounts`.`id` = `appeals`.`account_id` WHERE `appeals`.`account_id` IS NOT NULL AND `accounts`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `comments` LEFT JOIN `reports` ON `reports`.`id` = `comments`.`report_id` WHERE `reports`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `comments` LEFT JOIN `accounts` ON `accounts`.`id` = `comments`.`account_id` WHERE `comments`.`account_id` IS NOT NULL AND `accounts`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `report_submissions` LEFT JOIN `accounts` ON `accounts`.`id` = `report_submissions`.`account_id` WHERE `report_submissions`.`account_id` IS NOT NULL AND `accounts`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `report_submissions` LEFT JOIN `reports` ON `reports`.`id` = `report_submissions`.`related_report_id` WHERE `report_submissions`.`related_report_id` IS NOT NULL AND `reports`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `report_submissions` LEFT JOIN `reports` ON `reports`.`id` = `report_submissions`.`result_report_id` WHERE `report_submissions`.`result_report_id` IS NOT NULL AND `reports`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `review_revisions` LEFT JOIN `reviews` ON `reviews`.`id` = `review_revisions`.`review_id` WHERE `reviews`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `review_revisions` LEFT JOIN `accounts` ON `accounts`.`id` = `review_revisions`.`account_id` WHERE `review_revisions`.`account_id` IS NOT NULL AND `accounts`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `review_revisions` LEFT JOIN `accounts` ON `accounts`.`id` = `review_revisions`.`moderated_by_account_id` WHERE `review_revisions`.`moderated_by_account_id` IS NOT NULL AND `accounts`.`id` IS NULL),
	EXISTS (SELECT 1 FROM `review_revisions` WHERE `rating` NOT BETWEEN 1 AND 5);--> statement-breakpoint
DROP TABLE `__migration_0007_preflight`;--> statement-breakpoint

CREATE TRIGGER `reports_status_check_insert` BEFORE INSERT ON `reports`
WHEN NEW.`status` NOT IN ('Reported', 'Under Review', 'Confirmed', 'Rejected') BEGIN
	SELECT RAISE(ABORT, 'reports_status_check');
END;--> statement-breakpoint
CREATE TRIGGER `reports_status_check_update` BEFORE UPDATE OF `status` ON `reports`
WHEN NEW.`status` NOT IN ('Reported', 'Under Review', 'Confirmed', 'Rejected') BEGIN
	SELECT RAISE(ABORT, 'reports_status_check');
END;--> statement-breakpoint

DROP VIEW `report_family_metrics`;--> statement-breakpoint
DROP TRIGGER `reviews_report_aggregate_insert`;--> statement-breakpoint
DROP TRIGGER `reviews_report_aggregate_update`;--> statement-breakpoint
DROP TRIGGER `reviews_report_aggregate_delete`;--> statement-breakpoint

CREATE TABLE `__new_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`account_id` text,
	`display_name` text NOT NULL,
	`rating` integer NOT NULL,
	`relationship` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`moderator_notes` text DEFAULT '' NOT NULL,
	`author_fingerprint` text NOT NULL,
	`reviewer_verified` integer DEFAULT false NOT NULL,
	`approved_revision_id` text,
	`pending_revision_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `reviews_rating_check` CHECK (`rating` BETWEEN 1 AND 5),
	CONSTRAINT `reviews_status_check` CHECK (`status` IN ('Pending', 'Approved', 'Rejected'))
);--> statement-breakpoint
INSERT INTO `__new_reviews` (
	`id`, `report_id`, `account_id`, `display_name`, `rating`, `relationship`, `title`, `body`,
	`status`, `moderator_notes`, `author_fingerprint`, `reviewer_verified`, `approved_revision_id`,
	`pending_revision_id`, `created_at`, `updated_at`
) SELECT
	`id`, `report_id`, `account_id`, `display_name`, `rating`, `relationship`, `title`, `body`,
	`status`, `moderator_notes`, `author_fingerprint`, `reviewer_verified`, `approved_revision_id`,
	`pending_revision_id`, `created_at`, `updated_at`
FROM `reviews`;--> statement-breakpoint
CREATE TABLE `__new_review_revisions` (
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
	FOREIGN KEY (`review_id`) REFERENCES `__new_reviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`moderated_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `review_revisions_rating_check` CHECK (`rating` BETWEEN 1 AND 5)
);--> statement-breakpoint
INSERT INTO `__new_review_revisions` (
	`id`, `review_id`, `account_id`, `rating`, `relationship`, `title`, `body`, `status`,
	`moderator_notes`, `created_at`, `updated_at`, `moderated_at`, `moderated_by_account_id`
) SELECT
	`id`, `review_id`, `account_id`, `rating`, `relationship`, `title`, `body`, `status`,
	`moderator_notes`, `created_at`, `updated_at`, `moderated_at`, `moderated_by_account_id`
FROM `review_revisions`;--> statement-breakpoint
DROP TABLE `review_revisions`;--> statement-breakpoint
DROP TABLE `reviews`;--> statement-breakpoint
ALTER TABLE `__new_reviews` RENAME TO `reviews`;--> statement-breakpoint
ALTER TABLE `__new_review_revisions` RENAME TO `review_revisions`;--> statement-breakpoint
CREATE INDEX `idx_reviews_report_status` ON `reviews` (`report_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_reviews_report_status_created` ON `reviews` (`report_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reviews_status_created` ON `reviews` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_reviews_created_at` ON `reviews` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reviews_fingerprint_created` ON `reviews` (`author_fingerprint`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reviews_account_report` ON `reviews` (`account_id`,`report_id`);--> statement-breakpoint
CREATE INDEX `idx_review_revisions_review_created` ON `review_revisions` (`review_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_review_revisions_status_created` ON `review_revisions` (`status`,`created_at`);--> statement-breakpoint

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

CREATE TABLE `__new_appeals` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`report_id` text NOT NULL,
	`request_type` text NOT NULL,
	`submitter_name` text NOT NULL,
	`relationship` text NOT NULL,
	`contact_email` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`moderator_notes` text DEFAULT '' NOT NULL,
	`public_resolution` text DEFAULT '' NOT NULL,
	`author_fingerprint` text NOT NULL,
	`submitter_verified` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_appeals` (
	`id`, `account_id`, `report_id`, `request_type`, `submitter_name`, `relationship`, `contact_email`,
	`body`, `evidence_json`, `status`, `moderator_notes`, `public_resolution`, `author_fingerprint`,
	`submitter_verified`, `created_at`, `updated_at`
) SELECT
	`id`, `account_id`, `report_id`, `request_type`, `submitter_name`, `relationship`, `contact_email`,
	`body`, `evidence_json`, `status`, `moderator_notes`, `public_resolution`, `author_fingerprint`,
	`submitter_verified`, `created_at`, `updated_at`
FROM `appeals`;--> statement-breakpoint
DROP TABLE `appeals`;--> statement-breakpoint
ALTER TABLE `__new_appeals` RENAME TO `appeals`;--> statement-breakpoint
CREATE INDEX `idx_appeals_report_status` ON `appeals` (`report_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_appeals_status_created` ON `appeals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_appeals_fingerprint_created` ON `appeals` (`author_fingerprint`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_appeals_account_created` ON `appeals` (`account_id`,`created_at`);--> statement-breakpoint

CREATE TABLE `__new_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`parent_id` text,
	`account_id` text,
	`display_name` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`moderator_notes` text DEFAULT '' NOT NULL,
	`author_fingerprint` text NOT NULL,
	`reviewer_verified` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_comments` (
	`id`, `report_id`, `parent_id`, `account_id`, `display_name`, `body`, `status`,
	`moderator_notes`, `author_fingerprint`, `reviewer_verified`, `created_at`, `updated_at`
) SELECT
	`id`, `report_id`, `parent_id`, `account_id`, `display_name`, `body`, `status`,
	`moderator_notes`, `author_fingerprint`, `reviewer_verified`, `created_at`, `updated_at`
FROM `comments`;--> statement-breakpoint
DROP TABLE `comments`;--> statement-breakpoint
ALTER TABLE `__new_comments` RENAME TO `comments`;--> statement-breakpoint
CREATE INDEX `idx_comments_report_status_created` ON `comments` (`report_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_comments_parent_id` ON `comments` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_comments_fingerprint_created` ON `comments` (`author_fingerprint`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_comments_account_created` ON `comments` (`account_id`,`created_at`);--> statement-breakpoint

CREATE TABLE `__new_report_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`related_report_id` text,
	`submitter_name` text NOT NULL,
	`contact_email` text DEFAULT '' NOT NULL,
	`username` text NOT NULL,
	`discord_id` text NOT NULL,
	`game` text NOT NULL,
	`category` text NOT NULL,
	`reason` text NOT NULL,
	`description` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`moderator_notes` text DEFAULT '' NOT NULL,
	`author_fingerprint` text NOT NULL,
	`submitter_verified` integer DEFAULT false NOT NULL,
	`result_report_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`related_report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`result_report_id`) REFERENCES `reports`(`id`) ON UPDATE no action ON DELETE set null
);--> statement-breakpoint
INSERT INTO `__new_report_submissions` (
	`id`, `account_id`, `related_report_id`, `submitter_name`, `contact_email`, `username`, `discord_id`,
	`game`, `category`, `reason`, `description`, `evidence_json`, `status`, `moderator_notes`,
	`author_fingerprint`, `submitter_verified`, `result_report_id`, `created_at`, `updated_at`
) SELECT
	`id`, `account_id`, `related_report_id`, `submitter_name`, `contact_email`, `username`, `discord_id`,
	`game`, `category`, `reason`, `description`, `evidence_json`, `status`, `moderator_notes`,
	`author_fingerprint`, `submitter_verified`, `result_report_id`, `created_at`, `updated_at`
FROM `report_submissions`;--> statement-breakpoint
DROP TABLE `report_submissions`;--> statement-breakpoint
ALTER TABLE `__new_report_submissions` RENAME TO `report_submissions`;--> statement-breakpoint
CREATE INDEX `idx_report_submissions_status_created` ON `report_submissions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_report_submissions_discord_id` ON `report_submissions` (`discord_id`);--> statement-breakpoint
CREATE INDEX `idx_report_submissions_fingerprint_created` ON `report_submissions` (`author_fingerprint`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_report_submissions_account_created` ON `report_submissions` (`account_id`,`created_at`);--> statement-breakpoint

CREATE VIEW `report_family_metrics` AS
WITH `family_members` AS (
	SELECT
		`id` AS `member_report_id`,
		COALESCE(`merged_into_report_id`, `id`) AS `canonical_report_id`
	FROM `reports`
),
`family_review_candidates` AS (
	SELECT
		`family_members`.`canonical_report_id` AS `report_id`,
		`reviews`.`rating`,
		ROW_NUMBER() OVER (
			PARTITION BY
				`family_members`.`canonical_report_id`,
				COALESCE(`reviews`.`account_id`, 'review:' || `reviews`.`id`)
			ORDER BY `reviews`.`updated_at` DESC, `reviews`.`id` DESC
		) AS `family_position`
	FROM `family_members`
	INNER JOIN `reviews`
		ON `reviews`.`report_id` = `family_members`.`member_report_id`
		AND `reviews`.`status` = 'Approved'
),
`family_reviews` AS (
	SELECT
		`report_id`,
		COUNT(*) AS `approved_review_count`,
		COALESCE(SUM(`rating`), 0) AS `approved_rating_sum`
	FROM `family_review_candidates`
	WHERE `family_position` = 1
	GROUP BY `report_id`
),
`family_evidence` AS (
	SELECT
		`family_members`.`canonical_report_id` AS `report_id`,
		COUNT(DISTINCT `report_evidence`.`evidence_id`) AS `public_evidence_count`
	FROM `family_members`
	INNER JOIN `report_evidence`
		ON `report_evidence`.`report_id` = `family_members`.`member_report_id`
	INNER JOIN `evidence_assets`
		ON `evidence_assets`.`id` = `report_evidence`.`evidence_id`
		AND `evidence_assets`.`state` = 'public'
	GROUP BY `family_members`.`canonical_report_id`
)
SELECT
	`reports`.`id` AS `report_id`,
	COALESCE(`family_reviews`.`approved_review_count`, 0) AS `approved_review_count`,
	COALESCE(`family_reviews`.`approved_rating_sum`, 0) AS `approved_rating_sum`,
	COALESCE(`family_evidence`.`public_evidence_count`, 0) AS `public_evidence_count`
FROM `reports`
LEFT JOIN `family_reviews` ON `family_reviews`.`report_id` = `reports`.`id`
LEFT JOIN `family_evidence` ON `family_evidence`.`report_id` = `reports`.`id`
WHERE `reports`.`merged_into_report_id` IS NULL;
