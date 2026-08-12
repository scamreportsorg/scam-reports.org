import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createTestRuntime } from "./helpers/runtime.mjs";

let runtime;

before(async () => {
  ({ runtime } = await createTestRuntime());
});

after(async () => runtime?.dispose());

test("empty statistics omit a fake refresh time", async () => {
  const response = await runtime.dispatchFetch("http://localhost/statistics", {
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /Current public totals/u);
  assert.match(html, /No reports have been published yet\./u);
  assert.doesNotMatch(html, /Most viewed|public records have views|<th>Views<\/th>/u);
  assert.doesNotMatch(html, /Last recalculated/iu);
  assert.doesNotMatch(html, /<th>Position<\/th>/u);
});
