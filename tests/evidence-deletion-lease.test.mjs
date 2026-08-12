import assert from "node:assert/strict";
import test from "node:test";
import {
  authHeaders,
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
} from "./helpers/runtime.mjs";

async function insertEvidenceFixture(
  state,
  id,
  database,
  originals,
  derivatives,
  { legalHold = false, linkReportId = null } = {},
) {
  const suffix = id.slice(-12);
  const originalKey = `originals/deletion-${suffix}`;
  const derivativeKey = `derivatives/deletion-${suffix}.webp`;
  const now = "2026-08-10T00:00:00.000Z";
  await database
    .prepare(
      `INSERT INTO evidence_assets (
      id, intake_id, intake_kind, state, original_key, derivative_key,
      original_filename, original_content_type, original_size, original_sha256,
      derivative_content_type, derivative_size, derivative_sha256,
      source_width, source_height, width, height, visible_pii_reviewed,
      privacy_withheld, replaces_evidence_id, legal_hold, processing_error,
      created_by, created_at, updated_at, published_at, deleted_at
    ) VALUES (?, NULL, 'moderator_upload', ?, ?, ?, 'private-proof.png',
      'image/png', 4, ?, 'image/webp', 4, ?, 10, 10, 10, 10, 1,
      0, NULL, ?, '', 'DeletionLeaseFixture', ?, ?, NULL, NULL)`,
    )
    .bind(
      id,
      state,
      originalKey,
      derivativeKey,
      `original-sha-${suffix}`,
      `derivative-sha-${suffix}`,
      legalHold ? 1 : 0,
      now,
      now,
    )
    .run();
  if (originals) await originals.put(originalKey, Uint8Array.of(1, 2, 3, 4));
  if (derivatives) await derivatives.put(derivativeKey, Uint8Array.of(5, 6, 7, 8));
  if (linkReportId) {
    await database
      .prepare(
        `INSERT INTO report_evidence
      (report_id, evidence_id, caption, display_order, created_at)
      VALUES (?, ?, 'Synthetic deletion fixture', 0, ?)`,
      )
      .bind(linkReportId, id, now)
      .run();
  }
  return { originalKey, derivativeKey };
}

async function setup(options) {
  const state = await createTestRuntime(options);
  const admin = await insertAccountFixture(state.database, {
    id: "evidence_delete_admin",
    handle: "DeleteAdmin",
    role: "admin",
    providers: ["discord", "email"],
  });
  return { ...state, admin };
}

