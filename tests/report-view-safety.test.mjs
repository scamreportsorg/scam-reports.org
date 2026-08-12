import assert from "node:assert/strict";
import test from "node:test";
import { createTestRuntime, insertReportFixture } from "./helpers/runtime.mjs";

test("public report reads ignore the old view metric", async (t) => {
  const { runtime, database } = await createTestRuntime();
  t.after(() => runtime.dispose());
  await insertReportFixture(database, {
    id: "SR-VIEW-SAFETY",
    username: "ViewSafetyFixture",
    views: 41,
  });

  for (let index = 0; index < 3; index += 1) {
    const response = await runtime.dispatchFetch("http://localhost/reports/SR-VIEW-SAFETY");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.doesNotMatch(html, /Recorded views|>41<|41 views/iu);
  }

  const apiResponse = await runtime.dispatchFetch("http://localhost/api/reports/SR-VIEW-SAFETY");
  assert.equal(apiResponse.status, 200);
  const payload = await apiResponse.json();
  assert.equal("views" in payload.report, false);

  assert.equal(
    await database.prepare("SELECT views FROM reports WHERE id = 'SR-VIEW-SAFETY'").first("views"),
    41,
  );
});
