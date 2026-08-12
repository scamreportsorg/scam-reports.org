import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createTestRuntime } from "./helpers/runtime.mjs";

let runtime;
let database;

before(async () => {
  ({ runtime, database } = await createTestRuntime());
});

after(async () => runtime?.dispose());

test("page failures render the local error boundary", async () => {
  await database
    .prepare("DELETE FROM d1_migrations WHERE name = '0021_magic_login_browser_context.sql'")
    .run();

  const response = await runtime.dispatchFetch("http://localhost/", {
    headers: { accept: "text/html" },
  });

  const html = await response.text();
  assert.match(html, /This page did[^<]*t load/u);
  assert.match(html, /Try again/u);
  assert.match(html, /Back to the archive/u);
  assert.doesNotMatch(html, /0021_magic_login_browser_context|D1 schema is outdated/u);
});
