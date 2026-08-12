import assert from "node:assert/strict";
import test from "node:test";
import {
  authHeaders,
  createTestRuntime,
  insertAccountFixture,
  TURNSTILE_BYPASS,
} from "./helpers/runtime.mjs";

function applicationBody(overrides = {}) {
  return {
    motivation:
      "I want to help keep reports accurate, explain decisions clearly, and make the community safer without treating allegations as findings.",
    experience:
      "I have moderated gaming communities, documented difficult decisions, handled disputes calmly, and escalated conflicts instead of acting alone.",
    timezone: "UTC+2 / Europe/Vienna",
    availability: "Usually eight to ten hours per week, mostly on weekday evenings and weekends.",
    languages: "English, German",
    conflicts: "None involving current vendors, staff members, or report subjects.",
    confirmationAccepted: true,
    website: "",
    turnstileToken: TURNSTILE_BYPASS,
    ...overrides,
  };
}

async function submit(runtime, account, overrides = {}, headers = {}) {
  return runtime.dispatchFetch("http://localhost/api/moderator-applications", {
    method: "POST",
    headers: authHeaders(account, {
      "content-type": "application/json",
      ...headers,
    }),
    body: JSON.stringify({ ...applicationBody(overrides), csrfToken: account.csrf }),
  });
}

async function withdraw(runtime, account, id) {
  return runtime.dispatchFetch("http://localhost/api/moderator-applications", {
    method: "DELETE",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: JSON.stringify({ id, csrfToken: account.csrf }),
  });
}

async function moderate(runtime, account, id, status, moderatorNotes = "") {
  return runtime.dispatchFetch("http://localhost/api/admin/moderator-applications", {
    method: "PATCH",
    headers: authHeaders(account, { "content-type": "application/json" }),
    body: JSON.stringify({ id, status, moderatorNotes, csrfToken: account.csrf }),
  });
}

