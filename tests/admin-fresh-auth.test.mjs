import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";
import {
  authHeaders,
  createTestRuntime,
  insertAccountFixture,
  insertReportFixture,
  projectRoot,
} from "./helpers/runtime.mjs";

let runtime;
let database;
let freshModerator;
let staleModerator;
let freshAdmin;
let staleAdmin;

const staleAuthenticatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();

async function routeFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await routeFiles(entryPath)));
    else if (entry.isFile() && entry.name === "route.ts") files.push(entryPath);
  }
  return files;
}

async function expectFreshAuth(pathname, account, init = {}) {
  const response = await runtime.dispatchFetch(`http://localhost${pathname}`, {
    ...init,
    headers: authHeaders(account, init.headers),
  });
  const payload = await response.json();
  assert.equal(response.status, 401, `${init.method ?? "GET"} ${pathname}`);
  assert.equal(payload.code, "fresh_auth_required", `${init.method ?? "GET"} ${pathname}`);
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/u);
}

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  freshModerator = await insertAccountFixture(database, {
    id: "account_fresh_auth_moderator",
    handle: "FreshAuthModerator",
    role: "moderator",
    providers: ["discord", "email"],
  });
  staleModerator = await insertAccountFixture(database, {
    id: "account_stale_auth_moderator",
    handle: "StaleAuthModerator",
    role: "moderator",
    providers: ["discord", "email"],
    authenticatedAt: staleAuthenticatedAt,
  });
  freshAdmin = await insertAccountFixture(database, {
    id: "account_fresh_auth_admin",
    handle: "FreshAuthAdmin",
    role: "admin",
    providers: ["discord", "email"],
  });
  staleAdmin = await insertAccountFixture(database, {
    id: "account_stale_auth_admin",
    handle: "StaleAuthAdmin",
    role: "admin",
    providers: ["discord", "email"],
    authenticatedAt: staleAuthenticatedAt,
  });
  await insertReportFixture(database, {
    id: "SR-FRESH-AUTH-0001",
    username: "FreshAuthCanonical",
    discordId: "100000000000000091",
  });
  await insertReportFixture(database, {
    id: "SR-FRESH-AUTH-0002",
    username: "FreshAuthDuplicate",
    discordId: "100000000000000091",
  });
});

after(async () => runtime?.dispose());

test("admin routes use fresh session guards", async () => {
  const files = await routeFiles(path.join(projectRoot, "app", "api", "admin"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const source = await readFile(file, "utf8");
    const handlers = [
      ...source.matchAll(/export async function (?:GET|POST|PUT|PATCH|DELETE)\b/gu),
    ];
    const freshGuard =
      /(?:require(?:Moderator|Admin)\(\s*request\s*,\s*\{\s*fresh:\s*true(?:\s*,[^}]*)?\s*\}\s*\)|requireFreshModerator\(\s*request(?:\s*,[^)]*)?\)|requireConfirmedAdminMutation\(\s*request\s*\))/u;
    for (const [index, handler] of handlers.entries()) {
      const handlerSource = source.slice(
        handler.index,
        handlers[index + 1]?.index ?? source.length,
      );
      assert.match(
        handlerSource,
        freshGuard,
        `${path.relative(projectRoot, file)} handler ${handler[0]} must have a fresh guard`,
      );
    }
  }
});

