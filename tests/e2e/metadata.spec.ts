import { expect, test } from "./fixtures";
import { setFixtureSession } from "./support";

const publicPages = [
  { path: "/", title: "Scam-Reports.org" },
  { path: "/rankings", title: "Reputation Rankings | Scam-Reports.org" },
  { path: "/statistics", title: "Database Statistics | Scam-Reports.org" },
  { path: "/community", title: "Community and Open Source | Scam-Reports.org" },
  { path: "/community/ranks", title: "Community Ranks | Scam-Reports.org" },
  { path: "/submit", title: "Submit a Report | Scam-Reports.org" },
  { path: "/appeals", title: "Corrections and Appeals | Scam-Reports.org" },
  { path: "/rules", title: "Evidence and Publication Rules | Scam-Reports.org" },
  { path: "/privacy", title: "Privacy | Scam-Reports.org" },
  { path: "/security", title: "Security | Scam-Reports.org" },
] as const;

test("public pages have route metadata", async ({ page }) => {
  for (const entry of publicPages) {
    await page.goto(entry.path);
    const canonical =
      entry.path === "/"
        ? "https://scam-reports.org"
        : new URL(entry.path, "https://scam-reports.org").toString();
    await expect(page).toHaveTitle(entry.title);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", canonical);
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", entry.title);
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", canonical);
    await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute(
      "content",
      entry.title,
    );
  }
});

test("record pages use public metadata", async ({ page }) => {
  await page.goto("/reports/SR-E2E-0052");
  await expect(page).toHaveTitle("NeedleTarget | report | Scam-Reports.org");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://scam-reports.org/reports/SR-E2E-0052",
  );

  await page.goto("/members/E2EMember");
  await expect(page).toHaveTitle("E2EMember | community profile | Scam-Reports.org");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://scam-reports.org/members/E2EMember",
  );
});

test("private pages opt out of indexing", async ({ page, context }) => {
  await page.goto("/auth/sign-in");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/u);

  await setFixtureSession(context, "e2e_member");
  await page.goto("/account");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/u);

  await setFixtureSession(context, "e2e_moderator");
  await page.goto("/admin");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/u);
});
