import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";
import { createTestRuntime } from "./helpers/runtime.mjs";

const PEPPER = "security-monitor-test-pepper-with-more-than-32-bytes";
const BOT_TOKEN = "test-discord-security-monitor-bot-token-placeholder";
const CHANNEL_ID = "990000000000000101";
const MESSAGE_ID = "990000000000000102";
const ROTATED_CHANNEL_ID = "990000000000000103";
const ZONE_ID = "a".repeat(32);
const WAF_TOKEN = "test-cloudflare-read-only-analytics-token-placeholder";
const ATTACKER_IP = "203.0.113.77";

let vite;
let database;
let runtime;
let buildSecurityMonitorPayload;
let ingestCloudflareSecurityEvents;
let listActiveSecurityIncidents;
let normalizeSecurityEndpoint;
let purgeExpiredSecurityEvents;
let runDiscordSecurityMonitor;

before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 0 } },
    appType: "custom",
  });
  ({
    ingestCloudflareSecurityEvents,
    listActiveSecurityIncidents,
    normalizeSecurityEndpoint,
    purgeExpiredSecurityEvents,
  } = await vite.ssrLoadModule("/lib/security-events.ts"));
  ({ buildSecurityMonitorPayload, runDiscordSecurityMonitor } = await vite.ssrLoadModule(
    "/lib/discord-security-monitor.ts",
  ));
  ({ runtime, database } = await createTestRuntime());
});

after(async () => {
  await runtime?.dispose();
  await vite?.close();
});

function environment(extra = {}) {
  return {
    SECURITY_MONITOR_ENABLED: "true",
    DISCORD_BOT_TOKEN: BOT_TOKEN,
    DISCORD_SECURITY_CHANNEL_ID: CHANNEL_ID,
    INTAKE_PEPPER: PEPPER,
    ...extra,
  };
}

test("endpoint templates strip queries and IDs", () => {
  assert.equal(
    normalizeSecurityEndpoint("/api/reports/1234567890123456?secret=yes"),
    "/api/reports/:id",
  );
  assert.equal(normalizeSecurityEndpoint("/%3Cscript%3E/hello`world"), "/page");
});

test("WAF polling is bounded, private, and read-only", async () => {
  const now = new Date("2026-08-11T11:00:00.000Z");
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input: String(input), init });
    const payload = JSON.parse(init.body);
    assert.equal(input, "https://api.cloudflare.com/client/v4/graphql");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers.Authorization, `Bearer ${WAF_TOKEN}`);
    assert.doesNotMatch(payload.query, /userAgent|clientRequestQuery/iu);
    assert.equal(payload.variables.zoneTag, ZONE_ID);
    return Response.json({
      data: {
        viewer: {
          zones: [
            {
              firewallEventsAdaptive: [0, 1, 2].map((offset) => ({
                action: "block",
                clientAsn: "64513",
                clientCountryName: "AT",
                clientIP: ATTACKER_IP,
                clientRequestPath: "/api/auth/magic/request?email=hidden@example.invalid",
                datetime: new Date(now.getTime() - offset * 1_000).toISOString(),
                source: "waf",
              })),
            },
          ],
        },
      },
      errors: null,
    });
  };
  const bindings = environment({
    CLOUDFLARE_ZONE_ID: ZONE_ID,
    CLOUDFLARE_SECURITY_API_TOKEN: WAF_TOKEN,
  });
  const first = await ingestCloudflareSecurityEvents(database, bindings, { fetchImpl, now });
  const second = await ingestCloudflareSecurityEvents(database, bindings, { fetchImpl, now });
  assert.deepEqual(first, { state: "operational", errorCode: "", observations: 3 });
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);

  const incident = await database
    .prepare("SELECT * FROM security_incidents WHERE source = 'cloudflare'")
    .first();
  assert.equal(incident.event_count, 3);
  assert.equal(incident.endpoint, "/api/auth/magic/request");
  assert.equal(incident.country, "AT");
  assert.equal(incident.asn, 64513);
  const stored = JSON.stringify(
    (await database.prepare("SELECT * FROM security_observations").all()).results,
  );
  assert.doesNotMatch(stored, /203\.0\.113\.77|hidden@example\.invalid/iu);
});

