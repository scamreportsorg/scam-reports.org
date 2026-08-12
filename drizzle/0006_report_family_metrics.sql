CREATE VIEW `report_family_metrics` AS
WITH `family_members` AS (
  SELECT
    `id` AS `member_report_id`,
    COALESCE(`merged_into_report_id`, `id`) AS `canonical_report_id`
  FROM `reports`
),
`family_review_candidates` AS (
  SELECT
    `family_members`.`canonical_report_id` AS `report_id`,
    `reviews`.`rating`,
    ROW_NUMBER() OVER (
      PARTITION BY
        `family_members`.`canonical_report_id`,
        COALESCE(`reviews`.`account_id`, 'review:' || `reviews`.`id`)
      ORDER BY `reviews`.`updated_at` DESC, `reviews`.`id` DESC
    ) AS `family_position`
  FROM `family_members`
  INNER JOIN `reviews`
    ON `reviews`.`report_id` = `family_members`.`member_report_id`
   AND `reviews`.`status` = 'Approved'
),
`family_reviews` AS (
  SELECT
    `report_id`,
    COUNT(*) AS `approved_review_count`,
    COALESCE(SUM(`rating`), 0) AS `approved_rating_sum`
  FROM `family_review_candidates`
  WHERE `family_position` = 1
  GROUP BY `report_id`
),
`family_evidence` AS (
  SELECT
    `family_members`.`canonical_report_id` AS `report_id`,
    COUNT(DISTINCT `report_evidence`.`evidence_id`) AS `public_evidence_count`
  FROM `family_members`
  INNER JOIN `report_evidence`
    ON `report_evidence`.`report_id` = `family_members`.`member_report_id`
  INNER JOIN `evidence_assets`
    ON `evidence_assets`.`id` = `report_evidence`.`evidence_id`
   AND `evidence_assets`.`state` = 'public'
  GROUP BY `family_members`.`canonical_report_id`
)
SELECT
  `reports`.`id` AS `report_id`,
  COALESCE(`family_reviews`.`approved_review_count`, 0) AS `approved_review_count`,
  COALESCE(`family_reviews`.`approved_rating_sum`, 0) AS `approved_rating_sum`,
  COALESCE(`family_evidence`.`public_evidence_count`, 0) AS `public_evidence_count`
FROM `reports`
LEFT JOIN `family_reviews` ON `family_reviews`.`report_id` = `reports`.`id`
LEFT JOIN `family_evidence` ON `family_evidence`.`report_id` = `reports`.`id`
WHERE `reports`.`merged_into_report_id` IS NULL;
