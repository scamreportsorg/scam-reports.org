import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";
import { createTestRuntime, projectRoot } from "./helpers/runtime.mjs";

let rollbackUncommittedEvidenceAssets;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "error",
    root: projectRoot,
    plugins: [
      {
        name: "test-cloudflare-workers",
        resolveId(id) {
          return id === "cloudflare:workers" ? "\0test-cloudflare-workers" : null;
        },
        load(id) {
          return id === "\0test-cloudflare-workers" ? "export const env = {};" : null;
        },
      },
    ],
    server: { middlewareMode: true, hmr: { port: 0 } },
  });
  ({ rollbackUncommittedEvidenceAssets } = await vite.ssrLoadModule("/lib/evidence.ts"));
});

after(async () => vite?.close());

async function insertUncommittedAsset(context, { evidenceId, intakeId, objectId }) {
  const createdBy = `intake:${intakeId}`;
  const originalKey = `originals/${objectId}`;
  const derivativeKey = `derivatives/${objectId}.webp`;
  const backupKey = `evidence-originals/${objectId}`;
  const now = "2026-08-12T12:00:00.000Z";
  await context.database
    .prepare(
      `INSERT INTO evidence_assets (
        id, intake_id, intake_kind, state, original_key, derivative_key,
        original_filename, original_content_type, original_size, original_sha256,
        derivative_content_type, derivative_size, derivative_sha256,
        source_width, source_height, width, height, visible_pii_reviewed,
        privacy_withheld, legal_hold, processing_error, created_by, created_at, updated_at
      ) VALUES (?, ?, 'report_submission', 'private_ready', ?, ?, 'fixture.png',
        'image/png', 8, 'original-sha', 'image/webp', 8, 'derivative-sha',
        1, 1, 1, 1, 0, 0, 0, '', ?, ?, ?)`,
    )
    .bind(evidenceId, intakeId, originalKey, derivativeKey, createdBy, now, now)
    .run();
  await context.database
    .prepare(
      `INSERT INTO audit_logs (report_id, action, actor, created_at, detail)
       VALUES (?, 'evidence.uploaded', ?, ?, ?)`,
    )
    .bind(intakeId, createdBy, now, JSON.stringify({ evidenceId }))
    .run();
  await Promise.all([
    context.originals.put(originalKey, Uint8Array.of(1)),
    context.derivatives.put(derivativeKey, Uint8Array.of(2)),
    context.backups.put(backupKey, Uint8Array.of(3)),
  ]);
  return { createdBy, originalKey, derivativeKey, backupKey };
}

function dependencies(context) {
  return {
    database: context.database,
    storage: {
      originals: context.originals,
      derivatives: context.derivatives,
      backups: context.backups,
    },
  };
}

test("evidence rollback is idempotent", async (t) => {
  const context = await createTestRuntime();
  t.after(() => context.runtime.dispose());
  const evidenceId = "EVA-11111111-1111-4111-8111-111111111111";
  const intakeId = "SUB-2026-DEADBEEF";
  const keys = await insertUncommittedAsset(context, {
    evidenceId,
    intakeId,
    objectId: "11111111-1111-4111-8111-111111111111",
  });
  const options = { evidenceIds: [evidenceId], intakeId, createdBy: keys.createdBy };

  await rollbackUncommittedEvidenceAssets(options, dependencies(context));
  await rollbackUncommittedEvidenceAssets(options, dependencies(context));

  assert.equal(
    await context.database
      .prepare("SELECT COUNT(*) FROM evidence_assets WHERE id = ?")
      .bind(evidenceId)
      .first("COUNT(*)"),
    0,
  );
  assert.equal(
    await context.database
      .prepare("SELECT COUNT(*) FROM audit_logs WHERE report_id = ?")
      .bind(intakeId)
      .first("COUNT(*)"),
    0,
  );
  assert.equal(await context.originals.head(keys.originalKey), null);
  assert.equal(await context.derivatives.head(keys.derivativeKey), null);
  assert.equal(await context.backups.head(keys.backupKey), null);
});

test("evidence rollback rejects a foreign owner", async (t) => {
  const context = await createTestRuntime();
  t.after(() => context.runtime.dispose());
  const evidenceId = "EVA-22222222-2222-4222-8222-222222222222";
  const foreignIntakeId = "SUB-2026-CAFEBABE";
  const keys = await insertUncommittedAsset(context, {
    evidenceId,
    intakeId: foreignIntakeId,
    objectId: "22222222-2222-4222-8222-222222222222",
  });

  await assert.rejects(
    rollbackUncommittedEvidenceAssets(
      {
        evidenceIds: [evidenceId],
        intakeId: "SUB-2026-DEADBEEF",
        createdBy: "intake:SUB-2026-DEADBEEF",
      },
      dependencies(context),
    ),
    (error) => error?.code === "rollback_owner_invalid",
  );
  assert.ok(
    await context.database
      .prepare("SELECT id FROM evidence_assets WHERE id = ?")
      .bind(evidenceId)
      .first(),
  );
  assert.ok(await context.originals.head(keys.originalKey));
  assert.ok(await context.derivatives.head(keys.derivativeKey));
  assert.ok(await context.backups.head(keys.backupKey));
});
