import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  TURNSTILE_BYPASS,
  authHeaders,
  createTestRuntime,
  dispatchForm,
  insertAccountFixture,
  insertReportFixture,
} from "./helpers/runtime.mjs";
import {
  INTAKE_MULTIPART_LIMITS,
  MultipartRequestError,
  parseBoundedMultipartFormData,
  parseBoundedMultipartFormDataAfterPreflight,
} from "../lib/bounded-multipart.ts";

let runtime;
let database;
let member;

const AGGREGATE_LIMIT = INTAKE_MULTIPART_LIMITS.maxBodyBytes;

const TEST_POLICY = {
  ...INTAKE_MULTIPART_LIMITS,
  fields: { padding: { kind: "text" } },
};

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  member = await insertAccountFixture(database, {
    id: `account_${"8".repeat(32)}`,
    handle: "BoundedMultipartMember",
    providers: ["email"],
  });
});

after(async () => runtime?.dispose());

function multipartStream(boundary, bodyBytes) {
  const prefix = new TextEncoder().encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="padding"\r\n\r\n`,
  );
  const suffix = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  let prefixSent = false;
  let suffixSent = false;
  let remaining = Math.max(0, bodyBytes - prefix.byteLength - suffix.byteLength);
  let cancelled = false;
  let chunksRead = 0;
  return {
    stream: new ReadableStream({
      type: "bytes",
      pull(controller) {
        if (!prefixSent) {
          prefixSent = true;
          chunksRead += 1;
          controller.enqueue(prefix);
          return;
        }
        if (remaining > 0) {
          const size = Math.min(64 * 1024, remaining);
          remaining -= size;
          chunksRead += 1;
          controller.enqueue(new Uint8Array(size).fill(97));
          return;
        }
        if (!suffixSent) {
          suffixSent = true;
          chunksRead += 1;
          controller.enqueue(suffix);
          return;
        }
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    }),
    state: {
      get cancelled() {
        return cancelled;
      },
      get chunksRead() {
        return chunksRead;
      },
    },
  };
}

function validReportForm(account = member) {
  const form = new FormData();
  form.set("csrfToken", account.csrf);
  form.set("cf-turnstile-response", TURNSTILE_BYPASS);
  form.set("submitterName", "Ignored member name");
  form.set("contactEmail", "bounded@example.test");
  form.set("username", "Bounded Synthetic Subject");
  form.set("discordId", "800000000000000001");
  form.set("game", "Synthetic Arena");
  form.set("category", "Cheating");
  form.set("reason", "Synthetic bounded multipart regression evidence.");
  form.set(
    "description",
    "This synthetic report verifies that normal bounded multipart submissions still work safely.",
  );
  form.set("relatedReportId", "");
  form.set("consent", "true");
  form.set("website", "");
  return form;
}

test("denied multipart preflight leaves the body unread", async () => {
  const boundary = "unread-preflight-regression";
  const { stream, state } = multipartStream(boundary, 1024);
  const request = new Request("http://localhost/api/appeals", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: stream,
    duplex: "half",
  });
  await assert.rejects(
    parseBoundedMultipartFormDataAfterPreflight(request, TEST_POLICY, async () => {
      throw new Error("preflight denied");
    }),
    /preflight denied/u,
  );
  assert.equal(request.bodyUsed, false);
  assert.equal(state.chunksRead, 0);
});

test("anonymous appeals create nothing", async () => {
  const boundary = "unread-anonymous-appeal";
  const { stream } = multipartStream(boundary, 1024);
  const beforeCount = await database.prepare("SELECT COUNT(*) FROM appeals").first("COUNT(*)");
  const response = await runtime.dispatchFetch("http://localhost/api/appeals", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "x-turnstile-token": TURNSTILE_BYPASS,
    },
    body: stream,
    duplex: "half",
  });
  assert.equal(response.status, 401, await response.clone().text());
  assert.equal(
    await database.prepare("SELECT COUNT(*) FROM appeals").first("COUNT(*)"),
    beforeCount,
  );
});

test("appeals enforce the multipart limit across chunks", async () => {
  const boundary = "bounded-appeal-regression";
  const { stream } = multipartStream(boundary, AGGREGATE_LIMIT + 64 * 1024);
  const beforeCount = await database
    .prepare("SELECT COUNT(*) AS count FROM appeals")
    .first("count");
  const response = await runtime.dispatchFetch("http://localhost/api/appeals", {
    method: "POST",
    headers: authHeaders(member, {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "x-turnstile-token": TURNSTILE_BYPASS,
    }),
    body: stream,
    duplex: "half",
  });
  assert.equal(response.status, 413, await response.clone().text());
  assert.equal(
    await database.prepare("SELECT COUNT(*) AS count FROM appeals").first("count"),
    beforeCount,
  );
});

test("upload quota counts bad multipart attempts", async () => {
  const context = await createTestRuntime();
  try {
    const account = await insertAccountFixture(context.database, {
      id: `account_${"6".repeat(32)}`,
      handle: "UploadQuotaMember",
      providers: ["email"],
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const invalid = validReportForm(account);
      invalid.set("unexpected-field", `attempt-${attempt}`);
      const response = await dispatchForm(
        context.runtime,
        "/api/report-submissions",
        invalid,
        authHeaders(account),
      );
      assert.equal(response.status, 400, await response.clone().text());
    }

    const blocked = await dispatchForm(
      context.runtime,
      "/api/report-submissions",
      validReportForm(account),
      authHeaders(account),
    );
    assert.equal(blocked.status, 429, await blocked.clone().text());
    assert.equal(
      await context.database
        .prepare("SELECT COUNT(*) FROM report_submissions WHERE account_id = ?")
        .bind(account.id)
        .first("COUNT(*)"),
      0,
    );
  } finally {
    await context.runtime.dispose();
  }
});

test("multipart limits use bytes read, not Content-Length", async () => {
  const boundary = "bounded-report-regression";
  const { stream, state } = multipartStream(boundary, AGGREGATE_LIMIT + 64 * 1024);
  const request = new Request("http://localhost/api/report-submissions", {
    method: "POST",
    headers: {
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": "1",
    },
    body: stream,
    duplex: "half",
  });
  await assert.rejects(
    parseBoundedMultipartFormData(request, TEST_POLICY),
    (error) =>
      error instanceof MultipartRequestError &&
      error.status === 413 &&
      error.code === "multipart_too_large",
  );
  assert.equal(state.cancelled, true);
});

test("intake rejects unknown multipart fields", async () => {
  const unexpected = validReportForm();
  unexpected.set("unbounded-padding", "attacker-controlled extra field");
  const rejected = await dispatchForm(
    runtime,
    "/api/report-submissions",
    unexpected,
    authHeaders(member),
  );
  assert.equal(rejected.status, 400, await rejected.clone().text());

  const forgedFile = validReportForm();
  forgedFile.set("files", "non-empty text is not a file");
  const forgedFileResponse = await dispatchForm(
    runtime,
    "/api/report-submissions",
    forgedFile,
    authHeaders(member),
  );
  assert.equal(forgedFileResponse.status, 400, await forgedFileResponse.clone().text());

  const accepted = await dispatchForm(
    runtime,
    "/api/report-submissions",
    validReportForm(),
    authHeaders(member),
  );
  assert.equal(accepted.status, 201, await accepted.clone().text());

  const browserEmptyFile = validReportForm();
  browserEmptyFile.set("files", "");
  const browserEmptyFileResponse = await dispatchForm(
    runtime,
    "/api/report-submissions",
    browserEmptyFile,
    authHeaders(member),
  );
  assert.equal(browserEmptyFileResponse.status, 201, await browserEmptyFileResponse.clone().text());
});

test("failed intake rolls back all uploaded files", async () => {
  const context = await createTestRuntime();
  try {
    await insertReportFixture(context.database, {
      id: "SR-ROLLBACK-TARGET",
      username: "RollbackTarget",
      discordId: "800000000000000031",
    });
    const account = await insertAccountFixture(context.database, {
      id: `account_${"9".repeat(32)}`,
      handle: "RollbackMember",
      providers: ["email"],
    });
    const validImage = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
    const failedForm = validReportForm(account);
    failedForm.set("username", "Rollback Failure Subject");
    failedForm.set("discordId", "800000000000000032");
    failedForm.append("files", new Blob([validImage], { type: "image/png" }), "first-valid.png");
    failedForm.append(
      "files",
      new Blob([Uint8Array.of(1, 2, 3, 4)], { type: "image/png" }),
      "second-invalid.png",
    );

    const rejected = await dispatchForm(
      context.runtime,
      "/api/report-submissions",
      failedForm,
      authHeaders(account),
    );
    assert.equal(rejected.status, 415, await rejected.clone().text());
    assert.equal(
      await context.database.prepare("SELECT COUNT(*) FROM evidence_assets").first("COUNT(*)"),
      0,
    );
    assert.equal(
      await context.database
        .prepare("SELECT COUNT(*) FROM audit_logs WHERE action = 'evidence.uploaded'")
        .first("COUNT(*)"),
      0,
    );
    assert.equal((await context.originals.list()).objects.length, 0);
    assert.equal((await context.derivatives.list()).objects.length, 0);
    assert.equal((await context.backups.list()).objects.length, 0);

    const acceptedForm = validReportForm(account);
    acceptedForm.set("username", "Rollback Success Subject");
    acceptedForm.set("discordId", "800000000000000033");
    acceptedForm.append(
      "files",
      new Blob([validImage], { type: "image/png" }),
      "committed-valid.png",
    );
    const accepted = await dispatchForm(
      context.runtime,
      "/api/report-submissions",
      acceptedForm,
      authHeaders(account),
    );
    const payload = await accepted.json();
    assert.equal(accepted.status, 201, JSON.stringify(payload));
    const committed = await context.database
      .prepare(
        `SELECT original_key, derivative_key FROM evidence_assets
         WHERE intake_id = ? AND state = 'private_ready'`,
      )
      .bind(payload.submission.id)
      .first();
    assert.ok(committed);
    assert.ok(await context.originals.head(committed.original_key));
    assert.ok(await context.derivatives.head(committed.derivative_key));
    assert.ok(
      await context.backups.head(
        `evidence-originals/${committed.original_key.slice("originals/".length)}`,
      ),
    );
  } finally {
    await context.runtime.dispose();
  }
});

test("sanitizer failure removes intake metadata", async () => {
  const context = await createTestRuntime({
    bindings: { EVIDENCE_TEST_SANITIZER: "disabled" },
  });
  try {
    const account = await insertAccountFixture(context.database, {
      id: `account_${"4".repeat(32)}`,
      handle: "SanitizerFailureMember",
      providers: ["email"],
    });
    const form = validReportForm(account);
    form.set("username", "Sanitizer Failure Subject");
    form.set("discordId", "800000000000000034");
    form.append(
      "files",
      new Blob([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)], { type: "image/png" }),
      "valid-signature.png",
    );

    const response = await dispatchForm(
      context.runtime,
      "/api/report-submissions",
      form,
      authHeaders(account),
    );
    assert.equal(response.status, 503, await response.clone().text());
    assert.equal(
      await context.database.prepare("SELECT COUNT(*) FROM evidence_assets").first("COUNT(*)"),
      0,
    );
    assert.equal(
      await context.database.prepare("SELECT COUNT(*) FROM audit_logs").first("COUNT(*)"),
      0,
    );
    assert.equal(
      await context.database.prepare("SELECT COUNT(*) FROM report_submissions").first("COUNT(*)"),
      0,
    );
    assert.equal((await context.originals.list()).objects.length, 0);
    assert.equal((await context.derivatives.list()).objects.length, 0);
    assert.equal((await context.backups.list()).objects.length, 0);
  } finally {
    await context.runtime.dispose();
  }
});
