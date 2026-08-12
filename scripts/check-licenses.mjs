#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join } from "node:path";

const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const lockfile = JSON.parse(readFileSync("package-lock.json", "utf8"));

const allowed = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC-BY-4.0",
  "CC0-1.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MPL-2.0",
  "Python-2.0",
]);

function packageLicense(path, lockEntry) {
  try {
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    return manifest.license ?? lockEntry.license ?? null;
  } catch {
    return lockEntry.license ?? null;
  }
}

function expressionParts(expression) {
  return expression
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR)\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

const failures = [];
const counts = new Map();

if (rootPackage.license !== "AGPL-3.0-or-later") {
  failures.push({
    package: rootPackage.name ?? "<root>",
    license: rootPackage.license ?? "missing",
    reason: "root package must declare AGPL-3.0-or-later",
  });
}

for (const [path, entry] of Object.entries(lockfile.packages ?? {})) {
  if (!path.startsWith("node_modules/")) continue;

  const name = entry.name ?? path.slice("node_modules/".length);
  const license = packageLicense(path, entry);
  if (typeof license !== "string" || !license.trim()) {
    failures.push({ package: name, license: "missing", reason: "no declared license" });
    continue;
  }

  counts.set(license, (counts.get(license) ?? 0) + 1);
  const parts = expressionParts(license);
  if (!parts.length || parts.some((part) => !allowed.has(part))) {
    failures.push({
      package: name,
      license,
      reason: "license expression is not in the reviewed allowlist",
    });
  }
}

if (failures.length) {
  console.error("Dependency license check failed:");
  for (const failure of failures) {
    console.error(`- ${failure.package}: ${failure.license} (${failure.reason})`);
  }
  console.error("Review compatibility and notices before changing the allowlist.");
  process.exit(1);
}

console.log("Dependency license check passed:");
for (const [license, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`- ${license}: ${count}`);
}
