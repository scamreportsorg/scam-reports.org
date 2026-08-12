import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  sqliteView,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    handle: text("handle").notNull(),
    handleNormalized: text("handle_normalized").notNull(),
    role: text("role").notNull().default("member"),
    status: text("status").notNull().default("active"),
    roleVersion: integer("role_version").notNull().default(1),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastAuthenticatedAt: text("last_authenticated_at"),
  },
  (table) => [
    uniqueIndex("idx_accounts_handle_normalized").on(table.handleNormalized),
    index("idx_accounts_role_status").on(table.role, table.status),
    check("accounts_role_check", sql`${table.role} IN ('member', 'moderator', 'admin')`),
    check("accounts_status_check", sql`${table.status} IN ('active', 'suspended')`),
  ],
);

export const accountIdentities = sqliteTable(
  "account_identities",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    subjectHash: text("subject_hash").notNull(),
    subjectEncrypted: text("subject_encrypted").notNull(),
    displayHint: text("display_hint").notNull(),
    verifiedAt: text("verified_at").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_account_identities_provider_subject").on(table.provider, table.subjectHash),
    uniqueIndex("idx_account_identities_account_provider").on(table.accountId, table.provider),
    index("idx_account_identities_account").on(table.accountId),
    check("account_identities_provider_check", sql`${table.provider} IN ('discord', 'email')`),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    csrfTokenHash: text("csrf_token_hash").notNull(),
    roleVersion: integer("role_version").notNull(),
    authenticatedAt: text("authenticated_at").notNull(),
    discordConfirmedAt: text("discord_confirmed_at"),
    emailConfirmedAt: text("email_confirmed_at"),
    createdAt: text("created_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    idleExpiresAt: text("idle_expires_at").notNull(),
    absoluteExpiresAt: text("absolute_expires_at").notNull(),
  },
  (table) => [
    index("idx_auth_sessions_account").on(table.accountId),
    index("idx_auth_sessions_idle_expiry").on(table.idleExpiresAt),
    index("idx_auth_sessions_absolute_expiry").on(table.absoluteExpiresAt),
  ],
);

export const authOauthTransactions = sqliteTable(
  "auth_oauth_transactions",
  {
    stateHash: text("state_hash").primaryKey(),
    provider: text("provider").notNull(),
    mode: text("mode").notNull(),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    initiatingSessionId: text("initiating_session_id").references(() => authSessions.id, {
      onDelete: "cascade",
    }),
    browserHash: text("browser_hash").notNull(),
    returnTo: text("return_to").notNull(),
    codeVerifierEncrypted: text("code_verifier_encrypted").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("idx_auth_oauth_expiry").on(table.expiresAt),
    check("auth_oauth_provider_check", sql`${table.provider} IN ('discord')`),
    check("auth_oauth_mode_check", sql`${table.mode} IN ('login', 'link')`),
  ],
);

export const authMagicLinks = sqliteTable(
  "auth_magic_links",
  {
    tokenHash: text("token_hash").primaryKey(),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "cascade" }),
    initiatingSessionId: text("initiating_session_id").references(() => authSessions.id, {
      onDelete: "cascade",
    }),
    loginContextHash: text("login_context_hash"),
    purpose: text("purpose").notNull(),
    subjectHash: text("subject_hash").notNull(),
    subjectEncrypted: text("subject_encrypted").notNull(),
    returnTo: text("return_to").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [index("idx_auth_magic_expiry").on(table.expiresAt)],
);

export const authSettings = sqliteTable("auth_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const authSecurityEvents = sqliteTable(
  "auth_security_events",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    detail: text("detail").notNull().default(""),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_auth_security_account_created").on(table.accountId, table.createdAt)],
);

