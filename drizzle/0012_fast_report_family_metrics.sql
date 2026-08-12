DROP VIEW `report_family_metrics`;--> statement-breakpoint
CREATE VIEW `report_family_metrics` AS
WITH `merged_family_members` AS (
  SELECT
    `alias`.`id` AS `member_report_id`,
    `alias`.`merged_into_report_id` AS `canonical_report_id`
  FROM `reports` AS `alias`
  WHERE `alias`.`merged_into_report_id` IS NOT NULL
  UNION ALL
  SELECT DISTINCT
    `canonical`.`id` AS `member_report_id`,
    `canonical`.`id` AS `canonical_report_id`
  FROM `reports` AS `alias`
  INNER JOIN `reports` AS `canonical`
    ON `canonical`.`id` = `alias`.`merged_into_report_id`
  WHERE `alias`.`merged_into_report_id` IS NOT NULL
),
`merged_report_ids` AS (
  SELECT DISTINCT `canonical_report_id` AS `report_id`
  FROM `merged_family_members`
),
`merged_review_candidates` AS (
  SELECT
    `merged_family_members`.`canonical_report_id` AS `report_id`,
    `reviews`.`rating`,
    ROW_NUMBER() OVER (
      PARTITION BY
        `merged_family_members`.`canonical_report_id`,
        COALESCE(`reviews`.`account_id`, 'review:' || `reviews`.`id`)
      ORDER BY `reviews`.`updated_at` DESC, `reviews`.`id` DESC
    ) AS `family_position`
  FROM `merged_family_members`
  INNER JOIN `reviews`
    ON `reviews`.`report_id` = `merged_family_members`.`member_report_id`
   AND `reviews`.`status` = 'Approved'
),
`merged_reviews` AS (
  SELECT
    `report_id`,
    COUNT(*) AS `approved_review_count`,
    COALESCE(SUM(`rating`), 0) AS `approved_rating_sum`
  FROM `merged_review_candidates`
  WHERE `family_position` = 1
  GROUP BY `report_id`
),
`merged_evidence` AS (
  SELECT
    `merged_family_members`.`canonical_report_id` AS `report_id`,
    COUNT(DISTINCT `report_evidence`.`evidence_id`) AS `public_evidence_count`
  FROM `merged_family_members`
  INNER JOIN `report_evidence`
    ON `report_evidence`.`report_id` = `merged_family_members`.`member_report_id`
  INNER JOIN `evidence_assets`
    ON `evidence_assets`.`id` = `report_evidence`.`evidence_id`
   AND `evidence_assets`.`state` = 'public'
  GROUP BY `merged_family_members`.`canonical_report_id`
)
SELECT
  `reports`.`id` AS `report_id`,
  `reports`.`approved_review_count` AS `approved_review_count`,
  `reports`.`approved_rating_sum` AS `approved_rating_sum`,
  `reports`.`evidence_count` AS `public_evidence_count`
FROM `reports`
WHERE `reports`.`merged_into_report_id` IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM `merged_report_ids`
    WHERE `merged_report_ids`.`report_id` = `reports`.`id`
  )
UNION ALL
SELECT
  `reports`.`id` AS `report_id`,
  COALESCE(`merged_reviews`.`approved_review_count`, 0) AS `approved_review_count`,
  COALESCE(`merged_reviews`.`approved_rating_sum`, 0) AS `approved_rating_sum`,
  COALESCE(`merged_evidence`.`public_evidence_count`, 0) AS `public_evidence_count`
FROM `reports`
INNER JOIN `merged_report_ids`
  ON `merged_report_ids`.`report_id` = `reports`.`id`
LEFT JOIN `merged_reviews`
  ON `merged_reviews`.`report_id` = `reports`.`id`
LEFT JOIN `merged_evidence`
  ON `merged_evidence`.`report_id` = `reports`.`id`
WHERE `reports`.`merged_into_report_id` IS NULL;
