CREATE TABLE `moderator_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`motivation` text NOT NULL,
	`experience` text NOT NULL,
	`timezone` text NOT NULL,
	`availability` text NOT NULL,
	`languages` text NOT NULL,
	`conflicts` text NOT NULL,
	`confirmation_accepted` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'Pending' NOT NULL,
	`moderator_notes` text DEFAULT '' NOT NULL,
	`reviewed_by_account_id` text,
	`reviewed_at` text,
	`withdrawn_at` text,
	`purge_after` text,
	`answers_erased_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `moderator_applications_account_id_accounts_id_fk`
		FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT `moderator_applications_reviewed_by_account_id_accounts_id_fk`
		FOREIGN KEY (`reviewed_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `moderator_applications_status_check`
		CHECK (`moderator_applications`.`status` IN ('Pending', 'Under Review', 'Accepted', 'Rejected', 'Withdrawn', 'Expired')),
	CONSTRAINT `moderator_applications_confirmation_check`
		CHECK (`moderator_applications`.`confirmation_accepted` IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `idx_moderator_applications_status_created`
	ON `moderator_applications` (`status`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_moderator_applications_status_updated`
	ON `moderator_applications` (`status`, `updated_at`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_moderator_applications_account_created`
	ON `moderator_applications` (`account_id`, `created_at`, `id`);
--> statement-breakpoint
CREATE INDEX `idx_moderator_applications_reviewer`
	ON `moderator_applications` (`reviewed_by_account_id`, `reviewed_at`);
--> statement-breakpoint
CREATE INDEX `idx_moderator_applications_retention`
	ON `moderator_applications` (`answers_erased_at`, `purge_after`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_moderator_applications_one_active`
	ON `moderator_applications` (`account_id`)
	WHERE `status` IN ('Pending', 'Under Review');
--> statement-breakpoint
CREATE TRIGGER `moderator_applications_submit_requirements`
BEFORE INSERT ON `moderator_applications`
WHEN NOT (
	NEW.`confirmation_accepted` = 1
	AND EXISTS (
		SELECT 1 FROM `accounts`
		WHERE `id` = NEW.`account_id` AND `role` = 'member' AND `status` = 'active'
	)
	AND EXISTS (
		SELECT 1 FROM `account_identities`
		WHERE `account_id` = NEW.`account_id` AND `provider` = 'discord'
	)
	AND EXISTS (
		SELECT 1 FROM `account_identities`
		WHERE `account_id` = NEW.`account_id` AND `provider` = 'email'
	)
)
BEGIN
	SELECT RAISE(ABORT, 'moderator_application_eligibility_required');
END;
--> statement-breakpoint
CREATE TRIGGER `moderator_applications_status_transition`
BEFORE UPDATE OF `status` ON `moderator_applications`
WHEN NEW.`status` != OLD.`status` AND NOT (
	(OLD.`status` = 'Pending' AND NEW.`status` IN ('Under Review', 'Withdrawn', 'Expired'))
	OR (OLD.`status` = 'Under Review' AND NEW.`status` IN ('Accepted', 'Rejected', 'Withdrawn', 'Expired'))
)
BEGIN
	SELECT RAISE(ABORT, 'moderator_application_invalid_transition');
END;
--> statement-breakpoint
CREATE TRIGGER `moderator_applications_staff_actor`
BEFORE UPDATE OF `status` ON `moderator_applications`
WHEN NEW.`status` != OLD.`status` AND NEW.`status` IN ('Under Review', 'Accepted', 'Rejected')
	AND NOT EXISTS (
		SELECT 1 FROM `accounts` AS `staff`
		WHERE `staff`.`id` = NEW.`reviewed_by_account_id`
			AND `staff`.`role` IN ('moderator', 'admin')
			AND `staff`.`status` = 'active'
			AND EXISTS (
				SELECT 1 FROM `account_identities`
				WHERE `account_id` = `staff`.`id` AND `provider` = 'discord'
			)
			AND EXISTS (
				SELECT 1 FROM `account_identities`
				WHERE `account_id` = `staff`.`id` AND `provider` = 'email'
			)
	)
BEGIN
	SELECT RAISE(ABORT, 'moderator_application_staff_required');
END;
--> statement-breakpoint
CREATE TRIGGER `moderator_applications_accept_requirements`
BEFORE UPDATE OF `status` ON `moderator_applications`
WHEN NEW.`status` = 'Accepted' AND OLD.`status` != 'Accepted' AND NOT (
	EXISTS (
		SELECT 1 FROM `accounts` AS `administrator`
		WHERE `administrator`.`id` = NEW.`reviewed_by_account_id`
			AND `administrator`.`role` = 'admin'
			AND `administrator`.`status` = 'active'
	)
	AND EXISTS (
		SELECT 1 FROM `accounts` AS `applicant`
		WHERE `applicant`.`id` = NEW.`account_id`
			AND `applicant`.`role` = 'member'
			AND `applicant`.`status` = 'active'
			AND EXISTS (
				SELECT 1 FROM `account_identities`
				WHERE `account_id` = `applicant`.`id` AND `provider` = 'discord'
			)
			AND EXISTS (
				SELECT 1 FROM `account_identities`
				WHERE `account_id` = `applicant`.`id` AND `provider` = 'email'
			)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'moderator_application_acceptance_requirements');
END;
--> statement-breakpoint
CREATE TRIGGER `moderator_applications_audit_insert`
AFTER INSERT ON `moderator_applications`
BEGIN
	INSERT INTO `audit_logs`
		(`report_id`, `action`, `actor`, `actor_account_id`, `created_at`, `detail`)
	VALUES (
		NEW.`id`,
		'moderator-application-submitted',
		COALESCE((SELECT `handle` FROM `accounts` WHERE `id` = NEW.`account_id`), 'Member'),
		NEW.`account_id`,
		NEW.`created_at`,
		'Application entered the private staff queue.'
	);
END;
--> statement-breakpoint
CREATE TRIGGER `moderator_applications_audit_status`
AFTER UPDATE OF `status` ON `moderator_applications`
WHEN NEW.`status` != OLD.`status`
BEGIN
	INSERT INTO `audit_logs`
		(`report_id`, `action`, `actor`, `actor_account_id`, `created_at`, `detail`)
	VALUES (
		NEW.`id`,
		'moderator-application-' || lower(replace(NEW.`status`, ' ', '-')),
		CASE
			WHEN NEW.`status` = 'Expired' THEN 'system:retention'
			ELSE COALESCE((
				SELECT `handle` FROM `accounts`
				WHERE `id` = CASE
					WHEN NEW.`status` = 'Withdrawn' THEN NEW.`account_id`
					ELSE NEW.`reviewed_by_account_id`
				END
			), 'System')
		END,
		CASE
			WHEN NEW.`status` = 'Withdrawn' THEN NEW.`account_id`
			WHEN NEW.`status` = 'Expired' THEN NULL
			ELSE NEW.`reviewed_by_account_id`
		END,
		NEW.`updated_at`,
		CASE
			WHEN NEW.`status` = 'Expired' THEN 'status=Expired'
			ELSE OLD.`status` || ' -> ' || NEW.`status`
		END
	);
END;
--> statement-breakpoint
CREATE TRIGGER `moderator_applications_schedule_redaction`
AFTER UPDATE OF `status` ON `moderator_applications`
WHEN NEW.`status` != OLD.`status`
	AND NEW.`status` IN ('Accepted', 'Rejected', 'Withdrawn', 'Expired')
BEGIN
	UPDATE `moderator_applications`
	SET `purge_after` = CASE
		WHEN NEW.`status` = 'Expired' THEN NEW.`updated_at`
		ELSE strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`updated_at`, '+90 days')
	END
	WHERE `id` = NEW.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `moderator_applications_expired_redaction`
AFTER UPDATE OF `status` ON `moderator_applications`
WHEN NEW.`status` = 'Expired' AND OLD.`status` != 'Expired'
BEGIN
	UPDATE `moderator_applications`
	SET `motivation` = '',
		`experience` = '',
		`timezone` = '',
		`availability` = '',
		`languages` = '',
		`conflicts` = '',
		`moderator_notes` = '',
		`reviewed_by_account_id` = NULL,
		`purge_after` = NEW.`updated_at`,
		`answers_erased_at` = NEW.`updated_at`
	WHERE `id` = NEW.`id` AND `answers_erased_at` IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `moderator_applications_audit_redaction`
AFTER UPDATE OF `answers_erased_at` ON `moderator_applications`
WHEN OLD.`answers_erased_at` IS NULL AND NEW.`answers_erased_at` IS NOT NULL
BEGIN
	INSERT INTO `audit_logs`
		(`report_id`, `action`, `actor`, `actor_account_id`, `created_at`, `detail`)
	VALUES (
		NEW.`id`,
		'moderator-application-answers-erased',
		'system:retention',
		NULL,
		NEW.`answers_erased_at`,
		'status=' || NEW.`status`
	);
END;
--> statement-breakpoint
CREATE TRIGGER `moderator_applications_grant_role`
AFTER UPDATE OF `status` ON `moderator_applications`
WHEN NEW.`status` = 'Accepted' AND OLD.`status` != 'Accepted'
BEGIN
	UPDATE `accounts`
	SET `role` = 'moderator',
		`role_version` = `role_version` + 1,
		`updated_at` = NEW.`updated_at`
	WHERE `id` = NEW.`account_id` AND `role` = 'member' AND `status` = 'active';

	INSERT INTO `auth_security_events`
		(`id`, `account_id`, `event_type`, `detail`, `created_at`)
	VALUES (
		'security_' || lower(hex(randomblob(16))),
		NEW.`account_id`,
		'account.access_changed',
		json_object(
			'actorAccountId', NEW.`reviewed_by_account_id`,
			'targetAccountId', NEW.`account_id`,
			'fromRole', 'member',
			'toRole', 'moderator',
			'source', 'moderator_application',
			'applicationId', NEW.`id`
		),
		NEW.`updated_at`
	);
END;
