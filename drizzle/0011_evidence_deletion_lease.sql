CREATE TRIGGER `evidence_legal_hold_deleted_insert`
BEFORE INSERT ON `evidence_assets`
WHEN NEW.`legal_hold` = 1 AND (
	NEW.`state` = 'deleted' OR NEW.`deleted_at` LIKE 'deletion-pending:%'
)
BEGIN
	SELECT RAISE(ABORT, 'evidence_legal_hold_delete_forbidden');
END;--> statement-breakpoint

CREATE TRIGGER `evidence_legal_hold_deleted_update`
BEFORE UPDATE OF `state`, `legal_hold`, `deleted_at` ON `evidence_assets`
WHEN NEW.`legal_hold` = 1 AND (
	NEW.`state` = 'deleted' OR NEW.`deleted_at` LIKE 'deletion-pending:%'
)
BEGIN
	SELECT RAISE(ABORT, 'evidence_legal_hold_delete_forbidden');
END;--> statement-breakpoint

CREATE TRIGGER `evidence_deletion_lease_guard`
BEFORE UPDATE ON `evidence_assets`
WHEN OLD.`deleted_at` LIKE 'deletion-pending:%' AND NOT (
	(
		NEW.`state` = 'withheld' AND NEW.`legal_hold` = 0
		AND NEW.`deleted_at` IS NULL
	) OR (
		NEW.`state` = 'withheld' AND NEW.`legal_hold` = 0
		AND NEW.`deleted_at` LIKE 'deletion-pending:%'
		AND NEW.`deleted_at` != OLD.`deleted_at`
	) OR (
		NEW.`state` = 'deleted' AND NEW.`legal_hold` = 0
		AND NEW.`deleted_at` IS NOT NULL
		AND NEW.`deleted_at` NOT LIKE 'deletion-pending:%'
	)
)
BEGIN
	SELECT RAISE(ABORT, 'evidence_deletion_in_progress');
END;--> statement-breakpoint

CREATE TRIGGER `evidence_deletion_lease_delete_guard`
BEFORE DELETE ON `evidence_assets`
WHEN OLD.`legal_hold` = 1 OR OLD.`deleted_at` LIKE 'deletion-pending:%'
BEGIN
	SELECT RAISE(ABORT, 'evidence_legal_hold_delete_forbidden');
END;