export const moderatorApplications = sqliteTable(
  "moderator_applications",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    motivation: text("motivation").notNull(),
    experience: text("experience").notNull(),
    timezone: text("timezone").notNull(),
    availability: text("availability").notNull(),
    languages: text("languages").notNull(),
    conflicts: text("conflicts").notNull(),
    confirmationAccepted: integer("confirmation_accepted", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status").notNull().default("Pending"),
    moderatorNotes: text("moderator_notes").notNull().default(""),
    reviewedByAccountId: text("reviewed_by_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    reviewedAt: text("reviewed_at"),
    withdrawnAt: text("withdrawn_at"),
    purgeAfter: text("purge_after"),
    answersErasedAt: text("answers_erased_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_moderator_applications_status_created").on(table.status, table.createdAt, table.id),
    index("idx_moderator_applications_status_updated").on(table.status, table.updatedAt, table.id),
    index("idx_moderator_applications_account_created").on(
      table.accountId,
      table.createdAt,
      table.id,
    ),
    index("idx_moderator_applications_reviewer").on(table.reviewedByAccountId, table.reviewedAt),
    index("idx_moderator_applications_retention").on(table.answersErasedAt, table.purgeAfter),
    uniqueIndex("idx_moderator_applications_one_active")
      .on(table.accountId)
      .where(sql`${table.status} IN ('Pending', 'Under Review')`),
    check(
      "moderator_applications_status_check",
      sql`${table.status} IN ('Pending', 'Under Review', 'Accepted', 'Rejected', 'Withdrawn', 'Expired')`,
    ),
    check(
      "moderator_applications_confirmation_check",
      sql`${table.confirmationAccepted} IN (0, 1)`,
    ),
  ],
);

export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    username: text("username").notNull(),
    discordId: text("discord_id").notNull(),
    game: text("game").notNull().default("Unspecified"),
    category: text("category").notNull().default("Other"),
    reason: text("reason").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull(),
    notes: text("notes").notNull().default(""),
    moderatorNotes: text("moderator_notes").notNull().default(""),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    statusHistoryJson: text("status_history_json").notNull().default("[]"),
    dateAdded: text("date_added").notNull(),
    updatedAt: text("updated_at").notNull(),
    views: integer("views").notNull().default(0),
    isPublished: integer("is_published", { mode: "boolean" }).notNull().default(false),
    mergedIntoReportId: text("merged_into_report_id"),
    createdByAccountId: text("created_by_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    evidenceCount: integer("evidence_count").notNull().default(0),
    approvedReviewCount: integer("approved_review_count").notNull().default(0),
    approvedRatingSum: integer("approved_rating_sum").notNull().default(0),
  },
  (table) => [
    index("idx_reports_status").on(table.status),
    index("idx_reports_date_added").on(table.dateAdded),
    index("idx_reports_category").on(table.category),
    index("idx_reports_public_date").on(table.isPublished, table.dateAdded, table.id),
    index("idx_reports_public_status_date").on(
      table.isPublished,
      table.status,
      table.dateAdded,
      table.id,
    ),
    index("idx_reports_public_category_date").on(
      table.isPublished,
      table.category,
      table.dateAdded,
      table.id,
    ),
    index("idx_reports_public_views").on(table.isPublished, table.views, table.id),
    index("idx_reports_public_evidence").on(table.isPublished, table.evidenceCount, table.id),
    index("idx_reports_discord_id").on(table.discordId),
    index("idx_reports_merged_into").on(table.mergedIntoReportId),
    check(
      "reports_status_check",
      sql`${table.status} IN ('Reported', 'Under Review', 'Confirmed', 'Rejected')`,
    ),
  ],
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    reportId: text("report_id").notNull(),
    action: text("action").notNull(),
    actor: text("actor").notNull(),
    actorAccountId: text("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
    detail: text("detail").notNull().default(""),
  },
  (table) => [
    index("idx_audit_logs_report_id").on(table.reportId),
    index("idx_audit_logs_created").on(table.createdAt, table.id),
    index("idx_audit_logs_actor").on(table.actorAccountId, table.createdAt),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull(),
    rating: integer("rating").notNull(),
    relationship: text("relationship").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("Pending"),
    moderatorNotes: text("moderator_notes").notNull().default(""),
    authorFingerprint: text("author_fingerprint").notNull(),
    reviewerVerified: integer("reviewer_verified", { mode: "boolean" }).notNull().default(false),
    approvedRevisionId: text("approved_revision_id"),
    pendingRevisionId: text("pending_revision_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_reviews_report_status").on(table.reportId, table.status),
    index("idx_reviews_report_status_created").on(table.reportId, table.status, table.createdAt),
    index("idx_reviews_status_created").on(table.status, table.createdAt, table.id),
    index("idx_reviews_created_at").on(table.createdAt),
    index("idx_reviews_fingerprint_created").on(table.authorFingerprint, table.createdAt),
    index("idx_reviews_status_account_report_updated").on(
      table.status,
      table.accountId,
      table.reportId,
      table.updatedAt,
      table.id,
    ),
    uniqueIndex("idx_reviews_account_report").on(table.accountId, table.reportId),
    check("reviews_rating_check", sql`${table.rating} BETWEEN 1 AND 5`),
    check("reviews_status_check", sql`${table.status} IN ('Pending', 'Approved', 'Rejected')`),
  ],
);

