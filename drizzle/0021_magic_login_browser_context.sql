ALTER TABLE `auth_magic_links` ADD `login_context_hash` text;--> statement-breakpoint
UPDATE `audit_logs`
SET `actor` = 'Anonymous appellant'
WHERE `action` = 'appeal-submitted' AND `actor_account_id` IS NULL;