test("destructive admin routes use the confirmed mutation guard", async () => {
  const required = [
    ["accounts/route.ts", ["PATCH", "DELETE"]],
    ["reports/route.ts", ["DELETE"]],
    ["reviews/route.ts", ["DELETE"]],
    ["comments/route.ts", ["DELETE"]],
    ["appeals/route.ts", ["DELETE"]],
    ["report-submissions/route.ts", ["DELETE"]],
    ["evidence/[id]/route.ts", ["DELETE"]],
  ];
  const confirmedMutationGuard = /requireConfirmedAdminMutation\(\s*request\s*\)/u;
  for (const [relative, methods] of required) {
    const source = await readFile(path.join(projectRoot, "app", "api", "admin", relative), "utf8");
    const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\b/gu)];
    for (const method of methods) {
      const handler = handlers.find((match) => match[1] === method);
      assert.ok(handler, `${relative} ${method} must exist`);
      const handlerSource = source.slice(
        handler.index,
        handlers[handlers.indexOf(handler) + 1]?.index ?? source.length,
      );
      assert.match(
        handlerSource,
        confirmedMutationGuard,
        `${relative} ${method} must use the confirmed admin mutation guard`,
      );
    }
  }
});

test("confirmed admin mutations enforce the fixed check order", async () => {
  const source = await readFile(path.join(projectRoot, "lib", "admin-mutation-auth.ts"), "utf8");
  const declaration = source.indexOf("export async function requireConfirmedAdminMutation");
  assert.ok(declaration >= 0);
  const guard = source.slice(declaration);
  assert.match(
    guard,
    /requireConfirmedAdminMutation\(\s*request:\s*Request,?\s*\):\s*Promise<AuthPrincipal>/u,
  );
  const freshAdmin = guard.indexOf("requireAdmin(request, { fresh: true })");
  const csrf = guard.indexOf("assertCsrf(request)");
  const dualConfirmation = guard.indexOf("requireRecentDualProviderConfirmation(principal)");
  const returnedPrincipal = guard.indexOf("return principal");
  assert.ok(freshAdmin >= 0);
  assert.ok(freshAdmin < csrf);
  assert.ok(csrf < dualConfirmation);
  assert.ok(dualConfirmation < returnedPrincipal);
});

test("stale staff sessions cannot read admin queues", async () => {
  for (const pathname of ["/api/admin/reports", "/api/admin/evidence"]) {
    await expectFreshAuth(pathname, staleModerator);
    await expectFreshAuth(pathname, staleAdmin);
  }
  for (const pathname of [
    "/api/admin/operations/backups",
    "/api/admin/operations/notifications",
    "/api/admin/operations/security-events",
  ]) {
    await expectFreshAuth(pathname, staleAdmin);
  }
});

test("fresh staff sessions can read their queues", async () => {
  for (const [pathname, account] of [
    ["/api/admin/reports", freshModerator],
    ["/api/admin/evidence", freshModerator],
    ["/api/admin/reports", freshAdmin],
    ["/api/admin/evidence", freshAdmin],
    ["/api/admin/operations/backups", freshAdmin],
    ["/api/admin/operations/notifications", freshAdmin],
    ["/api/admin/operations/security-events", freshAdmin],
  ]) {
    const response = await runtime.dispatchFetch(`http://localhost${pathname}`, {
      headers: authHeaders(account),
    });
    assert.equal(response.status, 200, `${pathname}: ${await response.clone().text()}`);
  }
});

test("moderation writes require a fresh session", async () => {
  const body = JSON.stringify({
    duplicateId: "SR-FRESH-AUTH-0002",
    canonicalId: "SR-FRESH-AUTH-0001",
  });
  await expectFreshAuth("/api/admin/merge", staleModerator, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(
    await database
      .prepare("SELECT merged_into_report_id FROM reports WHERE id = ?")
      .bind("SR-FRESH-AUTH-0002")
      .first("merged_into_report_id"),
    null,
  );

  const accepted = await runtime.dispatchFetch("http://localhost/api/admin/merge", {
    method: "POST",
    headers: authHeaders(freshModerator, { "content-type": "application/json" }),
    body,
  });
  assert.equal(accepted.status, 200, await accepted.clone().text());
  assert.equal(
    await database
      .prepare("SELECT merged_into_report_id FROM reports WHERE id = ?")
      .bind("SR-FRESH-AUTH-0002")
      .first("merged_into_report_id"),
    "SR-FRESH-AUTH-0001",
  );
});