test("evidence deletion withdraws links and records a tombstone", async (t) => {
  const state = await setup();
  t.after(() => state.runtime.dispose());
  await insertReportFixture(state.database, { id: "R-DELETE-LEASE" });
  const id = "EVA-20000000-0000-4000-8000-000000000001";
  const keys = await insertEvidenceFixture(
    "public",
    id,
    state.database,
    state.originals,
    state.derivatives,
    { linkReportId: "R-DELETE-LEASE" },
  );

  const response = await state.runtime.dispatchFetch(`http://localhost/api/admin/evidence/${id}`, {
    method: "DELETE",
    headers: authHeaders(state.admin),
  });
  assert.equal(response.status, 200, await response.text());
  const row = await state.database
    .prepare(
      `SELECT state, legal_hold, derivative_key,
      deleted_at FROM evidence_assets WHERE id = ?`,
    )
    .bind(id)
    .first();
  assert.equal(row.state, "deleted");
  assert.equal(row.legal_hold, 0);
  assert.equal(row.derivative_key, null);
  assert.match(row.deleted_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.doesNotMatch(row.deleted_at, /^deletion-pending:/u);
  assert.equal(await state.originals.get(keys.originalKey), null);
  assert.equal(await state.derivatives.get(keys.derivativeKey), null);
  assert.equal(
    await state.database
      .prepare("SELECT COUNT(*) FROM report_evidence WHERE evidence_id = ?")
      .bind(id)
      .first("COUNT(*)"),
    0,
  );
  assert.equal(
    await state.database
      .prepare(
        `SELECT COUNT(*) FROM audit_logs
      WHERE action = 'evidence.deleted' AND detail LIKE ?`,
      )
      .bind(`%${id}%`)
      .first("COUNT(*)"),
    1,
  );
});

test("legal hold blocks evidence deletion", async (t) => {
  const state = await setup();
  t.after(() => state.runtime.dispose());
  const id = "EVA-20000000-0000-4000-8000-000000000002";
  const keys = await insertEvidenceFixture(
    "private_ready",
    id,
    state.database,
    state.originals,
    state.derivatives,
    { legalHold: true },
  );

  const response = await state.runtime.dispatchFetch(`http://localhost/api/admin/evidence/${id}`, {
    method: "DELETE",
    headers: authHeaders(state.admin),
  });
  const payload = await response.json();
  assert.equal(response.status, 409, JSON.stringify(payload));
  assert.equal(payload.code, "legal_hold");
  assert.ok(await state.originals.get(keys.originalKey));
  assert.ok(await state.derivatives.get(keys.derivativeKey));
  assert.deepEqual(
    await state.database
      .prepare("SELECT state, legal_hold, deleted_at FROM evidence_assets WHERE id = ?")
      .bind(id)
      .first(),
    { state: "private_ready", legal_hold: 1, deleted_at: null },
  );
});

test("deletion leases handle holds and stale recovery", async (t) => {
  const state = await setup();
  t.after(() => state.runtime.dispose());
  const id = "EVA-20000000-0000-4000-8000-000000000003";
  await insertEvidenceFixture("public", id, state.database, state.originals, state.derivatives);
  const staleLease = `deletion-pending:${Date.now() - 11 * 60 * 1000}:stale-test-lease`;
  await state.database
    .prepare(
      `UPDATE evidence_assets
    SET state = 'withheld', deleted_at = ? WHERE id = ?`,
    )
    .bind(staleLease, id)
    .run();

  const patch = await state.runtime.dispatchFetch(`http://localhost/api/admin/evidence/${id}`, {
    method: "PATCH",
    headers: authHeaders(state.admin, { "content-type": "application/json" }),
    body: JSON.stringify({ legalHold: true }),
  });
  const patchPayload = await patch.json();
  assert.equal(patch.status, 409, JSON.stringify(patchPayload));
  assert.equal(patchPayload.code, "deletion_in_progress");
  await assert.rejects(
    state.database.prepare("UPDATE evidence_assets SET legal_hold = 1 WHERE id = ?").bind(id).run(),
    /evidence_(legal_hold_delete_forbidden|deletion_in_progress)/u,
  );
  await assert.rejects(
    state.database
      .prepare(
        `UPDATE evidence_assets
      SET state = 'deleted', legal_hold = 1, deleted_at = ? WHERE id = ?`,
      )
      .bind(new Date().toISOString(), id)
      .run(),
    /evidence_(legal_hold_delete_forbidden|deletion_in_progress)/u,
  );

  const resumed = await state.runtime.dispatchFetch(`http://localhost/api/admin/evidence/${id}`, {
    method: "DELETE",
    headers: authHeaders(state.admin),
  });
  assert.equal(resumed.status, 200, await resumed.text());
  const final = await state.database
    .prepare("SELECT state, legal_hold, deleted_at FROM evidence_assets WHERE id = ?")
    .bind(id)
    .first();
  assert.equal(final.state, "deleted");
  assert.equal(final.legal_hold, 0);
  assert.doesNotMatch(final.deleted_at, /^deletion-pending:/u);
});

test("missing storage fails before leasing", async (t) => {
  const state = await setup({ r2Buckets: [] });
  t.after(() => state.runtime.dispose());
  const id = "EVA-20000000-0000-4000-8000-000000000004";
  await insertEvidenceFixture("private_ready", id, state.database);

  const response = await state.runtime.dispatchFetch(`http://localhost/api/admin/evidence/${id}`, {
    method: "DELETE",
    headers: authHeaders(state.admin),
  });
  const payload = await response.json();
  assert.equal(response.status, 503, JSON.stringify(payload));
  assert.equal(payload.code, "storage_unavailable");
  assert.deepEqual(
    await state.database
      .prepare("SELECT state, deleted_at FROM evidence_assets WHERE id = ?")
      .bind(id)
      .first(),
    { state: "private_ready", deleted_at: null },
  );
});