test("applications validate input, identity and abuse controls", async (t) => {
  const { runtime, database } = await createTestRuntime();
  t.after(() => runtime.dispose());
  const eligible = await insertAccountFixture(database, {
    id: "account_modapp_eligible",
    handle: "EligibleApplicant",
    providers: ["discord", "email"],
  });
  const emailOnly = await insertAccountFixture(database, {
    id: "account_modapp_email_only",
    handle: "EmailOnlyApplicant",
    providers: ["email"],
  });
  const multibyteApplicant = await insertAccountFixture(database, {
    id: "account_modapp_multibyte",
    handle: "MultibyteApplicant",
    providers: ["discord", "email"],
  });
  const staff = await insertAccountFixture(database, {
    id: "account_modapp_staff",
    handle: "ExistingModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });

  const anonymous = await runtime.dispatchFetch("http://localhost/api/moderator-applications");
  assert.equal(anonymous.status, 401);

  const wrongOrigin = await submit(runtime, eligible, {}, { origin: "https://evil.invalid" });
  assert.equal(wrongOrigin.status, 403);
  assert.equal((await wrongOrigin.json()).code, "invalid_origin");

  const badCsrf = await runtime.dispatchFetch("http://localhost/api/moderator-applications", {
    method: "POST",
    headers: authHeaders(eligible, { "content-type": "application/json" }),
    body: JSON.stringify({ ...applicationBody(), csrfToken: "test-csrf-token-placeholder" }),
  });
  assert.equal(badCsrf.status, 403);
  assert.equal((await badCsrf.json()).code, "invalid_csrf");

  const missingIdentity = await submit(runtime, emailOnly);
  assert.equal(missingIdentity.status, 409);
  assert.equal((await missingIdentity.json()).code, "moderator_application_identities_required");

  const existingStaff = await submit(runtime, staff);
  assert.equal(existingStaff.status, 409);
  assert.equal((await existingStaff.json()).code, "moderator_application_member_required");

  const missingTurnstile = await submit(runtime, eligible, { turnstileToken: "" });
  assert.equal(missingTurnstile.status, 403);
  assert.equal((await missingTurnstile.json()).code, "turnstile_required");

  const invalidFields = await submit(runtime, eligible, { motivation: "too short" });
  assert.equal(invalidFields.status, 400);

  const oversized = await runtime.dispatchFetch("http://localhost/api/moderator-applications", {
    method: "POST",
    headers: authHeaders(eligible, { "content-type": "application/json" }),
    body: JSON.stringify({
      ...applicationBody(),
      csrfToken: eligible.csrf,
      padding: "x".repeat(70_000),
    }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, "request_too_large");

  const created = await submit(runtime, eligible);
  assert.equal(created.status, 201, await created.clone().text());
  const payload = await created.json();
  assert.match(payload.application.id, /^MODAPP-[A-Z0-9]{20}$/u);
  assert.equal(payload.application.status, "Pending");
  assert.equal(payload.application.moderatorNotes, undefined);
  assert.equal(payload.application.accountId, undefined);
  assert.equal(payload.application.purgeAfter, null);
  assert.equal(payload.application.answersErasedAt, null);

  const duplicate = await submit(runtime, eligible);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, "moderator_application_exists");

  const validMaximumMultibyte = await submit(runtime, multibyteApplicant, {
    motivation: "\u754c".repeat(4000),
    experience: "\u754c".repeat(3000),
    timezone: "\u754c".repeat(80),
    availability: "\u754c".repeat(1000),
    languages: "\u754c".repeat(300),
    conflicts: "\u754c".repeat(2000),
  });
  assert.equal(validMaximumMultibyte.status, 201, await validMaximumMultibyte.clone().text());

  assert.equal(
    await database.prepare("SELECT COUNT(*) FROM moderator_applications").first("COUNT(*)"),
    2,
  );
  assert.equal(
    await database
      .prepare("SELECT COUNT(*) FROM rate_events WHERE scope = 'moderator_application'")
      .first("COUNT(*)"),
    2,
  );
  assert.equal(
    await database
      .prepare("SELECT COUNT(*) FROM audit_logs WHERE report_id = ?")
      .bind(payload.application.id)
      .first("COUNT(*)"),
    1,
  );
  const outbox = await database
    .prepare(
      "SELECT case_id, event_type, queue_path FROM notification_outbox WHERE case_id = ? ORDER BY channel",
    )
    .bind(payload.application.id)
    .all();
  assert.equal(outbox.results.length, 2);
  assert.ok(outbox.results.every((row) => row.event_type === "application"));
  assert.ok(outbox.results.every((row) => row.queue_path === "/admin?queue=applications"));
  assert.doesNotMatch(JSON.stringify(outbox.results), /motivation|EligibleApplicant|Vienna/iu);
});

test("applicants manage their latest application", async (t) => {
  const { runtime, database } = await createTestRuntime();
  t.after(() => runtime.dispose());
  const applicant = await insertAccountFixture(database, {
    id: "account_modapp_owner",
    handle: "ApplicationOwner",
    providers: ["discord", "email"],
  });
  const stranger = await insertAccountFixture(database, {
    id: "account_modapp_stranger",
    handle: "ApplicationStranger",
    providers: ["discord", "email"],
  });
  const moderator = await insertAccountFixture(database, {
    id: "account_modapp_withdraw_reviewer",
    handle: "WithdrawalReviewer",
    role: "moderator",
    providers: ["discord", "email"],
  });
  const created = await submit(runtime, applicant);
  const id = (await created.json()).application.id;

  const ownerView = await runtime.dispatchFetch("http://localhost/api/moderator-applications", {
    headers: authHeaders(applicant),
  });
  assert.equal(ownerView.status, 200);
  assert.equal((await ownerView.json()).application.id, id);

  const strangerView = await runtime.dispatchFetch("http://localhost/api/moderator-applications", {
    headers: authHeaders(stranger),
  });
  assert.equal(strangerView.status, 200);
  assert.equal((await strangerView.json()).application, null);

  const strangerWithdrawal = await withdraw(runtime, stranger, id);
  assert.equal(strangerWithdrawal.status, 404);

  const review = await moderate(runtime, moderator, id, "Under Review", "Review started.");
  assert.equal(review.status, 200, await review.clone().text());
  const withdrawn = await withdraw(runtime, applicant, id);
  assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
  const withdrawnApplication = (await withdrawn.json()).application;
  assert.equal(withdrawnApplication.status, "Withdrawn");
  const retentionMs =
    Date.parse(withdrawnApplication.purgeAfter) - Date.parse(withdrawnApplication.updatedAt);
  assert.equal(retentionMs, 90 * 24 * 60 * 60 * 1000);

  const replacement = await submit(runtime, applicant, {
    motivation: `${applicationBody().motivation} This is a new application after withdrawal.`,
  });
  assert.equal(replacement.status, 201, await replacement.clone().text());
  const replacementId = (await replacement.json()).application.id;
  assert.notEqual(replacementId, id);
  const pendingWithdrawal = await withdraw(runtime, applicant, replacementId);
  assert.equal(pendingWithdrawal.status, 200, await pendingWithdrawal.clone().text());
  assert.equal((await pendingWithdrawal.json()).application.status, "Withdrawn");

  const repeated = await withdraw(runtime, applicant, replacementId);
  assert.equal(repeated.status, 409);
  assert.equal((await repeated.json()).code, "moderator_application_not_active");

  const audit = await database
    .prepare("SELECT action, detail FROM audit_logs WHERE report_id = ? ORDER BY id")
    .bind(id)
    .all();
  assert.deepEqual(
    audit.results.map((row) => row.action),
    [
      "moderator-application-submitted",
      "moderator-application-under-review",
      "moderator-application-withdrawn",
    ],
  );
  assert.equal(audit.results[1].detail, "Pending -> Under Review");
  assert.equal(audit.results[2].detail, "Under Review -> Withdrawn");
});

test("application approval needs fresh dual-confirmed admin auth", async (t) => {
  const { runtime, database } = await createTestRuntime();
  t.after(() => runtime.dispose());
  const applicant = await insertAccountFixture(database, {
    id: "account_modapp_role_target",
    handle: "FutureModerator",
    providers: ["discord", "email"],
  });
  const moderator = await insertAccountFixture(database, {
    id: "account_modapp_reviewer",
    handle: "QueueModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  const staleAdmin = await insertAccountFixture(database, {
    id: "account_modapp_stale_admin",
    handle: "StaleAdmin",
    role: "admin",
    providers: ["discord", "email"],
    confirmedProviders: [],
  });
  const admin = await insertAccountFixture(database, {
    id: "account_modapp_admin",
    handle: "ApplicationAdmin",
    role: "admin",
    providers: ["discord", "email"],
  });
  const created = await submit(runtime, applicant);
  const id = (await created.json()).application.id;

  const memberQueue = await runtime.dispatchFetch(
    "http://localhost/api/admin/moderator-applications",
    { headers: authHeaders(applicant) },
  );
  assert.equal(memberQueue.status, 403);

  const queue = await runtime.dispatchFetch(
    "http://localhost/api/admin/moderator-applications?page=1&status=Pending",
    { headers: authHeaders(moderator) },
  );
  assert.equal(queue.status, 200, await queue.clone().text());
  const queuePayload = await queue.json();
  assert.equal(queuePayload.items.length, 1);
  assert.equal(queuePayload.items[0].motivation, applicationBody().motivation);
  assert.equal(queuePayload.items[0].applicantHandle, "FutureModerator");

  const directReject = await moderate(runtime, moderator, id, "Rejected", "Too early.");
  assert.equal(directReject.status, 409);
  assert.equal((await directReject.json()).code, "moderator_application_invalid_transition");
  const directAccept = await moderate(runtime, admin, id, "Accepted", "Too early.");
  assert.equal(directAccept.status, 409);
  assert.equal((await directAccept.json()).code, "moderator_application_invalid_transition");
  await assert.rejects(
    database
      .prepare(
        `UPDATE moderator_applications
        SET status = 'Rejected', reviewed_by_account_id = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ?`,
      )
      .bind(moderator.id, new Date().toISOString(), new Date().toISOString(), id)
      .run(),
    /moderator_application_invalid_transition/u,
  );

  const underReview = await moderate(runtime, moderator, id, "Under Review", "Looks relevant.");
  assert.equal(underReview.status, 200, await underReview.clone().text());
  assert.equal((await underReview.json()).application.status, "Under Review");

  const moderatorAccept = await moderate(runtime, moderator, id, "Accepted");
  assert.equal(moderatorAccept.status, 403);
  assert.equal((await moderatorAccept.json()).code, "admin_required");

  await assert.rejects(
    database
      .prepare(
        `UPDATE moderator_applications
        SET status = 'Accepted', reviewed_by_account_id = ?, reviewed_at = ?, updated_at = ?
        WHERE id = ?`,
      )
      .bind(moderator.id, new Date().toISOString(), new Date().toISOString(), id)
      .run(),
    /moderator_application_acceptance_requirements/u,
  );

  const staleAccept = await moderate(runtime, staleAdmin, id, "Accepted");
  assert.equal(staleAccept.status, 401);
  assert.equal((await staleAccept.json()).code, "dual_confirmation_required");

  const accepted = await moderate(
    runtime,
    admin,
    id,
    "Accepted",
    "Approved after independent review.",
  );
  assert.equal(accepted.status, 200, await accepted.clone().text());
  const acceptedApplication = (await accepted.json()).application;
  assert.equal(acceptedApplication.status, "Accepted");
  assert.equal(acceptedApplication.applicantRole, "moderator");
  assert.equal(
    Date.parse(acceptedApplication.purgeAfter) - Date.parse(acceptedApplication.updatedAt),
    90 * 24 * 60 * 60 * 1000,
  );

  const account = await database
    .prepare("SELECT role, role_version FROM accounts WHERE id = ?")
    .bind(applicant.id)
    .first();
  assert.deepEqual(account, { role: "moderator", role_version: 2 });
  assert.equal(
    await database
      .prepare(
        "SELECT COUNT(*) FROM auth_security_events WHERE account_id = ? AND event_type = 'account.access_changed'",
      )
      .bind(applicant.id)
      .first("COUNT(*)"),
    1,
  );
  const invalidatedSession = await runtime.dispatchFetch(
    "http://localhost/api/moderator-applications",
    { headers: authHeaders(applicant) },
  );
  assert.equal(invalidatedSession.status, 401);

  const terminalChange = await moderate(runtime, admin, id, "Rejected");
  assert.equal(terminalChange.status, 409);
});

test("scheduled redaction handles each expired application once", async (t) => {
  const { runtime, database } = await createTestRuntime({ unsafeTriggerHandlers: true });
  t.after(() => runtime.dispose());
  const reviewer = await insertAccountFixture(database, {
    id: "account_modapp_retention_reviewer",
    handle: "RetentionReviewer",
    role: "moderator",
    providers: ["discord", "email"],
  });
  const accountOptions = [
    ["account_modapp_purge_due", "PurgeDue"],
    ["account_modapp_purge_future", "PurgeFuture"],
    ["account_modapp_purge_pending", "PurgePending"],
    ["account_modapp_purge_review", "PurgeReview"],
  ];
  const accounts = [];
  for (const [id, handle] of accountOptions) {
    accounts.push(
      await insertAccountFixture(database, { id, handle, providers: ["discord", "email"] }),
    );
  }
  const applicationIds = [];
  for (const account of accounts) {
    const response = await submit(runtime, account);
    assert.equal(response.status, 201, await response.clone().text());
    applicationIds.push((await response.json()).application.id);
  }

  await withdraw(runtime, accounts[0], applicationIds[0]);
  await withdraw(runtime, accounts[1], applicationIds[1]);
  await moderate(runtime, reviewer, applicationIds[3], "Under Review", "Private review note.");

  const past = "2026-01-01T00:00:00.000Z";
  const future = "2099-01-01T00:00:00.000Z";
  await database
    .prepare("UPDATE moderator_applications SET purge_after = ? WHERE id = ?")
    .bind(past, applicationIds[0])
    .run();
  await database
    .prepare("UPDATE moderator_applications SET purge_after = ? WHERE id = ?")
    .bind(future, applicationIds[1])
    .run();
  await database
    .prepare("UPDATE moderator_applications SET purge_after = ? WHERE id IN (?, ?)")
    .bind(past, applicationIds[2], applicationIds[3])
    .run();

  const scheduledUrl = new URL("/cdn-cgi/local/scheduled", await runtime.ready);
  scheduledUrl.searchParams.set("cron", "*/5 * * * *");
  scheduledUrl.searchParams.set("time", String(Date.now()));
  const firstRun = await fetch(scheduledUrl);
  assert.equal(firstRun.status, 200, await firstRun.text());

  const due = await database
    .prepare(
      `SELECT motivation, experience, timezone, availability, languages, conflicts,
      moderator_notes, reviewed_by_account_id, answers_erased_at
      FROM moderator_applications WHERE id = ?`,
    )
    .bind(applicationIds[0])
    .first();
  assert.deepEqual(
    {
      motivation: due.motivation,
      experience: due.experience,
      timezone: due.timezone,
      availability: due.availability,
      languages: due.languages,
      conflicts: due.conflicts,
      moderator_notes: due.moderator_notes,
      reviewed_by_account_id: due.reviewed_by_account_id,
    },
    {
      motivation: "",
      experience: "",
      timezone: "",
      availability: "",
      languages: "",
      conflicts: "",
      moderator_notes: "",
      reviewed_by_account_id: null,
    },
  );
  assert.ok(due.answers_erased_at);
  const redactionAudit = await database
    .prepare(
      `SELECT action, actor, actor_account_id, created_at, detail
      FROM audit_logs
      WHERE report_id = ? AND action = 'moderator-application-answers-erased'`,
    )
    .bind(applicationIds[0])
    .all();
  assert.deepEqual(redactionAudit.results, [
    {
      action: "moderator-application-answers-erased",
      actor: "system:retention",
      actor_account_id: null,
      created_at: due.answers_erased_at,
      detail: "status=Withdrawn",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(redactionAudit.results),
    /PurgeDue|Private review note|keep reports accurate/iu,
  );

  for (const id of applicationIds.slice(1)) {
    const row = await database
      .prepare("SELECT motivation, answers_erased_at FROM moderator_applications WHERE id = ?")
      .bind(id)
      .first();
    assert.equal(row.motivation, applicationBody().motivation, id);
    assert.equal(row.answers_erased_at, null, id);
  }

  const erasedAt = due.answers_erased_at;
  const secondRun = await fetch(scheduledUrl);
  assert.equal(secondRun.status, 200, await secondRun.text());
  assert.equal(
    await database
      .prepare("SELECT answers_erased_at FROM moderator_applications WHERE id = ?")
      .bind(applicationIds[0])
      .first("answers_erased_at"),
    erasedAt,
  );
  assert.equal(
    await database
      .prepare(
        `SELECT COUNT(*) FROM audit_logs
        WHERE report_id = ? AND action = 'moderator-application-answers-erased'`,
      )
      .bind(applicationIds[0])
      .first("COUNT(*)"),
    1,
  );

  const publicDirectory = await runtime.dispatchFetch("http://localhost/api/reports");
  assert.equal(publicDirectory.status, 200);
  const publicText = await publicDirectory.text();
  assert.doesNotMatch(publicText, /PurgeDue|Private review note|keep reports accurate/iu);
});

test("stale applications expire and allow replacement", async (t) => {
  const { runtime, database } = await createTestRuntime({ unsafeTriggerHandlers: true });
  t.after(() => runtime.dispose());
  const reviewer = await insertAccountFixture(database, {
    id: "account_modapp_expiry_reviewer",
    handle: "ExpiryReviewer",
    role: "moderator",
    providers: ["discord", "email"],
  });
  const accountOptions = [
    ["account_modapp_stale_pending", "StalePendingApplicant"],
    ["account_modapp_stale_review", "StaleReviewApplicant"],
    ["account_modapp_fresh_pending", "FreshPendingApplicant"],
    ["account_modapp_fresh_review", "FreshReviewApplicant"],
  ];
  const accounts = [];
  const ids = [];
  for (const [id, handle] of accountOptions) {
    const account = await insertAccountFixture(database, {
      id,
      handle,
      providers: ["discord", "email"],
    });
    accounts.push(account);
    const response = await submit(runtime, account, {
      motivation: `${applicationBody().motivation} Distinct expiry fixture ${handle}.`,
    });
    assert.equal(response.status, 201, await response.clone().text());
    ids.push((await response.json()).application.id);
  }
  await moderate(runtime, reviewer, ids[1], "Under Review", "Stale private review note.");
  await moderate(runtime, reviewer, ids[3], "Under Review", "Fresh private review note.");

  const now = new Date();
  const staleAt = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000).toISOString();
  const freshAt = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000).toISOString();
  await database
    .prepare("UPDATE moderator_applications SET updated_at = ? WHERE id IN (?, ?)")
    .bind(staleAt, ids[0], ids[1])
    .run();
  await database
    .prepare("UPDATE moderator_applications SET updated_at = ? WHERE id IN (?, ?)")
    .bind(freshAt, ids[2], ids[3])
    .run();

  const scheduledUrl = new URL("/cdn-cgi/local/scheduled", await runtime.ready);
  scheduledUrl.searchParams.set("cron", "*/5 * * * *");
  scheduledUrl.searchParams.set("time", String(now.getTime()));
  const firstRun = await fetch(scheduledUrl);
  assert.equal(firstRun.status, 200, await firstRun.text());

  for (const id of ids.slice(0, 2)) {
    const expired = await database
      .prepare(
        `SELECT status, motivation, experience, timezone, availability, languages,
        conflicts, moderator_notes, reviewed_by_account_id, purge_after, answers_erased_at
        FROM moderator_applications WHERE id = ?`,
      )
      .bind(id)
      .first();
    assert.equal(expired.status, "Expired");
    assert.equal(expired.motivation, "");
    assert.equal(expired.experience, "");
    assert.equal(expired.timezone, "");
    assert.equal(expired.availability, "");
    assert.equal(expired.languages, "");
    assert.equal(expired.conflicts, "");
    assert.equal(expired.moderator_notes, "");
    assert.equal(expired.reviewed_by_account_id, null);
    assert.ok(expired.answers_erased_at);
    assert.equal(expired.purge_after, expired.answers_erased_at);

    const privacyEvents = await database
      .prepare(
        `SELECT action, actor, actor_account_id, detail
        FROM audit_logs WHERE report_id = ?
          AND action IN ('moderator-application-expired', 'moderator-application-answers-erased')
        ORDER BY action`,
      )
      .bind(id)
      .all();
    assert.deepEqual(privacyEvents.results, [
      {
        action: "moderator-application-answers-erased",
        actor: "system:retention",
        actor_account_id: null,
        detail: "status=Expired",
      },
      {
        action: "moderator-application-expired",
        actor: "system:retention",
        actor_account_id: null,
        detail: "status=Expired",
      },
    ]);
    assert.doesNotMatch(
      JSON.stringify(privacyEvents.results),
      /StalePendingApplicant|StaleReviewApplicant|account_modapp|private review|keep reports accurate/iu,
    );
  }

  const freshPending = await database
    .prepare(
      "SELECT status, motivation, answers_erased_at FROM moderator_applications WHERE id = ?",
    )
    .bind(ids[2])
    .first();
  assert.equal(freshPending.status, "Pending");
  assert.match(freshPending.motivation, /FreshPendingApplicant/u);
  assert.equal(freshPending.answers_erased_at, null);
  const freshReview = await database
    .prepare(
      `SELECT status, motivation, moderator_notes, reviewed_by_account_id, answers_erased_at
      FROM moderator_applications WHERE id = ?`,
    )
    .bind(ids[3])
    .first();
  assert.equal(freshReview.status, "Under Review");
  assert.match(freshReview.motivation, /FreshReviewApplicant/u);
  assert.equal(freshReview.moderator_notes, "Fresh private review note.");
  assert.equal(freshReview.reviewed_by_account_id, reviewer.id);
  assert.equal(freshReview.answers_erased_at, null);

  for (const account of accounts.slice(0, 2)) {
    const replacement = await submit(runtime, account, {
      motivation: `${applicationBody().motivation} Replacement after automatic expiry.`,
    });
    assert.equal(replacement.status, 201, await replacement.clone().text());
    assert.equal((await replacement.json()).application.status, "Pending");
  }

  const secondRun = await fetch(scheduledUrl);
  assert.equal(secondRun.status, 200, await secondRun.text());
  for (const id of ids.slice(0, 2)) {
    assert.equal(
      await database
        .prepare(
          `SELECT COUNT(*) FROM audit_logs WHERE report_id = ?
          AND action IN ('moderator-application-expired', 'moderator-application-answers-erased')`,
        )
        .bind(id)
        .first("COUNT(*)"),
      2,
    );
  }

  const publicDirectory = await runtime.dispatchFetch("http://localhost/api/reports");
  assert.equal(publicDirectory.status, 200);
  const publicText = await publicDirectory.text();
  assert.doesNotMatch(
    publicText,
    /StalePendingApplicant|StaleReviewApplicant|FreshPendingApplicant|FreshReviewApplicant|private review|Replacement after automatic expiry/iu,
  );
});

test("application migration installs its privacy rules", async (t) => {
  const { runtime, database } = await createTestRuntime();
  t.after(() => runtime.dispose());

  const columns = await database.prepare("PRAGMA table_info(moderator_applications)").all();
  const names = new Set(columns.results.map((column) => column.name));
  for (const column of [
    "account_id",
    "motivation",
    "experience",
    "timezone",
    "availability",
    "languages",
    "conflicts",
    "moderator_notes",
    "purge_after",
    "answers_erased_at",
  ]) {
    assert.ok(names.has(column), column);
  }

  const indexes = await database.prepare("PRAGMA index_list(moderator_applications)").all();
  const indexNames = new Set(indexes.results.map((index) => index.name));
  for (const name of [
    "idx_moderator_applications_status_created",
    "idx_moderator_applications_status_updated",
    "idx_moderator_applications_account_created",
    "idx_moderator_applications_reviewer",
    "idx_moderator_applications_retention",
    "idx_moderator_applications_one_active",
  ]) {
    assert.ok(indexNames.has(name), name);
  }

  const triggers = await database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'moderator_applications' ORDER BY name",
    )
    .all();
  assert.deepEqual(
    triggers.results.map((row) => row.name),
    [
      "moderator_applications_accept_requirements",
      "moderator_applications_audit_insert",
      "moderator_applications_audit_redaction",
      "moderator_applications_audit_status",
      "moderator_applications_expired_redaction",
      "moderator_applications_grant_role",
      "moderator_applications_schedule_redaction",
      "moderator_applications_staff_actor",
      "moderator_applications_status_transition",
      "moderator_applications_submit_requirements",
    ],
  );
  assert.deepEqual((await database.prepare("PRAGMA foreign_key_check").all()).results, []);
});
