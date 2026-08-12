import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";
import { createTestRuntime } from "./helpers/runtime.mjs";

const WEBHOOK_ID = "123456789012345678";
const MESSAGE_ID = "223456789012345678";
const REPLACEMENT_ID = "323456789012345678";
const WEBHOOK_URL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${"B".repeat(68)}`;
const ROTATED_WEBHOOK_URL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${"D".repeat(68)}`;

let vite;
let buildDiscordStatusPayload;
let createD1DiscordStatusMessageStore;
let discordWebhookFingerprint;
let DiscordStatusStoreConflictError;
let publishDiscordStatus;
let webhookFingerprint;

before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 0 } },
    appType: "custom",
  });
  ({
    buildDiscordStatusPayload,
    createD1DiscordStatusMessageStore,
    discordWebhookFingerprint,
    DiscordStatusStoreConflictError,
    publishDiscordStatus,
  } = await vite.ssrLoadModule("/lib/discord-status.ts"));
  webhookFingerprint = await discordWebhookFingerprint(WEBHOOK_URL);
});

after(async () => vite?.close());

function snapshot(extra = {}) {
  return {
    website: "operational",
    api: "operational",
    database: "operational",
    authentication: "degraded",
    evidence: "maintenance",
    email: "unknown",
    discordRoles: "degraded",
    backups: "operational",
    scheduledJobs: "unavailable",
    version: "0.2.0",
    updatedAt: "2026-08-11T12:34:56.000Z",
    ...extra,
  };
}

function statusStore(initial = null) {
  let record = initial;
  const writes = [];
  return {
    writes,
    current() {
      return record;
    },
    async read(id) {
      assert.equal(id, "primary");
      return record;
    },
    async write(next, expected) {
      writes.push({ next, expected });
      record = next;
    },
  };
}

test("status payload hides private details", () => {
  const payload = buildDiscordStatusPayload(
    snapshot({
      privateError: ["D1 token", "test-redaction-token-placeholder"].join("="),
      pendingReportCount: 9123,
      reporterAddress: "person@example.invalid",
      moderatorNote: "private moderator text",
    }),
  );
  const serialized = JSON.stringify(payload);
  assert.match(serialized, /Website.*Operational/iu);
  assert.match(serialized, /Discord roles.*Degraded/iu);
  assert.match(serialized, /Backups.*Operational/iu);
  assert.match(serialized, /Scam-Reports\.org.*0\.2\.0/iu);
  assert.equal(payload.content, "");
  assert.equal(payload.embeds.length, 1);
  assert.equal(payload.embeds[0].title, "Service interruption");
  assert.equal(payload.embeds[0].color, 0xed4245);
  assert.equal(payload.embeds[0].fields.length, 3);
  assert.equal(payload.embeds[0].thumbnail.url, "https://scam-reports.org/brand/sr-mark.png");
  assert.doesNotMatch(
    serialized,
    /test-redaction-token-placeholder|9123|person@example|private moderator text/iu,
  );
});

test("secondary maintenance keeps core status healthy", () => {
  const payload = buildDiscordStatusPayload(
    snapshot({
      authentication: "operational",
      scheduledJobs: "operational",
      discordRoles: "maintenance",
      backups: "unknown",
    }),
  );
  assert.equal(payload.embeds[0].title, "Core systems operational");
  assert.equal(payload.embeds[0].color, 0x57f287);
});

