#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, requireArg, sha256File } from "./operator-common.mjs";

export async function verifyReleaseAssets(directoryValue, tag) {
  const directory = resolve(directoryValue);
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error("Release tag is invalid.");
  const archive = `scam-reports-${tag}.tar.gz`;
  const expectedFiles = new Set(["SHA256SUMS", archive, "metadata.json", "sbom.spdx.json"]);
  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length !== expectedFiles.size ||
    entries.some((entry) => !entry.isFile() || !expectedFiles.has(entry.name))
  ) {
    throw new Error("Release download contains missing, extra, or non-regular files.");
  }

  const lines = (await readFile(resolve(directory, "SHA256SUMS"), "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean);
  const expectedSubjects = new Set([archive, "sbom.spdx.json"]);
  const declared = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9.-]+)$/u.exec(line);
    if (!match || !expectedSubjects.has(match[2]) || declared.has(match[2])) {
      throw new Error("Release checksum manifest has an unexpected or duplicate entry.");
    }
    declared.set(match[2], match[1]);
  }
  if (declared.size !== expectedSubjects.size)
    throw new Error("Release checksum manifest is incomplete.");
  for (const subject of expectedSubjects) {
    const digest = await sha256File(resolve(directory, subject));
    if (digest.sha256 !== declared.get(subject))
      throw new Error(`Release checksum mismatch for ${subject}.`);
  }
  return { status: "verified", archive: basename(archive), subjects: [...expectedSubjects] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    JSON.stringify(
      await verifyReleaseAssets(requireArg(args, "directory"), requireArg(args, "tag")),
    ),
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(
      `verify-release-assets: ${error instanceof Error ? error.message : "unexpected failure"}`,
    );
    process.exitCode = 1;
  });
}
