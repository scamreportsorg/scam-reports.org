CREATE TABLE `__migration_0008_preflight` (
	`reports_over_file_limit` integer NOT NULL CONSTRAINT `migration_0008_reports_over_file_limit` CHECK (`reports_over_file_limit` = 0),
	`reports_over_size_limit` integer NOT NULL CONSTRAINT `migration_0008_reports_over_size_limit` CHECK (`reports_over_size_limit` = 0)
);--> statement-breakpoint
INSERT INTO `__migration_0008_preflight` (`reports_over_file_limit`, `reports_over_size_limit`)
SELECT
	(SELECT COUNT(*) FROM (
		SELECT `report_id` FROM `report_evidence`
		GROUP BY `report_id` HAVING COUNT(*) > 5
	)),
	(SELECT COUNT(*) FROM (
		SELECT `report_evidence`.`report_id`
		FROM `report_evidence`
		INNER JOIN `evidence_assets`
			ON `evidence_assets`.`id` = `report_evidence`.`evidence_id`
		GROUP BY `report_evidence`.`report_id`
		HAVING COALESCE(SUM(`evidence_assets`.`original_size`), 0) > 20971520
	));--> statement-breakpoint
DROP TABLE `__migration_0008_preflight`;--> statement-breakpoint

ALTER TABLE `evidence_assets` ADD `privacy_withheld` integer DEFAULT 0 NOT NULL
	CONSTRAINT `evidence_assets_privacy_withheld_check` CHECK (`privacy_withheld` IN (0, 1));--> statement-breakpoint
ALTER TABLE `evidence_assets` ADD `replaces_evidence_id` text
	REFERENCES `evidence_assets`(`id`) ON DELETE restrict;--> statement-breakpoint
CREATE INDEX `idx_evidence_assets_replaces` ON `evidence_assets` (`replaces_evidence_id`);--> statement-breakpoint

CREATE TRIGGER `evidence_privacy_withheld_immutable`
BEFORE UPDATE OF `privacy_withheld` ON `evidence_assets`
WHEN OLD.`privacy_withheld` = 1 AND NEW.`privacy_withheld` != 1
BEGIN
	SELECT RAISE(ABORT, 'evidence_privacy_withheld_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `evidence_privacy_public_insert`
BEFORE INSERT ON `evidence_assets`
WHEN NEW.`state` = 'public' AND NEW.`privacy_withheld` = 1
BEGIN
	SELECT RAISE(ABORT, 'evidence_privacy_public_forbidden');
END;--> statement-breakpoint
CREATE TRIGGER `evidence_privacy_public_update`
BEFORE UPDATE OF `state`, `privacy_withheld` ON `evidence_assets`
WHEN NEW.`state` = 'public' AND NEW.`privacy_withheld` = 1
BEGIN
	SELECT RAISE(ABORT, 'evidence_privacy_public_forbidden');
END;--> statement-breakpoint

CREATE TRIGGER `evidence_replacement_insert`
BEFORE INSERT ON `evidence_assets`
WHEN NEW.`replaces_evidence_id` IS NOT NULL AND (
	NEW.`replaces_evidence_id` = NEW.`id` OR NOT EXISTS (
		SELECT 1 FROM `evidence_assets` AS `source`
		WHERE `source`.`id` = NEW.`replaces_evidence_id`
			AND `source`.`privacy_withheld` = 1
			AND `source`.`state` = 'withheld'
	)
)
BEGIN
	SELECT RAISE(ABORT, 'evidence_replacement_source_invalid');
END;--> statement-breakpoint
CREATE TRIGGER `evidence_replacement_update`
BEFORE UPDATE OF `replaces_evidence_id` ON `evidence_assets`
WHEN NEW.`replaces_evidence_id` IS NOT NULL AND (
	NEW.`replaces_evidence_id` = NEW.`id` OR NOT EXISTS (
		SELECT 1 FROM `evidence_assets` AS `source`
		WHERE `source`.`id` = NEW.`replaces_evidence_id`
			AND `source`.`privacy_withheld` = 1
			AND `source`.`state` = 'withheld'
	)
)
BEGIN
	SELECT RAISE(ABORT, 'evidence_replacement_source_invalid');
END;--> statement-breakpoint

CREATE TRIGGER `report_evidence_file_limit_insert`
BEFORE INSERT ON `report_evidence`
WHEN (
	SELECT COUNT(*) FROM `report_evidence`
	WHERE `report_id` = NEW.`report_id` AND `evidence_id` != NEW.`evidence_id`
) >= 5
BEGIN
	SELECT RAISE(ABORT, 'report_evidence_file_limit');
END;--> statement-breakpoint
CREATE TRIGGER `report_evidence_size_limit_insert`
BEFORE INSERT ON `report_evidence`
WHEN COALESCE((
	SELECT SUM(`evidence_assets`.`original_size`)
	FROM `report_evidence`
	INNER JOIN `evidence_assets`
		ON `evidence_assets`.`id` = `report_evidence`.`evidence_id`
	WHERE `report_evidence`.`report_id` = NEW.`report_id`
		AND `report_evidence`.`evidence_id` != NEW.`evidence_id`
), 0) + COALESCE((
	SELECT `original_size` FROM `evidence_assets` WHERE `id` = NEW.`evidence_id`
), 0) > 20971520
BEGIN
	SELECT RAISE(ABORT, 'report_evidence_size_limit');
END;--> statement-breakpoint
CREATE TRIGGER `report_evidence_file_limit_update`
BEFORE UPDATE OF `report_id`, `evidence_id` ON `report_evidence`
WHEN (
	SELECT COUNT(*) FROM `report_evidence`
	WHERE `report_id` = NEW.`report_id`
		AND NOT (`report_id` = OLD.`report_id` AND `evidence_id` = OLD.`evidence_id`)
) >= 5
BEGIN
	SELECT RAISE(ABORT, 'report_evidence_file_limit');
END;--> statement-breakpoint
CREATE TRIGGER `report_evidence_size_limit_update`
BEFORE UPDATE OF `report_id`, `evidence_id` ON `report_evidence`
WHEN COALESCE((
	SELECT SUM(`evidence_assets`.`original_size`)
	FROM `report_evidence`
	INNER JOIN `evidence_assets`
		ON `evidence_assets`.`id` = `report_evidence`.`evidence_id`
	WHERE `report_evidence`.`report_id` = NEW.`report_id`
		AND NOT (
			`report_evidence`.`report_id` = OLD.`report_id`
			AND `report_evidence`.`evidence_id` = OLD.`evidence_id`
		)
), 0) + COALESCE((
	SELECT `original_size` FROM `evidence_assets` WHERE `id` = NEW.`evidence_id`
), 0) > 20971520
BEGIN
	SELECT RAISE(ABORT, 'report_evidence_size_limit');
END;
