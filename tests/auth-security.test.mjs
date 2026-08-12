import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  TEST_BINDINGS,
  authHeaders,
  createTestRuntime,
  insertAccountFixture,
  sha256Base64Url,
} from "./helpers/runtime.mjs";
import { BoundedJsonError, readBoundedJson, requestMediaType } from "../lib/bounded-json.ts";

let runtime;
let database;
let member;
let moderator;

async function encryptIdentityForFixture(value) {
  const keyBytes = Buffer.from(TEST_BINDINGS.IDENTITY_ENCRYPTION_KEY, "base64url");
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const iv = new Uint8Array(12).fill(7);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  );
  return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
}

function chunkedTextBody(value, chunkSize = 1024) {
  const bytes = new TextEncoder().encode(value);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
      offset += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
}

test("request media types ignore case and parameters", () => {
  for (const [value, expected] of [
    [null, ""],
    ["application/json", "application/json"],
    ["Application/JSON; Charset=UTF-8", "application/json"],
    [" application/x-www-form-urlencoded ; charset=utf-8 ", "application/x-www-form-urlencoded"],
    ["text/plain", "text/plain"],
    ["not-a-media-type", "not-a-media-type"],
  ]) {
    const headers = value === null ? undefined : { "content-type": value };
    assert.equal(requestMediaType(new Request("http://localhost/", { headers })), expected);
  }
});

test("bounded JSON uses normalized media types", async () => {
  const accepted = new Request("http://localhost/", {
    method: "POST",
    headers: { "content-type": "Application/JSON; Charset=UTF-8" },
    body: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(await readBoundedJson(accepted), { ok: true });

  for (const contentType of ["text/plain", "application/jsonp", "not-a-media-type"]) {
    const rejected = new Request("http://localhost/", {
      method: "POST",
      headers: { "content-type": contentType },
      body: new TextEncoder().encode("{}"),
    });
    await assert.rejects(
      readBoundedJson(rejected),
      (error) =>
        error instanceof BoundedJsonError &&
        error.status === 415 &&
        error.code === "unsupported_media_type",
      contentType,
    );
  }
});

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  member = await insertAccountFixture(database, {
    id: "account_member",
    handle: "InitialHandle",
    role: "member",
  });
  moderator = await insertAccountFixture(database, {
    id: "account_moderator",
    handle: "TestModerator",
    role: "moderator",
    providers: ["discord"],
    authenticatedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  });
});

after(async () => runtime?.dispose());

test("auth tests apply every migration", async () => {
  const rows = await database.prepare("SELECT name FROM d1_migrations ORDER BY id").all();
  assert.deepEqual(
    rows.results.map((row) => row.name),
    [
      "0000_chilly_sleepwalker.sql",
      "0001_blue_doctor_doom.sql",
      "0002_eminent_anthem.sql",
      "0003_happy_johnny_blaze.sql",
      "0004_flowery_bishop.sql",
      "0005_lean_zombie.sql",
      "0006_report_family_metrics.sql",
      "0007_restore_legacy_integrity.sql",
      "0008_evidence_privacy_replacements.sql",
      "0009_authoritative_status_history.sql",
      "0010_session_bound_step_up.sql",
      "0011_evidence_deletion_lease.sql",
      "0012_fast_report_family_metrics.sql",
      "0013_moderator_applications.sql",
      "0014_public_member_activity.sql",
      "0015_report_merge_integrity.sql",
      "0016_discord_rank_sync.sql",
      "0017_discord_status_delivery.sql",
      "0018_discord_orphan_retention.sql",
      "0019_security_attack_monitor.sql",
      "0020_security_monitor_diagnostics.sql",
      "0021_magic_login_browser_context.sql",
    ],
  );
});

