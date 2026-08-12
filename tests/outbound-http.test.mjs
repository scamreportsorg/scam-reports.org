import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";

async function loadHelper() {
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 0 } },
    appType: "custom",
  });
  return {
    helper: await vite.ssrLoadModule("/lib/outbound-http.ts"),
    close: () => vite.close(),
  };
}

test("outbound requests pin destinations and disable redirects", async () => {
  const { helper, close } = await loadHelper();
  try {
    let request;
    const response = await helper.sendOutboundRequest(
      "/v1/resource?cursor=next",
      { method: "GET" },
      {
        origin: "https://provider.example",
        pathPrefix: "/v1/",
        timeoutMs: 100,
        fetchImpl: async (input, init) => {
          request = { input: String(input), init };
          return new Response(null, { status: 204 });
        },
      },
    );
    assert.equal(response.status, 204);
    assert.equal(request.input, "https://provider.example/v1/resource?cursor=next");
    assert.equal(request.init.redirect, "manual");
    assert.ok(request.init.signal instanceof AbortSignal);

    for (const input of [
      "https://attacker.invalid/v1/resource",
      "https://provider.example/v2/resource",
      "https://user@provider.example/v1/resource",
      "https://provider.example/v1/resource#fragment",
    ]) {
      await assert.rejects(
        helper.sendOutboundRequest(
          input,
          {},
          {
            origin: "https://provider.example",
            pathPrefix: "/v1/",
            timeoutMs: 100,
            fetchImpl: async () => {
              throw new Error("fetch must not run");
            },
          },
        ),
        (error) => error.problem === "invalid_destination",
      );
    }
  } finally {
    await close();
  }
});

test("outbound JSON parsing enforces byte limits", async () => {
  const { helper, close } = await loadHelper();
  try {
    assert.deepEqual(await helper.readJsonWithinLimit(Response.json({ ok: true }), 64), {
      ok: true,
    });
    assert.equal(
      await helper.readJsonWithinLimit(
        new Response(JSON.stringify({ private: "x".repeat(128) })),
        32,
      ),
      null,
    );
    assert.equal(await helper.readJsonWithinLimit(new Response("not-json"), 64), null);
  } finally {
    await close();
  }
});
