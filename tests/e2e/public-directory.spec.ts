import { expect, test } from "./fixtures";

test("home directory search and paging work", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "Report forums" })).toBeVisible();
  await expect(
    page.locator("#database").getByRole("heading", { name: "Reports", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".report-table tbody tr")).toHaveCount(25);

  await page.getByLabel("Search reports").fill("NeedleTarget");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/\?q=NeedleTarget(?:&|$)/u);
  await expect(page.locator(".report-table tbody tr")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "NeedleTarget" }).first()).toBeVisible();

  await page.getByRole("link", { name: "NeedleTarget" }).first().click();
  await expect(page).toHaveURL(/\/reports\/SR-E2E-0052$/u);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("NeedleTarget");
  await expect(page.getByRole("heading", { name: "Why it was reported" })).toBeVisible();
  await expect(
    page.getByText("This is synthetic browser-only evidence context.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Adjacent reports" })).toBeVisible();
});

test("directory pages keep shareable state", async ({ page }) => {
  await page.goto("/#database");
  await page.getByRole("link", { name: /^Next/u }).click();

  await expect(page).toHaveURL(/\?page=2#database$/u);
  await expect(page.locator(".report-table tbody tr")).toHaveCount(25);
  await expect(
    page
      .getByRole("navigation", { name: "Report directory pages" })
      .locator('[aria-current="page"]'),
  ).toHaveText("2");
  await expect(page.getByText(/Showing 26/u)).toBeVisible();
});
