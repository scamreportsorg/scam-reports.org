import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { createServer } from "vite";

let DiscordWebhookError;
let discordWebhookDestination;
let editDiscordWebhookMessage;
let executeDiscordWebhook;
let isDiscordWebhookUrl;
let vite;

before(async () => {
  vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: { port: 0 } },
    appType: "custom",
  });
  ({
    DiscordWebhookError,
    discordWebhookDestination,
    editDiscordWebhookMessage,
    executeDiscordWebhook,
    isDiscordWebhookUrl,
  } = await vite.ssrLoadModule("/lib/discord-webhook.ts"));
});

after(async () => vite?.close());

const WEBHOOK_ID = "123456789012345678";
const MESSAGE_ID = "223456789012345678";
const WEBHOOK_TOKEN = "test-discord-webhook-token-placeholder-000000000000000000000000000000";
const WEBHOOK_URL = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`;

test("webhook URLs reject SSRF tricks", () => {
  assert.equal(isDiscordWebhookUrl(WEBHOOK_URL), true);
  const rejected = [
    WEBHOOK_URL.replace("https://", "http://"),
    WEBHOOK_URL.replace("discord.com", "discord.com.attacker.invalid"),
    WEBHOOK_URL.replace("discord.com", "attacker.invalid"),
    WEBHOOK_URL.replace("https://discord.com", "https://discord.com@attacker.invalid"),
    WEBHOOK_URL.replace("discord.com", "discord.com:443"),
    `${WEBHOOK_URL}?wait=true`,
    `${WEBHOOK_URL}#fragment`,
    `${WEBHOOK_URL}/messages/${MESSAGE_ID}`,
    `https://discord.com/api/webhooks/not-a-snowflake/${WEBHOOK_TOKEN}`,
    `https://discord.com/api/webhooks/${WEBHOOK_ID}/short`,
    `https://discordapp.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
    ` https://discord.com/api/webhooks/${WEBHOOK_ID}/${WEBHOOK_TOKEN}`,
  ];
  for (const value of rejected) assert.equal(isDiscordWebhookUrl(value), false, value);

  assert.equal(
    discordWebhookDestination({ MODERATOR_DISCORD_WEBHOOK_URL: WEBHOOK_URL }, "moderation"),
    WEBHOOK_URL,
  );
  assert.throws(
    () => discordWebhookDestination({ MODERATOR_DISCORD_WEBHOOK_URL: WEBHOOK_URL }, "status"),
    (error) => error instanceof DiscordWebhookError && error.code === "not_configured",
  );
  assert.throws(
    () => discordWebhookDestination({ DISCORD_STATUS_WEBHOOK_URL: WEBHOOK_URL }, "moderation"),
    (error) => error instanceof DiscordWebhookError && error.code === "not_configured",
  );
});

test("webhook posts wait for a message ID", async () => {
  let request;
  const messageId = await executeDiscordWebhook(
    WEBHOOK_URL,
    { content: "fixed operator notice", allowed_mentions: { parse: ["everyone"] } },
    {
      fetchImpl: async (input, init) => {
        request = { input: String(input), init };
        return Response.json({ id: MESSAGE_ID });
      },
    },
  );
  assert.equal(messageId, MESSAGE_ID);
  assert.equal(request.input, `${WEBHOOK_URL}?wait=true`);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "manual");
  assert.ok(request.init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(request.init.body).allowed_mentions, { parse: [] });

  await assert.rejects(
    executeDiscordWebhook(
      WEBHOOK_URL,
      { content: "notice" },
      {
        fetchImpl: async (_input, init) => {
          assert.equal(init.redirect, "manual");
          return new Response(null, {
            status: 302,
            headers: { location: "https://attacker.invalid/capture" },
          });
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof DiscordWebhookError);
      assert.equal(error.code, "request_rejected");
      assert.equal(error.retryable, false);
      assert.doesNotMatch(error.message, new RegExp(WEBHOOK_TOKEN, "u"));
      return true;
    },
  );
});

test("webhook requests time out", async () => {
  await assert.rejects(
    executeDiscordWebhook(
      WEBHOOK_URL,
      { content: "notice" },
      {
        timeoutMs: 5,
        fetchImpl: async (_input, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            );
          }),
      },
    ),
    (error) => error instanceof DiscordWebhookError && error.code === "timeout" && error.retryable,
  );
});

test("Discord retries use retry_after with jitter", async () => {
  await assert.rejects(
    executeDiscordWebhook(
      WEBHOOK_URL,
      { content: "notice" },
      {
        random: () => 0.5,
        fetchImpl: async () => Response.json({ retry_after: 1.25 }, { status: 429 }),
      },
    ),
    (error) => {
      assert.ok(error instanceof DiscordWebhookError);
      assert.equal(error.code, "rate_limited");
      assert.equal(error.retryable, true);
      assert.equal(error.retryAfterMs, 1375);
      return true;
    },
  );

  await assert.rejects(
    executeDiscordWebhook(
      WEBHOOK_URL,
      { content: "notice" },
      {
        random: () => 0,
        fetchImpl: async () => Response.json({}, { status: 429 }),
      },
    ),
    (error) => error instanceof DiscordWebhookError && error.retryAfterMs === 1000,
  );

  for (const status of [500, 502, 599]) {
    await assert.rejects(
      executeDiscordWebhook(
        WEBHOOK_URL,
        { content: "notice" },
        {
          fetchImpl: async () => new Response(null, { status }),
        },
      ),
      (error) => error instanceof DiscordWebhookError && error.retryable,
    );
  }
  for (const status of [400, 401, 403, 404]) {
    await assert.rejects(
      executeDiscordWebhook(
        WEBHOOK_URL,
        { content: "notice" },
        {
          fetchImpl: async () => new Response(null, { status }),
        },
      ),
      (error) => error instanceof DiscordWebhookError && !error.retryable,
    );
  }
});

test("webhook edits suppress mentions", async () => {
  let request;
  const result = await editDiscordWebhookMessage(
    WEBHOOK_URL,
    MESSAGE_ID,
    { content: "status" },
    {
      fetchImpl: async (input, init) => {
        request = { input: String(input), init };
        return Response.json({ id: MESSAGE_ID });
      },
    },
  );
  assert.equal(result, MESSAGE_ID);
  assert.equal(request.input, `${WEBHOOK_URL}/messages/${MESSAGE_ID}`);
  assert.equal(request.init.method, "PATCH");
  assert.deepEqual(JSON.parse(request.init.body).allowed_mentions, { parse: [] });
});

test("webhook responses are size bounded", async () => {
  await assert.rejects(
    executeDiscordWebhook(
      WEBHOOK_URL,
      { content: "notice" },
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ id: MESSAGE_ID, padding: "x".repeat(300 * 1024) }), {
            headers: { "content-type": "application/json" },
          }),
      },
    ),
    (error) => error instanceof DiscordWebhookError && error.code === "invalid_response",
  );
});
