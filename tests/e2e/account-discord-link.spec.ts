import { expect, test } from "./fixtures";
import { baseURL, currentSession, setFixtureSession } from "./support";

test.use({ mockDiscordLinkAuthorization: true });

test("email member can link Discord", async ({ page, context }) => {
  await setFixtureSession(context, "e2e_link_member");
  const accountResponse = await page.goto("/account");

  expect(accountResponse?.headers()["content-security-policy"]).toContain("form-action 'self'");
  const identities = page.locator(".identity-table").first();
  const discordIdentity = identities.locator("div").filter({ hasText: /^Discord/u });
  const emailIdentity = identities.locator("div").filter({ hasText: /^Email/u });
  await expect(discordIdentity.getByText("Not linked", { exact: true })).toBeVisible();
  await expect(emailIdentity.getByText("email test identity", { exact: true })).toBeVisible();

  const sessionBeforeLink = await currentSession(page);
  expect(sessionBeforeLink.status).toBe(200);
  expect(sessionBeforeLink.payload.authenticated).toBe(true);
  expect(sessionBeforeLink.payload.account?.id).toBe("e2e_link_member");

  const startRequestPromise = page.waitForRequest(
    (request) =>
      request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/discord/start",
  );
  const startResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/auth/discord/start",
  );
  const authorizationRequestPromise = page.waitForRequest((request) => {
    const requestUrl = new URL(request.url());
    return (
      requestUrl.origin === "https://discord.com" && requestUrl.pathname === "/oauth2/authorize"
    );
  });
  await page.getByRole("button", { name: "Link Discord" }).click();
  const [startRequest, startResponse, authorizationRequest] = await Promise.all([
    startRequestPromise,
    startResponsePromise,
    authorizationRequestPromise,
  ]);
  expect(startRequest.resourceType()).toBe("fetch");
  expect(startRequest.headers().accept).toContain("application/json");
  expect(startResponse.status()).toBe(200);
  expect(startResponse.headers().location).toBeUndefined();
  const authorizationUrl = new URL(authorizationRequest.url());
  expect(authorizationUrl.origin).toBe("https://discord.com");
  expect(authorizationUrl.pathname).toBe("/oauth2/authorize");

  await expect(page).toHaveURL(`${baseURL}/account?updated=identity`);
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  await expect(discordIdentity.getByText("@e2e_linked_member", { exact: true })).toBeVisible();
  await expect(emailIdentity.getByText("email test identity", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Link Discord", exact: true })).toHaveCount(0);

  const sessionAfterLink = await currentSession(page);
  expect(sessionAfterLink.status).toBe(200);
  expect(sessionAfterLink.payload.authenticated).toBe(true);
  expect(sessionAfterLink.payload.account?.id).toBe(sessionBeforeLink.payload.account?.id);
});
