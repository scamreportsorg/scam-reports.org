DROP TABLE IF EXISTS `_migration_0015_report_merge_guard`;--> statement-breakpoint
CREATE TABLE `_migration_0015_report_merge_guard` (
	`ok` integer NOT NULL CHECK (`ok` = 1)
);--> statement-breakpoint
INSERT INTO `_migration_0015_report_merge_guard` (`ok`)
SELECT CASE WHEN EXISTS (
	SELECT 1
	FROM `reports` AS `source`
	LEFT JOIN `reports` AS `target`
		ON `target`.`id` = `source`.`merged_into_report_id`
	WHERE `source`.`merged_into_report_id` IS NOT NULL
		AND (
			`source`.`id` = `source`.`merged_into_report_id`
			OR `target`.`id` IS NULL
			OR `target`.`merged_into_report_id` IS NOT NULL
			OR EXISTS (
				SELECT 1 FROM `reports` AS `child`
				WHERE `child`.`merged_into_report_id` = `source`.`id`
			)
		)
) THEN 0 ELSE 1 END;--> statement-breakpoint
DROP TABLE `_migration_0015_report_merge_guard`;--> statement-breakpoint

CREATE TRIGGER `reports_merge_integrity_insert`
BEFORE INSERT ON `reports`
WHEN NEW.`merged_into_report_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'report_merge_integrity_same_report')
	WHERE NEW.`id` = NEW.`merged_into_report_id`;
	SELECT RAISE(ABORT, 'report_merge_integrity_target_missing')
	WHERE NOT EXISTS (
			SELECT 1 FROM `reports` AS `target`
			WHERE `target`.`id` = NEW.`merged_into_report_id`
		);
	SELECT RAISE(ABORT, 'report_merge_integrity_target_not_canonical')
	WHERE EXISTS (
			SELECT 1 FROM `reports` AS `target`
			WHERE `target`.`id` = NEW.`merged_into_report_id`
				AND `target`.`merged_into_report_id` IS NOT NULL
		);
	SELECT RAISE(ABORT, 'report_merge_integrity_source_has_children')
	WHERE EXISTS (
			SELECT 1 FROM `reports` AS `child`
			WHERE `child`.`merged_into_report_id` = NEW.`id`
		);
END;--> statement-breakpoint

CREATE TRIGGER `reports_merge_integrity_update`
BEFORE UPDATE OF `merged_into_report_id` ON `reports`
WHEN NEW.`merged_into_report_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'report_merge_integrity_source_already_merged')
	WHERE OLD.`merged_into_report_id` IS NOT NULL;
	SELECT RAISE(ABORT, 'report_merge_integrity_same_report')
	WHERE NEW.`id` = NEW.`merged_into_report_id`;
	SELECT RAISE(ABORT, 'report_merge_integrity_target_missing')
	WHERE NOT EXISTS (
			SELECT 1 FROM `reports` AS `target`
			WHERE `target`.`id` = NEW.`merged_into_report_id`
		);
	SELECT RAISE(ABORT, 'report_merge_integrity_target_not_canonical')
	WHERE EXISTS (
			SELECT 1 FROM `reports` AS `target`
			WHERE `target`.`id` = NEW.`merged_into_report_id`
				AND `target`.`merged_into_report_id` IS NOT NULL
		);
	SELECT RAISE(ABORT, 'report_merge_integrity_source_has_children')
	WHERE EXISTS (
			SELECT 1 FROM `reports` AS `child`
			WHERE `child`.`merged_into_report_id` = OLD.`id`
		);
END;--> statement-breakpoint

CREATE TRIGGER `reports_merge_integrity_delete`
BEFORE DELETE ON `reports`
WHEN EXISTS (
	SELECT 1 FROM `reports` AS `child`
	WHERE `child`.`merged_into_report_id` = OLD.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'report_merge_integrity_canonical_has_children');
END;--> statement-breakpoint

CREATE TRIGGER `reports_merge_integrity_id_update`
BEFORE UPDATE OF `id` ON `reports`
WHEN NEW.`id` != OLD.`id` AND EXISTS (
	SELECT 1 FROM `reports` AS `child`
	WHERE `child`.`merged_into_report_id` = OLD.`id`
)
BEGIN
	SELECT RAISE(ABORT, 'report_merge_integrity_canonical_has_children');
END;
