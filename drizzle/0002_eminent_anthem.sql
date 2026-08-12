ALTER TABLE `reports` ADD `category` text DEFAULT 'Other' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_reports_category` ON `reports` (`category`);
