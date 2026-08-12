import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  authHeaders,
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
} from "./helpers/runtime.mjs";

let runtime;
let database;
let member;
let moderator;
let administrator;

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  member = await insertAccountFixture(database, {
    id: "account_reports_member",
    handle: "ReportsMember",
    role: "member",
    providers: ["discord", "email"],
  });
  moderator = await insertAccountFixture(database, {
    id: "account_reports_moderator",
    handle: "ReportsModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  administrator = await insertAccountFixture(database, {
    id: "account_reports_admin",
    handle: "ReportsAdmin",
    role: "admin",
    providers: ["discord", "email"],
  });
  await insertReportFixture(database, {
    id: "SR-TEST-0001",
    username: "CanonicalFixture",
    discordId: "100000000000000011",
  });
  await insertReportFixture(database, {
    id: "SR-TEST-0002",
    username: "DuplicateFixture",
    discordId: "100000000000000011",
  });
  await insertReportFixture(database, {
    id: "SR-TEST-PRIVATE",
    username: "PrivateFixture",
    discordId: "100000000000000012",
    isPublished: false,
  });
});

after(async () => runtime?.dispose());

function reportBody(id, username, discordId) {
  const now = new Date().toISOString();
  return {
    id,
    username,
    discordId,
    game: "Synthetic Arena",
    category: "Cheating",
    reason: "A detailed synthetic reason used only by the automated test suite.",
    description: "A longer synthetic description that contains no allegation about a real person.",
    status: "Reported",
    notes: "No final decision yet.",
    moderatorNotes: "Private test fixture note.",
    evidence: [],
    statusHistory: [
      {
        status: "Reported",
        date: now,
        note: "Synthetic report created by an integration test.",
        moderator: "ReportsModerator",
      },
    ],
    dateAdded: now,
    updatedAt: now,
    views: 0,
    isPublished: false,
  };
}

function evidenceAttachment(id, options = {}) {
  return {
    id,
    filename: `${id}.webp`,
    url: options.url === undefined ? `/api/evidence/${id}` : options.url,
    caption: options.caption ?? "Synthetic evidence attachment.",
    uploadedAt: "2026-08-09T00:00:00.000Z",
    fileSize: options.fileSize ?? 1024,
    contentType: "image/webp",
    redacted: options.redacted ?? false,
  };
}

async function insertEvidenceAssetFixture(id, originalSize, state = "private_ready") {
  await database
    .prepare(
      `INSERT INTO evidence_assets (
      id, intake_id, intake_kind, state, original_key, derivative_key,
      original_filename, original_content_type, original_size, original_sha256,
      derivative_content_type, derivative_size, derivative_sha256,
      source_width, source_height, width, height, visible_pii_reviewed,
      legal_hold, processing_error, created_by, created_at, updated_at,
      published_at, deleted_at
    ) VALUES (?, NULL, 'moderator_upload', ?, ?, ?, ?, 'image/png', ?, ?,
      'image/webp', 1024, ?, 100, 100, 100, 100, 0, 0, '', 'test',
      '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z', NULL, ?)`,
    )
    .bind(
      id,
      state,
      `originals/${id}`,
      `derivatives/${id}.webp`,
      `${id}.png`,
      originalSize,
      `original-sha-${id}`,
      `derivative-sha-${id}`,
      state === "deleted" ? "2026-08-09T00:00:00.000Z" : null,
    )
    .run();
}

async function reportMutationCounts(id) {
  const [report, links, audit, statusEvents] = await Promise.all([
    database.prepare("SELECT COUNT(*) AS count FROM reports WHERE id = ?").bind(id).first("count"),
    database
      .prepare("SELECT COUNT(*) AS count FROM report_evidence WHERE report_id = ?")
      .bind(id)
      .first("count"),
    database
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE report_id = ?")
      .bind(id)
      .first("count"),
    database
      .prepare("SELECT COUNT(*) AS count FROM report_status_events WHERE report_id = ?")
      .bind(id)
      .first("count"),
  ]);
  return { report, links, audit, statusEvents };
}

