ALTER TABLE `auth_magic_links` ADD `initiating_session_id` text REFERENCES auth_sessions(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `auth_oauth_transactions` ADD `initiating_session_id` text REFERENCES auth_sessions(id) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `discord_confirmed_at` text;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD `email_confirmed_at` text;
