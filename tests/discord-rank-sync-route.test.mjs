import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { authHeaders, createTestRuntime, insertAccountFixture } from "./helpers/runtime.mjs";

let runtime;
let database;
let linkedMember;
let emailOnlyMember;

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  linkedMember = await insertAccountFixture(database, {
    id: "account_discord_sync_route_linked",
    handle: "LinkedRankMember",
    providers: ["discord", "email"],
  });
  emailOnlyMember = await insertAccountFixture(database, {
    id: "account_discord_sync_route_email",
    handle: "EmailOnlyRankMember",
    providers: ["email"],
  });
});

after(async () => runtime?.dispose());

async function postSync(account, csrfToken = account.csrf) {
  return runtime.dispatchFetch("http://localhost/api/auth/discord/rank-sync", {
    method: "POST",
    headers: authHeaders(account, {
      "content-type": "application/x-www-form-urlencoded",
      "x-csrf-token": "",
    }),
    body: new URLSearchParams({ csrfToken }).toString(),
    redirect: "manual",
  });
}

test("members can queue only their own rank sync", async () => {
  const beforeRow = await database
    .prepare("SELECT generation FROM discord_rank_sync WHERE account_id = ?")
    .bind(linkedMember.id)
    .first();

  const response = await postSync(linkedMember);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/account?updated=discord-rank");

  const afterRow = await database
    .prepare(
      "SELECT account_id, generation, status, attempts FROM discord_rank_sync WHERE account_id = ?",
    )
    .bind(linkedMember.id)
    .first();
  assert.equal(afterRow.account_id, linkedMember.id);
  assert.equal(afterRow.generation, Number(beforeRow.generation) + 1);
  assert.equal(afterRow.status, "pending");
  assert.equal(afterRow.attempts, 0);
});

test("rank sync checks CSRF and Discord identity", async () => {
  const csrfFailure = await postSync(linkedMember, "wrong-token");
  assert.equal(csrfFailure.status, 403);
  assert.equal((await csrfFailure.json()).code, "invalid_csrf");

  const missingIdentity = await postSync(emailOnlyMember);
  assert.equal(missingIdentity.status, 409);
  assert.equal((await missingIdentity.json()).code, "discord_not_linked");
});