test("status publisher creates one tracked message", async () => {
  const store = statusStore();
  const requests = [];
  const result = await publishDiscordStatus(snapshot(), {
    webhookEnvironment: { DISCORD_STATUS_WEBHOOK_URL: WEBHOOK_URL },
    store,
    fetchImpl: async (input, init) => {
      requests.push({ input: String(input), init });
      return Response.json({ id: MESSAGE_ID });
    },
  });
  assert.deepEqual(result, { action: "created", messageId: MESSAGE_ID });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, `${WEBHOOK_URL}?wait=true`);
  assert.equal(requests[0].init.method, "POST");
  assert.deepEqual(store.writes[0].expected, {
    messageId: null,
    webhookFingerprint: null,
  });
  assert.equal(store.writes[0].next.messageId, MESSAGE_ID);
  assert.equal(store.writes[0].next.webhookFingerprint, webhookFingerprint);
  assert.equal(store.writes[0].next.deliveryState, "active");
  assert.match(webhookFingerprint, /^[a-f0-9]{64}$/u);
  const stored = JSON.stringify(store.writes);
  assert.equal(stored.includes("B".repeat(68)), false);
  assert.doesNotMatch(stored, /discord\.com|api\/webhooks/iu);
});

test("status publisher edits its existing message", async () => {
  const store = statusStore({
    id: "primary",
    messageId: MESSAGE_ID,
    webhookFingerprint,
    deliveryState: "active",
    updatedAt: "2026-08-11T12:33:00.000Z",
  });
  const methods = [];
  const result = await publishDiscordStatus(snapshot(), {
    webhookEnvironment: { DISCORD_STATUS_WEBHOOK_URL: WEBHOOK_URL },
    store,
    fetchImpl: async (_input, init) => {
      methods.push(init.method);
      return Response.json({ id: MESSAGE_ID });
    },
  });
  assert.deepEqual(result, { action: "edited", messageId: MESSAGE_ID });
  assert.deepEqual(methods, ["PATCH"]);
  assert.deepEqual(store.writes[0].expected, { messageId: MESSAGE_ID, webhookFingerprint });
});

test("deleted status messages are recreated", async () => {
  const store = statusStore({
    id: "primary",
    messageId: MESSAGE_ID,
    webhookFingerprint,
    deliveryState: "active",
    updatedAt: "2026-08-11T12:33:00.000Z",
  });
  const methods = [];
  const result = await publishDiscordStatus(snapshot(), {
    webhookEnvironment: { DISCORD_STATUS_WEBHOOK_URL: WEBHOOK_URL },
    store,
    fetchImpl: async (_input, init) => {
      methods.push(init.method);
      if (init.method === "PATCH") return new Response(null, { status: 404 });
      return Response.json({ id: REPLACEMENT_ID });
    },
  });
  assert.deepEqual(result, { action: "recreated", messageId: REPLACEMENT_ID });
  assert.deepEqual(methods, ["PATCH", "POST"]);
  assert.deepEqual(store.writes[0].expected, { messageId: MESSAGE_ID, webhookFingerprint });
  assert.equal(store.writes[0].next.messageId, null);
  assert.deepEqual(store.writes[1].expected, { messageId: null, webhookFingerprint });
  assert.equal(store.writes[1].next.messageId, REPLACEMENT_ID);
});

test("webhook auth failure opens a circuit", async () => {
  const store = statusStore();
  let requests = 0;
  const publish = (webhook, fetchImpl) =>
    publishDiscordStatus(snapshot(), {
      webhookEnvironment: { DISCORD_STATUS_WEBHOOK_URL: webhook },
      store,
      fetchImpl,
    });

  await assert.rejects(
    publish(WEBHOOK_URL, async () => {
      requests += 1;
      return new Response(null, { status: 401 });
    }),
  );
  assert.equal(requests, 1);
  assert.equal(store.current().deliveryState, "disabled");
  assert.equal(store.current().webhookFingerprint, webhookFingerprint);
  assert.equal(store.current().messageId, null);

  const disabled = await publish(WEBHOOK_URL, async () => {
    requests += 1;
    return Response.json({ id: MESSAGE_ID });
  });
  assert.deepEqual(disabled, { action: "disabled", messageId: null });
  assert.equal(requests, 1);

  const rotated = await publish(ROTATED_WEBHOOK_URL, async () => {
    requests += 1;
    return Response.json({ id: REPLACEMENT_ID });
  });
  assert.deepEqual(rotated, { action: "created", messageId: REPLACEMENT_ID });
  assert.equal(requests, 2);
  assert.equal(store.current().deliveryState, "active");
  assert.notEqual(store.current().webhookFingerprint, webhookFingerprint);
});

