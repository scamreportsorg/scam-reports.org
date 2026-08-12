CREATE INDEX `idx_reviews_status_account_report_updated` ON `reviews` (`status`,`account_id`,`report_id`,`updated_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_comments_account_status_report_created` ON `comments` (`account_id`,`status`,`report_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_report_submissions_status_account_result` ON `report_submissions` (`status`,`account_id`,`result_report_id`);--> statement-breakpoint
CREATE VIEW `public_member_activity` AS
WITH `accepted_report_activity` AS (
  SELECT
    `submission`.`account_id` AS `account_id`,
    COUNT(DISTINCT COALESCE(`report`.`merged_into_report_id`, `report`.`id`)) AS `approved_report_count`
  FROM `report_submissions` `submission`
  INNER JOIN `reports` `report` ON `report`.`id` = `submission`.`result_report_id`
  LEFT JOIN `reports` `canonical` ON `canonical`.`id` = `report`.`merged_into_report_id`
  WHERE `submission`.`account_id` IS NOT NULL
    AND `submission`.`status` = 'Accepted'
    AND (
      (`report`.`merged_into_report_id` IS NULL AND `report`.`is_published` = 1)
      OR (`report`.`merged_into_report_id` IS NOT NULL AND `canonical`.`is_published` = 1)
    )
  GROUP BY `submission`.`account_id`
),
`approved_review_activity` AS (
  SELECT
    `review`.`account_id` AS `account_id`,
    COUNT(DISTINCT COALESCE(`report`.`merged_into_report_id`, `report`.`id`)) AS `approved_review_count`
  FROM `reviews` `review`
  INNER JOIN `reports` `report` ON `report`.`id` = `review`.`report_id`
  LEFT JOIN `reports` `canonical` ON `canonical`.`id` = `report`.`merged_into_report_id`
  WHERE `review`.`account_id` IS NOT NULL
    AND `review`.`status` = 'Approved'
    AND (
      (`report`.`merged_into_report_id` IS NULL AND `report`.`is_published` = 1)
      OR (`report`.`merged_into_report_id` IS NOT NULL AND `canonical`.`is_published` = 1)
    )
  GROUP BY `review`.`account_id`
),
`ranked_comment_activity` AS (
  SELECT
    `comment`.`account_id` AS `account_id`,
    ROW_NUMBER() OVER (
      PARTITION BY
        `comment`.`account_id`,
        COALESCE(`report`.`merged_into_report_id`, `report`.`id`),
        SUBSTR(`comment`.`created_at`, 1, 10)
      ORDER BY `comment`.`created_at` ASC, `comment`.`id` ASC
    ) AS `daily_thread_position`
  FROM `comments` `comment`
  INNER JOIN `reports` `report` ON `report`.`id` = `comment`.`report_id`
  LEFT JOIN `reports` `canonical` ON `canonical`.`id` = `report`.`merged_into_report_id`
  WHERE `comment`.`account_id` IS NOT NULL
    AND `comment`.`status` = 'Approved'
    AND (
      (`report`.`merged_into_report_id` IS NULL AND `report`.`is_published` = 1)
      OR (`report`.`merged_into_report_id` IS NOT NULL AND `canonical`.`is_published` = 1)
    )
),
`approved_comment_activity` AS (
  SELECT
    `account_id`,
    COUNT(*) AS `approved_comment_count`,
    SUM(CASE WHEN `daily_thread_position` <= 3 THEN 1 ELSE 0 END) AS `score_eligible_comment_count`
  FROM `ranked_comment_activity`
  GROUP BY `account_id`
)
SELECT
  `account`.`id` AS `account_id`,
  COALESCE(`reports`.`approved_report_count`, 0) AS `approved_report_count`,
  COALESCE(`reviews`.`approved_review_count`, 0) AS `approved_review_count`,
  COALESCE(`comments`.`approved_comment_count`, 0) AS `approved_comment_count`,
  COALESCE(`comments`.`score_eligible_comment_count`, 0) AS `score_eligible_comment_count`
FROM `accounts` `account`
LEFT JOIN `accepted_report_activity` `reports` ON `reports`.`account_id` = `account`.`id`
LEFT JOIN `approved_review_activity` `reviews` ON `reviews`.`account_id` = `account`.`id`
LEFT JOIN `approved_comment_activity` `comments` ON `comments`.`account_id` = `account`.`id`
WHERE `account`.`status` = 'active';
