import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";

let pagination;
let vite;

before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 0 } },
    appType: "custom",
  });
  pagination = await vite.ssrLoadModule("/lib/pagination.ts");
});

after(async () => vite?.close());

test("request pages clamp and truncate", () => {
  const page = (value) =>
    pagination.pageFromRequest(
      new Request(`https://example.test/items${value === null ? "" : `?page=${value}`}`),
    );

  assert.equal(page(null), 1);
  assert.equal(page("0"), 1);
  assert.equal(page("-4"), 1);
  assert.equal(page("2.9"), 2);
  assert.equal(page("nope"), 1);
});

test("strict positive integers reject decimals", () => {
  const parse = pagination.positiveInteger;

  assert.equal(parse(null, 25), 25);
  assert.equal(parse("0", 25), 25);
  assert.equal(parse("-4", 25), 25);
  assert.equal(parse("2.9", 25), 25);
  assert.equal(parse("nope", 25), 25);
  assert.equal(parse("7", 25), 7);
});