test("sessions expose only the public account fields", async () => {
  const response = await runtime.dispatchFetch("http://localhost/api/auth/session", {
    headers: { cookie: member.cookie },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.authenticated, true);
  assert.deepEqual(
    {
      id: payload.account.id,
      handle: payload.account.handle,
      role: payload.account.role,
    },
    { id: "account_member", handle: "InitialHandle", role: "member" },
  );
  assert.match(payload.account.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(payload.csrfToken, member.csrf);
  assert.deepEqual(Object.keys(payload.account).sort(), ["createdAt", "handle", "id", "role"]);
  assert.equal("token" in payload, false);
});

test("account writes check origin and session CSRF", async () => {
  const validForm = new URLSearchParams({
    handle: "UpdatedHandle",
    csrfToken: member.csrf,
  });
  const accepted = await runtime.dispatchFetch("http://localhost/api/auth/account", {
    method: "POST",
    headers: authHeaders(member, { "content-type": "application/x-www-form-urlencoded" }),
    body: validForm.toString(),
    redirect: "manual",
  });
  assert.equal(accepted.status, 303);
  assert.equal(
    (await database.prepare("SELECT handle FROM accounts WHERE id = 'account_member'").first())
      .handle,
    "UpdatedHandle",
  );

  for (const headers of [
    authHeaders(member, { origin: "https://attacker.invalid" }),
    authHeaders(member, { "x-csrf-token": "test-csrf-token-placeholder" }),
  ]) {
    const rejected = await runtime.dispatchFetch("http://localhost/api/auth/account", {
      method: "POST",
      headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        handle: "AttackerHandle",
        csrfToken: headers["x-csrf-token"],
      }).toString(),
    });
    assert.equal(rejected.status, 403);
  }
  assert.equal(
    (await database.prepare("SELECT handle FROM accounts WHERE id = 'account_member'").first())
      .handle,
    "UpdatedHandle",
  );
});

test("auth writes reject bad JSON and content types", async () => {
  for (const [pathname, headers] of [
    ["/api/auth/account", authHeaders(member, { "content-type": "application/json" })],
    [
      "/api/auth/magic/request",
      {
        origin: "http://localhost",
        "content-type": "application/json",
        "cf-connecting-ip": "198.51.100.42",
      },
    ],
  ]) {
    const response = await runtime.dispatchFetch(`http://localhost${pathname}`, {
      method: "POST",
      headers,
      body: "{",
    });
    assert.equal(response.status, 400, pathname);
    assert.equal((await response.json()).code, "invalid_json", pathname);
  }

  for (const [pathname, headers] of [
    ["/api/auth/account", authHeaders(member, { "content-type": "text/plain" })],
    [
      "/api/auth/magic/request",
      {
        origin: "http://localhost",
        "content-type": "text/plain",
        "cf-connecting-ip": "198.51.100.42",
      },
    ],
    ["/api/auth/logout", authHeaders(member, { "content-type": "text/plain" })],
  ]) {
    const response = await runtime.dispatchFetch(`http://localhost${pathname}`, {
      method: "POST",
      headers,
      body: "unsupported request body",
    });
    assert.equal(response.status, 415, pathname);
    assert.equal((await response.json()).code, "invalid_content_type", pathname);
  }

  const session = await runtime.dispatchFetch("http://localhost/api/auth/session", {
    headers: { cookie: member.cookie },
  });
  assert.equal((await session.json()).authenticated, true);
});

test("JSON size errors survive a failed stream cancel", async () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(5 * 1024));
    },
    cancel() {
      throw new Error("disconnected test stream");
    },
  });
  const request = new Request("http://localhost/api/auth/account", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  });
  await assert.rejects(
    readBoundedJson(request, 4 * 1024),
    (error) =>
      error instanceof BoundedJsonError &&
      error.status === 413 &&
      error.code === "request_too_large",
  );
});

