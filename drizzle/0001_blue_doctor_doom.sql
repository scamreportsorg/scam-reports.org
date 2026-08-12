CREATE INDEX `idx_audit_logs_report_id` ON `audit_logs` (`report_id`);--> statement-breakpoint
CREATE INDEX `idx_reports_status` ON `reports` (`status`);--> statement-breakpoint
CREATE INDEX `idx_reports_date_added` ON `reports` (`date_added`);--> statement-breakpoint
CREATE INDEX `idx_reports_discord_id` ON `reports` (`discord_id`);