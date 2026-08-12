import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import {
  TURNSTILE_BYPASS,
  authHeaders,
  createTestRuntime,
  dispatchForm,
  insertAccountFixture,
  insertReportFixture,
} from "./helpers/runtime.mjs";

let runtime;
let database;
let member;

function reportForm(suffix) {
  const form = new FormData();
  form.set("csrfToken", member.csrf);
  form.set("cf-turnstile-response", TURNSTILE_BYPASS);
  form.set("submitterName", "Ignored Display Name");
  form.set("contactEmail", "reporter@example.test");
  form.set("username", `ReportedUser${suffix}`);
  form.set("discordId", `1000000000000000${suffix}`.slice(0, 18));
  form.set("game", "Test Arena");
  form.set("category", "Cheating");
  form.set("reason", "Repeated suspicious gameplay requires a moderator review.");
  form.set(
    "description",
    `Submission ${suffix} is synthetic test data with enough chronological context for private moderator review.`,
  );
  form.set("relatedReportId", "");
  form.set("consent", "true");
  form.set("website", "");
  return form;
}

before(async () => {
  ({ runtime, database } = await createTestRuntime());
  for (let index = 1; index <= 30; index += 1) {
    const value = String(index).padStart(4, "0");
    await insertReportFixture(database, {
      id: `SR-TEST-${value}`,
      username: index === 30 ? "NeedleTarget" : `FixtureUser${value}`,
      discordId: `10000000000000${String(index).padStart(4, "0")}`,
      category: index % 2 ? "Cheating" : "Marketplace Scam",
      status: index % 3 === 0 ? "Confirmed" : "Reported",
      dateAdded: `2026-07-${String(Math.min(index, 28)).padStart(2, "0")}`,
      views: index * 10,
      isPublished: index !== 29,
    });
  }
  member = await insertAccountFixture(database, {
    id: "directory_member",
    handle: "DirectoryMember",
    role: "member",
    providers: ["email"],
  });
});

after(async () => runtime?.dispose());

