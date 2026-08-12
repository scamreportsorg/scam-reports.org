import { expect, test } from "./fixtures";
import { installTurnstileToken, setFixtureSession } from "./support";

const applicationForm = ".moderator-application-form";

async function fillApplication(page: import("@playwright/test").Page, suffix: string) {
  await page
    .getByLabel("Why do you want to moderate Scam-Reports.org?")
    .fill(
      `I want to help keep reports accurate, explain decisions carefully, and protect the community from abuse. ${suffix}`,
    );
  await page
    .getByLabel("Relevant moderation or community experience")
    .fill(
      `I have moderated gaming communities, handled disputes calmly, documented decisions, and escalated conflicts when necessary. ${suffix}`,
    );
  await page.getByLabel("Timezone").fill("UTC+2 / Europe/Vienna");
  await page.getByLabel("Languages").fill("English, German");
  await page
    .getByLabel("Typical weekly availability")
    .fill("Eight to ten hours per week, usually during weekday evenings and weekends.");
  await page.getByLabel("Conflicts of interest").fill("None.");
  await page.getByRole("checkbox", { name: /These answers are accurate/u }).check();
  await installTurnstileToken(page, applicationForm);
}

test("moderator application flow works", async ({ page, context }) => {
  await setFixtureSession(context, "e2e_application_member");
  await page.goto("/account");

  await expect(page.getByRole("heading", { name: "Moderator applications" })).toBeVisible();
  await fillApplication(page, "Initial browser application.");
  await page.getByRole("button", { name: "Send private application" }).click();

  await expect(page.getByText("Pending", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Initial browser application", { exact: false }).first(),
  ).toBeVisible();
  await expect(page.locator(applicationForm)).toHaveCount(0);

  await page.getByRole("button", { name: "Withdraw application" }).click();
  await page.getByRole("button", { name: "Confirm withdrawal" }).click();
  await expect(page.getByText("Withdrawn", { exact: true })).toBeVisible();
  await expect(page.locator(applicationForm)).toBeVisible();

  await fillApplication(page, "Second browser application for staff review.");
  await page.getByRole("button", { name: "Send private application" }).click();
  await expect(page.getByText("Pending", { exact: true })).toBeVisible();

  await setFixtureSession(context, "e2e_moderator");
  await page.goto("/admin");
  const queue = page.locator(".moderator-application-admin-box");
  await expect(queue.getByText("E2EApplicationMember", { exact: true })).toHaveCount(2);
  const pendingRow = queue
    .locator("tbody tr")
    .filter({ hasText: "E2EApplicationMember" })
    .filter({ hasText: "Pending" });
  await expect(pendingRow.getByRole("button", { name: "Accept + grant role" })).toHaveCount(0);
  await pendingRow.getByRole("button", { name: "Start review" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Under Review E2EApplicationMember's application",
    }),
  ).toBeVisible();
  await page.getByLabel("Private staff note").fill("Browser-tested private queue note.");
  await page.getByRole("button", { name: "Under Review", exact: true }).click();
  await expect(queue.locator(".application-status-under-review")).toBeVisible();

  await setFixtureSession(context, "e2e_application_member");
  await page.goto("/account");
  await expect(page.getByText("Under Review", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Withdraw application" })).toBeVisible();

  await setFixtureSession(context, "e2e_admin");
  await page.goto("/admin");
  const adminQueue = page.locator(".moderator-application-admin-box");
  const reviewedRow = adminQueue
    .locator("tbody tr")
    .filter({ hasText: "E2EApplicationMember" })
    .filter({ hasText: "Under Review" });
  await reviewedRow.getByRole("button", { name: "Accept + grant role" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Accepted E2EApplicationMember's application",
    }),
  ).toBeVisible();
  await page.getByLabel("Private staff note").fill("Browser-tested administrator approval.");
  await page.getByRole("button", { name: "Accepted", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("is now a moderator");
  await expect(adminQueue.locator(".application-status-accepted")).toBeVisible();

  await setFixtureSession(context, "e2e_application_member");
  await page.goto("/account");
  await expect(page).toHaveURL(/\/auth\/sign-in/u);
  await expect(page.getByRole("heading", { name: "Use Discord or email" })).toBeVisible();
});