test("public reports paginate without admin switches", async () => {
  const response = await runtime.dispatchFetch(
    "http://localhost/api/reports?includeUnpublished=1&page=1",
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.items));
  assert.equal(typeof payload.pagination.totalItems, "number");
  assert.equal(
    payload.items.some((report) => report.id === "SR-TEST-PRIVATE"),
    false,
  );
  assert.equal("reports" in payload, false);
  assert.equal("auditLogs" in payload, false);
});

test("report queue needs a dual-linked moderator", async () => {
  const anonymous = await runtime.dispatchFetch("http://localhost/api/admin/reports");
  assert.equal(anonymous.status, 401);

  const denied = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    headers: authHeaders(member),
  });
  assert.equal(denied.status, 403);

  const accepted = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    headers: authHeaders(moderator),
  });
  assert.equal(accepted.status, 200);
  const payload = await accepted.json();
  assert.ok(payload.items.some((report) => report.id === "SR-TEST-PRIVATE"));
  assert.equal("auditLogs" in payload, false);
  assert.equal(typeof payload.pagination.totalPages, "number");
});

test("report creation checks CSRF and records its actor", async () => {
  const body = reportBody("SR-TEST-0003", "CreatedByModerator", "100000000000000013");
  const missingCsrf = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    method: "POST",
    headers: {
      cookie: moderator.cookie,
      origin: "http://localhost",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  assert.equal(missingCsrf.status, 403);

  const accepted = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    method: "POST",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  assert.equal(accepted.status, 201, await accepted.text());

  const audit = await database
    .prepare(
      "SELECT actor, actor_account_id FROM audit_logs WHERE report_id = ? AND action = 'report.created'",
    )
    .bind(body.id)
    .first();
  assert.equal(audit.actor_account_id, moderator.id);
  assert.match(audit.actor, /ReportsModerator/u);
});

test("largest valid report fits the request limit", async () => {
  const escapedCharacter = "\u0001";
  const evidenceIds = Array.from({ length: 5 }, (_, index) => `EVA-MAX-BOUND-${index + 1}`);
  for (const evidenceId of evidenceIds) {
    await insertEvidenceAssetFixture(evidenceId, 1024);
  }

  const body = reportBody("SR-TEST-MAX-BOUND", escapedCharacter.repeat(80), "100000000000000099");
  body.game = escapedCharacter.repeat(80);
  body.reason = escapedCharacter.repeat(500);
  body.description = escapedCharacter.repeat(8000);
  body.notes = escapedCharacter.repeat(3000);
  body.moderatorNotes = escapedCharacter.repeat(3000);
  body.evidence = evidenceIds.map((evidenceId) => ({
    ...evidenceAttachment(evidenceId),
    filename: escapedCharacter.repeat(180),
    url: escapedCharacter.repeat(2048),
    caption: escapedCharacter.repeat(500),
    uploadedAt: escapedCharacter.repeat(64),
    contentType: escapedCharacter.repeat(128),
  }));
  body.statusHistory = Array.from({ length: 50 }, () => ({
    status: "Reported",
    date: escapedCharacter.repeat(64),
    note: escapedCharacter.repeat(1000),
    moderator: escapedCharacter.repeat(120),
  }));
  body.dateAdded = escapedCharacter.repeat(64);
  body.updatedAt = escapedCharacter.repeat(64);

  const encoded = JSON.stringify(body);
  assert.ok(Buffer.byteLength(encoded, "utf8") > 512 * 1024);
  assert.ok(Buffer.byteLength(encoded, "utf8") < 1024 * 1024);

  const response = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    method: "POST",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: encoded,
  });

  assert.equal(response.status, 201, await response.text());
});

test("report failures return generic errors", async () => {
  const conflict = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    method: "POST",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify(reportBody("SR-TEST-0001", "ConflictingFixture", "100000000000000015")),
  });
  assert.equal(conflict.status, 409, await conflict.clone().text());
  assert.deepEqual(await conflict.json(), {
    error: "A report with that identifier already exists.",
  });

  await database
    .prepare(
      `CREATE TRIGGER fail_report_insert
      BEFORE INSERT ON reports
      BEGIN
        SELECT RAISE(ABORT, 'sensitive_storage_detail');
      END`,
    )
    .run();
  try {
    const failure = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
      method: "POST",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify(reportBody("SR-TEST-FAILURE", "FailureFixture", "100000000000000016")),
    });
    assert.equal(failure.status, 500, await failure.clone().text());
    assert.deepEqual(await failure.json(), { error: "Couldn't create the report." });
  } finally {
    await database.prepare("DROP TRIGGER fail_report_insert").run();
  }
});

