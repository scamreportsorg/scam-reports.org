INSERT OR IGNORE INTO `report_status_events`
  (`id`, `report_id`, `status`, `public_note`, `actor_account_id`, `created_at`)
SELECT
  'RSE-LEGACY-' || r.`id` || '-' || history.key,
  r.`id`,
  json_extract(history.value, '$.status'),
  substr(COALESCE(json_extract(history.value, '$.note'), ''), 1, 1000),
  NULL,
  CASE
    WHEN typeof(json_extract(history.value, '$.date')) = 'text'
      AND length(json_extract(history.value, '$.date')) > 0
      THEN json_extract(history.value, '$.date')
    ELSE r.`updated_at`
  END
FROM `reports` r
JOIN json_each(
  CASE
    WHEN json_valid(r.`status_history_json`) THEN
      CASE WHEN json_type(r.`status_history_json`) = 'array'
        THEN r.`status_history_json` ELSE '[]' END
    ELSE '[]'
  END
) history
WHERE history.type = 'object'
  AND json_extract(history.value, '$.status') IN
    ('Reported', 'Under Review', 'Confirmed', 'Rejected');
--> statement-breakpoint
INSERT OR IGNORE INTO `report_status_events`
  (`id`, `report_id`, `status`, `public_note`, `actor_account_id`, `created_at`)
SELECT
  'RSE-BACKFILL-' || r.`id`,
  r.`id`,
  r.`status`,
  CASE WHEN length(trim(r.`notes`)) > 0
    THEN substr(r.`notes`, 1, 1000)
    ELSE 'Historical status imported during the normalized-ledger migration.'
  END,
  NULL,
  r.`updated_at`
FROM `reports` r
WHERE NOT EXISTS (
  SELECT 1 FROM `report_status_events` event WHERE event.`report_id` = r.`id`
);
