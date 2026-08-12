import { expect, test } from "./fixtures";

const viewports = [
  { name: "desktop", width: 1280, height: 900 },
  { name: "mobile", width: 390, height: 844 },
] as const;

type Rectangle = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

function intersectionArea(left: Rectangle, right: Rectangle) {
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  return width * height;
}

for (const viewport of viewports) {
  test(`ranking rows work on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/rankings");

    const section = page.locator("section.forum-box", {
      has: page.getByRole("heading", { name: "How scores work" }),
    });
    await expect(section).toBeVisible();

    const rows = section.locator("tbody > tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.locator("th")).toHaveText(["Score", "Confidence", "Reviews"]);

    const geometry = await rows.evaluateAll((elements) => {
      function rectangle(element: Element) {
        const value = element.getBoundingClientRect();
        return {
          left: value.left,
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          width: value.width,
          height: value.height,
        };
      }

      function contentRectangle(element: Element) {
        const range = document.createRange();
        range.selectNodeContents(element);
        const value = range.getBoundingClientRect();
        return {
          left: value.left,
          top: value.top,
          right: value.right,
          bottom: value.bottom,
          width: value.width,
          height: value.height,
        };
      }

      return elements.map((row) => {
        const label = row.querySelector("th");
        const description = row.querySelector("td");
        if (!label || !description) throw new Error("Ranking methodology row is incomplete.");
        return {
          label: label.textContent?.trim() ?? "",
          row: rectangle(row),
          labelCell: rectangle(label),
          descriptionCell: rectangle(description),
          labelContent: contentRectangle(label),
          descriptionContent: contentRectangle(description),
        };
      });
    });

    for (const row of geometry) {
      expect(row.labelCell.width, `${row.label} label width`).toBeGreaterThan(0);
      expect(row.labelCell.height, `${row.label} label height`).toBeGreaterThan(0);
      expect(row.descriptionCell.width, `${row.label} description width`).toBeGreaterThan(0);
      expect(row.descriptionCell.height, `${row.label} description height`).toBeGreaterThan(0);

      expect(
        intersectionArea(row.labelCell, row.descriptionCell),
        `${row.label} label and description cells overlap at ${viewport.width}px`,
      ).toBeLessThanOrEqual(0.5);
      expect(
        intersectionArea(row.labelContent, row.descriptionContent),
        `${row.label} label and description text overlap at ${viewport.width}px`,
      ).toBeLessThanOrEqual(0.5);

      for (const cell of [row.labelCell, row.descriptionCell]) {
        expect(cell.left).toBeGreaterThanOrEqual(row.row.left - 1);
        expect(cell.right).toBeLessThanOrEqual(row.row.right + 1);
        expect(cell.top).toBeGreaterThanOrEqual(row.row.top - 1);
        expect(cell.bottom).toBeLessThanOrEqual(row.row.bottom + 1);
      }
    }
  });
}
