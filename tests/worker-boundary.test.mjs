import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createTestRuntime } from "./helpers/runtime.mjs";

const configuredStagingValue = ["alpha7", "bravo9", "charlie2", "delta5", "echo8"].join("-");
const rejectedStagingValues = [
  "replace-with-random-staging-token",
  "test-staging-access-token-000000000000000000000000",
  "fixture-staging-access-token-placeholder-32-bytes",
  "long-placeholder-value-for-private-staging-access",
];
let staging;
let production;

before(async () => {
  staging = await createTestRuntime({
    bindings: {
      ENVIRONMENT: "staging",
      STAGING_ACCESS_TOKEN: configuredStagingValue,
    },
  });
  production = await createTestRuntime({
    bindings: { ENVIRONMENT: "production" },
    migrate: false,
  });
});

after(async () => {
  await staging?.runtime.dispose();
  await production?.runtime.dispose();
});

test("private staging uses a secure same-origin cookie", async () => {
  const anonymous = await staging.runtime.dispatchFetch("http://localhost/");
  assert.equal(anonymous.status, 401);
  assert.match(await anonymous.text(), /Private staging/u);

  const crossOrigin = await staging.runtime.dispatchFetch("http://localhost/__staging/access", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://attacker.invalid",
    },
    body: new URLSearchParams({ token: configuredStagingValue }).toString(),
    redirect: "manual",
  });
  assert.equal(crossOrigin.status, 403);

  const oversized = await staging.runtime.dispatchFetch("http://localhost/__staging/access", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://localhost",
    },
    body: new URLSearchParams({
      token: configuredStagingValue,
      padding: "x".repeat(5 * 1024),
    }).toString(),
    redirect: "manual",
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.get("set-cookie"), null);

  const accepted = await staging.runtime.dispatchFetch("http://localhost/__staging/access", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://localhost",
    },
    body: new URLSearchParams({ token: configuredStagingValue }).toString(),
    redirect: "manual",
  });
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/");
  const setCookie = accepted.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^__Host-sr_staging=[^;]+;/u);
  assert.match(setCookie, /; Secure;/u);
  assert.match(setCookie, /; HttpOnly;/u);
  assert.match(setCookie, /; SameSite=Lax/u);
  assert.doesNotMatch(setCookie, new RegExp(configuredStagingValue, "u"));

  const authorized = await staging.runtime.dispatchFetch("http://localhost/api/version", {
    headers: { cookie: setCookie.split(";")[0] },
  });
  assert.equal(authorized.status, 200);

  const automated = await staging.runtime.dispatchFetch("http://localhost/api/version", {
    headers: { authorization: `Bearer ${configuredStagingValue}` },
  });
  assert.equal(automated.status, 200);
});

test("private staging rejects fake credentials", async () => {
  for (const candidateCredential of rejectedStagingValues) {
    assert.ok(candidateCredential.length >= 32, candidateCredential);
    const candidate = await createTestRuntime({
      bindings: {
        ENVIRONMENT: "staging",
        STAGING_ACCESS_TOKEN: candidateCredential,
      },
      migrate: false,
    });
    try {
      const gated = await candidate.runtime.dispatchFetch("http://localhost/");
      assert.equal(gated.status, 503, candidateCredential);
      assert.equal(await gated.text(), "Private staging is not configured.", candidateCredential);

      const access = await candidate.runtime.dispatchFetch("http://localhost/__staging/access", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost",
        },
        body: new URLSearchParams({ token: candidateCredential }).toString(),
        redirect: "manual",
      });
      assert.equal(access.status, 503, candidateCredential);
      assert.equal(access.headers.get("set-cookie"), null, candidateCredential);
    } finally {
      await candidate.runtime.dispose();
    }
  }
});

test("www redirects to the production origin", async () => {
  const response = await production.runtime.dispatchFetch(
    "https://www.scam-reports.org/reports/SR-TEST?q=one",
    { redirect: "manual" },
  );
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://scam-reports.org/reports/SR-TEST?q=one");
  assert.equal(
    response.headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains; preload",
  );
});

test("production redirects HTTP before app routing", async () => {
  for (const [source, destination, method] of [
    ["http://scam-reports.org/rules?from=http", "https://scam-reports.org/rules?from=http", "GET"],
    ["http://www.scam-reports.org/appeals", "https://scam-reports.org/appeals", "POST"],
    [
      "http://attacker.invalid/account?next=%2Fadmin",
      "https://scam-reports.org/account?next=%2Fadmin",
      "GET",
    ],
  ]) {
    const response = await production.runtime.dispatchFetch(source, {
      method,
      redirect: "manual",
    });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("location"), destination);
  }

  const canonical = await production.runtime.dispatchFetch("https://scam-reports.org/robots.txt", {
    redirect: "manual",
  });
  assert.equal(canonical.status, 200);
  assert.equal(canonical.headers.get("location"), null);
});

test("redirect paths cannot replace the origin", async () => {
  for (const source of [
    "http://scam-reports.org//attacker.invalid/phish?from=redirect",
    "http://scam-reports.org/%2F%2Fattacker.invalid/phish",
    "http://scam-reports.org//user@attacker.invalid/phish",
    "http://scam-reports.org/%5C%5Cattacker.invalid/phish",
  ]) {
    const response = await production.runtime.dispatchFetch(source, { redirect: "manual" });
    assert.equal(response.status, 308, source);
    const location = new URL(response.headers.get("location"));
    assert.equal(location.origin, "https://scam-reports.org", source);
  }
});

test("unused image routes return 404", async () => {
  for (const pathname of ["/_next/image", "/_next/image/", "/_vinext/image/"]) {
    const response = await production.runtime.dispatchFetch(
      `https://scam-reports.org${pathname}?url=%2Fbrand%2Fsr-mark.png&w=640&q=75`,
    );
    assert.equal(response.status, 404, pathname);
    assert.equal(response.headers.get("cache-control"), "no-store", pathname);
  }
});