export const reviewRevisions = sqliteTable(
  "review_revisions",
  {
    id: text("id").primaryKey(),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    rating: integer("rating").notNull(),
    relationship: text("relationship").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("Pending"),
    moderatorNotes: text("moderator_notes").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    moderatedAt: text("moderated_at"),
    moderatedByAccountId: text("moderated_by_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    index("idx_review_revisions_review_created").on(table.reviewId, table.createdAt),
    index("idx_review_revisions_status_created").on(table.status, table.createdAt),
    check("review_revisions_rating_check", sql`${table.rating} BETWEEN 1 AND 5`),
  ],
);

export const reportSubmissions = sqliteTable(
  "report_submissions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    relatedReportId: text("related_report_id").references(() => reports.id, {
      onDelete: "set null",
    }),
    submitterName: text("submitter_name").notNull(),
    contactEmail: text("contact_email").notNull().default(""),
    username: text("username").notNull(),
    discordId: text("discord_id").notNull(),
    game: text("game").notNull(),
    category: text("category").notNull(),
    reason: text("reason").notNull(),
    description: text("description").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    status: text("status").notNull().default("Pending"),
    moderatorNotes: text("moderator_notes").notNull().default(""),
    authorFingerprint: text("author_fingerprint").notNull(),
    submitterVerified: integer("submitter_verified", { mode: "boolean" }).notNull().default(false),
    resultReportId: text("result_report_id").references(() => reports.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_report_submissions_status_created").on(table.status, table.createdAt),
    index("idx_report_submissions_discord_id").on(table.discordId),
    index("idx_report_submissions_fingerprint_created").on(
      table.authorFingerprint,
      table.createdAt,
    ),
    index("idx_report_submissions_account_created").on(table.accountId, table.createdAt),
    index("idx_report_submissions_status_account_result").on(
      table.status,
      table.accountId,
      table.resultReportId,
    ),
  ],
);

