import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createHash } from "node:crypto";

export type BackupParams = { kind: "weekly" | "monthly"; requestedAt: string };

export type BackupWorkflowEnv = {
  DB: D1Database;
  BACKUPS: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_D1_DATABASE_ID?: string;
  CLOUDFLARE_BACKUP_API_TOKEN?: string;
  ENVIRONMENT?: string;
};

type ExportState = {
  bookmark?: string;
  status?: string;
  error?: string;
  signedUrl?: string;
  filename?: string;
};

function requireBinding(value: string | undefined, name: string) {
  if (!value || value.startsWith("replace-with")) throw new Error(`${name} is unavailable.`);
  return value;
}

function parseRequestedAt(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid backup timestamp.");
  return date;
}

const MAX_BACKUP_BYTES = 1024 * 1024 * 1024;
const MULTIPART_BYTES = 8 * 1024 * 1024;

async function streamBackupToR2(options: {
  bucket: R2Bucket;
  response: Response;
  key: string;
  runId: string;
  bookmark: string;
}) {
  const { bucket, response, key, runId, bookmark } = options;
  if (!response.body) throw new Error("D1 export download returned no body.");
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BACKUP_BYTES) {
    throw new Error("D1 export exceeds the 1 GiB workflow safety limit.");
  }
  const upload = await bucket.createMultipartUpload(key, {
    httpMetadata: { contentType: "application/sql" },
    customMetadata: { runId, bookmark },
  });
  const uploadedParts: R2UploadedPart[] = [];
  const hash = createHash("sha256");
  const reader = response.body.getReader();
  let part = new Uint8Array(MULTIPART_BYTES);
  let partLength = 0;
  let size = 0;
  let completed = false;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value;
      size += chunk.byteLength;
      if (size > MAX_BACKUP_BYTES)
        throw new Error("D1 export exceeds the 1 GiB workflow safety limit.");
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const copied = Math.min(part.byteLength - partLength, chunk.byteLength - offset);
        part.set(chunk.subarray(offset, offset + copied), partLength);
        partLength += copied;
        offset += copied;
        if (partLength === part.byteLength) {
          uploadedParts.push(await upload.uploadPart(uploadedParts.length + 1, part));
          part = new Uint8Array(MULTIPART_BYTES);
          partLength = 0;
        }
      }
    }
    if (partLength) {
      uploadedParts.push(
        await upload.uploadPart(uploadedParts.length + 1, part.subarray(0, partLength)),
      );
    }
    if (!uploadedParts.length) throw new Error("D1 export download was empty.");
    await upload.complete(uploadedParts);
    completed = true;
  } finally {
    if (!completed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
    if (!completed) await upload.abort().catch(() => undefined);
  }
  return { sha256: hash.digest("hex"), size };
}