test("magic-link bodies are bounded before side effects", async () => {
  const isolated = await createTestRuntime();
  try {
    const oversizedJson = await isolated.runtime.dispatchFetch(
      "http://localhost/api/auth/magic/request",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.75",
        },
        body: JSON.stringify({
          email: "oversized@example.invalid",
          purpose: "login",
          turnstileToken: TEST_BINDINGS.TURNSTILE_TEST_BYPASS_TOKEN,
          padding: "x".repeat(9 * 1024),
        }),
      },
    );
    assert.equal(oversizedJson.status, 413);
    assert.equal((await oversizedJson.json()).code, "request_too_large");

    const chunkedBody = chunkedTextBody(
      new URLSearchParams({
        email: "oversized@example.invalid",
        purpose: "login",
        "cf-turnstile-response": TEST_BINDINGS.TURNSTILE_TEST_BYPASS_TOKEN,
        padding: "x".repeat(9 * 1024),
      }).toString(),
    );
    const oversizedForm = await isolated.runtime.dispatchFetch(
      "http://localhost/api/auth/magic/request",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "198.51.100.75",
        },
        body: chunkedBody,
        duplex: "half",
        redirect: "manual",
      },
    );
    assert.equal(oversizedForm.status, 413);
    assert.equal((await oversizedForm.json()).code, "request_too_large");

    assert.equal(
      (await isolated.database.prepare("SELECT COUNT(*) AS count FROM rate_events").first()).count,
      0,
    );
    assert.equal(
      (await isolated.database.prepare("SELECT COUNT(*) AS count FROM auth_magic_links").first())
        .count,
      0,
    );
  } finally {
    await isolated.runtime.dispose();
  }
});

test("authenticated writes bound request bodies first", async () => {
  const isolated = await createTestRuntime();
  try {
    const account = await insertAccountFixture(isolated.database, {
      id: "account_bounded_auth",
      handle: "BoundedAuthMember",
      providers: ["email"],
    });
    const requests = [
      {
        pathname: "/api/auth/account",
        contentType: "application/json",
        body: JSON.stringify({
          handle: "ChangedByOversizedBody",
          csrfToken: account.csrf,
          padding: "x".repeat(5 * 1024),
        }),
      },
      ...[
        "/api/auth/logout",
        "/api/auth/discord/rank-sync",
        "/api/auth/identities/email",
        "/api/auth/discord/start",
      ].map((pathname) => ({
        pathname,
        contentType: "application/x-www-form-urlencoded",
        body: new URLSearchParams({
          csrfToken: account.csrf,
          returnTo: "/account",
          padding: "x".repeat(5 * 1024),
        }).toString(),
      })),
    ];

    for (const request of requests) {
      const response = await isolated.runtime.dispatchFetch(`http://localhost${request.pathname}`, {
        method: "POST",
        headers: authHeaders(account, { "content-type": request.contentType }),
        body: chunkedTextBody(request.body),
        duplex: "half",
        redirect: "manual",
      });
      assert.equal(response.status, 413, request.pathname);
      assert.equal((await response.json()).code, "request_too_large", request.pathname);
    }

    assert.equal(
      (
        await isolated.database
          .prepare("SELECT handle FROM accounts WHERE id = 'account_bounded_auth'")
          .first()
      ).handle,
      "BoundedAuthMember",
    );
    assert.equal(
      (
        await isolated.database
          .prepare("SELECT COUNT(*) AS count FROM auth_oauth_transactions")
          .first()
      ).count,
      0,
    );
    assert.equal(
      (await isolated.database.prepare("SELECT COUNT(*) AS count FROM rate_events").first()).count,
      0,
    );
    const session = await isolated.runtime.dispatchFetch("http://localhost/api/auth/session", {
      headers: { cookie: account.cookie },
    });
    assert.equal((await session.json()).authenticated, true);
  } finally {
    await isolated.runtime.dispose();
  }
});

