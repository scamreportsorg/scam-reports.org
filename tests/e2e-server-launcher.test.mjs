import assert from "node:assert/strict";
import test from "node:test";
import { shouldRetryE2eServerStart } from "../scripts/e2e-server-launcher.mjs";

test("Windows E2E launcher retries an early workerd crash", () => {
  assert.equal(
    shouldRetryE2eServerStart({
      attempt: 0,
      code: 3221226505,
      platform: "win32",
      ready: false,
    }),
    true,
  );
  assert.equal(
    shouldRetryE2eServerStart({
      attempt: 1,
      code: 3221226505,
      platform: "win32",
      ready: false,
    }),
    false,
  );
  assert.equal(
    shouldRetryE2eServerStart({
      attempt: 0,
      code: 3221226505,
      platform: "win32",
      ready: true,
    }),
    false,
  );
  assert.equal(
    shouldRetryE2eServerStart({ attempt: 0, code: 1, platform: "win32", ready: false }),
    false,
  );
  assert.equal(
    shouldRetryE2eServerStart({
      attempt: 0,
      code: 3221226505,
      platform: "linux",
      ready: false,
    }),
    false,
  );
});
