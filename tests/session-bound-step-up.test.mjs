import assert from "node:assert/strict";
import test from "node:test";
import {
  TEST_BINDINGS,
  authHeaders,
  createTestRuntime,
  insertAccountFixture,
  sha256Base64Url,
} from "./helpers/runtime.mjs";

async function encryptIdentityForFixture(value) {
  const keyBytes = Buffer.from(TEST_BINDINGS.IDENTITY_ENCRYPTION_KEY, "base64url");
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  );
  return `v1.${Buffer.from(iv).toString("base64url")}.${Buffer.from(ciphertext).toString("base64url")}`;
}

function sessionCookies(response) {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const session = /(?:^|,\s*)sr_session=([^;,\s]+)/u.exec(setCookie)?.[1];
  const csrf = /(?:^|,\s*)sr_csrf=([^;,\s]+)/u.exec(setCookie)?.[1];
  assert.ok(session, `Missing rotated session cookie in ${setCookie}`);
  assert.ok(csrf, `Missing rotated CSRF cookie in ${setCookie}`);
  return {
    csrf: decodeURIComponent(csrf),
    cookie: `sr_session=${session}; sr_csrf=${csrf}`,
  };
}

test("provider confirmations cannot cross sessions", async () => {
  const application = await createTestRuntime();
  try {
    const now = new Date();
    const timestamp = now.toISOString();
    const admin = await insertAccountFixture(application.database, {
      id: `account_${"e".repeat(32)}`,
      handle: "SplitProofAdmin",
      role: "admin",
      providers: ["discord", "email"],
      confirmedProviders: ["discord"],
      authenticatedAt: timestamp,
    });
    const target = await insertAccountFixture(application.database, {
      id: `account_${"1".repeat(32)}`,
      handle: "SplitProofTarget",
      providers: ["discord", "email"],
    });
    const emailToken = "test-email-token-placeholder-000000000000000000000000000000000000";
    const emailCsrf = `split-email-${"c".repeat(48)}`;
    await application.database
      .prepare(
        `INSERT INTO auth_sessions (
        id, account_id, token_hash, csrf_token_hash, role_version,
        authenticated_at, discord_confirmed_at, email_confirmed_at,
        created_at, last_seen_at, idle_expires_at, absolute_expires_at
      ) VALUES (?, ?, ?, ?, 1, ?, NULL, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "session_split_email",
        admin.id,
        sha256Base64Url(emailToken),
        sha256Base64Url(emailCsrf),
        timestamp,
        timestamp,
        timestamp,
        timestamp,
        new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      )
      .run();
    const emailSession = {
      csrf: emailCsrf,
      cookie: `sr_session=${emailToken}; sr_csrf=${emailCsrf}`,
    };

    for (const actingSession of [admin, emailSession]) {
      const response = await application.runtime.dispatchFetch(
        "http://localhost/api/admin/accounts",
        {
          method: "PATCH",
          headers: authHeaders(actingSession, { "content-type": "application/json" }),
          body: JSON.stringify({ id: target.id, role: "moderator", status: "active" }),
        },
      );
      assert.equal(response.status, 401);
      assert.equal((await response.json()).code, "dual_confirmation_required");
    }
    assert.equal(
      await application.database
        .prepare("SELECT role FROM accounts WHERE id = ?")
        .bind(target.id)
        .first("role"),
      "member",
    );
  } finally {
    await application.runtime.dispose();
  }
});

test("same-session linking completes dual confirmation", async () => {
  const application = await createTestRuntime();
  try {
    const admin = await insertAccountFixture(application.database, {
      id: `account_${"a".repeat(32)}`,
      handle: "LinkedProofAdmin",
      role: "admin",
      providers: ["discord"],
      confirmedProviders: ["discord"],
    });
    const target = await insertAccountFixture(application.database, {
      id: `account_${"b".repeat(32)}`,
      handle: "LinkedProofTarget",
      providers: ["discord", "email"],
    });
    const token = "test-magic-link-token-placeholder-pppppppppppppppppppppppppppppppppppppppp";
    const now = new Date();
    await application.database
      .prepare(
        `INSERT INTO auth_magic_links (
        token_hash, account_id, initiating_session_id, purpose, subject_hash,
        subject_encrypted, return_to, created_at, expires_at
      ) VALUES (?, ?, ?, 'link', ?, ?, '/admin', ?, ?)`,
      )
      .bind(
        sha256Base64Url(token),
        admin.id,
        `session_${admin.id}`,
        "new-email-subject-hash",
        await encryptIdentityForFixture("linked-admin@example.test"),
        now.toISOString(),
        new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      )
      .run();

    const verified = await application.runtime.dispatchFetch(
      `http://localhost/api/auth/magic/verify?token=${encodeURIComponent(token)}`,
      { headers: { cookie: admin.cookie }, redirect: "manual" },
    );
    assert.equal(verified.status, 303);
    assert.equal(verified.headers.get("location"), "/admin");
    const rotated = sessionCookies(verified);
    const proof = await application.database
      .prepare(
        `SELECT discord_confirmed_at, email_confirmed_at
        FROM auth_sessions WHERE account_id = ?`,
      )
      .bind(admin.id)
      .first();
    assert.match(proof.discord_confirmed_at, /^\d{4}-\d{2}-\d{2}T/u);
    assert.match(proof.email_confirmed_at, /^\d{4}-\d{2}-\d{2}T/u);

    const accepted = await application.runtime.dispatchFetch(
      "http://localhost/api/admin/accounts",
      {
        method: "PATCH",
        headers: authHeaders(rotated, { "content-type": "application/json" }),
        body: JSON.stringify({ id: target.id, role: "moderator", status: "active" }),
      },
    );
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.equal(
      await application.database
        .prepare("SELECT role FROM accounts WHERE id = ?")
        .bind(target.id)
        .first("role"),
      "moderator",
    );
  } finally {
    await application.runtime.dispose();
  }
});
