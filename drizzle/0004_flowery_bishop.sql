CREATE TABLE `appeals` (
	`id` text PRIMARY KEY NOT NULL,
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_appeals_report_status` ON `appeals` (`report_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_appeals_status_created` ON `appeals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_appeals_fingerprint_created` ON `appeals` (`author_fingerprint`,`created_at`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`parent_id` text,
	`display_name` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`moderator_notes` text DEFAULT '' NOT NULL,
	`author_fingerprint` text NOT NULL,
	`reviewer_verified` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_comments_report_status_created` ON `comments` (`report_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_comments_parent_id` ON `comments` (`parent_id`);--> statement-breakpoint
CREATE INDEX `idx_comments_fingerprint_created` ON `comments` (`author_fingerprint`,`created_at`);--> statement-breakpoint
CREATE TABLE `report_submissions` (
	`id` text PRIMARY KEY NOT NULL,
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
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_report_submissions_status_created` ON `report_submissions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_report_submissions_discord_id` ON `report_submissions` (`discord_id`);--> statement-breakpoint
CREATE INDEX `idx_report_submissions_fingerprint_created` ON `report_submissions` (`author_fingerprint`,`created_at`);