test("attack embed contains aggregates only", async () => {
  const incidents = await listActiveSecurityIncidents(
    database,
    new Date("2026-08-11T11:01:00.000Z"),
  );
  const payload = buildSecurityMonitorPayload(
    incidents.map((incident) => ({
      ...incident,
      rawIp: ATTACKER_IP,
      requestBody: ["password", "test-redaction-password-placeholder"].join("="),
      accountId: "account-private-id",
    })),
    { state: "operational", errorCode: "", observations: 3 },
    "2026-08-11T11:01:00.000Z",
  );
  const serialized = JSON.stringify(payload);
  assert.equal(payload.content, "");
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.equal(payload.embeds.length, 1);
  assert.match(serialized, /Attack activity detected|Attack monitor/u);
  assert.match(serialized, /anon-[A-F0-9]{12}/u);
  assert.doesNotMatch(
    serialized,
    /203\.0\.113\.77|password=test-redaction-password-placeholder|account-private-id/iu,
  );
});

test("attack embed is not green without WAF data", () => {
  const notConfigured = buildSecurityMonitorPayload(
    [],
    { state: "not_configured", errorCode: "", observations: 0 },
    "2026-08-11T11:01:00.000Z",
  ).embeds[0];
  assert.match(notConfigured.title, /not configured/u);
  assert.match(notConfigured.description, /cannot be determined/u);
  assert.match(JSON.stringify(notConfigured.fields), /Not configured/u);
  assert.notEqual(notConfigured.color, 0x57f287);
  assert.doesNotMatch(notConfigured.description, /No active attack pattern/u);

  const failed = buildSecurityMonitorPayload(
    [],
    { state: "failed", errorCode: "network_connection_lost", observations: 0 },
    "2026-08-11T11:02:00.000Z",
  ).embeds[0];
  assert.match(failed.title, /unavailable/u);
  assert.match(failed.description, /cannot be determined/u);
  assert.equal(failed.color, 0xfee75c);
  assert.doesNotMatch(failed.description, /No active attack pattern/u);
});

test("attack monitor edits one configured message", async () => {
  const now = new Date("2026-08-11T11:02:00.000Z");
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url: url.toString(), init });
    assert.equal(init.headers.Authorization, `Bot ${BOT_TOKEN}`);
    assert.equal(url.origin, "https://discord.com");
    assert.equal(url.pathname.startsWith(`/api/v10/channels/${CHANNEL_ID}/messages`), true);
    const body = JSON.parse(init.body);
    assert.deepEqual(body.allowed_mentions, { parse: [] });
    return Response.json({ id: MESSAGE_ID, channel_id: CHANNEL_ID });
  };

  const first = await runDiscordSecurityMonitor(database, environment(), { fetchImpl, now });
  const second = await runDiscordSecurityMonitor(database, environment(), {
    fetchImpl,
    now: new Date(now.getTime() + 60_000),
  });
  assert.equal(first.state, "updated");
  assert.equal(second.state, "updated");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[1].init.method, "PATCH");
  assert.equal(requests[1].url.endsWith(`/messages/${MESSAGE_ID}`), true);

  const state = await database.prepare("SELECT * FROM security_monitor_state").first();
  assert.equal(state.message_id, MESSAGE_ID);
  assert.equal(state.delivery_state, "active");
  assert.equal(state.last_delivery_error_code, "");
  assert.doesNotMatch(JSON.stringify(requests), /203\.0\.113\.77|cloudflare-read-only/iu);
});

