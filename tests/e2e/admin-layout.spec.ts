import { expect, test } from "./fixtures";
import { setFixtureSession } from "./support";

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`admin works on ${viewport.name}`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await setFixtureSession(context, "e2e_admin");
    await page.goto("/admin");

    await expect(page.getByRole("heading", { level: 1, name: "Staff panel" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Control panel sections" })).toBeVisible();
    await expect(page.locator(".admin-hero.forum-box")).toBeVisible();
    await expect(page.locator(".admin-overview.forum-box")).toBeVisible();
    await expect(page.locator(".admin-queue-disclosure")).toHaveCount(7);
    await expect(page.locator(".admin-account-table tbody tr").first()).toBeVisible();

    const firstQueue = page.locator(".admin-queue-disclosure").first();
    const initiallyOpen = await firstQueue.getAttribute("open");
    await firstQueue.locator("summary").click();
    await expect(firstQueue).toHaveJSProperty("open", initiallyOpen === null);

    const geometry = await page.evaluate(() => {
      const documentWidth = document.documentElement.getBoundingClientRect().width;
      const workspace = document.querySelector<HTMLElement>(".admin-workspace");
      const accountRow = document.querySelector<HTMLElement>(".admin-account-table tbody tr");
      if (!workspace || !accountRow) throw new Error("Admin layout did not render.");
      return {
        documentWidth,
        scrollWidth: document.documentElement.scrollWidth,
        workspace: workspace.getBoundingClientRect(),
        accountRow: accountRow.getBoundingClientRect(),
      };
    });

    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.documentWidth + 1);
    expect(geometry.workspace.left).toBeGreaterThanOrEqual(-1);
    expect(geometry.workspace.right).toBeLessThanOrEqual(geometry.documentWidth + 1);
    expect(geometry.accountRow.left).toBeGreaterThanOrEqual(geometry.workspace.left - 1);
    expect(geometry.accountRow.right).toBeLessThanOrEqual(geometry.workspace.right + 1);

    if (viewport.name === "mobile") {
      const accountCellDisplays = await page
        .locator(".admin-account-table tbody tr")
        .first()
        .locator("td")
        .evaluateAll((cells) => cells.map((cell) => getComputedStyle(cell).display));
      expect(accountCellDisplays.every((display) => display === "block")).toBe(true);
    }
  });
}

test("admin can save role and status", async ({ page, context }) => {
  await setFixtureSession(context, "e2e_admin");
  await page.goto("/admin");

  const accountRow = page
    .locator(".admin-account-table tbody tr")
    .filter({ hasText: "E2ERoleTarget" });
  await expect(accountRow).toBeVisible();
  const roleSelect = accountRow.getByLabel("Role for E2ERoleTarget");
  const statusSelect = accountRow.getByLabel("Status for E2ERoleTarget");
  await expect(roleSelect).toHaveClass(/admin-role-member/u);
  await expect(statusSelect).toHaveClass(/admin-status-active/u);
  await roleSelect.selectOption("moderator");
  await statusSelect.selectOption("suspended");
  await expect(roleSelect).toHaveClass(/admin-role-moderator/u);
  await expect(statusSelect).toHaveClass(/admin-status-suspended/u);
  await accountRow.getByRole("button", { name: "Save changes" }).click();

  await expect(accountRow.getByText("E2ERoleTarget is now moderator and suspended.")).toBeVisible();
  await expect(roleSelect).toHaveValue("moderator");
  await expect(statusSelect).toHaveValue("suspended");

  await roleSelect.selectOption("member");
  await statusSelect.selectOption("active");
  await accountRow.getByRole("button", { name: "Save changes" }).click();
  await expect(accountRow.getByText("E2ERoleTarget is now member and active.")).toBeVisible();
});

test("account changes explain reconfirmation", async ({ page, context }) => {
  await setFixtureSession(context, "e2e_admin");
  await page.goto("/admin");

  const accountRow = page
    .locator(".admin-account-table tbody tr")
    .filter({ hasText: "E2ERoleTarget" });
  await accountRow.getByLabel("Role for E2ERoleTarget").selectOption("moderator");
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input) === "/api/admin/accounts" && init?.method === "PATCH") {
        return new Response(
          JSON.stringify({
            code: "dual_confirmation_required",
            error: "Reauthenticate with both Discord and email within ten minutes.",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      return originalFetch(input, init);
    };
  });

  await accountRow.getByRole("button", { name: "Save changes" }).click();
  await expect(
    accountRow.getByRole("link", { name: "Reconfirm Discord and email" }),
  ).toHaveAttribute("href", "/account?notice=reconfirm-required");
});
