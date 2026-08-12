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
let derivatives;
let originals;
let moderator;

const ASSETS = {
  privateLinked: "EVA-00000000-0000-4000-8000-000000000001",
  publicUnlinked: "EVA-00000000-0000-4000-8000-000000000002",
  publicUnpublished: "EVA-00000000-0000-4000-8000-000000000003",
  publicPublished: "EVA-00000000-0000-4000-8000-000000000004",
  publicUnverified: "EVA-00000000-0000-4000-8000-000000000005",
  publicShaMismatch: "EVA-00000000-0000-4000-8000-000000000006",
  publicSizeMismatch: "EVA-00000000-0000-4000-8000-000000000007",
  publicPiiUnreviewed: "EVA-00000000-0000-4000-8000-000000000008",
  privacySource: "EVA-00000000-0000-4000-8000-000000000009",
};

function assertNoStore(response) {
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/u);
}

function assertPrivateEvidenceHeaders(response) {
  assert.match(response.headers.get("cache-control") ?? "", /\bprivate\b/u);
  assertNoStore(response);
  assert.ok(response.headers.get("content-security-policy"));
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.ok(response.headers.get("referrer-policy"));
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
}

async function insertAssetRow(targetDatabase, id, state, { originalSize = 4 } = {}) {
  const suffix = id.slice(-12);
  await targetDatabase
    .prepare(
      `INSERT INTO evidence_assets (
      id, intake_id, intake_kind, state, original_key, derivative_key,
      original_filename, original_content_type, original_size, original_sha256,
      derivative_content_type, derivative_size, derivative_sha256,
      source_width, source_height, width, height, visible_pii_reviewed,
      legal_hold, processing_error, created_by, created_at, updated_at,
      published_at, deleted_at
    ) VALUES (?, NULL, 'moderator_upload', ?, ?, ?, 'raw.png', 'image/png',
      ?, ?, 'image/webp', 4, ?, 10, 10, 10, 10, 1, 0, '', 'test',
      '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z', NULL, NULL)`,
    )
    .bind(
      id,
      state,
      `originals/${suffix}`,
      `derivatives/${suffix}.webp`,
      originalSize,
      `original-hash-${suffix}`,
      `derivative-hash-${suffix}`,
    )
    .run();
}

async function insertAsset(id, state, options = {}) {
  const suffix = id.slice(-12);
  await insertAssetRow(database, id, state, options);
  await derivatives.put(
    `derivatives/${suffix}.webp`,
    Uint8Array.of(82, 73, 70, Number(suffix.slice(-1))),
    {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: {
        sanitized: "cloudflare-images-webp",
        sha256: `derivative-hash-${suffix}`,
      },
    },
  );
}