test("Discord rejection opens the monitor circuit", async () => {
  await database.prepare("DELETE FROM security_monitor_state").run();
  let calls = 0;
  const rejected = async () => {
    calls += 1;
    return new Response(null, { status: 403 });
  };
  const first = await runDiscordSecurityMonitor(database, environment(), {
    fetchImpl: rejected,
    now: new Date("2026-08-11T12:00:00.000Z"),
  });
  const second = await runDiscordSecurityMonitor(database, environment(), {
    fetchImpl: rejected,
    now: new Date("2026-08-11T12:01:00.000Z"),
  });
  assert.equal(first.state, "delivery_disabled");
  assert.equal(second.state, "delivery_disabled");
  assert.equal(calls, 1);
  assert.equal(
    (await database.prepare("SELECT last_delivery_error_code FROM security_monitor_state").first())
      .last_delivery_error_code,
    "discord_permission_rejected",
  );

  const rotated = environment({
    DISCORD_SECURITY_CHANNEL_ID: ROTATED_CHANNEL_ID,
  });
  const recovered = await runDiscordSecurityMonitor(database, rotated, {
    fetchImpl: async () => {
      calls += 1;
      return Response.json({ id: MESSAGE_ID, channel_id: ROTATED_CHANNEL_ID });
    },
    now: new Date("2026-08-11T12:02:00.000Z"),
  });
  assert.equal(recovered.state, "updated");
  assert.equal(calls, 2);
  assert.equal(
    (await database.prepare("SELECT last_delivery_error_code FROM security_monitor_state").first())
      .last_delivery_error_code,
    "",
  );
});

test("WAF failures store a fixed error code", async () => {
  const result = await ingestCloudflareSecurityEvents(
    database,
    environment({
      CLOUDFLARE_SECURITY_API_TOKEN: WAF_TOKEN,
      CLOUDFLARE_ZONE_ID: ZONE_ID,
    }),
    {
      fetchImpl: async () => {
        throw new TypeError("Network connection lost.");
      },
      now: new Date("2026-08-11T12:10:00.000Z"),
    },
  );
  assert.deepEqual(result, {
    state: "failed",
    errorCode: "waf_network_connection_lost",
    observations: 0,
  });
});

test("GraphQL errors map to fixed codes", async () => {
  const result = await ingestCloudflareSecurityEvents(
    database,
    environment({
      CLOUDFLARE_SECURITY_API_TOKEN: WAF_TOKEN,
      CLOUDFLARE_ZONE_ID: ZONE_ID,
    }),
    {
      fetchImpl: async () =>
        Response.json({
          data: null,
          errors: [{ message: "zones are not authorized: private provider detail" }],
        }),
      now: new Date("2026-08-11T12:11:00.000Z"),
    },
  );
  assert.deepEqual(result, {
    state: "failed",
    errorCode: "waf_auth_rejected",
    observations: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /private provider detail/iu);
});

test("WAF responses are size bounded", async () => {
  const result = await ingestCloudflareSecurityEvents(
    database,
    environment({
      CLOUDFLARE_SECURITY_API_TOKEN: WAF_TOKEN,
      CLOUDFLARE_ZONE_ID: ZONE_ID,
    }),
    {
      fetchImpl: async () =>
        new Response(JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }), {
          headers: { "content-type": "application/json" },
        }),
      now: new Date("2026-08-11T12:12:00.000Z"),
    },
  );
  assert.deepEqual(result, {
    state: "failed",
    errorCode: "waf_invalid_response",
    observations: 0,
  });
});

test("security events expire on schedule", async () => {
  await purgeExpiredSecurityEvents(database, new Date("2026-08-11T11:21:00.000Z"));
  assert.equal(
    (await database.prepare("SELECT COUNT(*) AS count FROM security_observations").first()).count,
    0,
  );
  assert.ok(
    (await database.prepare("SELECT COUNT(*) AS count FROM security_incidents").first()).count > 0,
  );

  const finalPurge = await purgeExpiredSecurityEvents(
    database,
    new Date("2026-08-14T11:03:00.000Z"),
  );
  assert.ok(finalPurge.incidents > 0);
  assert.equal(
    (await database.prepare("SELECT COUNT(*) AS count FROM security_incidents").first()).count,
    0,
  );
});
