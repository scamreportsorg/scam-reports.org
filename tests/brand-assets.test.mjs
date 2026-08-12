import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import sharp from "sharp";

async function metadata(pathname) {
  return sharp(pathname).metadata();
}

test("brand images keep their expected size", async () => {
  const mastheadPath = "public/brand/scam-reports-wordmark.webp";
  const emblemPath = "public/brand/scam-reports-emblem.png";
  const markPath = "public/brand/sr-mark.png";
  const faviconPath = "public/favicon.ico";
  const socialPath = "public/brand/scam-reports-social.png";
  const masterPath = "assets/brand/scam-reports-wordmark-master.png";

  const [
    masthead,
    emblem,
    mark,
    social,
    master,
    mastheadFile,
    emblemFile,
    markFile,
    faviconFile,
    favicon,
    socialFile,
  ] = await Promise.all([
    metadata(mastheadPath),
    metadata(emblemPath),
    metadata(markPath),
    metadata(socialPath),
    metadata(masterPath),
    stat(mastheadPath),
    stat(emblemPath),
    stat(markPath),
    stat(faviconPath),
    readFile(faviconPath),
    stat(socialPath),
  ]);

  assert.deepEqual([masthead.width, masthead.height, masthead.format], [760, 138, "webp"]);
  assert.deepEqual([emblem.width, emblem.height, emblem.format], [512, 512, "png"]);
  assert.deepEqual([mark.width, mark.height, mark.format], [96, 96, "png"]);
  assert.deepEqual([social.width, social.height, social.format], [1200, 630, "png"]);
  assert.deepEqual([master.width, master.height, master.format], [1900, 345, "png"]);
  assert.ok(mastheadFile.size <= 200_000, `masthead is ${mastheadFile.size} bytes`);
  assert.ok(emblemFile.size <= 500_000, `emblem is ${emblemFile.size} bytes`);
  assert.ok(markFile.size <= 16_000, `favicon is ${markFile.size} bytes`);
  assert.ok(faviconFile.size <= 16_000, `ICO favicon is ${faviconFile.size} bytes`);
  assert.deepEqual([...favicon.subarray(0, 6)], [0, 0, 1, 0, 1, 0]);
  assert.deepEqual([...favicon.subarray(22, 30)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(socialFile.size <= 200_000, `social preview is ${socialFile.size} bytes`);
});

test("emblem fits a circular avatar", async () => {
  const emblem = await sharp("public/brand/scam-reports-emblem.png")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const centerX = (emblem.info.width - 1) / 2;
  const centerY = (emblem.info.height - 1) / 2;
  const circleRadius = emblem.info.width / 2;
  let foreground = 0;
  let maxRadius = 0;

  for (let y = 0; y < emblem.info.height; y += 1) {
    for (let x = 0; x < emblem.info.width; x += 1) {
      const alpha = emblem.data[(y * emblem.info.width + x) * 4 + 3];
      if (alpha <= 8) continue;

      foreground += 1;
      maxRadius = Math.max(maxRadius, Math.hypot(x - centerX, y - centerY));
    }
  }

  const fillRatio = foreground / (emblem.info.width * emblem.info.height);
  assert.ok(fillRatio >= 0.35, `emblem only fills ${(fillRatio * 100).toFixed(1)}% of the canvas`);
  assert.ok(
    maxRadius <= circleRadius - 8,
    `emblem exceeds the circular safe area at ${maxRadius}px`,
  );
});

test("wordmark keeps the silver S and blue R", async () => {
  const masthead = await sharp("assets/brand/scam-reports-wordmark-master.png")
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  function glyphMean(left, right) {
    const totals = [0, 0, 0];
    let pixels = 0;

    for (let y = 70; y <= 275; y += 1) {
      for (let x = left; x <= right; x += 1) {
        const offset = (y * masthead.info.width + x) * 4;
        const brightness =
          (masthead.data[offset] + masthead.data[offset + 1] + masthead.data[offset + 2]) / 3;
        if (brightness <= 50) continue;

        for (let channel = 0; channel < 3; channel += 1) {
          totals[channel] += masthead.data[offset + channel];
        }
        pixels += 1;
      }
    }

    return totals.map((total) => total / pixels);
  }

  const firstS = glyphMean(336, 427);
  const firstR = glyphMean(857, 951);
  const secondR = glyphMean(1253, 1344);

  assert.ok(Math.abs(firstS[2] - firstS[0]) < 5);
  assert.ok(firstR[2] - firstR[0] > 70);
  assert.ok(Math.abs(secondR[2] - secondR[0]) < 5);
});

test("metadata uses public brand assets", async () => {
  const [layout, sitemap, robots] = await Promise.all([
    readFile("app/layout.tsx", "utf8"),
    readFile("app/sitemap.ts", "utf8"),
    readFile("app/robots.ts", "utf8"),
  ]);

  assert.match(layout, /https:\/\/scam-reports\.org/u);
  assert.match(layout, /\/favicon\.ico/u);
  assert.match(layout, /scam-reports-social\.png/u);
  assert.match(layout, /summary_large_image/u);
  assert.match(sitemap, /scam-reports\.org/u);
  assert.match(robots, /sitemap\.xml/u);
  assert.match(robots, /"\/admin"/u);
});