before(async () => {
  ({ runtime, database, derivatives, originals } = await createTestRuntime());
  await insertReportFixture(database, {
    id: "R-PUBLIC",
    username: "PublishedFixture",
    discordId: "100000000000000011",
    isPublished: true,
  });
  await insertReportFixture(database, {
    id: "R-DRAFT",
    username: "DraftFixture",
    discordId: "100000000000000012",
    isPublished: false,
  });
  await insertReportFixture(database, {
    id: "R-PUBLIC-2",
    username: "PublishedFixtureTwo",
    discordId: "100000000000000013",
    isPublished: true,
  });
  await insertReportFixture(database, {
    id: "R-REDACT",
    username: "RedactionFixture",
    discordId: "100000000000000014",
    isPublished: true,
  });
  moderator = await insertAccountFixture(database, {
    id: "account_test_moderator",
    handle: "TestModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  await insertAsset(ASSETS.privateLinked, "private_ready");
  await insertAsset(ASSETS.publicUnlinked, "public");
  await insertAsset(ASSETS.publicUnpublished, "public");
  await insertAsset(ASSETS.publicPublished, "public");
  await insertAsset(ASSETS.publicUnverified, "public");
  await insertAsset(ASSETS.publicShaMismatch, "public");
  await insertAsset(ASSETS.publicSizeMismatch, "public");
  await insertAsset(ASSETS.publicPiiUnreviewed, "public");
  await insertAsset(ASSETS.privacySource, "private_ready");
  await derivatives.put("derivatives/000000000005.webp", Uint8Array.of(137, 80, 78, 71), {
    httpMetadata: { contentType: "image/png" },
  });
  await derivatives.put("derivatives/000000000006.webp", Uint8Array.of(82, 73, 70, 6), {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: {
      sanitized: "cloudflare-images-webp",
      sha256: "deliberately-wrong-sha256",
    },
  });
  await database
    .prepare("UPDATE evidence_assets SET derivative_size = 5 WHERE id = ?")
    .bind(ASSETS.publicSizeMismatch)
    .run();
  await database
    .prepare("UPDATE evidence_assets SET visible_pii_reviewed = 0 WHERE id = ?")
    .bind(ASSETS.publicPiiUnreviewed)
    .run();
  await database
    .prepare(
      `INSERT INTO report_evidence
      (report_id, evidence_id, caption, display_order, created_at)
      VALUES
      ('R-PUBLIC', ?, 'Private asset', 0, '2026-08-09T00:00:00.000Z'),
      ('R-DRAFT', ?, 'Draft asset', 0, '2026-08-09T00:00:00.000Z'),
      ('R-PUBLIC', ?, 'Published sanitized asset', 1, '2026-08-09T00:00:00.000Z'),
      ('R-PUBLIC', ?, 'Unverified derivative', 2, '2026-08-09T00:00:00.000Z'),
      ('R-PUBLIC', ?, 'SHA mismatch derivative', 3, '2026-08-09T00:00:00.000Z'),
      ('R-PUBLIC', ?, 'Size mismatch derivative', 4, '2026-08-09T00:00:00.000Z'),
      ('R-PUBLIC-2', ?, 'Unreviewed visible PII derivative', 0, '2026-08-09T00:00:00.000Z'),
      ('R-REDACT', ?, 'Original screenshot requiring redaction', 0, '2026-08-09T00:00:00.000Z')`,
    )
    .bind(
      ASSETS.privateLinked,
      ASSETS.publicUnpublished,
      ASSETS.publicPublished,
      ASSETS.publicUnverified,
      ASSETS.publicShaMismatch,
      ASSETS.publicSizeMismatch,
      ASSETS.publicPiiUnreviewed,
      ASSETS.privacySource,
    )
    .run();
});

after(async () => runtime?.dispose());

test("public evidence needs a published report link", async () => {
  for (const id of [ASSETS.privateLinked, ASSETS.publicUnlinked, ASSETS.publicUnpublished]) {
    const response = await runtime.dispatchFetch(`http://localhost/api/evidence/${id}`);
    assert.equal(response.status, 404, id);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("public evidence serves the verified derivative only", async () => {
  const response = await runtime.dispatchFetch(
    `http://localhost/api/evidence/${ASSETS.publicPublished}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/webp");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [82, 73, 70, 4]);
});

test("public reports hide original evidence filenames", async () => {
  const response = await runtime.dispatchFetch("http://localhost/api/reports/R-PUBLIC");
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.doesNotMatch(JSON.stringify(payload), /raw\.png/u);
  const evidence = payload.report.evidence.find((item) => item.id === ASSETS.publicPublished);
  assert.equal(evidence.filename, `${ASSETS.publicPublished}.webp`);
});

test("public evidence needs sanitizer provenance", async () => {
  const response = await runtime.dispatchFetch(
    `http://localhost/api/evidence/${ASSETS.publicUnverified}`,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("public evidence checks derivative hash and size", async () => {
  for (const id of [ASSETS.publicShaMismatch, ASSETS.publicSizeMismatch]) {
    const response = await runtime.dispatchFetch(`http://localhost/api/evidence/${id}`);
    assert.equal(response.status, 503, id);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("public state does not bypass PII review", async () => {
  const response = await runtime.dispatchFetch(
    `http://localhost/api/evidence/${ASSETS.publicPiiUnreviewed}`,
  );
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("private evidence errors are never cacheable", async () => {
  const missingId = "EVA-ffffffff-ffff-4fff-8fff-ffffffffffff";
  for (const pathname of [
    `/api/admin/evidence/${ASSETS.privateLinked}/derivative`,
    `/api/intake-files/asset/${ASSETS.privateLinked}`,
  ]) {
    const response = await runtime.dispatchFetch(`http://localhost${pathname}`, {
      headers: authHeaders(moderator),
    });
    assert.equal(response.status, 200, pathname);
    assertPrivateEvidenceHeaders(response);
  }

  const invalidFilter = await runtime.dispatchFetch(
    "http://localhost/api/admin/evidence?state=invalid",
    { headers: authHeaders(moderator) },
  );
  assert.equal(invalidFilter.status, 400);
  assertNoStore(invalidFilter);

  const adminNotFound = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${missingId}`,
    { headers: authHeaders(moderator) },
  );
  assert.equal(adminNotFound.status, 404);
  assertNoStore(adminNotFound);

  const invalidUpdate = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${ASSETS.privateLinked}`,
    {
      method: "PATCH",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify({ state: "invalid" }),
    },
  );
  assert.equal(invalidUpdate.status, 400);
  assertNoStore(invalidUpdate);

  const forbiddenUpdate = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${ASSETS.privateLinked}`,
    {
      method: "PATCH",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify({ legalHold: true }),
    },
  );
  assert.equal(forbiddenUpdate.status, 403);
  assertNoStore(forbiddenUpdate);

  for (const pathname of [
    `/api/admin/evidence/${missingId}/derivative`,
    `/api/admin/evidence/${missingId}/original`,
    `/api/intake-files/asset/${missingId}`,
  ]) {
    const response = await runtime.dispatchFetch(`http://localhost${pathname}`, {
      headers: authHeaders(moderator),
    });
    assert.equal(response.status, 404, pathname);
    assertPrivateEvidenceHeaders(response);
  }
});

test("private evidence storage failures are never cacheable", async () => {
  const isolated = await createTestRuntime({ r2Buckets: [] });
  try {
    const isolatedModerator = await insertAccountFixture(isolated.database, {
      id: "account_evidence_headers_moderator",
      handle: "EvidenceHeadersModerator",
      role: "moderator",
      providers: ["discord", "email"],
    });
    const id = "EVA-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await insertAssetRow(isolated.database, id, "private_ready");
    for (const pathname of [
      `/api/admin/evidence/${id}/derivative`,
      `/api/admin/evidence/${id}/original`,
      `/api/intake-files/asset/${id}`,
    ]) {
      const response = await isolated.runtime.dispatchFetch(`http://localhost${pathname}`, {
        headers: authHeaders(isolatedModerator),
      });
      assert.equal(response.status, 503, pathname);
      assertPrivateEvidenceHeaders(response);
    }
  } finally {
    await isolated.runtime.dispose();
  }
});

test("privacy review can publish a verified derivative", async () => {
  const response = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${ASSETS.privateLinked}`,
    {
      method: "PATCH",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify({ state: "public", visiblePiiReviewed: true }),
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.evidence.state, "public");
  assert.equal(payload.evidence.visiblePiiReviewed, true);

  const publicResponse = await runtime.dispatchFetch(
    `http://localhost/api/evidence/${ASSETS.privateLinked}`,
  );
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get("content-type"), "image/webp");
});

test("moderation respects the five-file limit", async () => {
  const response = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${ASSETS.publicUnlinked}`,
    {
      method: "PATCH",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify({
        reportId: "R-PUBLIC",
        caption: "Sixth attachment must fail",
      }),
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 413, JSON.stringify(payload));
  assert.equal(payload.code, "too_many_evidence_files");
  assert.equal(
    await database
      .prepare("SELECT COUNT(*) FROM report_evidence WHERE report_id = 'R-PUBLIC'")
      .first("COUNT(*)"),
    5,
  );
  assert.equal(
    await database
      .prepare("SELECT COUNT(*) FROM report_evidence WHERE evidence_id = ?")
      .bind(ASSETS.publicUnlinked)
      .first("COUNT(*)"),
    0,
  );
});

test("moderation respects the 20 MiB limit", async () => {
  await insertReportFixture(database, {
    id: "R-SIZE-LIMIT",
    username: "SizeLimitFixture",
    discordId: "100000000000000015",
    isPublished: false,
  });
  const ids = [1, 2, 3, 4].map(
    (value) => `EVA-10000000-0000-4000-8000-${String(200000000000 + value)}`,
  );
  for (const id of ids) {
    await insertAsset(id, "private_ready", { originalSize: 5 * 1024 * 1024 });
    await database
      .prepare(
        `INSERT INTO report_evidence
      (report_id, evidence_id, caption, display_order, created_at)
      VALUES ('R-SIZE-LIMIT', ?, 'Five MiB fixture', 0, '2026-08-09T00:00:00.000Z')`,
      )
      .bind(id)
      .run();
  }

  const response = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${ASSETS.publicUnlinked}`,
    {
      method: "PATCH",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify({
        reportId: "R-SIZE-LIMIT",
        caption: "Over-size attachment must fail",
      }),
    },
  );
  const payload = await response.json();
  assert.equal(response.status, 413, JSON.stringify(payload));
  assert.equal(payload.code, "evidence_total_too_large");
  assert.equal(
    await database
      .prepare("SELECT COUNT(*) FROM report_evidence WHERE report_id = 'R-SIZE-LIMIT'")
      .first("COUNT(*)"),
    4,
  );
});

test("database triggers guard report evidence limits", async () => {
  await insertReportFixture(database, {
    id: "R-TRIGGER-LIMIT",
    username: "TriggerLimitFixture",
    discordId: "100000000000000016",
    isPublished: false,
  });
  const firstFive = [
    ASSETS.privateLinked,
    ASSETS.publicPublished,
    ASSETS.publicUnverified,
    ASSETS.publicShaMismatch,
    ASSETS.publicSizeMismatch,
  ];
  for (const [index, id] of firstFive.entries()) {
    await database
      .prepare(
        `INSERT INTO report_evidence
      (report_id, evidence_id, caption, display_order, created_at)
      VALUES ('R-TRIGGER-LIMIT', ?, 'Trigger fixture', ?, '2026-08-09T00:00:00.000Z')`,
      )
      .bind(id, index)
      .run();
  }
  await assert.rejects(
    database
      .prepare(
        `INSERT INTO report_evidence
      (report_id, evidence_id, caption, display_order, created_at)
      VALUES ('R-TRIGGER-LIMIT', ?, 'Forbidden sixth link', 5, '2026-08-09T00:00:00.000Z')`,
      )
      .bind(ASSETS.publicUnlinked)
      .run(),
    /report_evidence_file_limit/u,
  );
  assert.equal(
    await database
      .prepare("SELECT COUNT(*) FROM report_evidence WHERE report_id = 'R-TRIGGER-LIMIT'")
      .first("COUNT(*)"),
    5,
  );
});

test("visible PII needs a separate redacted file", async () => {
  const withhold = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${ASSETS.privacySource}`,
    {
      method: "PATCH",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify({ visiblePiiDetected: true }),
    },
  );
  const withheldPayload = await withhold.json();
  assert.equal(withhold.status, 200, JSON.stringify(withheldPayload));
  assert.equal(withheldPayload.evidence.state, "withheld");
  assert.equal(withheldPayload.evidence.privacyWithheld, true);
  assert.equal(withheldPayload.evidence.visiblePiiReviewed, true);

  const republishOriginal = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${ASSETS.privacySource}`,
    {
      method: "PATCH",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify({ state: "public", visiblePiiReviewed: true }),
    },
  );
  assert.equal(republishOriginal.status, 409);
  assert.equal((await republishOriginal.json()).code, "redacted_replacement_required");
  await assert.rejects(
    database
      .prepare("UPDATE evidence_assets SET state = 'public' WHERE id = ?")
      .bind(ASSETS.privacySource)
      .run(),
    /evidence_privacy_public_forbidden/u,
  );
  await assert.rejects(
    database
      .prepare("UPDATE evidence_assets SET privacy_withheld = 0 WHERE id = ?")
      .bind(ASSETS.privacySource)
      .run(),
    /evidence_privacy_withheld_immutable/u,
  );

  const raw = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  const invalidForm = new FormData();
  invalidForm.set("file", new Blob([raw], { type: "image/png" }), "redacted.png");
  invalidForm.set("replacesEvidenceId", ASSETS.publicPublished);
  const invalidRequest = new Request("http://localhost/api/admin/evidence/upload", {
    method: "POST",
    headers: authHeaders(moderator),
    body: invalidForm,
  });
  const invalidReplacement = await runtime.dispatchFetch(invalidRequest.url, {
    method: "POST",
    headers: Object.fromEntries(invalidRequest.headers),
    body: await invalidRequest.arrayBuffer(),
  });
  assert.equal(invalidReplacement.status, 409);
  assert.equal((await invalidReplacement.json()).code, "replacement_source_invalid");

  const form = new FormData();
  form.set("file", new Blob([raw], { type: "image/png" }), "externally-redacted.png");
  form.set("replacesEvidenceId", ASSETS.privacySource);
  const request = new Request("http://localhost/api/admin/evidence/upload", {
    method: "POST",
    headers: authHeaders(moderator),
    body: form,
  });
  const upload = await runtime.dispatchFetch(request.url, {
    method: "POST",
    headers: Object.fromEntries(request.headers),
    body: await request.arrayBuffer(),
  });
  const uploaded = await upload.json();
  assert.equal(upload.status, 201, JSON.stringify(uploaded));
  assert.equal(uploaded.evidence.replacesEvidenceId, ASSETS.privacySource);
  assert.equal(uploaded.evidence.privacyWithheld, false);

  const replacementRecord = await database
    .prepare("SELECT derivative_key FROM evidence_assets WHERE id = ?")
    .bind(uploaded.evidence.id)
    .first();
  await database
    .prepare(
      `UPDATE evidence_assets
    SET derivative_content_type = 'image/webp' WHERE id = ?`,
    )
    .bind(uploaded.evidence.id)
    .run();
  const replacementObject = await derivatives.get(replacementRecord.derivative_key);
  const replacementBytes = await replacementObject.arrayBuffer();
  await derivatives.put(replacementRecord.derivative_key, replacementBytes, {
    httpMetadata: { contentType: "image/webp" },
    customMetadata: {
      ...replacementObject.customMetadata,
      sanitized: "cloudflare-images-webp",
    },
  });

  const publishReplacement = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${uploaded.evidence.id}`,
    {
      method: "PATCH",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify({
        state: "public",
        reportId: "R-REDACT",
        caption: "Externally redacted screenshot",
        visiblePiiReviewed: true,
      }),
    },
  );
  const replacementPayload = await publishReplacement.json();
  assert.equal(publishReplacement.status, 200, JSON.stringify(replacementPayload));
  assert.equal(replacementPayload.evidence.state, "public");
  assert.deepEqual(
    (
      await database
        .prepare(
          `SELECT evidence_id FROM report_evidence
      WHERE report_id = 'R-REDACT' ORDER BY evidence_id`,
        )
        .all()
    ).results,
    [{ evidence_id: uploaded.evidence.id }],
  );
  assert.equal(
    (await runtime.dispatchFetch(`http://localhost/api/evidence/${ASSETS.privacySource}`)).status,
    404,
  );
  assert.equal(
    (await runtime.dispatchFetch(`http://localhost/api/evidence/${uploaded.evidence.id}`)).status,
    200,
  );

  const unrelatedLink = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${uploaded.evidence.id}`,
    {
      method: "PATCH",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify({ reportId: "R-DRAFT", caption: "Invalid transfer" }),
    },
  );
  assert.equal(unrelatedLink.status, 409);
  assert.equal((await unrelatedLink.json()).code, "replacement_source_not_linked");
});

test("legacy raw upload routes stay gone", async () => {
  const legacyUpload = await runtime.dispatchFetch(
    "http://localhost/api/uploads/evidence/legacy-raw.png",
  );
  assert.equal(legacyUpload.status, 410);
  assert.equal(legacyUpload.headers.get("cache-control"), "no-store");

  const legacyIntake = await runtime.dispatchFetch(
    "http://localhost/api/intake-files/quarantine/legacy-raw.png",
  );
  assert.equal(legacyIntake.status, 401);
  assert.match(legacyIntake.headers.get("cache-control") ?? "", /\bno-store\b/u);

  const before = await database
    .prepare("SELECT state FROM evidence_assets WHERE id = ?")
    .bind(ASSETS.privateLinked)
    .first();
  const legacyDelete = await runtime.dispatchFetch(
    `http://localhost/api/intake-files/asset/${ASSETS.privateLinked}`,
    { method: "DELETE", headers: authHeaders(moderator) },
  );
  assert.equal(legacyDelete.status, 410);
  const after = await database
    .prepare("SELECT state FROM evidence_assets WHERE id = ?")
    .bind(ASSETS.privateLinked)
    .first();
  assert.deepEqual(after, before);
});

test("test sanitizer keeps both files private", async () => {
  const form = new FormData();
  const raw = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  form.set("file", new Blob([raw], { type: "image/png" }), "private-proof.png");
  const request = new Request("http://localhost/api/admin/evidence/upload", {
    method: "POST",
    headers: authHeaders(moderator),
    body: form,
  });
  const response = await runtime.dispatchFetch(request.url, {
    method: "POST",
    headers: Object.fromEntries(request.headers),
    body: await request.arrayBuffer(),
  });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  assert.equal(payload.evidence.state, "private_ready");
  assert.match(payload.attachment.url, /^\/api\/evidence\/EVA-/u);
  assert.equal("originalKey" in payload.evidence, false);
  assert.equal("derivativeKey" in payload.evidence, false);

  const evidenceNotification = await database
    .prepare(
      `SELECT channel, case_id, event_type, queue_path, status, attempts
       FROM notification_outbox
       WHERE event_key = ?`,
    )
    .bind(`evidence:${payload.evidence.id}:discord`)
    .first();
  assert.deepEqual(evidenceNotification, {
    channel: "discord",
    case_id: payload.evidence.id,
    event_type: "evidence",
    queue_path: "/admin?queue=evidence",
    status: "pending",
    attempts: 0,
  });

  const keys = await database
    .prepare("SELECT original_key, derivative_key FROM evidence_assets WHERE id = ?")
    .bind(payload.evidence.id)
    .first();
  const original = await originals.get(keys.original_key);
  const derivative = await derivatives.get(keys.derivative_key);
  assert.ok(original);
  assert.ok(derivative);
  assert.equal(derivative.customMetadata.sanitized, "test-only-unsafe-copy");
  assert.equal(
    (await runtime.dispatchFetch(`http://localhost${payload.attachment.url}`)).status,
    404,
  );

  const publish = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${payload.evidence.id}`,
    {
      method: "PATCH",
      headers: authHeaders(moderator, { "content-type": "application/json" }),
      body: JSON.stringify({
        state: "public",
        reportId: "R-PUBLIC",
        caption: "Must remain private",
        visiblePiiReviewed: true,
      }),
    },
  );
  assert.equal(publish.status, 409);
  assert.equal((await publish.json()).code, "derivative_required");

  const unauthorized = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${payload.evidence.id}/original`,
  );
  assert.equal(unauthorized.status, 401);
  const download = await runtime.dispatchFetch(
    `http://localhost/api/admin/evidence/${payload.evidence.id}/original`,
    { headers: { cookie: moderator.cookie } },
  );
  assert.equal(download.status, 200);
  assertPrivateEvidenceHeaders(download);
  assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/u);
  assert.deepEqual([...new Uint8Array(await download.arrayBuffer())], [...raw]);
  assert.ok(
    await database
      .prepare(
        "SELECT id FROM audit_logs WHERE action = 'evidence.original_downloaded' AND detail LIKE ?",
      )
      .bind(`%${payload.evidence.id}%`)
      .first(),
  );
});

