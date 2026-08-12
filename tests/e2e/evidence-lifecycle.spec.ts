import { expect, test } from "./fixtures";
import { setFixtureSession } from "./support";

const evidenceId = "EVA-11111111-1111-4111-8111-111111111111";
const publicEvidenceFilename = `${evidenceId}.webp`;
const reportId = "SR-E2E-0052";

test("moderator publishes sanitized evidence", async ({ page, context }) => {
  const caption = "Synthetic sanitized evidence published by the local browser lifecycle test.";
  await setFixtureSession(context, "e2e_moderator");
  await page.goto("/admin");
  await page
    .locator(".admin-queue-disclosure > summary")
    .filter({ hasText: /^Private evidence/u })
    .click();

  let evidenceRow = page.locator(".evidence-admin-box tbody tr").filter({ hasText: evidenceId });
  await expect(evidenceRow).toContainText("private ready");
  await expect(evidenceRow).toContainText("Not reviewed");

  const previewResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/admin/evidence/${evidenceId}/derivative`) &&
      response.request().method() === "GET",
  );
  const popupOpened = page.waitForEvent("popup");
  await evidenceRow.getByRole("button", { name: "Sanitized preview" }).click();
  expect((await previewResponse).status()).toBe(200);
  const popup = await popupOpened;
  await popup.close();

  await evidenceRow.getByRole("button", { name: "Review & link" }).click();
  const reviewDialog = page.getByRole("dialog", { name: "Review and link evidence" });
  await expect(reviewDialog).toBeVisible();
  await reviewDialog.getByLabel("Report ID").fill(reportId);
  await reviewDialog.getByLabel("Public caption").fill(caption);
  await reviewDialog.getByRole("button", { name: "Save review" }).click();
  await expect(page.locator(".form-success")).toContainText(
    `${evidenceId} passed visible-PII review`,
  );

  evidenceRow = page.locator(".evidence-admin-box tbody tr").filter({ hasText: evidenceId });
  await expect(evidenceRow).toContainText(reportId);
  await expect(evidenceRow).toContainText(caption);
  await expect(evidenceRow).toContainText("Reviewed");

  await evidenceRow.getByRole("button", { name: "Publish derivative" }).click();
  const publishDialog = page.getByRole("dialog", { name: "Publish sanitized evidence" });
  await expect(publishDialog).toContainText("The original file stays private");
  await publishDialog.getByRole("button", { name: "Publish derivative" }).click();
  await expect(page.locator(".form-success")).toContainText(`${evidenceId} was published`);

  const persisted = await page.evaluate(async (id) => {
    const response = await fetch("/api/admin/evidence?page=1&pageSize=25", {
      cache: "no-store",
    });
    const payload = (await response.json()) as {
      items: Array<{
        id: string;
        state: string;
        visiblePiiReviewed: boolean;
        links: Array<{ reportId: string; caption: string }>;
      }>;
    };
    return payload.items.find((item) => item.id === id) ?? null;
  }, evidenceId);
  expect(persisted).toEqual(
    expect.objectContaining({
      id: evidenceId,
      state: "public",
      visiblePiiReviewed: true,
      links: expect.arrayContaining([expect.objectContaining({ reportId, caption })]),
    }),
  );

  await context.clearCookies();
  const publicResponse = await page.request.get(`/api/evidence/${evidenceId}`);
  expect(publicResponse.status()).toBe(200);
  expect(publicResponse.headers()["content-type"]).toBe("image/webp");

  await page.goto(`/reports/${reportId}`);
  await expect(page.getByText(caption, { exact: true })).toBeVisible();
  await expect(page.locator(`img[src="/api/evidence/${evidenceId}"]`).first()).toBeVisible();

  const previewButton = page.getByRole("button", { name: `Open ${publicEvidenceFilename}` });
  await previewButton.click();
  const lightbox = page.getByRole("dialog", { name: "Evidence preview" });
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByRole("button", { name: /Close/u })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(lightbox.getByRole("button", { name: /Close/u })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(lightbox).toBeHidden();
  await expect(previewButton).toBeFocused();
});