test("server renders the forum index", async () => {
  const response = await runtime.dispatchFetch("http://localhost/", {
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/iu);
  const html = await response.text();
  assert.match(html, /Scam-Reports\.org/u);
  assert.match(html, /brand\/scam-reports-wordmark\.webp/u);
  assert.match(html, />Reports</u);
  assert.doesNotMatch(html, /Source code|Source publication pending/u);
  assert.match(html, /FixtureUser/u);
  assert.doesNotMatch(html, /moderator_notes|author_fingerprint|Local demo administrator/iu);
});

test("community pages show the rules and links", async () => {
  const community = await runtime.dispatchFetch("http://localhost/community", {
    headers: { accept: "text/html" },
  });
  assert.equal(community.status, 200);
  assert.match(community.headers.get("content-type") ?? "", /^text\/html\b/iu);
  const communityHtml = await community.text();
  assert.match(communityHtml, /Community and Open Source/u);
  assert.match(communityHtml, /href="\/community\/ranks"/u);
  assert.match(communityHtml, /href="\/account"/u);
  assert.match(communityHtml, /doesn[^<]*add review weight[^<]*unlock staff tools/iu);
  assert.match(
    communityHtml,
    /don[^<]*t sell premium accounts[^<]*ranks[^<]*moderation[^<]*evidence access/iu,
  );
  assert.match(communityHtml, /Free access and non-profit operation are separate policies/iu);
  assert.match(
    communityHtml,
    /Source links will appear[^<]*repo[^<]*matching release archive[^<]*public/iu,
  );
  assert.doesNotMatch(communityHtml, /github\.com\/scamreportsorg/iu);

  const ranks = await runtime.dispatchFetch("http://localhost/community/ranks", {
    headers: { accept: "text/html" },
  });
  assert.equal(ranks.status, 200);
  const ranksHtml = await ranks.text();
  for (const rank of [
    "Newcomer",
    "Contributor",
    "Regular",
    "Senior Contributor",
    "Veteran",
    "Community Guardian",
  ]) {
    assert.match(ranksHtml, new RegExp(rank, "u"));
  }
  assert.match(ranksHtml, /Moderator and admin access always goes through the staff process/iu);
});

test("privacy and security pages are public", async () => {
  const privacy = await runtime.dispatchFetch("http://localhost/privacy", {
    headers: { accept: "text/html" },
  });
  assert.equal(privacy.status, 200);
  const privacyHtml = await privacy.text();
  assert.match(privacyHtml, /don[^<]*t sell personal data/iu);
  assert.match(privacyHtml, /Discord OAuth/iu);
  assert.match(privacyHtml, /90 days/iu);
  assert.match(privacyHtml, /href="\/appeals"/u);

  const security = await runtime.dispatchFetch("http://localhost/security", {
    headers: { accept: "text/html" },
  });
  assert.equal(security.status, 200);
  const securityHtml = await security.text();
  assert.match(securityHtml, /\[SECURITY\]/u);
  assert.match(securityHtml, /scam\.reports\.org@gmail\.com/u);
  assert.match(securityHtml, /denial-of-service/iu);

  const securityTxt = await readFile("public/.well-known/security.txt", "utf8");
  assert.match(securityTxt, /^Contact: mailto:/mu);
  assert.match(
    securityTxt,
    /^Canonical: https:\/\/scam-reports\.org\/\.well-known\/security\.txt$/mu,
  );
  assert.match(securityTxt, /^Expires: 2027-/mu);
});

test("public reports API is compact and paginated", async () => {
  const first = await runtime.dispatchFetch("http://localhost/api/reports");
  assert.equal(first.status, 200);
  const pageOne = await first.json();
  assert.equal(pageOne.items.length, 25);
  assert.deepEqual(pageOne.pagination, {
    page: 1,
    pageSize: 25,
    totalItems: 29,
    totalPages: 2,
  });
  assert.ok(pageOne.items.every((item) => item.id.startsWith("SR-")));
  assert.ok(pageOne.items.every((item) => !("description" in item)));
  assert.ok(pageOne.items.every((item) => !("moderatorNotes" in item)));
  assert.ok(pageOne.items.every((item) => !("evidence" in item)));
  assert.ok(JSON.stringify(pageOne).length < 200_000);

  const second = await runtime.dispatchFetch("http://localhost/api/reports?page=2");
  const pageTwo = await second.json();
  assert.equal(pageTwo.items.length, 4);
  assert.equal(pageTwo.pagination.page, 2);

  const filtered = await runtime.dispatchFetch(
    "http://localhost/api/reports?status=Confirmed&category=Cheating&sort=oldest&page=1",
  );
  const filteredPayload = await filtered.json();
  assert.ok(filteredPayload.items.length > 0);
  assert.ok(filteredPayload.items.every((item) => item.status === "Confirmed"));
  assert.ok(filteredPayload.items.every((item) => item.category === "Cheating"));

  const searched = await runtime.dispatchFetch("http://localhost/api/reports?q=NeedleTarget");
  const searchPayload = await searched.json();
  assert.equal(searchPayload.items.length, 1);
  assert.equal(searchPayload.items[0].username, "NeedleTarget");
});

test("report pages return 404 when missing", async () => {
  const found = await runtime.dispatchFetch("http://localhost/reports/SR-TEST-0030", {
    headers: { accept: "text/html" },
  });
  assert.equal(found.status, 200);
  assert.match(await found.text(), /NeedleTarget/u);

  const missing = await runtime.dispatchFetch("http://localhost/reports/SR-TEST-NOT-FOUND", {
    headers: { accept: "text/html" },
  });
  assert.equal(missing.status, 404);
});

test("community writes require an account", async () => {
  const report = await dispatchForm(runtime, "/api/report-submissions", reportForm("91"), {
    origin: "http://localhost",
  });
  assert.equal(report.status, 401);

  for (const [pathname, body] of [
    [
      "/api/reviews",
      {
        reportId: "SR-TEST-0030",
        displayName: "Anonymous",
        rating: 3,
        relationship: "Player",
        title: "Synthetic neutral review",
        body: "This synthetic review exists only to verify member authentication controls.",
        website: "",
        turnstileToken: TURNSTILE_BYPASS,
      },
    ],
    [
      "/api/comments",
      {
        reportId: "SR-TEST-0030",
        parentId: "",
        displayName: "Anonymous",
        body: "This synthetic comment is long enough to satisfy validation.",
        website: "",
        turnstileToken: TURNSTILE_BYPASS,
      },
    ],
  ]) {
    const response = await runtime.dispatchFetch(`http://localhost${pathname}`, {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 401, pathname);
  }
});

test("report intake checks abuse controls", async () => {
  const wrongCsrf = reportForm("92");
  wrongCsrf.set("csrfToken", "wrong-token");
  const rejected = await dispatchForm(
    runtime,
    "/api/report-submissions",
    wrongCsrf,
    authHeaders(member),
  );
  assert.equal(rejected.status, 403);

  for (const suffix of ["01", "02"]) {
    const response = await dispatchForm(
      runtime,
      "/api/report-submissions",
      reportForm(suffix),
      authHeaders(member),
    );
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.equal(payload.submission.status, "Pending");
  }
  const limited = await dispatchForm(
    runtime,
    "/api/report-submissions",
    reportForm("03"),
    authHeaders(member),
  );
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/u);
  assert.equal(
    (await database.prepare("SELECT COUNT(*) AS count FROM report_submissions").first()).count,
    2,
  );
  assert.equal(
    (
      await database
        .prepare("SELECT COUNT(*) AS count FROM rate_events WHERE scope = 'report'")
        .first()
    ).count,
    2,
  );
});

test("review edits preserve the approved version", async () => {
  const base = {
    reportId: "SR-TEST-0030",
    displayName: "Ignored Name",
    rating: 4,
    relationship: "Player",
    title: "Synthetic first-hand review",
    body: "This synthetic first-hand account exists only to test moderated revisions safely.",
    website: "",
    csrfToken: member.csrf,
    turnstileToken: TURNSTILE_BYPASS,
  };
  const first = await runtime.dispatchFetch("http://localhost/api/reviews", {
    method: "POST",
    headers: authHeaders(member, { "content-type": "application/json" }),
    body: JSON.stringify(base),
  });
  const created = await first.json();
  assert.equal(first.status, 201, JSON.stringify(created));
  const revisionOne = await database
    .prepare("SELECT pending_revision_id FROM reviews WHERE id = ?")
    .bind(created.review.id)
    .first();
  assert.ok(revisionOne.pending_revision_id);

  await database
    .prepare(`UPDATE review_revisions SET status = 'Approved' WHERE id = ?`)
    .bind(revisionOne.pending_revision_id)
    .run();
  await database
    .prepare(
      `UPDATE reviews SET status = 'Approved', approved_revision_id = pending_revision_id,
      pending_revision_id = NULL WHERE id = ?`,
    )
    .bind(created.review.id)
    .run();

  const edit = await runtime.dispatchFetch("http://localhost/api/reviews", {
    method: "POST",
    headers: authHeaders(member, { "content-type": "application/json" }),
    body: JSON.stringify({ ...base, rating: 2, title: "Synthetic edited review" }),
  });
  assert.equal(edit.status, 201);
  const row = await database
    .prepare(
      "SELECT status, approved_revision_id, pending_revision_id, rating FROM reviews WHERE id = ?",
    )
    .bind(created.review.id)
    .first();
  assert.equal(row.status, "Approved");
  assert.equal(row.rating, 4);
  assert.ok(row.approved_revision_id);
  assert.ok(row.pending_revision_id);
  assert.notEqual(row.approved_revision_id, row.pending_revision_id);
});
