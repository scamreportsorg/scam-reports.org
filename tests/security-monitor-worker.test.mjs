import assert from "node:assert/strict";
import test from "node:test";
import { createTestRuntime, insertAccountFixture } from "./helpers/runtime.mjs";

test("rejected requests never persist attacker data", async (t) => {
  const { runtime, database } = await createTestRuntime({
    bindings: {
      SECURITY_MONITOR_ENABLED: "true",
      INTAKE_PEPPER: "worker-security-monitor-pepper-with-at-least-32-bytes",
    },
  });
  t.after(() => runtime.dispose());
  const member = await insertAccountFixture(database, {
    id: "security-monitor-member",
    handle: "SecurityMonitorMember",
  });
  for (let index = 0; index < 10; index += 1) {
    const response = await runtime.dispatchFetch(
      "http://localhost/api/reviews?private=must-not-be-stored",
      {
        method: "POST",
        headers: {
          "cf-connecting-ip": "203.0.113.91",
          cookie: member.cookie,
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          reportId: "SR-SECURITY-MONITOR",
          body: "not persisted by the monitor",
          csrfToken: "test-csrf-token-placeholder",
        }),
      },
    );
    assert.equal(response.status, 403);
  }

  assert.equal(
    await database.prepare("SELECT COUNT(*) AS count FROM security_incidents").first("count"),
    0,
  );
});
