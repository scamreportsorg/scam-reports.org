import type { BrowserContext, Page } from "@playwright/test";

export const baseURL =
  process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? 4173}`;

export const turnstileBypassToken = "test-turnstile-bypass-placeholder";

function fixtureToken(accountId: string) {
  return ["test", accountId, "session", "value", "s".repeat(40)].join("-");
}

function fixtureCsrf(accountId: string) {
  return `${accountId}-csrf-token-${"c".repeat(40)}`;
}

export async function setFixtureSession(
  context: BrowserContext,
  accountId:
    | "e2e_admin"
    | "e2e_application_member"
    | "e2e_link_member"
    | "e2e_member"
    | "e2e_moderator",
) {
  await context.clearCookies();
  await context.addCookies([
    {
      name: "sr_session",
      value: fixtureToken(accountId),
      url: baseURL,
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "sr_csrf",
      value: fixtureCsrf(accountId),
      url: baseURL,
      sameSite: "Lax",
    },
  ]);
}

export async function installTurnstileToken(page: Page, formSelector: string) {
  await page.locator(formSelector).evaluate((form, token) => {
    const existing = form.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
    const input = existing ?? document.createElement("input");
    input.type = "hidden";
    input.name = "cf-turnstile-response";
    input.value = token;
    input.defaultValue = token;
    if (!existing) form.appendChild(input);
  }, turnstileBypassToken);
}

export async function currentSession(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/session", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    return {
      status: response.status,
      payload: (await response.json()) as {
        authenticated?: boolean;
        account?: { id?: string; handle?: string; role?: string };
      },
    };
  });
}
