CREATE TABLE `security_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`signal_type` text NOT NULL,
	`action` text NOT NULL,
	`method` text NOT NULL,
	`endpoint` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`country` text NOT NULL,
	`asn` integer,
	`event_count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	CONSTRAINT "security_incidents_source_check" CHECK("security_incidents"."source" IN ('app', 'cloudflare')),
	CONSTRAINT "security_incidents_count_check" CHECK("security_incidents"."event_count" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_security_incidents_recent` ON `security_incidents` (`last_seen_at`,`event_count`);--> statement-breakpoint
CREATE TABLE `security_monitor_state` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`configuration_fingerprint` text NOT NULL,
	`delivery_state` text DEFAULT 'active' NOT NULL,
	`last_waf_poll_at` text,
	`last_waf_error_code` text DEFAULT '' NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`updated_at` text NOT NULL,
	CONSTRAINT "security_monitor_state_id_check" CHECK("security_monitor_state"."id" = 'primary'),
	CONSTRAINT "security_monitor_state_fingerprint_check" CHECK(length("security_monitor_state"."configuration_fingerprint") = 64 AND "security_monitor_state"."configuration_fingerprint" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "security_monitor_state_message_id_check" CHECK("security_monitor_state"."message_id" IS NULL OR (length("security_monitor_state"."message_id") BETWEEN 15 AND 22 AND "security_monitor_state"."message_id" NOT GLOB '*[^0-9]*')),
	CONSTRAINT "security_monitor_state_delivery_check" CHECK("security_monitor_state"."delivery_state" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE `security_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`source` text NOT NULL,
	`signal_type` text NOT NULL,
	`action` text NOT NULL,
	`method` text NOT NULL,
	`endpoint` text NOT NULL,
	`source_fingerprint` text NOT NULL,
	`country` text NOT NULL,
	`asn` integer,
	`observed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT "security_observations_source_check" CHECK("security_observations"."source" IN ('app', 'cloudflare')),
	CONSTRAINT "security_observations_method_check" CHECK("security_observations"."method" IN ('ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
	CONSTRAINT "security_observations_asn_check" CHECK("security_observations"."asn" IS NULL OR "security_observations"."asn" > 0)
);
--> statement-breakpoint
CREATE INDEX `idx_security_observations_expiry` ON `security_observations` (`expires_at`);
