import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";

let allocateUniqueIntakeId;
let vite;

before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 0 } },
    appType: "custom",
  });
  ({ allocateUniqueIntakeId } = await vite.ssrLoadModule("/lib/intake-identifiers.ts"));
});

after(async () => vite?.close());

test("intake IDs retry collisions", async () => {
  const candidates = ["SUB-2026-11111111", "SUB-2026-22222222", "SUB-2026-33333333"];
  const checked = [];
  const prefixes = [];

  const result = await allocateUniqueIntakeId(
    "SUB",
    async (id) => {
      checked.push(id);
      return id !== "SUB-2026-33333333";
    },
    (prefix) => {
      prefixes.push(prefix);
      return candidates.shift();
    },
  );

  assert.equal(result, "SUB-2026-33333333");
  assert.deepEqual(checked, ["SUB-2026-11111111", "SUB-2026-22222222", "SUB-2026-33333333"]);
  assert.deepEqual(prefixes, ["SUB", "SUB", "SUB"]);
});

test("intake IDs stop after eight collisions", async () => {
  let probes = 0;
  let generated = 0;

  await assert.rejects(
    allocateUniqueIntakeId(
      "APL",
      async () => {
        probes += 1;
        return true;
      },
      () => `APL-2026-${String(++generated).padStart(8, "0")}`,
    ),
    /Unable to allocate an intake identifier\./u,
  );
  assert.equal(probes, 8);
  assert.equal(generated, 8);
});