test("handle conflicts and D1 failures stay distinct", async () => {
  const isolated = await createTestRuntime();
  try {
    const actor = await insertAccountFixture(isolated.database, {
      id: "account_handle_actor",
      handle: "HandleActor",
    });
    await insertAccountFixture(isolated.database, {
      id: "account_handle_holder",
      handle: "TakenHandle",
    });

    const conflict = await isolated.runtime.dispatchFetch("http://localhost/api/auth/account", {
      method: "PATCH",
      headers: {
        ...authHeaders(actor),
        "content-type": "application/json",
      },
      body: JSON.stringify({ handle: "TakenHandle", csrfToken: actor.csrf }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).code, "handle_taken");

    await isolated.database
      .prepare(
        `CREATE TRIGGER fail_handle_update
      BEFORE UPDATE OF handle_normalized ON accounts
      BEGIN
        SELECT RAISE(ABORT, 'simulated_storage_failure');
      END`,
      )
      .run();
    const unavailable = await isolated.runtime.dispatchFetch("http://localhost/api/auth/account", {
      method: "PATCH",
      headers: {
        ...authHeaders(actor),
        "content-type": "application/json",
      },
      body: JSON.stringify({ handle: "AvailableHandle", csrfToken: actor.csrf }),
    });
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, "auth_unavailable");
    assert.equal(
      (
        await isolated.database
          .prepare("SELECT handle FROM accounts WHERE id = 'account_handle_actor'")
          .first()
      ).handle,
      "HandleActor",
    );
  } finally {
    await isolated.runtime.dispose();
  }
});

test("cookie reads reject the wrong scheme", async () => {
  const localMismatch = await runtime.dispatchFetch("https://localhost/api/auth/session", {
    headers: {
      cookie: [
        `sr_session=${member.token}`,
        `sr_csrf=${member.csrf}`,
        `__Host-sr_session=${member.token}`,
        `__Host-sr_csrf=${member.csrf}`,
      ].join("; "),
    },
  });
  assert.deepEqual(await localMismatch.json(), { authenticated: false });

  const isolated = await createTestRuntime({
    bindings: {
      APP_ENVIRONMENT: "production",
      AUTH_RUNTIME_ENV: "production",
      AUTH_APP_ORIGIN: "https://scam-reports.org",
    },
  });
  try {
    const account = await insertAccountFixture(isolated.database, {
      id: "account_secure_cookie",
      handle: "SecureCookieMember",
    });
    const cookie = [
      `__Host-sr_session=${account.token}`,
      `__Host-sr_csrf=${account.csrf}`,
      `sr_session=${account.token}`,
      `sr_csrf=${account.csrf}`,
    ].join("; ");
    const accepted = await isolated.runtime.dispatchFetch(
      "https://scam-reports.org/api/auth/session",
      {
        headers: { cookie },
      },
    );
    assert.equal(accepted.status, 200);
    const payload = await accepted.json();
    assert.equal(payload.authenticated, true);
    assert.equal(payload.account.id, account.id);
    assert.equal(payload.csrfToken, account.csrf);

    const productionMismatch = await isolated.runtime.dispatchFetch(
      "http://internal-worker.invalid/api/auth/session",
      { headers: { cookie } },
    );
    assert.deepEqual(await productionMismatch.json(), { authenticated: false });

    const logout = await isolated.runtime.dispatchFetch(
      "https://scam-reports.org/api/auth/logout",
      {
        method: "POST",
        headers: {
          origin: "https://scam-reports.org",
          cookie,
          "content-type": "application/json",
          "x-csrf-token": account.csrf,
        },
        body: "{}",
      },
    );
    assert.equal(logout.status, 200);
    const clearedCookies = logout.headers.get("set-cookie") ?? "";
    assert.match(clearedCookies, /__Host-sr_session=;/u);
    assert.match(clearedCookies, /__Host-sr_csrf=;/u);
    assert.match(clearedCookies, /Secure/u);
    assert.equal(
      await isolated.database
        .prepare("SELECT id FROM auth_sessions WHERE account_id = ?")
        .bind(account.id)
        .first(),
      null,
    );
  } finally {
    await isolated.runtime.dispose();
  }
});

