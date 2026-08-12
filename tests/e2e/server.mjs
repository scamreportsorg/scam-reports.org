import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
} from "../helpers/runtime.mjs";

const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = Number(portArgument?.slice("--port=".length) ?? process.env.E2E_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("E2E server requires a valid TCP port.");
}

const hostname = "127.0.0.1";
const origin = `http://${hostname}:${port}`;
const clientRoot = fileURLToPath(new URL("../../dist/client/", import.meta.url));
const latestMagicLinks = new Map();
async function outboundService(request) {
  const url = new URL(request.url);
  if (url.origin === "https://api.resend.com" && url.pathname === "/emails") {
    const message = await request.json();
    const recipient = String(message.to?.[0] ?? "").toLowerCase();
    const link = String(message.text ?? "").match(/https?:\/\/[^\s]+/u)?.[0];
    if (recipient && link) latestMagicLinks.set(recipient, link);
    return Response.json({ id: `e2e-email-${latestMagicLinks.size}` });
  }
  if (url.origin === "https://discord.com" && url.pathname === "/api/v10/oauth2/token") {
    const form = await request.formData();
    const accessToken =
      form.get("code") === "test-e2e-discord-link-authorization-code-placeholder"
        ? "test-e2e-discord-link-access-token-placeholder"
        : "test-e2e-discord-access-token-placeholder";
    return Response.json({ access_token: accessToken });
  }
  if (url.origin === "https://discord.com" && url.pathname === "/api/v10/users/@me") {
    if (
      request.headers.get("authorization") ===
      "Bearer test-e2e-discord-link-access-token-placeholder"
    ) {
      return Response.json({
        id: "910000000000000002",
        username: "e2e_linked_member",
        global_name: "E2E Linked Member",
      });
    }
    return Response.json({
      id: "910000000000000001",
      username: "e2e_discord_member",
      global_name: "E2E Discord Member",
    });
  }
  return new Response("Unexpected outbound request blocked by local E2E runtime.", {
    status: 502,
  });
}

const { runtime, database, originals, derivatives } = await createTestRuntime({
  outboundService,
  bindings: {
    AUTH_APP_ORIGIN: origin,
    APP_ENVIRONMENT: "test",
    AUTH_RUNTIME_ENV: "test",
  },
});

for (let index = 1; index <= 55; index += 1) {
  const serial = String(index).padStart(4, "0");
  await insertReportFixture(database, {
    id: `SR-E2E-${serial}`,
    username: index === 52 ? "NeedleTarget" : `BrowserFixture${serial}`,
    discordId: `80000000000000${serial}`,
    game: index % 2 === 0 ? "Synthetic Arena" : "Fixture Frontline",
    category: index % 4 === 0 ? "Marketplace Scam" : "Cheating",
    status: index % 3 === 0 ? "Confirmed" : "Reported",
    reason: `Synthetic browser report ${serial} retained for local navigation tests.`,
    description:
      "This is synthetic browser-only evidence context. It does not identify or accuse a real person.",
    dateAdded: `2026-07-${String((index % 28) + 1).padStart(2, "0")}`,
    updatedAt: `2026-08-${String((index % 8) + 1).padStart(2, "0")}T12:00:00.000Z`,
    views: index * 7,
  });
}

await insertAccountFixture(database, {
  id: "e2e_member",
  handle: "E2EMember",
  role: "member",
  providers: ["email"],
});
await insertAccountFixture(database, {
  id: "e2e_link_member",
  handle: "E2ELinkMember",
  role: "member",
  providers: ["email"],
});
await insertAccountFixture(database, {
  id: "e2e_application_member",
  handle: "E2EApplicationMember",
  role: "member",
  providers: ["discord", "email"],
});
await insertAccountFixture(database, {
  id: "e2e_moderator",
  handle: "E2EModerator",
  role: "moderator",
  providers: ["discord", "email"],
});
await insertAccountFixture(database, {
  id: "e2e_admin",
  handle: "E2EAdmin",
  role: "admin",
  providers: ["discord", "email"],
});
await insertAccountFixture(database, {
  id: `account_${"e".repeat(32)}`,
  handle: "E2ERoleTarget",
  role: "member",
  providers: ["discord", "email"],
});

