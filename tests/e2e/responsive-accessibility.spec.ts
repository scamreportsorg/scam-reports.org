import { expect, test } from "./fixtures";

const localOrigin = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? 4173}`;

const publicRoutes = [
  "/",
  "/rankings",
  "/statistics",
  "/community",
  "/community/ranks",
  "/submit",
  "/appeals",
  "/rules",
  "/privacy",
  "/security",
  "/auth/sign-in",
] as const;

test("public pages fit at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });

  for (const route of publicRoutes) {
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    const geometry = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(
      geometry.scrollWidth,
      `${route} overflows its ${geometry.clientWidth}px layout viewport`,
    ).toBeLessThanOrEqual(geometry.clientWidth + 1);
  }
});

test("header keeps keyboard focus visible", async ({ page }) => {
  await page.goto("/");

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeFocused();
  await skipLink.press("Enter");
  await expect(page.locator("#main-content")).toBeFocused();

  for (let index = 0; index < 10; index += 1) {
    await page.keyboard.press("Tab");
    const focus = await page.evaluate(() => {
      const element = document.activeElement;
      if (!(element instanceof HTMLElement)) return null;
      const style = getComputedStyle(element);
      return {
        label: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
      };
    });
    expect(focus, `tab stop ${index + 1} is missing`).not.toBeNull();
    expect(focus?.outlineStyle, `${focus?.label} has no visible focus style`).not.toBe("none");
    expect(focus?.outlineWidth, `${focus?.label} focus outline is too thin`).toBeGreaterThanOrEqual(
      2,
    );
  }
});

test("navigation marks the current section", async ({ page }) => {
  await page.goto("/community/ranks");
  const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
  await expect(primaryNavigation).toContainText("Community");
  await expect(
    primaryNavigation.getByRole("link", { name: "Community", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  await page.goto("/reports/SR-E2E-0052");
  await expect(
    primaryNavigation.getByRole("link", { name: "Reports", exact: true }),
  ).toHaveAttribute("aria-current", "page");

  await page.evaluate(() => window.history.pushState({}, "", "/community"));
  await expect(
    primaryNavigation.getByRole("link", { name: "Community", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    primaryNavigation.getByRole("link", { name: "Reports", exact: true }),
  ).not.toHaveAttribute("aria-current", "page");
});

test("navigation state renders before hydration", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto(`${localOrigin}/community/ranks`);
    const primaryNavigation = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(
      primaryNavigation.getByRole("link", { name: "Community", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  } finally {
    await context.close();
  }
});

test("mobile navigation has usable targets", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto("/");

  const utilityLinks = page.locator(".utility-links a");
  await expect(utilityLinks).toHaveCount(3);
  const targets = await utilityLinks.evaluateAll((links) =>
    links.map((link) => ({
      label: link.textContent?.trim() ?? "utility link",
      height: link.getBoundingClientRect().height,
    })),
  );

  for (const target of targets) {
    expect(target.height, `${target.label} is too short`).toBeGreaterThanOrEqual(24);
  }
});

test("mobile form controls avoid iOS zoom", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/submit");

  const controls = page.locator(
    "#header-search, .intake-form input, .intake-form select, .intake-form textarea",
  );
  const metrics = await controls.evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => {
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          type: element.getAttribute("type"),
          fontSize: Number.parseFloat(style.fontSize),
          height: element.getBoundingClientRect().height,
        };
      }),
  );

  expect(metrics.length).toBeGreaterThan(1);
  for (const control of metrics) {
    expect(
      control.fontSize,
      `${control.tag} ${control.type ?? ""} uses a zoom-prone font`,
    ).toBeGreaterThanOrEqual(16);
    if (control.tag !== "TEXTAREA" && control.type !== "file" && control.type !== "checkbox") {
      expect(
        control.height,
        `${control.tag} ${control.type ?? ""} is too short`,
      ).toBeGreaterThanOrEqual(40);
    }
  }
});

test("home and sign-in have one main heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Scam and cheating report archive",
  );

  await page.goto("/auth/sign-in");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  await expect(page.getByRole("heading", { level: 2, name: "Use Discord or email" })).toBeVisible();
});