test("report updates cannot rewrite status history", async () => {
  const id = "SR-TEST-HISTORY";
  const originalDate = "2026-08-01T09:00:00.000Z";
  await insertReportFixture(database, {
    id,
    username: "HistoryFixture",
    discordId: "100000000000000019",
    status: "Reported",
    isPublished: true,
  });
  await database
    .prepare(`UPDATE reports SET status_history_json = ? WHERE id = ?`)
    .bind('[{"status":"Reported","date":"legacy","note":"rollback copy","moderator":"legacy"}]', id)
    .run();
  await database
    .prepare(
      `INSERT INTO report_status_events
    (id, report_id, status, public_note, actor_account_id, created_at)
    VALUES (?, ?, 'Reported', 'Original public event.', ?, ?)`,
    )
    .bind("RSE-HISTORY-ORIGINAL", id, moderator.id, originalDate)
    .run();

  const unchanged = reportBody(id, "HistoryFixtureEdited", "100000000000000019");
  unchanged.status = "Reported";
  unchanged.isPublished = true;
  unchanged.statusHistory = [
    {
      status: "Rejected",
      date: "1999-01-01T00:00:00.000Z",
      note: "Forged replacement event.",
      moderator: "Forged Moderator",
    },
  ];
  const firstPatch = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    method: "PATCH",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify(unchanged),
  });
  assert.equal(firstPatch.status, 200, await firstPatch.clone().text());
  const firstPayload = await firstPatch.json();
  assert.deepEqual(firstPayload.report.statusHistory, [
    {
      status: "Reported",
      date: originalDate,
      note: "Original public event.",
      moderator: moderator.handle,
    },
  ]);
  assert.match(
    await database
      .prepare("SELECT status_history_json FROM reports WHERE id = ?")
      .bind(id)
      .first("status_history_json"),
    /rollback copy/u,
  );

  const changed = { ...unchanged, status: "Confirmed" };
  changed.statusHistory = [
    unchanged.statusHistory[0],
    {
      status: "Confirmed",
      date: "1999-01-02T00:00:00.000Z",
      note: "New public confirmation event.",
      moderator: "Forged Moderator",
    },
  ];
  const secondPatch = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    method: "PATCH",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify(changed),
  });
  assert.equal(secondPatch.status, 200, await secondPatch.clone().text());
  const secondPayload = await secondPatch.json();
  assert.equal(secondPayload.report.statusHistory.length, 2);
  assert.deepEqual(
    secondPayload.report.statusHistory.map(({ status, note, moderator: eventModerator }) => ({
      status,
      note,
      moderator: eventModerator,
    })),
    [
      { status: "Reported", note: "Original public event.", moderator: moderator.handle },
      { status: "Confirmed", note: "New public confirmation event.", moderator: moderator.handle },
    ],
  );
  assert.notEqual(secondPayload.report.statusHistory[1].date, "1999-01-02T00:00:00.000Z");

  const publicResponse = await runtime.dispatchFetch(`http://localhost/api/reports/${id}`);
  assert.equal(publicResponse.status, 200);
  const publicPayload = await publicResponse.json();
  assert.deepEqual(
    publicPayload.report.statusHistory.map(({ status, note, moderator: eventModerator }) => ({
      status,
      note,
      moderator: eventModerator,
    })),
    [
      { status: "Reported", note: "Original public event.", moderator: "Moderation team" },
      { status: "Confirmed", note: "New public confirmation event.", moderator: "Moderation team" },
    ],
  );
  assert.ok(
    publicPayload.report.statusHistory.every((entry) => entry.moderator === "Moderation team"),
  );
  assert.ok(
    secondPayload.report.statusHistory.every((entry) => entry.moderator === moderator.handle),
  );

  const publicPage = await runtime.dispatchFetch(`http://localhost/reports/${id}`, {
    headers: { accept: "text/html" },
  });
  const publicHtml = await publicPage.text();
  assert.equal(publicPage.status, 200);
  assert.match(publicHtml, /Moderation team/u);
  assert.doesNotMatch(publicHtml, new RegExp(moderator.handle, "u"));
});