test("Discord state is hashed and bound to its HttpOnly cookie", async () => {
  const response = await runtime.dispatchFetch(
    "http://localhost/api/auth/discord/start?returnTo=%2Faccount",
    { redirect: "manual" },
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  const state = location.searchParams.get("state");
  assert.ok(state && state.length >= 40);
  assert.equal(location.origin, "https://discord.com");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "http://localhost/api/auth/discord/callback",
  );
  const cookie = response.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^sr_oauth_tx=/u);
  assert.match(cookie, /HttpOnly/u);
  assert.match(cookie, /SameSite=Lax/u);

  const transaction = await database
    .prepare("SELECT state_hash, browser_hash, return_to FROM auth_oauth_transactions LIMIT 1")
    .first();
  assert.equal(transaction.state_hash, sha256Base64Url(state));
  assert.notEqual(transaction.state_hash, state);
  assert.equal(transaction.return_to, "/account");
  assert.notEqual(transaction.browser_hash, cookie.split("=")[1]?.split(";")[0]);
});

test("Discord linking keeps same-origin CSRF", async () => {
  await database.prepare("DELETE FROM auth_oauth_transactions").run();
  const body = new URLSearchParams({
    csrfToken: member.csrf,
    returnTo: "/account?updated=identity",
  });
  const response = await runtime.dispatchFetch("http://localhost/api/auth/discord/start", {
    method: "POST",
    headers: authHeaders(member, {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    }),
    body: body.toString(),
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.match(response.headers.get("set-cookie") ?? "", /^sr_oauth_tx=/u);
  const payload = await response.json();
  const authorizationUrl = new URL(payload.authorizationUrl);
  assert.equal(authorizationUrl.origin, "https://discord.com");
  assert.equal(authorizationUrl.pathname, "/oauth2/authorize");

  const transaction = await database
    .prepare(
      `SELECT mode, account_id, initiating_session_id, return_to
       FROM auth_oauth_transactions LIMIT 1`,
    )
    .first();
  assert.deepEqual(transaction, {
    mode: "link",
    account_id: member.id,
    initiating_session_id: `session_${member.id}`,
    return_to: "/account?updated=identity",
  });

  const rejected = await runtime.dispatchFetch("http://localhost/api/auth/discord/start", {
    method: "POST",
    headers: authHeaders(member, {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      "x-csrf-token": "test-csrf-token-placeholder",
    }),
    body: new URLSearchParams({
      csrfToken: "test-csrf-token-placeholder",
      returnTo: "/account",
    }).toString(),
  });
  assert.equal(rejected.status, 403);
});

test("junk callbacks preserve the Discord start limit", async () => {
  const isolated = await createTestRuntime();
  const headers = { "cf-connecting-ip": "198.51.100.88" };
  try {
    for (let index = 0; index < 25; index += 1) {
      const response = await isolated.runtime.dispatchFetch(
        `http://localhost/api/auth/discord/callback?code=invalid-${index}&state=invalid-${index}`,
        { headers, redirect: "manual" },
      );
      assert.equal(response.status, 303, `callback ${index + 1}`);
      assert.equal(response.headers.get("location"), "/auth/error?code=invalid_callback");
    }

    for (let index = 0; index < 20; index += 1) {
      const response = await isolated.runtime.dispatchFetch(
        "http://localhost/api/auth/discord/start",
        { headers, redirect: "manual" },
      );
      assert.equal(response.status, 302, `start ${index + 1}`);
    }
    const blockedStart = await isolated.runtime.dispatchFetch(
      "http://localhost/api/auth/discord/start",
      { headers, redirect: "manual" },
    );
    assert.equal(blockedStart.status, 429);
    assert.match(blockedStart.headers.get("retry-after") ?? "", /^\d+$/u);
    assert.equal(
      (
        await isolated.database
          .prepare("SELECT COUNT(*) AS count FROM auth_oauth_transactions")
          .first()
      ).count,
      20,
    );
    assert.equal(
      (
        await isolated.database
          .prepare(
            "SELECT COUNT(*) AS count FROM rate_events WHERE scope = 'discord_start_network'",
          )
          .first()
      ).count,
      20,
    );
  } finally {
    await isolated.runtime.dispose();
  }
});

test("magic links are single-use and stored as hashes", async () => {
  const token = "test-magic-link-token-placeholder-tttttttttttttttttttttttttttttttttttttttt";
  const browserSecret =
    "test-magic-browser-context-placeholder-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const tokenHash = sha256Base64Url(token);
  const loginContextHash = sha256Base64Url(browserSecret);
  const now = new Date();
  await database
    .prepare(
      `INSERT INTO auth_magic_links (
      token_hash, account_id, login_context_hash, purpose, subject_hash, subject_encrypted,
      return_to, created_at, expires_at
    ) VALUES (?, NULL, ?, 'login', ?, ?, '/account', ?, ?)`,
    )
    .bind(
      tokenHash,
      loginContextHash,
      "fixture-subject-hash",
      await encryptIdentityForFixture("new-member@example.test"),
      now.toISOString(),
      new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    )
    .run();
  assert.equal(
    await database
      .prepare("SELECT token_hash FROM auth_magic_links WHERE token_hash = ?")
      .bind(token)
      .first(),
    null,
  );

  for (const cookie of [
    null,
    "sr_magic_login=wrong-browser-context-secret-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  ]) {
    const rejected = await runtime.dispatchFetch(
      `http://localhost/api/auth/magic/verify?token=${encodeURIComponent(token)}`,
      {
        redirect: "manual",
        ...(cookie ? { headers: { cookie } } : {}),
      },
    );
    assert.equal(rejected.status, 303);
    assert.equal(rejected.headers.get("location"), "/auth/error?code=browser_context_required");
    assert.notEqual(
      await database
        .prepare("SELECT token_hash FROM auth_magic_links WHERE token_hash = ?")
        .bind(tokenHash)
        .first(),
      null,
    );
  }

  const first = await runtime.dispatchFetch(
    `http://localhost/api/auth/magic/verify?token=${encodeURIComponent(token)}`,
    {
      redirect: "manual",
      headers: { cookie: `sr_magic_login=${browserSecret}` },
    },
  );
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "/account");
  assert.match(first.headers.get("set-cookie") ?? "", /sr_session=/u);
  const providerProof = await database
    .prepare(
      `SELECT discord_confirmed_at, email_confirmed_at
      FROM auth_sessions
      WHERE email_confirmed_at IS NOT NULL AND discord_confirmed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    )
    .first();
  assert.equal(providerProof.discord_confirmed_at, null);
  assert.match(providerProof.email_confirmed_at, /^\d{4}-\d{2}-\d{2}T/u);
  assert.equal(
    await database
      .prepare("SELECT token_hash FROM auth_magic_links WHERE token_hash = ?")
      .bind(tokenHash)
      .first(),
    null,
  );

  const replay = await runtime.dispatchFetch(
    `http://localhost/api/auth/magic/verify?token=${encodeURIComponent(token)}`,
    { redirect: "manual" },
  );
  assert.equal(replay.status, 303);
  assert.equal(replay.headers.get("location"), "/auth/error?code=expired_link");
});

test("staff guards require both providers", async () => {
  const response = await runtime.dispatchFetch("http://localhost/api/admin/evidence", {
    headers: { cookie: moderator.cookie },
  });
  assert.equal(response.status, 403);
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/u);
  assert.equal((await response.json()).code, "staff_identity_required");
});

test("stale moderator auth cannot reach evidence", async () => {
  const timestamp = new Date().toISOString();
  await database
    .prepare(
      `INSERT INTO account_identities (
      id, account_id, provider, subject_hash, subject_encrypted,
      display_hint, verified_at, created_at, last_used_at
    ) VALUES ('id_mod_email', 'account_moderator', 'email', 'email-hash',
      'email-encrypted', 'email test identity', ?, ?, ?)`,
    )
    .bind(timestamp, timestamp, timestamp)
    .run();
  const response = await runtime.dispatchFetch(
    "http://localhost/api/admin/evidence/EVA-00000000-0000-4000-8000-000000000001/original",
    { headers: { cookie: moderator.cookie } },
  );
  assert.equal(response.status, 401);
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/u);
  assert.equal((await response.json()).code, "fresh_auth_required");
});

