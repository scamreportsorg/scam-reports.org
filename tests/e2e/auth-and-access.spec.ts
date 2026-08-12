import { expect, test } from "./fixtures";
import { installTurnstileToken, setFixtureSession } from "./support";

test("anonymous staff access redirects to sign-in", async ({ page }) => {
  await page.goto("/auth/sign-in?returnTo=/submit");

  await expect(page.getByRole("heading", { name: "Use Discord or email" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Discord" })).toHaveAttribute(
    "href",
    /\/api\/auth\/discord\/start\?returnTo=%2Fsubmit/u,
  );
  await expect(page.getByLabel("Or get a one-time email link")).toBeVisible();
  const emailForm = page.locator('form[action="/api/auth/magic/request"]');
  const submit = page.getByRole("button", { name: "Email me a sign-in link" });
  await expect(emailForm.locator('input[name="cf-turnstile-response"]')).toBeAttached();
  await expect(submit).toBeDisabled();
  await installTurnstileToken(page, 'form[action="/api/auth/magic/request"]');
  await expect(submit).toBeEnabled();

  await page.goto("/admin");
  await expect(page).toHaveURL(/\/auth\/sign-in\?returnTo=%2Fadmin$/u);
  await expect(page.getByRole("heading", { name: "Use Discord or email" })).toBeVisible();
});

test("members and moderators see different admin pages", async ({ page, context }) => {
  await setFixtureSession(context, "e2e_member");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Access denied" })).toBeVisible();
  await expect(
    page.getByText("don't have access to the moderation tools", { exact: false }),
  ).toBeVisible();

  await context.clearCookies();
  await setFixtureSession(context, "e2e_moderator");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Staff panel" })).toBeVisible();
  await expect(page.getByText("Actions are logged")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add report", exact: true })).toBeVisible();
});

test("report form uses the current member", async ({ page, context }) => {
  await page.goto("/submit");
  await expect(page.getByText("You need an account to send this", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Submit report for review" })).toBeDisabled();

  await setFixtureSession(context, "e2e_member");
  await page.reload();

  await expect(page.getByLabel("Submitting as")).toHaveValue("E2EMember");
  await expect(page.locator('input[name="csrfToken"]')).toHaveValue(/^e2e_member-csrf-token-/u);
  await expect(page.getByRole("button", { name: "Submit report for review" })).toBeEnabled();
});
