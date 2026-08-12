import { expect, test as base } from "@playwright/test";

const localOrigin = new URL(
  process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? 4173}`,
).origin;
const turnstileScript = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export const test = base.extend<{
  browserHygiene: void;
  mockDiscordLinkAuthorization: boolean;
}>({
  mockDiscordLinkAuthorization: [false, { option: true }],
  browserHygiene: [
    async ({ page, mockDiscordLinkAuthorization }, use) => {
      const problems: string[] = [];
      if (mockDiscordLinkAuthorization) {
        await page.route("https://discord.com/oauth2/authorize**", async (route) => {
          const providerUrl = new URL(route.request().url());
          const localProviderUrl = new URL("/__e2e/discord/authorize", localOrigin);
          localProviderUrl.search = providerUrl.search;
          localProviderUrl.searchParams.set("e2e_profile", "link");
          await route.fulfill({
            status: 302,
            headers: {
              "cache-control": "no-store",
              location: localProviderUrl.toString(),
            },
          });
        });
      }
      await page.route(turnstileScript, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "text/javascript; charset=utf-8",
          body: `(() => {
            const widgets = new Map();
            let sequence = 0;
            window.turnstile = {
              render(container) {
                sequence += 1;
                const widgetId = \`e2e-turnstile-\${sequence}\`;
                const input = document.createElement("input");
                input.type = "hidden";
                input.name = "cf-turnstile-response";
                input.value = "";
                container.appendChild(input);
                widgets.set(widgetId, container);
                return widgetId;
              },
              remove(widgetId) {
                widgets.get(widgetId)?.replaceChildren();
                widgets.delete(widgetId);
              },
              reset(widgetId) {
                const containers = widgetId ? [widgets.get(widgetId)] : [...widgets.values()];
                for (const container of containers) {
                  const input = container?.querySelector('input[name="cf-turnstile-response"]');
                  if (input) input.value = "";
                }
              },
            };
          })();`,
        });
      });
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          problems.push(`console.${message.type()}: ${message.text()}`);
        }
      });
      page.on("pageerror", (error) => {
        problems.push(`pageerror: ${error.message}`);
      });
      page.on("request", (request) => {
        if (request.url() === turnstileScript) return;
        const requestUrl = new URL(request.url());
        if (
          mockDiscordLinkAuthorization &&
          requestUrl.origin === "https://discord.com" &&
          requestUrl.pathname === "/oauth2/authorize"
        ) {
          return;
        }
        const origin = requestUrl.origin;
        if (origin !== localOrigin && !request.url().startsWith("data:")) {
          problems.push(`unexpected external request: ${request.method()} ${request.url()}`);
        }
      });

      await use();

      expect(
        problems,
        "The page must not emit browser warnings/errors or contact live external services.",
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