export class D1BackupWorkflow extends WorkflowEntrypoint<BackupWorkflowEnv, BackupParams> {
  async exportRequest(bookmark?: string): Promise<ExportState> {
    const accountId = requireBinding(this.env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID");
    const databaseId = requireBinding(
      this.env.CLOUDFLARE_D1_DATABASE_ID,
      "CLOUDFLARE_D1_DATABASE_ID",
    );
    const token = requireBinding(
      this.env.CLOUDFLARE_BACKUP_API_TOKEN,
      "CLOUDFLARE_BACKUP_API_TOKEN",
    );
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/export`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          output_format: "polling",
          ...(bookmark ? { current_bookmark: bookmark } : {}),
        }),
      },
    );
    if (!response.ok) throw new Error(`D1 export API returned HTTP ${response.status}.`);
    const payload = (await response.json()) as {
      success?: boolean;
      result?: {
        at_bookmark?: string;
        status?: string;
        error?: string;
        result?: { signed_url?: string; filename?: string };
      };
    };
    if (!payload.success || !payload.result)
      throw new Error("D1 export API returned an invalid response.");
    return {
      bookmark: payload.result.at_bookmark,
      status: payload.result.status,
      error: payload.result.error,
      signedUrl: payload.result.result?.signed_url,
      filename: payload.result.result?.filename,
    };
  }

  async run(event: Readonly<WorkflowEvent<BackupParams>>, step: WorkflowStep) {
    const requestedAt = parseRequestedAt(event.payload.requestedAt);
    const runId = `BKP-${requestedAt.toISOString().replace(/[-:.TZ]/gu, "")}-${event.instanceId.slice(-8)}`;
    await step.do("record backup start", async () => {
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO backup_runs
        (id, kind, status, error, started_at) VALUES (?, ?, 'running', '', ?)`,
      )
        .bind(runId, event.payload.kind, requestedAt.toISOString())
        .run();
      return { runId };
    });

    try {
      // Workflow step names are replay keys. Do not rename them.
      let state = await step.do(
        "start D1 export",
        {
          retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
          sensitive: "output",
        },
        () => this.exportRequest(),
      );
      for (let attempt = 0; attempt < 30 && state.status !== "complete"; attempt += 1) {
        if (state.status === "error") throw new Error(state.error || "D1 export failed.");
        if (!state.bookmark) throw new Error("D1 export polling bookmark is missing.");
        await step.sleep(`wait for D1 export ${attempt + 1}`, "10 seconds");
        const bookmark = state.bookmark;
        state = await step.do(
          `poll D1 export ${attempt + 1}`,
          {
            retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
            sensitive: "output",
          },
          () => this.exportRequest(bookmark),
        );
      }
      if (state.status !== "complete" || !state.signedUrl)
        throw new Error("D1 export did not complete in time.");

      const stored = await step.do(
        "store encrypted-boundary D1 export",
        {
          retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
          sensitive: "output",
        },
        async () => {
          const response = await fetch(state.signedUrl!);
          if (!response.ok) throw new Error(`D1 export download returned HTTP ${response.status}.`);
          const date = requestedAt.toISOString().slice(0, 10);
          const key = `d1/${event.payload.kind}/${date}-${runId}.sql`;
          const streamed = await streamBackupToR2({
            bucket: this.env.BACKUPS,
            response,
            key,
            runId,
            bookmark: state.bookmark ?? "",
          });
          const manifest = {
            schema: "scam-reports.r2-d1-backup/v1",
            environment: this.env.ENVIRONMENT ?? "unknown",
            databaseId: requireBinding(
              this.env.CLOUDFLARE_D1_DATABASE_ID,
              "CLOUDFLARE_D1_DATABASE_ID",
            ),
            kind: event.payload.kind,
            key,
            createdAt: requestedAt.toISOString(),
            runId,
            bookmark: state.bookmark ?? "",
            sha256: streamed.sha256,
            size: streamed.size,
          };
          await this.env.BACKUPS.put(`${key}.manifest.json`, `${JSON.stringify(manifest)}\n`, {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { runId, sha256: streamed.sha256 },
          });
          return {
            key,
            sha256: streamed.sha256,
            size: streamed.size,
            bookmark: state.bookmark ?? "",
          };
        },
      );

      await step.do("record backup completion", async () => {
        await this.env.DB.prepare(
          `UPDATE backup_runs SET status = 'complete', object_key = ?,
          sha256 = ?, size = ?, bookmark = ?, completed_at = ? WHERE id = ?`,
        )
          .bind(
            stored.key,
            stored.sha256,
            stored.size,
            stored.bookmark,
            new Date().toISOString(),
            runId,
          )
          .run();
        return { complete: true };
      });
      await step.do("enforce D1 backup retention", () => enforceBackupRetention(this.env.BACKUPS));
      return stored;
    } catch (error) {
      const message = (error instanceof Error ? error.message : "Backup failed.").slice(0, 500);
      await step.do("record backup failure", async () => {
        await this.env.DB.prepare(
          `UPDATE backup_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
        )
          .bind(message, new Date().toISOString(), runId)
          .run();
        return { failed: true };
      });
      throw error;
    }
  }
}

async function trimBackups(bucket: R2Bucket, prefix: string, keep: number) {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const snapshots = objects.filter((item) => item.key.endsWith(".sql"));
  const stale = snapshots
    .sort((left, right) => right.uploaded.getTime() - left.uploaded.getTime())
    .slice(keep);
  for (let index = 0; index < stale.length; index += 500) {
    await bucket.delete(
      stale.slice(index, index + 500).flatMap((item) => [item.key, `${item.key}.manifest.json`]),
    );
  }
}

export async function enforceBackupRetention(bucket: R2Bucket) {
  await trimBackups(bucket, "d1/weekly/", 12);
  await trimBackups(bucket, "d1/monthly/", 12);
  return { retained: true };
}