test("report creation rejects more than five files", async () => {
  const id = "SR-TEST-EVIDENCE-SIX";
  const body = reportBody(id, "TooManyEvidence", "100000000000000021");
  body.evidence = Array.from({ length: 6 }, (_, index) =>
    evidenceAttachment(`EVA-TOO-MANY-${index + 1}`),
  );

  const response = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    method: "POST",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 400, JSON.stringify(payload));
  assert.ok(payload.issues.fieldErrors.evidence?.length);
  assert.deepEqual(await reportMutationCounts(id), {
    report: 0,
    links: 0,
    audit: 0,
    statusEvents: 0,
  });
});

test("oversized evidence cannot partly create a report", async () => {
  const id = "SR-TEST-EVIDENCE-LARGE-CREATE";
  const evidenceIds = Array.from({ length: 5 }, (_, index) => `EVA-ATOMIC-CREATE-${index + 1}`);
  for (const evidenceId of evidenceIds) {
    await insertEvidenceAssetFixture(evidenceId, 4 * 1024 * 1024 + 1);
  }
  const body = reportBody(id, "LargeCreateEvidence", "100000000000000022");
  body.evidence = evidenceIds.map((evidenceId) => evidenceAttachment(evidenceId));

  const response = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    method: "POST",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 413, JSON.stringify(payload));
  assert.equal(payload.code, "evidence_total_too_large");
  assert.deepEqual(await reportMutationCounts(id), {
    report: 0,
    links: 0,
    audit: 0,
    statusEvents: 0,
  });
});

test("oversized evidence cannot partly update a report", async () => {
  const id = "SR-TEST-EVIDENCE-LARGE-UPDATE";
  await insertReportFixture(database, {
    id,
    username: "UnchangedEvidenceReport",
    discordId: "100000000000000023",
    isPublished: false,
  });
  const oldEvidenceId = "EVA-ATOMIC-UPDATE-OLD";
  await insertEvidenceAssetFixture(oldEvidenceId, 1024);
  await database
    .prepare(
      `INSERT INTO report_evidence
      (report_id, evidence_id, caption, display_order, created_at)
      VALUES (?, ?, 'Existing evidence', 0, '2026-08-09T00:00:00.000Z')`,
    )
    .bind(id, oldEvidenceId)
    .run();
  const evidenceIds = Array.from({ length: 5 }, (_, index) => `EVA-ATOMIC-UPDATE-${index + 1}`);
  for (const evidenceId of evidenceIds) {
    await insertEvidenceAssetFixture(evidenceId, 4 * 1024 * 1024 + 1);
  }
  const before = await database
    .prepare("SELECT username, status, evidence_json, updated_at FROM reports WHERE id = ?")
    .bind(id)
    .first();
  const countsBefore = await reportMutationCounts(id);
  const body = reportBody(id, "MustNotPersist", "100000000000000023");
  body.status = "Confirmed";
  body.evidence = evidenceIds.map((evidenceId) => evidenceAttachment(evidenceId));

  const response = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    method: "PATCH",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert.equal(response.status, 413, JSON.stringify(payload));
  assert.equal(payload.code, "evidence_total_too_large");
  assert.deepEqual(
    await database
      .prepare("SELECT username, status, evidence_json, updated_at FROM reports WHERE id = ?")
      .bind(id)
      .first(),
    before,
  );
  assert.deepEqual(await reportMutationCounts(id), countsBefore);
  assert.equal(
    await database
      .prepare("SELECT evidence_id FROM report_evidence WHERE report_id = ?")
      .bind(id)
      .first("evidence_id"),
    oldEvidenceId,
  );
});