test("second missing message opens the status circuit", async () => {
  const store = statusStore({
    id: "primary",
    messageId: MESSAGE_ID,
    webhookFingerprint,
    deliveryState: "active",
    updatedAt: "2026-08-11T12:33:00.000Z",
  });
  const methods = [];
  const publish = () =>
    publishDiscordStatus(snapshot(), {
      webhookEnvironment: { DISCORD_STATUS_WEBHOOK_URL: WEBHOOK_URL },
      store,
      fetchImpl: async (_input, init) => {
        methods.push(init.method);
        return new Response(null, { status: 404 });
      },
    });

  await assert.rejects(publish());
  assert.deepEqual(methods, ["PATCH", "POST"]);
  assert.equal(store.current().deliveryState, "disabled");
  assert.equal(store.current().messageId, null);

  assert.deepEqual(await publish(), { action: "disabled", messageId: null });
  assert.deepEqual(methods, ["PATCH", "POST"]);
});

test("failed recreation forgets the old message", async () => {
  const store = statusStore({
    id: "primary",
    messageId: MESSAGE_ID,
    webhookFingerprint,
    deliveryState: "active",
    updatedAt: "2026-08-11T12:33:00.000Z",
  });
  const methods = [];
  let requestNumber = 0;
  const publish = () =>
    publishDiscordStatus(snapshot(), {
      webhookEnvironment: { DISCORD_STATUS_WEBHOOK_URL: WEBHOOK_URL },
      store,
      fetchImpl: async (_input, init) => {
        methods.push(init.method);
        requestNumber += 1;
        if (requestNumber === 1) return new Response(null, { status: 404 });
        if (requestNumber === 2) return new Response(null, { status: 502 });
        return Response.json({ id: REPLACEMENT_ID });
      },
    });

  await assert.rejects(publish());
  assert.equal(store.current().deliveryState, "active");
  assert.equal(store.current().messageId, null);

  assert.deepEqual(await publish(), { action: "created", messageId: REPLACEMENT_ID });
  assert.deepEqual(methods, ["PATCH", "POST", "POST"]);
});

test("D1 status store rejects stale writers", async (t) => {
  const { runtime, database } = await createTestRuntime();
  t.after(() => runtime.dispose());
  const store = createD1DiscordStatusMessageStore(database);
  assert.equal(await store.read("primary"), null);

  const active = {
    id: "primary",
    messageId: MESSAGE_ID,
    webhookFingerprint,
    deliveryState: "active",
    updatedAt: "2026-08-11T12:34:56.000Z",
  };
  await store.write(active, { messageId: null, webhookFingerprint: null });
  assert.deepEqual(await store.read("primary"), active);

  await assert.rejects(
    store.write(
      { ...active, updatedAt: "2026-08-11T12:35:56.000Z" },
      { messageId: null, webhookFingerprint: null },
    ),
    (error) => error instanceof DiscordStatusStoreConflictError,
  );

  const disabled = {
    ...active,
    messageId: null,
    deliveryState: "disabled",
    updatedAt: "2026-08-11T12:36:56.000Z",
  };
  await store.write(disabled, { messageId: MESSAGE_ID, webhookFingerprint });
  assert.deepEqual(await store.read("primary"), disabled);

  const stored = await database.prepare("SELECT * FROM discord_status_messages").first();
  assert.equal(stored.webhook_fingerprint, webhookFingerprint);
  const serialized = JSON.stringify(stored);
  assert.equal(serialized.includes("B".repeat(68)), false);
  assert.doesNotMatch(serialized, /discord\.com|api\/webhooks/iu);
  const columns = await database.prepare("PRAGMA table_info(discord_status_messages)").all();
  assert.doesNotMatch(
    JSON.stringify(columns.results.map((column) => column.name)),
    /webhook_url|webhook_token|secret/iu,
  );
});
