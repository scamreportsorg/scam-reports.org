import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";

let vite;
let ImageOptimizationCoordinator;
let imageOptimizationCacheKey;
let imageOptimizationPolicy;

before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 0 } },
    appType: "custom",
  });
  ({ ImageOptimizationCoordinator, imageOptimizationCacheKey, imageOptimizationPolicy } =
    await vite.ssrLoadModule("/lib/image-optimization.ts"));
});

after(async () => vite?.close());

const allowedWidths = [32, 640];

function request(query, init = {}) {
  return new Request(`https://scam-reports.org/_vinext/image?${query}`, init);
}

test("image requests use one bounded transform key", () => {
  const first = imageOptimizationPolicy(
    request("q=75&url=%2Fbrand%2Fsr-mark.png&w=640", {
      headers: { accept: "image/avif,image/webp,*/*" },
    }),
    allowedWidths,
  );
  const reordered = imageOptimizationPolicy(
    request("w=640&q=75&url=%2Fbrand%2Fsr-mark.png", {
      headers: { accept: "image/avif,image/webp,*/*" },
    }),
    allowedWidths,
  );
  assert.equal(first.accepted, true);
  assert.equal(reordered.accepted, true);
  assert.equal(first.canonicalUrl.toString(), reordered.canonicalUrl.toString());
  assert.equal(imageOptimizationCacheKey(first).url, imageOptimizationCacheKey(reordered).url);
  assert.equal(first.format, "image/avif");

  const head = imageOptimizationPolicy(
    request("url=%2Fbrand%2Fsr-mark.png&w=32&q=75", { method: "HEAD" }),
    allowedWidths,
  );
  assert.equal(head.accepted, true);
  assert.equal(head.headOnly, true);
});

test("image policy rejects bad keys and methods early", () => {
  for (const candidate of [
    request("url=%2Fbrand%2Fsr-mark.png&w=640&q=75&dpl=random"),
    request("url=%2Fbrand%2Fsr-mark.png&w=640&q=75&q=74"),
    request("url=%2Fbrand%2Fsr-mark.png%3Fv%3Drandom&w=640&q=75"),
    request("url=%2Fbrand%2F..%2Fbrand%2Fsr-mark.png&w=640&q=75"),
    request("url=%2F%2562rand%2Fsr-mark.png&w=640&q=75"),
    request("url=%2Fbrand%2F%2Fsr-mark.png&w=640&q=75"),
    request("url=%2Fbrand%2Fsr-mark.png&w=640&q=74"),
    request("url=%2Fbrand%2Fsr-mark.png&w=641&q=75"),
  ]) {
    const policy = imageOptimizationPolicy(candidate, allowedWidths);
    assert.deepEqual(policy, {
      accepted: false,
      status: 400,
      message: "Invalid image request",
    });
  }

  assert.deepEqual(
    imageOptimizationPolicy(
      request("url=%2Fbrand%2Fsr-mark.png&w=640&q=75", { method: "POST" }),
      allowedWidths,
    ),
    { accepted: false, status: 405, message: "Method not allowed" },
  );
});

test("image coordinator caches and caps transforms", async () => {
  const stored = new Map();
  const cache = {
    async match(key) {
      return stored.get(key.url)?.clone();
    },
    async put(key, response) {
      stored.set(key.url, response.clone());
    },
  };
  const policy = imageOptimizationPolicy(
    request("url=%2Fbrand%2Fsr-mark.png&w=640&q=75"),
    allowedWidths,
  );
  const key = imageOptimizationCacheKey(policy);
  const coordinator = new ImageOptimizationCoordinator(2);
  let transforms = 0;
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const optimize = async () => {
    transforms += 1;
    await blocked;
    return new Response("optimized", { headers: { "Content-Type": "image/jpeg" } });
  };

  const first = coordinator.run(cache, key, optimize);
  const second = coordinator.run(cache, key, optimize);
  release();
  assert.deepEqual(
    await Promise.all([first.then((value) => value.text()), second.then((value) => value.text())]),
    ["optimized", "optimized"],
  );
  assert.equal(transforms, 1);
  assert.equal(await (await coordinator.run(cache, key, optimize)).text(), "optimized");
  assert.equal(transforms, 1);

  const capacity = new ImageOptimizationCoordinator(2);
  const pendingResolvers = [];
  const hold = () =>
    new Promise((resolve) => {
      pendingResolvers.push(() => resolve(new Response("ok")));
    });
  const one = capacity.run(cache, new Request("https://scam-reports.org/cache/one"), hold);
  const two = capacity.run(cache, new Request("https://scam-reports.org/cache/two"), hold);
  await assert.rejects(
    capacity.run(cache, new Request("https://scam-reports.org/cache/three"), hold),
    /image_transform_capacity_exceeded/u,
  );
  pendingResolvers.forEach((resolve) => resolve());
  await Promise.all([one, two]);
});

test("cache failure stops repeated transforms", async () => {
  const key = new Request("https://scam-reports.org/cache/failure");
  let transforms = 0;
  const optimize = async () => {
    transforms += 1;
    return new Response("optimized");
  };

  const matchFailure = new ImageOptimizationCoordinator(2);
  await assert.rejects(
    matchFailure.run(
      {
        async match() {
          throw new Error("cache unavailable");
        },
        async put() {},
      },
      key,
      optimize,
    ),
    /image_transform_capacity_exceeded/u,
  );
  assert.equal(transforms, 0);

  const putFailure = new ImageOptimizationCoordinator(2);
  const unavailableCache = {
    async match() {
      return undefined;
    },
    async put() {
      throw new Error("cache unavailable");
    },
  };
  await assert.rejects(
    putFailure.run(unavailableCache, key, optimize),
    /image_transform_capacity_exceeded/u,
  );
  await assert.rejects(
    putFailure.run(unavailableCache, key, optimize),
    /image_transform_capacity_exceeded/u,
  );
  assert.equal(transforms, 1);
});