const evidenceFixture = {
  id: "EVA-11111111-1111-4111-8111-111111111111",
  filename: "e2e-private-evidence.png",
  originalKey: "originals/e2e-private-evidence",
  derivativeKey: "derivatives/e2e-private-evidence.webp",
};
const originalBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const derivativeBytes = Buffer.from(
  "UklGRh4AAABXRUJQVlA4TBEAAAAvAUAAAAdQq6qUr/+BiOh/AAA=",
  "base64",
);
const originalSha256 = createHash("sha256").update(originalBytes).digest("hex");
const derivativeSha256 = createHash("sha256").update(derivativeBytes).digest("hex");
const evidenceCreatedAt = new Date().toISOString();
await originals.put(evidenceFixture.originalKey, originalBytes, {
  httpMetadata: { contentType: "image/png" },
  customMetadata: {
    assetId: evidenceFixture.id,
    sha256: originalSha256,
    private: "true",
  },
});
await derivatives.put(evidenceFixture.derivativeKey, derivativeBytes, {
  httpMetadata: { contentType: "image/webp" },
  customMetadata: {
    assetId: evidenceFixture.id,
    sourceSha256: originalSha256,
    sha256: derivativeSha256,
    sanitized: "cloudflare-images-webp",
  },
});
await database
  .prepare(
    `INSERT INTO evidence_assets (
    id, intake_id, intake_kind, state, original_key, derivative_key,
    original_filename, original_content_type, original_size, original_sha256,
    derivative_content_type, derivative_size, derivative_sha256,
    source_width, source_height, width, height, visible_pii_reviewed,
    legal_hold, processing_error, created_by, created_at, updated_at,
    published_at, deleted_at
  ) VALUES (?, NULL, 'moderator_upload', 'private_ready', ?, ?, ?, 'image/png', ?, ?,
    'image/webp', ?, ?, 2, 2, 2, 2, 0, 0, '', 'E2E fixture', ?, ?, NULL, NULL)`,
  )
  .bind(
    evidenceFixture.id,
    evidenceFixture.originalKey,
    evidenceFixture.derivativeKey,
    evidenceFixture.filename,
    originalBytes.byteLength,
    originalSha256,
    derivativeBytes.byteLength,
    derivativeSha256,
    evidenceCreatedAt,
    evidenceCreatedAt,
  )
  .run();

function responseHeaders(response) {
  const headers = {};
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() !== "set-cookie") headers[name] = value;
  }
  const cookies = response.headers.getSetCookie?.() ?? [];
  if (cookies.length > 0) headers["set-cookie"] = cookies;
  return headers;
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

async function clientAsset(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const absolutePath = path.resolve(clientRoot, `.${decoded}`);
  if (!absolutePath.startsWith(`${path.resolve(clientRoot)}${path.sep}`)) return null;
  try {
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) return null;
    return {
      body: await readFile(absolutePath),
      type:
        contentTypes.get(path.extname(absolutePath).toLowerCase()) ?? "application/octet-stream",
    };
  } catch {
    return null;
  }
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(incoming.url ?? "/", origin);
    if (url.pathname === "/__e2e/mail/latest") {
      const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
      const link = latestMagicLinks.get(email);
      outgoing.writeHead(link ? 200 : 404, {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
      });
      outgoing.end(JSON.stringify(link ? { link } : { error: "No local message found." }));
      return;
    }
    if (url.pathname === "/__e2e/discord/authorize") {
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state");
      if (!redirectUri || !state || new URL(redirectUri).origin !== origin) {
        outgoing.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        outgoing.end("Invalid local Discord authorization request.");
        return;
      }
      const callback = new URL(redirectUri);
      callback.searchParams.set(
        "code",
        url.searchParams.get("e2e_profile") === "link"
          ? "test-e2e-discord-link-authorization-code-placeholder"
          : "e2e-discord-authorization-code",
      );
      callback.searchParams.set("state", state);
      outgoing.writeHead(302, { location: callback.toString(), "cache-control": "no-store" });
      outgoing.end();
      return;
    }
    const asset = await clientAsset(url.pathname);
    if (asset) {
      outgoing.writeHead(200, {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": asset.type,
        "x-content-type-options": "nosniff",
      });
      outgoing.end(incoming.method === "HEAD" ? undefined : asset.body);
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) headers.append(name, item);
      } else if (value !== undefined) {
        headers.set(name, value);
      }
    }

    const method = incoming.method ?? "GET";
    const response = await runtime.dispatchFetch(url.toString(), {
      method,
      headers: Object.fromEntries(headers),
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
    });
    const outgoingHeaders = responseHeaders(response);
    const location = response.headers.get("location");
    if (method === "GET" && location?.startsWith("https://discord.com/oauth2/authorize")) {
      const providerUrl = new URL(location);
      outgoingHeaders.location = `${origin}/__e2e/discord/authorize?${providerUrl.searchParams}`;
    }
    outgoing.writeHead(response.status, outgoingHeaders);
    if (method === "HEAD" || !response.body) {
      outgoing.end();
      return;
    }
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("E2E request failed", error);
    if (!outgoing.headersSent) outgoing.writeHead(500, { "content-type": "text/plain" });
    outgoing.end("Local E2E worker request failed.");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, hostname, resolve);
});
console.log(`Local E2E worker listening on ${origin}`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise((resolve) => server.close(resolve));
  await runtime.dispose();
  process.exit(0);
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
