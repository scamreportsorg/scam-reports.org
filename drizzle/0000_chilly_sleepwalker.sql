CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`report_id` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` text NOT NULL,
	`detail` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`discord_id` text NOT NULL,
	`game` text DEFAULT 'Unspecified' NOT NULL,
	`reason` text NOT NULL,
	`description` text NOT NULL,
	`status` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`moderator_notes` text DEFAULT '' NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`status_history_json` text DEFAULT '[]' NOT NULL,
	`date_added` text NOT NULL,
	`updated_at` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	`is_published` integer DEFAULT false NOT NULL
);
