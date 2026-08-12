import { expect, test } from "./fixtures";
import { installTurnstileToken, setFixtureSession } from "./support";

const reportId = "SR-E2E-0052";

test("moderator accepts a member report", async ({ page, context }) => {
  const reportedUsername = "E2EIntakeSubject";
  await setFixtureSession(context, "e2e_member");
  await page.goto("/submit");

  await page.getByLabel("Contact email optional").fill("intake-member@example.invalid");
  await page.getByLabel("Discord username").fill(reportedUsername);
  await page.getByLabel("Discord user ID").fill("920000000000000001");
  await page.getByLabel("Game, product, or community").fill("Synthetic Browser Arena");
  await page.getByLabel("Report category").selectOption("Cheating");
  await page
    .getByLabel("Short summary")
    .fill("Synthetic E2E claim submitted only to exercise the private moderation queue.");
  await page
    .getByLabel("Full timeline")
    .fill(
      "This browser-only fixture describes a synthetic interaction in enough detail to pass validation. It does not identify or accuse any real person.",
    );
  await page.getByRole("checkbox").check();
  await installTurnstileToken(page, ".intake-form");
  await page.getByRole("button", { name: "Submit report for review" }).click();

  const receipt = page.locator(".submission-receipt");
  await expect(receipt).toContainText("Submission received");
  const submissionId = (await receipt.locator("strong").textContent())?.trim();
  expect(submissionId).toMatch(/^SUB-/u);

  await setFixtureSession(context, "e2e_moderator");
  await page.goto("/admin");
  const intakeRow = page
    .locator(".report-intake-table tbody tr")
    .filter({ hasText: reportedUsername });
  await expect(intakeRow).toContainText(submissionId!);
  await expect(intakeRow).toContainText("Pending");

  await intakeRow.getByRole("button", { name: "Accept" }).click();
  const submissionDialog = page.getByRole("dialog", { name: "Mark submission Accepted" });
  await expect(submissionDialog).toBeVisible();
  await submissionDialog
    .getByLabel("Private moderator note")
    .fill("Reviewed by the local E2E moderator.");
  await submissionDialog.getByRole("button", { name: "Mark Accepted" }).click();
  await expect(page.locator(".form-success")).toContainText(`${submissionId} was marked Accepted`);

  const persisted = await page.evaluate(async (id) => {
    const response = await fetch("/api/admin/report-submissions?page=1", {
      cache: "no-store",
    });
    const payload = (await response.json()) as {
      submissions?: Array<{ id: string; status: string }>;
    };
    return payload.submissions?.find((submission) => submission.id === id) ?? null;
  }, submissionId);
  expect(persisted).toEqual(expect.objectContaining({ id: submissionId, status: "Accepted" }));
});

