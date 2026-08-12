import assert from "node:assert/strict";
import test from "node:test";
import {
  authHeaders,
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
} from "./helpers/runtime.mjs";

const now = "2026-08-10T10:00:00.000Z";

function attachment(id) {
  return {
    id,
    filename: "synthetic-proof.png",
    storageKey: `asset/${id}`,
    adminUrl: `/api/intake-files/asset/${id}`,
    uploadedAt: now,
    fileSize: 4,
    contentType: "image/webp",
  };
}

async function insertEvidenceAsset(database, { id, intakeId, intakeKind, legalHold = false }) {
  const suffix = id.slice(-12);
  const originalKey = `originals/intake/${suffix}.png`;
  const derivativeKey = `derivatives/intake/${suffix}.webp`;
  await database
    .prepare(
      `INSERT INTO evidence_assets (
      id, intake_id, intake_kind, state, original_key, derivative_key,
      original_filename, original_content_type, original_size, original_sha256,
      derivative_content_type, derivative_size, derivative_sha256,
      source_width, source_height, width, height, visible_pii_reviewed,
      legal_hold, processing_error, created_by, created_at, updated_at,
      published_at, deleted_at
    ) VALUES (?, ?, ?, 'private_ready', ?, ?, 'synthetic-proof.png', 'image/png',
      4, ?, 'image/webp', 4, ?, 2, 2, 2, 2, 0, ?, '', 'test-suite', ?, ?, NULL, NULL)`,
    )
    .bind(
      id,
      intakeId,
      intakeKind,
      originalKey,
      derivativeKey,
      `original-hash-${suffix}`,
      `derivative-hash-${suffix}`,
      legalHold ? 1 : 0,
      now,
      now,
    )
    .run();
  return { originalKey, derivativeKey };
}

async function insertSubmission(database, { id, accountId, evidence }) {
  await database
    .prepare(
      `INSERT INTO report_submissions (
      id, account_id, related_report_id, submitter_name, contact_email, username,
      discord_id, game, category, reason, description, evidence_json, status,
      moderator_notes, author_fingerprint, submitter_verified, result_report_id,
      created_at, updated_at
    ) VALUES (?, ?, 'SR-DELETE-INTEGRITY', 'Synthetic Member', 'member@example.test',
      'Synthetic Subject', '800000000000000099', 'Synthetic Arena', 'Cheating',
      'Synthetic deletion-integrity reason.',
      'Synthetic private intake body for deletion-integrity testing.', ?, 'Pending',
      '', 'synthetic-submission-fingerprint', 1, NULL, ?, ?)`,
    )
    .bind(id, accountId, JSON.stringify(evidence), now, now)
    .run();
}

async function insertAppeal(database, { id, evidence }) {
  await database
    .prepare(
      `INSERT INTO appeals (
      id, account_id, report_id, request_type, submitter_name, relationship,
      contact_email, body, evidence_json, status, moderator_notes, public_resolution,
      author_fingerprint, submitter_verified, created_at, updated_at
    ) VALUES (?, NULL, 'SR-DELETE-INTEGRITY', 'Correction', 'Synthetic Appellant',
      'Named person', 'appellant@example.test',
      'Synthetic private appeal body for deletion-integrity testing.', ?, 'Pending',
      '', '', 'synthetic-appeal-fingerprint', 0, ?, ?)`,
    )
    .bind(id, JSON.stringify(evidence), now, now)
    .run();
}

async function seedPrincipalAndReport(database, suffix) {
  await insertReportFixture(database, {
    id: "SR-DELETE-INTEGRITY",
    username: "DeletionIntegrityFixture",
    discordId: "800000000000000098",
  });
  const member = await insertAccountFixture(database, {
    id: `account_delete_member_${suffix}`,
    handle: `DeleteMember${suffix}`,
    providers: ["discord", "email"],
  });
  const admin = await insertAccountFixture(database, {
    id: `account_delete_admin_${suffix}`,
    handle: `DeleteAdmin${suffix}`,
    role: "admin",
    providers: ["discord", "email"],
  });
  return { member, admin };
}

test("legal holds keep intake evidence and its case", async () => {
  const context = await createTestRuntime();
  try {
    const { member, admin } = await seedPrincipalAndReport(context.database, "Hold");
    const caseId = "SUB-LEGAL-HOLD";
    const evidenceId = "EVA-10000000-0000-4000-8000-000000000001";
    const keys = await insertEvidenceAsset(context.database, {
      id: evidenceId,
      intakeId: caseId,
      intakeKind: "report_submission",
      legalHold: true,
    });
    await context.originals.put(keys.originalKey, Uint8Array.of(1, 2, 3, 4));
    await context.derivatives.put(keys.derivativeKey, Uint8Array.of(5, 6, 7, 8));
    await insertSubmission(context.database, {
      id: caseId,
      accountId: member.id,
      evidence: [attachment(evidenceId)],
    });

    const response = await context.runtime.dispatchFetch(
      `http://localhost/api/admin/report-submissions?id=${caseId}`,
      { method: "DELETE", headers: authHeaders(admin) },
    );
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await response.json()).code, "legal_hold");
    assert.ok(
      await context.database
        .prepare("SELECT id FROM report_submissions WHERE id = ?")
        .bind(caseId)
        .first(),
    );
    assert.ok(await context.originals.head(keys.originalKey));
    assert.ok(await context.derivatives.head(keys.derivativeKey));
    assert.deepEqual(
      await context.database
        .prepare("SELECT state, legal_hold FROM evidence_assets WHERE id = ?")
        .bind(evidenceId)
        .first(),
      { state: "private_ready", legal_hold: 1 },
    );
  } finally {
    await context.runtime.dispose();
  }
});