test("role version changes invalidate old sessions", async () => {
  await database
    .prepare("UPDATE accounts SET role_version = role_version + 1 WHERE id = 'account_member'")
    .run();
  const response = await runtime.dispatchFetch("http://localhost/api/auth/session", {
    headers: { cookie: member.cookie },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { authenticated: false });
  assert.equal(
    await database
      .prepare("SELECT id FROM auth_sessions WHERE account_id = 'account_member'")
      .first(),
    null,
  );
});

test("Turnstile test tokens need both runtime gates", async () => {
  const productionApplication = await createTestRuntime({
    bindings: {
      APP_ENVIRONMENT: "production",
      AUTH_RUNTIME_ENV: "test",
      AUTH_APP_ORIGIN: "https://scam-reports.org",
    },
  });
  try {
    const response = await productionApplication.runtime.dispatchFetch(
      "https://scam-reports.org/api/auth/magic/request",
      {
        method: "POST",
        headers: {
          origin: "https://scam-reports.org",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "turnstile-gate@example.invalid",
          purpose: "login",
          turnstileToken: TEST_BINDINGS.TURNSTILE_TEST_BYPASS_TOKEN,
        }),
      },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "turnstile_unavailable");
  } finally {
    await productionApplication.runtime.dispose();
  }
});

