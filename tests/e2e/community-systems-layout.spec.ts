import { expect, test } from "./fixtures";

const viewports = [
  { name: "desktop", width: 1280, height: 900, stacked: false },
  { name: "mobile", width: 390, height: 844, stacked: true },
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
  test(`community rows work on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/community");

    const section = page.locator("section.forum-box", {
      has: page.getByRole("heading", {
        name: "Ranks, roles and access",
      }),
    });
    await expect(section).toBeVisible();

    const rows = section.locator("tbody > tr");
    await expect(rows).toHaveCount(4);
    await expect(rows.locator("th")).toHaveText([
      "Account role",
      "Community rank",
      "Report reputation",
      "Repository role",
    ]);

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

      const table = elements[0]?.closest("table");
      const wrapper = table?.parentElement;
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        tableClientWidth: table?.clientWidth ?? 0,
        tableScrollWidth: table?.scrollWidth ?? 0,
        wrapperClientWidth: wrapper?.clientWidth ?? 0,
        wrapperScrollWidth: wrapper?.scrollWidth ?? 0,
        rows: elements.map((row) => {
          const label = row.querySelector("th");
          const description = row.querySelector("td");
          if (!label || !description) throw new Error("Community systems row is incomplete.");
          return {
            label: label.textContent?.trim() ?? "",
            row: rectangle(row),
            labelCell: rectangle(label),
            descriptionCell: rectangle(description),
            labelContent: contentRectangle(label),
            descriptionContent: contentRectangle(description),
          };
        }),
      };
    });

    expect(geometry.documentWidth, "page has horizontal overflow").toBeLessThanOrEqual(
      geometry.viewportWidth + 1,
    );
    expect(geometry.tableScrollWidth, "table has horizontal overflow").toBeLessThanOrEqual(
      geometry.tableClientWidth + 1,
    );
    expect(
      geometry.wrapperScrollWidth,
      "table wrapper has horizontal overflow",
    ).toBeLessThanOrEqual(geometry.wrapperClientWidth + 1);

    for (const row of geometry.rows) {
      expect(row.labelCell.width, `${row.label} label width`).toBeGreaterThan(0);
      expect(row.descriptionCell.width, `${row.label} description width`).toBeGreaterThan(0);
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

      if (viewport.stacked) {
        expect(
          row.labelCell.width,
          `${row.label} mobile label is not full width`,
        ).toBeGreaterThanOrEqual(row.row.width - 2);
        expect(
          row.descriptionCell.width,
          `${row.label} mobile description is not full width`,
        ).toBeGreaterThanOrEqual(row.row.width - 2);
        expect(
          row.labelCell.bottom,
          `${row.label} mobile label is not stacked above its description`,
        ).toBeLessThanOrEqual(row.descriptionCell.top + 1);
      }
    }
  });
}