test("bucket failure leaves appeals untouched", async () => {
  const context = await createTestRuntime({
    r2Buckets: ["EVIDENCE_DERIVATIVES", "BACKUPS"],
  });
  try {
    const { admin } = await seedPrincipalAndReport(context.database, "Storage");
    const caseId = "APL-STORAGE-FAIL";
    const evidenceId = "EVA-20000000-0000-4000-8000-000000000002";
    const keys = await insertEvidenceAsset(context.database, {
      id: evidenceId,
      intakeId: caseId,
      intakeKind: "appeal",
    });
    await context.derivatives.put(keys.derivativeKey, Uint8Array.of(5, 6, 7, 8));
    await insertAppeal(context.database, {
      id: caseId,
      evidence: [attachment(evidenceId)],
    });

    const response = await context.runtime.dispatchFetch(
      `http://localhost/api/admin/appeals?id=${caseId}`,
      { method: "DELETE", headers: authHeaders(admin) },
    );
    assert.equal(response.status, 503, await response.clone().text());
    assert.equal((await response.json()).code, "storage_unavailable");
    assert.ok(
      await context.database.prepare("SELECT id FROM appeals WHERE id = ?").bind(caseId).first(),
    );
    assert.ok(await context.derivatives.head(keys.derivativeKey));
    assert.equal(
      await context.database
        .prepare("SELECT state FROM evidence_assets WHERE id = ?")
        .bind(evidenceId)
        .first("state"),
      "private_ready",
    );
  } finally {
    await context.runtime.dispose();
  }
});

test("intake deletion removes files before cases", async () => {
  const context = await createTestRuntime();
  try {
    const { member, admin } = await seedPrincipalAndReport(context.database, "Success");
    const fixtures = [
      {
        route: "report-submissions",
        table: "report_submissions",
        caseId: "SUB-DELETE-SUCCESS",
        evidenceId: "EVA-30000000-0000-4000-8000-000000000003",
        intakeKind: "report_submission",
        auditAction: "submission-deleted",
      },
      {
        route: "appeals",
        table: "appeals",
        caseId: "APL-DELETE-SUCCESS",
        evidenceId: "EVA-40000000-0000-4000-8000-000000000004",
        intakeKind: "appeal",
        auditAction: "appeal-deleted",
      },
    ];

    for (const fixture of fixtures) {
      const keys = await insertEvidenceAsset(context.database, {
        id: fixture.evidenceId,
        intakeId: fixture.caseId,
        intakeKind: fixture.intakeKind,
      });
      await context.originals.put(keys.originalKey, Uint8Array.of(1, 2, 3, 4));
      await context.derivatives.put(keys.derivativeKey, Uint8Array.of(5, 6, 7, 8));
      await context.backups.put(`backup/${fixture.evidenceId}`, Uint8Array.of(9));
      if (fixture.route === "report-submissions") {
        await insertSubmission(context.database, {
          id: fixture.caseId,
          accountId: member.id,
          evidence: [attachment(fixture.evidenceId)],
        });
      } else {
        await insertAppeal(context.database, {
          id: fixture.caseId,
          evidence: [attachment(fixture.evidenceId)],
        });
      }

      const response = await context.runtime.dispatchFetch(
        `http://localhost/api/admin/${fixture.route}?id=${fixture.caseId}`,
        { method: "DELETE", headers: authHeaders(admin) },
      );
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        await context.database
          .prepare(`SELECT id FROM ${fixture.table} WHERE id = ?`)
          .bind(fixture.caseId)
          .first(),
        null,
      );
      assert.equal(await context.originals.head(keys.originalKey), null);
      assert.equal(await context.derivatives.head(keys.derivativeKey), null);
      assert.ok(await context.backups.head(`backup/${fixture.evidenceId}`));
      assert.deepEqual(
        await context.database
          .prepare("SELECT state, derivative_key FROM evidence_assets WHERE id = ?")
          .bind(fixture.evidenceId)
          .first(),
        { state: "deleted", derivative_key: null },
      );
      assert.ok(
        await context.database
          .prepare("SELECT id FROM audit_logs WHERE report_id = ? AND action = 'evidence.deleted'")
          .bind(fixture.caseId)
          .first(),
      );
      assert.ok(
        await context.database
          .prepare("SELECT id FROM audit_logs WHERE action = ? AND detail = ?")
          .bind(fixture.auditAction, fixture.caseId)
          .first(),
      );
    }
  } finally {
    await context.runtime.dispose();
  }
});
