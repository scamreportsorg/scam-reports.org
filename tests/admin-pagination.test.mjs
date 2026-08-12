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
let moderator;

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  moderator = await insertAccountFixture(database, {
    id: `account_${"a".repeat(32)}`,
    handle: "PaginationModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  await insertReportFixture(database, {
    id: "SR-PAGE-CLAMP",
    username: "PageClampFixture",
    discordId: "100000000000009904",
  });
  const now = "2026-08-09T00:00:00.000Z";
  for (let index = 1; index <= 26; index += 1) {
    await database
      .prepare(
        `INSERT INTO comments (
      id, report_id, parent_id, display_name, body, status, moderator_notes,
      author_fingerprint, reviewer_verified, created_at, updated_at
    ) VALUES (?, 'SR-PAGE-CLAMP', NULL, ?, 'Synthetic pagination comment.',
      'Pending', '', ?, 0, ?, ?)`,
      )
      .bind(
        `COM-PAGE-${String(index).padStart(4, "0")}`,
        `Pagination User ${index}`,
        `pagination-fingerprint-${index}`,
        now,
        now,
      )
      .run();
  }
});

after(async () => runtime?.dispose());

test("admin queues clamp page numbers", async () => {
  const queues = [
    ["/api/admin/reports?page=9999", "items"],
    ["/api/admin/reviews?page=9999", "reviews"],
    ["/api/admin/comments?page=9999", "comments"],
    ["/api/admin/report-submissions?page=9999", "submissions"],
    ["/api/admin/appeals?page=9999", "appeals"],
    ["/api/admin/evidence?page=9999", "items"],
  ];

  for (const [pathname, collection] of queues) {
    const response = await runtime.dispatchFetch(`http://localhost${pathname}`, {
      headers: authHeaders(moderator),
    });
    assert.equal(response.status, 200, `${pathname}: ${await response.clone().text()}`);
    const payload = await response.json();
    assert.ok(Array.isArray(payload[collection]), pathname);
    assert.ok(payload.pagination.totalPages >= 1, pathname);
    assert.equal(payload.pagination.page, payload.pagination.totalPages, pathname);
  }
});

test("empty last pages fall back one page", async () => {
  const before = await runtime.dispatchFetch("http://localhost/api/admin/comments?page=2", {
    headers: authHeaders(moderator),
  });
  assert.equal(before.status, 200);
  const beforePayload = await before.json();
  assert.equal(beforePayload.pagination.page, 2);
  assert.equal(beforePayload.comments.length, 1);

  await database.prepare("DELETE FROM comments WHERE id = 'COM-PAGE-0001'").run();

  const afterResponse = await runtime.dispatchFetch("http://localhost/api/admin/comments?page=2", {
    headers: authHeaders(moderator),
  });
  assert.equal(afterResponse.status, 200);
  const afterPayload = await afterResponse.json();
  assert.deepEqual(afterPayload.pagination, {
    page: 1,
    pageSize: 25,
    totalItems: 25,
    totalPages: 1,
  });
  assert.equal(afterPayload.comments.length, 25);
});
