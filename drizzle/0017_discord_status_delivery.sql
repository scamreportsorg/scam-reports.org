CREATE TABLE `discord_status_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`webhook_fingerprint` text NOT NULL,
	`delivery_state` text DEFAULT 'active' NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "discord_status_messages_id_check" CHECK("discord_status_messages"."id" = 'primary'),
	CONSTRAINT "discord_status_messages_fingerprint_check" CHECK(length("discord_status_messages"."webhook_fingerprint") = 64 AND "discord_status_messages"."webhook_fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "discord_status_messages_message_id_check" CHECK("discord_status_messages"."message_id" IS NULL OR (length("discord_status_messages"."message_id") BETWEEN 15 AND 22 AND "discord_status_messages"."message_id" NOT GLOB '*[^0-9]*')),
	CONSTRAINT "discord_status_messages_delivery_state_check" CHECK("discord_status_messages"."delivery_state" IN ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `provider_message_id` text;