test("moderator publishes a review and reply", async ({ page, context }) => {
  const reviewTitle = "Browser-tested direct experience";
  const reviewBody =
    "This is a synthetic browser review with enough factual context for validation and moderation testing only.";
  const commentBody =
    "This synthetic browser reply adds relevant context and exists only to test the moderation workflow.";

  await setFixtureSession(context, "e2e_member");
  await page.goto(`/reports/${reportId}`);

  await page.getByLabel("Your relationship").selectOption("Researcher");
  await page.getByLabel("Reputation rating").selectOption("4");
  await page.getByLabel("Review title").fill(reviewTitle);
  await page.getByLabel("What happened?").fill(reviewBody);
  await installTurnstileToken(page, ".review-form:not(.discussion-form)");
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.locator(".review-form:not(.discussion-form) .form-success")).toContainText(
    "Review received. It is waiting for approval.",
  );

  await page.getByLabel("Your reply").fill(commentBody);
  await installTurnstileToken(page, ".discussion-form");
  await page.getByRole("button", { name: "Send reply for review" }).click();
  await expect(page.locator(".discussion-form .form-success")).toContainText(
    "Reply received. It is waiting for approval.",
  );

  await setFixtureSession(context, "e2e_moderator");
  await page.goto("/admin");
  const reviewRow = page.locator(".review-admin-table tbody tr").filter({ hasText: reviewTitle });
  await expect(reviewRow).toContainText("Pending");
  await reviewRow.getByRole("button", { name: "Approve" }).click();
  const reviewDialog = page.getByRole("dialog", { name: "Approved community review" });
  await expect(reviewDialog).toBeVisible();
  await reviewDialog.getByLabel("Private moderator note").fill("Approved by browser E2E.");
  await reviewDialog.getByRole("button", { name: "Approved" }).click();
  await expect(page.locator(".form-success")).toContainText("was approved");

  const commentRow = page
    .locator(".comment-intake-table tbody tr")
    .filter({ hasText: commentBody });
  await expect(commentRow).toContainText("Pending");
  await commentRow.getByRole("button", { name: "Approve" }).click();
  const commentDialog = page.getByRole("dialog", { name: "Approved discussion reply" });
  await expect(commentDialog).toBeVisible();
  await commentDialog.getByLabel("Private moderator note").fill("Approved by browser E2E.");
  await commentDialog.getByRole("button", { name: "Approved" }).click();
  await expect(page.locator(".form-success")).toContainText("was approved");
  await expect(commentRow.getByRole("button", { name: "Reject" })).toBeEnabled();

  await context.clearCookies();
  await page.goto(`/reports/${reportId}`);
  await expect(page.getByRole("heading", { name: reviewTitle })).toBeVisible();
  await expect(page.getByText(reviewBody, { exact: true })).toBeVisible();
  await expect(page.getByText(commentBody, { exact: true })).toBeVisible();

  const publicState = await page.evaluate(async (id) => {
    const [reviewsResponse, commentsResponse] = await Promise.all([
      fetch(`/api/reviews?reportId=${encodeURIComponent(id)}`),
      fetch(`/api/comments?reportId=${encodeURIComponent(id)}`),
    ]);
    return {
      reviews: (
        (await reviewsResponse.json()) as { reviews: Array<{ title: string; status: string }> }
      ).reviews,
      comments: (
        (await commentsResponse.json()) as { comments: Array<{ body: string; status: string }> }
      ).comments,
    };
  }, reportId);
  expect(publicState.reviews).toEqual(
    expect.arrayContaining([expect.objectContaining({ title: reviewTitle, status: "Approved" })]),
  );
  expect(publicState.comments).toEqual(
    expect.arrayContaining([expect.objectContaining({ body: commentBody, status: "Approved" })]),
  );
});

test("another moderator resolves a member appeal", async ({ page, context }) => {
  const resolution =
    "The synthetic E2E correction was reviewed and this public resolution confirms the browser workflow.";
  await setFixtureSession(context, "e2e_member");
  await page.goto(`/appeals?report=${reportId}`);
  await page.getByLabel("Request type").selectOption("Correction");
  await expect(page.getByLabel("Submitting as")).toHaveValue("E2EMember");
  await page.getByLabel("Relationship to the report").selectOption("Other");
  await page.getByLabel("Contact email").fill("appeal-requester@example.invalid");
  await page
    .getByLabel("What needs another look?")
    .fill(
      "This is a synthetic correction request with sufficient detail for the browser test. It disputes no real person and asks only for local fixture review.",
    );
  await page.getByRole("checkbox").check();
  await installTurnstileToken(page, ".intake-form");
  await page.getByRole("button", { name: "Submit correction or appeal" }).click();

  const receipt = page.locator(".submission-receipt");
  await expect(receipt).toContainText("Request received");
  const appealId = (await receipt.locator("strong").textContent())?.trim();
  expect(appealId).toMatch(/^APL-/u);

  await setFixtureSession(context, "e2e_moderator");
  await page.goto("/admin");
  const appealRow = page.locator(".appeal-intake-table tbody tr").filter({ hasText: appealId! });
  await expect(appealRow).toContainText("Pending");

  await appealRow.getByRole("button", { name: "Accept" }).click();
  const appealDialog = page.getByRole("dialog", { name: "Mark appeal Accepted" });
  await expect(appealDialog).toBeVisible();
  await appealDialog.getByLabel("Private moderator note").fill("Resolved by local E2E moderation.");
  await appealDialog.getByLabel("Public resolution").fill(resolution);
  await appealDialog.getByRole("button", { name: "Mark Accepted" }).click();
  await expect(page.locator(".form-success")).toContainText(`${appealId} was marked Accepted`);
  await expect(appealRow.getByRole("button", { name: "Reject" })).toBeEnabled();

  await context.clearCookies();
  const publicAppeal = await page.evaluate(async (id) => {
    const response = await fetch(`/api/appeals?reportId=${encodeURIComponent(id)}`);
    return (await response.json()) as {
      resolutions: Array<{ id: string; publicResolution: string }>;
    };
  }, reportId);
  expect(publicAppeal.resolutions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: appealId, publicResolution: resolution }),
    ]),
  );

  await page.goto(`/reports/${reportId}`);
  await expect(page.getByText(resolution, { exact: true })).toBeVisible();
});
