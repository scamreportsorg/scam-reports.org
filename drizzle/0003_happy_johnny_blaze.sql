CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`display_name` text NOT NULL,
	`rating` integer NOT NULL,
	`relationship` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`moderator_notes` text DEFAULT '' NOT NULL,
	`author_fingerprint` text NOT NULL,
	`reviewer_verified` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_reviews_report_status` ON `reviews` (`report_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_reviews_created_at` ON `reviews` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_reviews_fingerprint_created` ON `reviews` (`author_fingerprint`,`created_at`);