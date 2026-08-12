import { expect, test } from "./fixtures";
import { baseURL, currentSession, installTurnstileToken } from "./support";

test("Discord registration works with the local mock", async ({ page }) => {
  await page.goto("/auth/sign-in?returnTo=/account");
  await page.getByRole("link", { name: "Continue with Discord" }).click();

  await expect(page).toHaveURL(`${baseURL}/account`);
  const session = await currentSession(page);
  expect(session.status).toBe(200);
  expect(session.payload.authenticated).toBe(true);
  expect(session.payload.account?.id).toMatch(/^account_/u);
  expect(session.payload.account?.handle).toMatch(/^member-/u);
});

test("email registration uses the local magic link", async ({ page, request }) => {
  const email = "browser-magic-member@example.invalid";
  await page.goto("/auth/sign-in?returnTo=/account");
  const submit = page.getByRole("button", { name: "Email me a sign-in link" });
  await expect(submit).toBeDisabled();
  await installTurnstileToken(page, 'form[action="/api/auth/magic/request"]');
  await expect(submit).toBeEnabled();
  await page.getByLabel("Or get a one-time email link").fill(email);
  await submit.click();

  await expect(page).toHaveURL(`${baseURL}/auth/check-email`);
  const delivery = await request.get(`/__e2e/mail/latest?email=${encodeURIComponent(email)}`);
  expect(delivery.status()).toBe(200);
  const { link } = (await delivery.json()) as { link: string };
  expect(new URL(link).origin).toBe(baseURL);

  await page.goto(link);
  await expect(page).toHaveURL(`${baseURL}/account`);
  const session = await currentSession(page);
  expect(session.status).toBe(200);
  expect(session.payload.authenticated).toBe(true);
  expect(session.payload.account?.id).toMatch(/^account_/u);
  expect(session.payload.account?.handle).toMatch(/^member-/u);
});