test("signature mismatch stores nothing", async () => {
  const form = new FormData();
  form.set(
    "file",
    new Blob([Uint8Array.of(255, 216, 255, 0)], { type: "image/png" }),
    "spoofed.png",
  );
  const request = new Request("http://localhost/api/admin/evidence/upload", {
    method: "POST",
    headers: authHeaders(moderator),
    body: form,
  });
  const response = await runtime.dispatchFetch(request.url, {
    method: "POST",
    headers: Object.fromEntries(request.headers),
    body: await request.arrayBuffer(),
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, "invalid_image");
});

test("animated WebP is rejected before storage", async () => {
  const animatedWebp = Uint8Array.of(
    82,
    73,
    70,
    70,
    22,
    0,
    0,
    0,
    87,
    69,
    66,
    80,
    86,
    80,
    56,
    88,
    10,
    0,
    0,
    0,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  );
  const before = await database
    .prepare("SELECT COUNT(*) AS count FROM evidence_assets")
    .first("count");
  const form = new FormData();
  form.set("file", new Blob([animatedWebp], { type: "image/webp" }), "animated-proof.webp");
  const request = new Request("http://localhost/api/admin/evidence/upload", {
    method: "POST",
    headers: authHeaders(moderator),
    body: form,
  });
  const response = await runtime.dispatchFetch(request.url, {
    method: "POST",
    headers: Object.fromEntries(request.headers),
    body: await request.arrayBuffer(),
  });
  assert.equal(response.status, 415);
  assert.equal((await response.json()).code, "invalid_image");
  assert.equal(
    await database.prepare("SELECT COUNT(*) AS count FROM evidence_assets").first("count"),
    before,
  );
});

test("production uploads need the Images binding", async () => {
  const production = await createTestRuntime({
    bindings: {
      APP_ENVIRONMENT: "production",
      AUTH_RUNTIME_ENV: "production",
      AUTH_APP_ORIGIN: "https://scam-reports.org",
    },
  });
  try {
    const productionModerator = await insertAccountFixture(production.database, {
      id: "production_moderator",
      handle: "ProductionModerator",
      role: "moderator",
      providers: ["discord", "email"],
    });
    const form = new FormData();
    form.set(
      "file",
      new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)], {
        type: "image/png",
      }),
      "must-fail.png",
    );
    const request = new Request("https://scam-reports.org/api/admin/evidence/upload", {
      method: "POST",
      headers: {
        origin: "https://scam-reports.org",
        cookie: `__Host-sr_session=${productionModerator.token}; __Host-sr_csrf=${productionModerator.csrf}`,
        "x-csrf-token": productionModerator.csrf,
      },
      body: form,
    });
    const response = await production.runtime.dispatchFetch(request.url, {
      method: "POST",
      headers: Object.fromEntries(request.headers),
      body: await request.arrayBuffer(),
    });
    const payload = await response.json();
    assert.equal(response.status, 503, JSON.stringify(payload));
    assert.equal(payload.code, "sanitizer_unavailable");
    assert.equal((await production.originals.list()).objects.length, 0);
    const row = await production.database
      .prepare("SELECT state FROM evidence_assets ORDER BY created_at DESC LIMIT 1")
      .first();
    assert.equal(row.state, "failed");
  } finally {
    await production.runtime.dispose();
  }
});