test("bad evidence references are rejected", async () => {
  const deletedId = "EVA-ATOMIC-DELETED";
  const liveId = "EVA-ATOMIC-DUPLICATE";
  await insertEvidenceAssetFixture(deletedId, 1024, "deleted");
  await insertEvidenceAssetFixture(liveId, 1024);

  for (const [suffix, attachments, expectedCode] of [
    ["UNKNOWN", [evidenceAttachment("EVA-ATOMIC-UNKNOWN")], "invalid_evidence_reference"],
    ["DELETED", [evidenceAttachment(deletedId)], "invalid_evidence_reference"],
    [
      "DUPLICATE",
      [evidenceAttachment(liveId), evidenceAttachment(liveId)],
      "duplicate_evidence_reference",
    ],
  ]) {
    const id = `SR-TEST-EVIDENCE-${suffix}`;
    const body = reportBody(id, `InvalidEvidence${suffix}`, `10000000000000002${suffix.length}`);
    body.evidence = attachments;
    const response = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
      method: "POST",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(payload.code, expectedCode, JSON.stringify(payload));
    assert.deepEqual(await reportMutationCounts(id), {
      report: 0,
      links: 0,
      audit: 0,
      statusEvents: 0,
    });
  }
});

test("redacted placeholders need a stored asset", async () => {
  const id = "SR-TEST-EVIDENCE-PLACEHOLDER";
  const body = reportBody(id, "LegacyPlaceholder", "100000000000000027");
  body.evidence = [evidenceAttachment("EV-LEGACY-REDACTED", { redacted: true, url: null })];
  const response = await runtime.dispatchFetch("http://localhost/api/admin/reports", {
    method: "POST",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 422, await response.clone().text());
  assert.deepEqual(await reportMutationCounts(id), {
    report: 0,
    links: 0,
    audit: 0,
    statusEvents: 0,
  });
});

test("reports can be merged and unmerged", async () => {
  const query = new URLSearchParams({
    duplicateId: "SR-TEST-0002",
    canonicalId: "SR-TEST-0001",
  });
  const preflight = await runtime.dispatchFetch(`http://localhost/api/admin/merge?${query}`, {
    headers: authHeaders(moderator),
  });
  assert.equal(preflight.status, 200, await preflight.clone().text());
  const preflightPayload = await preflight.json();
  assert.deepEqual(preflightPayload.preflight.conflicts, []);

  const merged = await runtime.dispatchFetch("http://localhost/api/admin/merge", {
    method: "POST",
    headers: authHeaders(moderator, { "content-type": "application/json" }),
    body: JSON.stringify({
      duplicateId: "SR-TEST-0002",
      canonicalId: "SR-TEST-0001",
    }),
  });
  assert.equal(merged.status, 200, await merged.text());
  assert.equal(
    await database
      .prepare("SELECT merged_into_report_id FROM reports WHERE id = ?")
      .bind("SR-TEST-0002")
      .first("merged_into_report_id"),
    "SR-TEST-0001",
  );

  const oldUrl = await runtime.dispatchFetch("http://localhost/api/reports/SR-TEST-0002", {
    redirect: "manual",
  });
  assert.equal(oldUrl.status, 308);
  assert.match(oldUrl.headers.get("location") ?? "", /SR-TEST-0001$/u);

  const unmerged = await runtime.dispatchFetch(
    "http://localhost/api/admin/merge?duplicateId=SR-TEST-0002",
    { method: "DELETE", headers: authHeaders(moderator) },
  );
  assert.equal(unmerged.status, 200, await unmerged.text());
  assert.equal(
    await database
      .prepare("SELECT merged_into_report_id FROM reports WHERE id = ?")
      .bind("SR-TEST-0002")
      .first("merged_into_report_id"),
    null,
  );
});

test("report deletion needs fresh admin auth", async () => {
  const body = reportBody("SR-TEST-DELETE", "DeleteFixture", "100000000000000014");
  await insertReportFixture(database, {
    id: body.id,
    username: body.username,
    discordId: body.discordId,
    isPublished: false,
  });

  const moderatorAttempt = await runtime.dispatchFetch(
    `http://localhost/api/admin/reports?id=${body.id}`,
    { method: "DELETE", headers: authHeaders(moderator) },
  );
  assert.equal(moderatorAttempt.status, 403);

  const adminAttempt = await runtime.dispatchFetch(
    `http://localhost/api/admin/reports?id=${body.id}`,
    { method: "DELETE", headers: authHeaders(administrator) },
  );
  assert.equal(adminAttempt.status, 200, await adminAttempt.text());
  assert.equal(
    await database.prepare("SELECT id FROM reports WHERE id = ?").bind(body.id).first(),
    null,
  );
});
