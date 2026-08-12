#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const publicBrand = resolve(root, "public/brand");
const mastheadOriginal = resolve(root, "assets/brand/scam-reports-wordmark-original.png");
const mastheadMasterPath = resolve(root, "assets/brand/scam-reports-wordmark-master.png");
const emblemMasterPath = resolve(root, "assets/brand/scam-reports-emblem-master.png");

const mastheadPath = resolve(publicBrand, "scam-reports-wordmark.webp");
const emblemPath = resolve(publicBrand, "scam-reports-emblem.png");
const markPath = resolve(publicBrand, "sr-mark.png");
const faviconPath = resolve(root, "public/favicon.ico");
const socialPath = resolve(publicBrand, "scam-reports-social.png");

await mkdir(dirname(mastheadPath), { recursive: true });

const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

const original = await sharp(mastheadOriginal)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

function restyleSilverGlyph({ left, top, right, bottom, color }) {
  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      const offset = (y * original.info.width + x) * 4;
      const red = original.data[offset];
      const green = original.data[offset + 1];
      const blue = original.data[offset + 2];
      const brightness = (red + green + blue) / 3;
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);

      if (original.data[offset + 3] === 0 || brightness < 50 || chroma > 55) continue;

      if (color === "steel") {
        original.data[offset] = Math.round(red * 0.87);
        original.data[offset + 1] = Math.round(green * 0.87);
        original.data[offset + 2] = Math.round(blue * 0.88);
      } else {
        original.data[offset] = Math.round(brightness * 0.32);
        original.data[offset + 1] = Math.round(brightness * 0.64);
        original.data[offset + 2] = Math.round(brightness * 0.78);
      }
    }
  }
}

restyleSilverGlyph({ left: 576, top: 70, right: 667, bottom: 275, color: "steel" });
restyleSilverGlyph({ left: 1097, top: 70, right: 1191, bottom: 275, color: "blue" });

const styledOriginal = await sharp(original.data, { raw: original.info }).png().toBuffer();

const wordmark = await sharp(styledOriginal)
  .extract({ left: 560, top: 0, width: 1550, height: 345 })
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

for (let y = 275; y < wordmark.info.height; y += 1) {
  for (let x = 0; x < 60; x += 1) {
    const offset = (y * wordmark.info.width + x) * 4;
    wordmark.data.fill(0, offset, offset + 4);
  }
}

const wordmarkStrip = await sharp(wordmark.data, { raw: wordmark.info }).png().toBuffer();

const mastheadEmblem = await sharp(emblemMasterPath)
  .trim({ background: transparent })
  .resize({ width: 300, kernel: "lanczos3" })
  .png()
  .toBuffer();

const mastheadEmblemMetadata = await sharp(mastheadEmblem).metadata();
const mastheadEmblemTop = 275 - (mastheadEmblemMetadata.height ?? 0);

const mastheadMaster = await sharp({
  create: { width: 1900, height: 345, channels: 4, background: transparent },
})
  .composite([
    { input: wordmarkStrip, left: 320, top: 0 },
    { input: mastheadEmblem, left: 15, top: mastheadEmblemTop },
  ])
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toBuffer();

const emblem = await sharp(emblemMasterPath)
  .trim({ background: transparent })
  .resize({ width: 455, height: 455, fit: "contain", background: transparent, kernel: "lanczos3" })
  .extend({ top: 28, bottom: 29, left: 28, right: 29, background: transparent })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toBuffer();

const masthead = await sharp(mastheadMaster)
  .resize({ width: 760, height: 138, fit: "fill", kernel: "lanczos3" })
  .webp({ lossless: true, effort: 6 })
  .toBuffer();

const mark = await sharp(emblem)
  .resize({ width: 96, height: 96, fit: "fill", kernel: "lanczos3" })
  .png({
    compressionLevel: 9,
    adaptiveFiltering: true,
    palette: true,
    colours: 256,
    dither: 0,
  })
  .toBuffer();

function icoFromPng(png, width, height) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(width === 256 ? 0 : width, 6);
  header.writeUInt8(height === 256 ? 0 : height, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  return Buffer.concat([header, png]);
}

const favicon = icoFromPng(mark, 96, 96);

const socialBackground = Buffer.from(`
  <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#171d23" />
        <stop offset="1" stop-color="#0d1115" />
      </linearGradient>
      <pattern id="lines" width="8" height="8" patternUnits="userSpaceOnUse">
        <path d="M0 7.5H8" stroke="#ffffff" stroke-opacity=".025" />
      </pattern>
    </defs>
    <rect width="1200" height="630" fill="#090c0f" />
    <rect x="18" y="18" width="1164" height="594" fill="url(#panel)" stroke="#475560" stroke-width="2" />
    <rect x="26" y="26" width="1148" height="578" fill="url(#lines)" stroke="#050607" />
    <rect x="38" y="38" width="1124" height="28" fill="#202a32" stroke="#586875" />
    <rect x="38" y="67" width="1124" height="4" fill="#9a6b1f" />
    <line x1="110" y1="302" x2="1090" y2="302" stroke="#53616b" />
    <line x1="110" y1="305" x2="1090" y2="305" stroke="#050607" />
    <text x="600" y="374" text-anchor="middle" fill="#e4e8eb" font-family="Arial, sans-serif" font-size="38" font-weight="700">Community evidence archive</text>
    <text x="600" y="420" text-anchor="middle" fill="#9ca8b1" font-family="Arial, sans-serif" font-size="22">Cheating · Marketplace fraud · Unsafe files · Impersonation</text>
    <rect x="110" y="477" width="980" height="58" fill="#12181d" stroke="#3c4851" />
    <text x="600" y="514" text-anchor="middle" fill="#c5ccd1" font-family="Arial, sans-serif" font-size="20">Moderated reports · Evidence reviewed before publication</text>
    <text x="600" y="580" text-anchor="middle" fill="#8b969e" font-family="Arial, sans-serif" font-size="17">scam-reports.org</text>
  </svg>
`);

const social = await sharp(socialBackground)
  .composite([{ input: masthead, left: 220, top: 112 }])
  .png({
    compressionLevel: 9,
    adaptiveFiltering: true,
    palette: true,
    colours: 256,
    dither: 0,
  })
  .toBuffer();

await Promise.all([
  writeFile(mastheadMasterPath, mastheadMaster),
  writeFile(mastheadPath, masthead),
  writeFile(emblemPath, emblem),
  writeFile(markPath, mark),
  writeFile(faviconPath, favicon),
  writeFile(socialPath, social),
]);

console.log(`Wrote ${mastheadMasterPath} (${mastheadMaster.length} bytes)`);
console.log(`Wrote ${mastheadPath} (${masthead.length} bytes)`);
console.log(`Wrote ${emblemPath} (${emblem.length} bytes)`);
console.log(`Wrote ${markPath} (${mark.length} bytes)`);
console.log(`Wrote ${faviconPath} (${favicon.length} bytes)`);
console.log(`Wrote ${socialPath} (${social.length} bytes)`);