test("magic-link failures use client-specific responses", async () => {
  const isolated = await createTestRuntime({
    bindings: { RESEND_API_KEY: "" },
  });
  try {
    const browserBody = new URLSearchParams({
      email: "browser-error@example.invalid",
      purpose: "login",
      returnTo: "/account",
      "cf-turnstile-response": TEST_BINDINGS.TURNSTILE_TEST_BYPASS_TOKEN,
    });
    const browserResponse = await isolated.runtime.dispatchFetch(
      "http://localhost/api/auth/magic/request",
      {
        method: "POST",
        redirect: "manual",
        headers: {
          origin: "http://localhost",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: browserBody.toString(),
      },
    );
    assert.equal(browserResponse.status, 303);
    assert.equal(browserResponse.headers.get("location"), "/auth/error?code=auth_unavailable");

    const apiResponse = await isolated.runtime.dispatchFetch(
      "http://localhost/api/auth/magic/request",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "api-error@example.invalid",
          purpose: "login",
          turnstileToken: TEST_BINDINGS.TURNSTILE_TEST_BYPASS_TOKEN,
        }),
      },
    );
    assert.equal(apiResponse.status, 503);
    assert.equal((await apiResponse.json()).code, "auth_unavailable");
  } finally {
    await isolated.runtime.dispose();
  }
});

test("bad Resend senders disable email sign-in", async () => {
  const isolated = await createTestRuntime({
    bindings: { RESEND_FROM: "Scam Reports <login@auth.scam-reports.org>>" },
  });
  try {
    const signIn = await isolated.runtime.dispatchFetch("http://localhost/auth/sign-in");
    assert.equal(signIn.status, 200);
    assert.match(await signIn.text(), /Email sign-in is currently unavailable/u);

    const response = await isolated.runtime.dispatchFetch(
      "http://localhost/api/auth/magic/request",
      {
        method: "POST",
        headers: {
          origin: "http://localhost",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: "invalid-sender@example.invalid",
          purpose: "login",
          turnstileToken: TEST_BINDINGS.TURNSTILE_TEST_BYPASS_TOKEN,
        }),
      },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "auth_unavailable");
  } finally {
    await isolated.runtime.dispose();
  }
});