export const appeals = sqliteTable(
  "appeals",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    requestType: text("request_type").notNull(),
    submitterName: text("submitter_name").notNull(),
    relationship: text("relationship").notNull(),
    contactEmail: text("contact_email").notNull().default(""),
    body: text("body").notNull(),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    status: text("status").notNull().default("Pending"),
    moderatorNotes: text("moderator_notes").notNull().default(""),
    publicResolution: text("public_resolution").notNull().default(""),
    authorFingerprint: text("author_fingerprint").notNull(),
    submitterVerified: integer("submitter_verified", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_appeals_report_status").on(table.reportId, table.status),
    index("idx_appeals_status_created").on(table.status, table.createdAt),
    index("idx_appeals_fingerprint_created").on(table.authorFingerprint, table.createdAt),
    index("idx_appeals_account_created").on(table.accountId, table.createdAt),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    displayName: text("display_name").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("Pending"),
    moderatorNotes: text("moderator_notes").notNull().default(""),
    authorFingerprint: text("author_fingerprint").notNull(),
    reviewerVerified: integer("reviewer_verified", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_comments_report_status_created").on(table.reportId, table.status, table.createdAt),
    index("idx_comments_parent_id").on(table.parentId),
    index("idx_comments_fingerprint_created").on(table.authorFingerprint, table.createdAt),
    index("idx_comments_account_created").on(table.accountId, table.createdAt),
    index("idx_comments_account_status_report_created").on(
      table.accountId,
      table.status,
      table.reportId,
      table.createdAt,
      table.id,
    ),
  ],
);

export const evidenceAssets = sqliteTable(
  "evidence_assets",
  {
    id: text("id").primaryKey(),
    intakeId: text("intake_id"),
    intakeKind: text("intake_kind").notNull(),
    state: text("state").notNull().default("uploading"),
    originalKey: text("original_key").notNull().unique(),
    derivativeKey: text("derivative_key").unique(),
    originalFilename: text("original_filename").notNull(),
    originalContentType: text("original_content_type").notNull(),
    originalSize: integer("original_size").notNull(),
    originalSha256: text("original_sha256").notNull(),
    derivativeContentType: text("derivative_content_type"),
    derivativeSize: integer("derivative_size"),
    derivativeSha256: text("derivative_sha256"),
    sourceWidth: integer("source_width"),
    sourceHeight: integer("source_height"),
    width: integer("width"),
    height: integer("height"),
    visiblePiiReviewed: integer("visible_pii_reviewed", { mode: "boolean" })
      .notNull()
      .default(false),
    privacyWithheld: integer("privacy_withheld", { mode: "boolean" }).notNull().default(false),
    replacesEvidenceId: text("replaces_evidence_id").references(
      (): AnySQLiteColumn => evidenceAssets.id,
      { onDelete: "restrict" },
    ),
    legalHold: integer("legal_hold", { mode: "boolean" }).notNull().default(false),
    processingError: text("processing_error").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    publishedAt: text("published_at"),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("idx_evidence_assets_state_created").on(table.state, table.createdAt),
    index("idx_evidence_assets_intake").on(table.intakeId, table.createdAt),
    index("idx_evidence_assets_replaces").on(table.replacesEvidenceId),
    check(
      "evidence_assets_intake_kind_check",
      sql`${table.intakeKind} IN ('report_submission', 'appeal', 'moderator_upload', 'legacy')`,
    ),
    check(
      "evidence_assets_state_check",
      sql`${table.state} IN ('uploading', 'private_ready', 'public', 'withheld', 'failed', 'deleted')`,
    ),
    check(
      "evidence_assets_mime_check",
      sql`${table.originalContentType} IN ('image/png', 'image/jpeg', 'image/webp')`,
    ),
    check("evidence_assets_privacy_withheld_check", sql`${table.privacyWithheld} IN (0, 1)`),
  ],
);

export const reportEvidence = sqliteTable(
  "report_evidence",
  {
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => evidenceAssets.id, { onDelete: "restrict" }),
    caption: text("caption").notNull().default(""),
    displayOrder: integer("display_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.reportId, table.evidenceId] }),
    index("idx_report_evidence_asset").on(table.evidenceId),
    index("idx_report_evidence_order").on(table.reportId, table.displayOrder),
  ],
);

export const reportStatusEvents = sqliteTable(
  "report_status_events",
  {
    id: text("id").primaryKey(),
    reportId: text("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    publicNote: text("public_note").notNull().default(""),
    actorAccountId: text("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_report_status_events_report_created").on(table.reportId, table.createdAt)],
);

export const reportMergeEvents = sqliteTable(
  "report_merge_events",
  {
    id: text("id").primaryKey(),
    duplicateReportId: text("duplicate_report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    canonicalReportId: text("canonical_report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    actorAccountId: text("actor_account_id").references(() => accounts.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    index("idx_report_merge_duplicate_created").on(table.duplicateReportId, table.createdAt),
  ],
);

export const rateEvents = sqliteTable(
  "rate_events",
  {
    id: text("id").primaryKey(),
    scope: text("scope").notNull(),
    subjectHash: text("subject_hash").notNull(),
    occurredAt: text("occurred_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("idx_rate_events_scope_subject_time").on(
      table.scope,
      table.subjectHash,
      table.occurredAt,
    ),
    index("idx_rate_events_expiry").on(table.expiresAt),
  ],
);

export const notificationOutbox = sqliteTable(
  "notification_outbox",
  {
    id: text("id").primaryKey(),
    eventKey: text("event_key").notNull().unique(),
    channel: text("channel").notNull(),
    caseId: text("case_id").notNull(),
    eventType: text("event_type").notNull(),
    queuePath: text("queue_path").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    lastError: text("last_error").notNull().default(""),
    providerMessageId: text("provider_message_id"),
    createdAt: text("created_at").notNull(),
    deliveredAt: text("delivered_at"),
  },
  (table) => [
    index("idx_notification_outbox_delivery").on(table.status, table.nextAttemptAt),
    check("notification_outbox_channel_check", sql`${table.channel} IN ('email', 'discord')`),
  ],
);

export const discordStatusMessages = sqliteTable(
  "discord_status_messages",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id"),
    webhookFingerprint: text("webhook_fingerprint").notNull(),
    deliveryState: text("delivery_state").notNull().default("active"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("discord_status_messages_id_check", sql`${table.id} = 'primary'`),
    check(
      "discord_status_messages_fingerprint_check",
      sql`length(${table.webhookFingerprint}) = 64 AND ${table.webhookFingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "discord_status_messages_message_id_check",
      sql`${table.messageId} IS NULL OR (length(${table.messageId}) BETWEEN 15 AND 22 AND ${table.messageId} NOT GLOB '*[^0-9]*')`,
    ),
    check(
      "discord_status_messages_delivery_state_check",
      sql`${table.deliveryState} IN ('active', 'disabled')`,
    ),
  ],
);

export const securityObservations = sqliteTable(
  "security_observations",
  {
    id: text("id").primaryKey(),
    incidentId: text("incident_id").notNull(),
    source: text("source").notNull(),
    signalType: text("signal_type").notNull(),
    action: text("action").notNull(),
    method: text("method").notNull(),
    endpoint: text("endpoint").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    country: text("country").notNull(),
    asn: integer("asn"),
    observedAt: text("observed_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (table) => [
    index("idx_security_observations_expiry").on(table.expiresAt),
    check("security_observations_source_check", sql`${table.source} IN ('app', 'cloudflare')`),
    check(
      "security_observations_method_check",
      sql`${table.method} IN ('ANY', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE')`,
    ),
    check("security_observations_asn_check", sql`${table.asn} IS NULL OR ${table.asn} > 0`),
  ],
);

export const securityIncidents = sqliteTable(
  "security_incidents",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    signalType: text("signal_type").notNull(),
    action: text("action").notNull(),
    method: text("method").notNull(),
    endpoint: text("endpoint").notNull(),
    sourceFingerprint: text("source_fingerprint").notNull(),
    country: text("country").notNull(),
    asn: integer("asn"),
    eventCount: integer("event_count").notNull().default(1),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
  },
  (table) => [
    index("idx_security_incidents_recent").on(table.lastSeenAt, table.eventCount),
    check("security_incidents_source_check", sql`${table.source} IN ('app', 'cloudflare')`),
    check("security_incidents_count_check", sql`${table.eventCount} > 0`),
  ],
);

export const securityMonitorState = sqliteTable(
  "security_monitor_state",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id"),
    configurationFingerprint: text("configuration_fingerprint").notNull(),
    deliveryState: text("delivery_state").notNull().default("active"),
    lastWafPollAt: text("last_waf_poll_at"),
    lastWafErrorCode: text("last_waf_error_code").notNull().default(""),
    lastDeliveryErrorCode: text("last_delivery_error_code").notNull().default(""),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    check("security_monitor_state_id_check", sql`${table.id} = 'primary'`),
    check(
      "security_monitor_state_fingerprint_check",
      sql`length(${table.configurationFingerprint}) = 64 AND ${table.configurationFingerprint} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "security_monitor_state_message_id_check",
      sql`${table.messageId} IS NULL OR (length(${table.messageId}) BETWEEN 15 AND 22 AND ${table.messageId} NOT GLOB '*[^0-9]*')`,
    ),
    check(
      "security_monitor_state_delivery_check",
      sql`${table.deliveryState} IN ('active', 'disabled')`,
    ),
  ],
);

export const discordRankSync = sqliteTable(
  "discord_rank_sync",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").references(() => accounts.id, { onDelete: "set null" }),
    subjectHash: text("subject_hash").notNull(),
    subjectEncrypted: text("subject_encrypted").notNull(),
    generation: integer("generation").notNull().default(1),
    desiredRankLevel: integer("desired_rank_level").notNull().default(0),
    appliedRankLevel: integer("applied_rank_level"),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    nextReconcileAt: text("next_reconcile_at").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    lastErrorCode: text("last_error_code").notNull().default(""),
    lastCheckedAt: text("last_checked_at"),
    lastSyncedAt: text("last_synced_at"),
    orphanPurgeAfter: text("orphan_purge_after"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_discord_rank_sync_subject").on(table.subjectHash),
    uniqueIndex("idx_discord_rank_sync_account").on(table.accountId),
    index("idx_discord_rank_sync_delivery").on(table.status, table.nextAttemptAt),
    index("idx_discord_rank_sync_reconcile").on(table.nextReconcileAt),
    index("idx_discord_rank_sync_orphan_purge").on(table.accountId, table.orphanPurgeAfter),
    check(
      "discord_rank_sync_generation_check",
      sql`${table.generation} > 0 AND ${table.attempts} >= 0`,
    ),
    check("discord_rank_sync_desired_level_check", sql`${table.desiredRankLevel} BETWEEN 0 AND 6`),
    check(
      "discord_rank_sync_applied_level_check",
      sql`${table.appliedRankLevel} IS NULL OR ${table.appliedRankLevel} BETWEEN 0 AND 6`,
    ),
    check(
      "discord_rank_sync_status_check",
      sql`${table.status} IN ('pending', 'leased', 'synced', 'not_in_guild', 'failed', 'terminal', 'disabled')`,
    ),
  ],
);

export const discordRankSyncControl = sqliteTable(
  "discord_rank_sync_control",
  {
    id: text("id").primaryKey(),
    circuitOpenUntil: text("circuit_open_until"),
    lastErrorCode: text("last_error_code").notNull().default(""),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [check("discord_rank_sync_control_id_check", sql`${table.id} = 'global'`)],
);

export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    objectKey: text("object_key"),
    sha256: text("sha256"),
    size: integer("size"),
    bookmark: text("bookmark"),
    error: text("error").notNull().default(""),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [index("idx_backup_runs_started").on(table.startedAt, table.id)],
);

export const reportFamilyMetrics = sqliteView("report_family_metrics", {
  reportId: text("report_id").notNull(),
  approvedReviewCount: integer("approved_review_count").notNull(),
  approvedRatingSum: integer("approved_rating_sum").notNull(),
  publicEvidenceCount: integer("public_evidence_count").notNull(),
}).existing();

export const publicMemberActivity = sqliteView("public_member_activity", {
  accountId: text("account_id").notNull(),
  approvedReportCount: integer("approved_report_count").notNull(),
  approvedReviewCount: integer("approved_review_count").notNull(),
  approvedCommentCount: integer("approved_comment_count").notNull(),
  scoreEligibleCommentCount: integer("score_eligible_comment_count").notNull(),
}).existing();

export type ReportRow = typeof reports.$inferSelect;
export type ReviewRow = typeof reviews.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type EvidenceAssetRow = typeof evidenceAssets.$inferSelect;
export type ModeratorApplicationRow = typeof moderatorApplications.$inferSelect;
