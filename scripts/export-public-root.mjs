#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptRoot = fileURLToPath(new URL("../", import.meta.url));

function usage() {
  return `Usage:
  node scripts/export-public-root.mjs --target <empty-or-missing-directory> [options]

Options:
  --source <git-root>  Repository to export (defaults to this checkout)
  --execute            Copy the files; without this flag the command is a dry run
  --allow-missing      With --execute, explicitly permit reviewed missing tracked paths
  --list               Print every selected path
  --help                Show this help`;
}

function fail(message) {
  console.error(`export-public-root: ${message}`);
  process.exitCode = 1;
}

function parseArguments(argv) {
  const options = { source: scriptRoot, execute: false, allowMissing: false, list: false };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") options.execute = true;
    else if (argument === "--allow-missing") options.allowMissing = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--help") options.help = true;
    else if (argument === "--source" || argument === "--target") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a directory path.`);
      }
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!options.help && !options.target) throw new Error("--target is required.");
  return options;
}

function git(source, args) {
  return execFileSync("git", ["-C", source, ...args], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function quotePathForLog(value) {
  return JSON.stringify(value)
    .replace(
      /[\u2028\u2029]/gu,
      (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
    )
    .replace(
      /[\u202a-\u202e\u2066-\u2069]/gu,
      (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
    );
}

function safeRelativePath(value) {
  if (
    !value ||
    value.includes("\0") ||
    isAbsolute(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error(`Git returned an unsafe publication path: ${quotePathForLog(value)}.`);
  }
  return value;
}

async function existingPath(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function resolveSource(value) {
  const requested = resolve(value);
  const source = await realpath(requested);
  const stats = await lstat(source);
  if (!stats.isDirectory()) throw new Error("--source must be a directory.");

  let topLevel;
  try {
    topLevel = git(source, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  } catch {
    throw new Error("--source must be the root of a Git working tree.");
  }
  const resolvedTopLevel = await realpath(topLevel);
  if (resolvedTopLevel !== source) throw new Error("--source must be the Git working-tree root.");
  return source;
}

async function resolveTarget(value, source) {
  const requested = resolve(value);
  if (requested.split(sep).some((part) => part.toLowerCase() === ".git")) {
    throw new Error("--target cannot be inside Git metadata.");
  }
  const current = await existingPath(requested);
  let target;

  if (current) {
    if (!current.isDirectory()) throw new Error("--target must be a directory.");
    target = await realpath(requested);
    const contents = await readdir(target);
    if (contents.length !== 0) throw new Error("--target must not exist or must be empty.");
  } else {
    let parent;
    try {
      parent = await realpath(dirname(requested));
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("The target parent directory must exist.");
      throw error;
    }
    const parentStats = await lstat(parent);
    if (!parentStats.isDirectory()) throw new Error("The target parent must be a directory.");
    target = join(parent, basename(requested));
  }

  if (isInside(source, target)) {
    throw new Error("--target cannot be the source directory or live inside it.");
  }
  return { path: target, exists: Boolean(current) };
}

async function selectedFiles(source) {
  const unmerged = git(source, ["diff", "--name-only", "--diff-filter=U", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (unmerged.length !== 0) {
    throw new Error("Resolve every unmerged path before exporting a public root.");
  }

  const output = git(source, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const paths = output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(safeRelativePath)
    .sort((left, right) => left.localeCompare(right, "en"));
  const selected = [];
  const missing = [];

  for (const path of paths) {
    const absolute = join(source, ...path.split("/"));
    const stats = await existingPath(absolute);
    if (!stats) {
      missing.push(path);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Selected path is not a regular file: ${quotePathForLog(path)}`);
    }
    selected.push({ path, absolute, stats });
  }

  return { selected, missing };
}

async function copyMode(sourceStats, destination) {
  try {
    await chmod(destination, sourceStats.mode & 0o777);
  } catch (error) {
    if (process.platform !== "win32" || !["ENOSYS", "EPERM"].includes(error?.code)) throw error;
  }
}

async function copyEntry(entry, target) {
  const destination = join(target, ...entry.path.split("/"));
  await mkdir(dirname(destination), { recursive: true });

  await copyFile(entry.absolute, destination, constants.COPYFILE_EXCL);
  await copyMode(entry.stats, destination);
}

function printSummary({ source, target, selected, missing, execute, allowMissing, list }) {
  const bytes = selected.reduce((total, entry) => total + entry.stats.size, 0);
  console.log("Public-root export plan");
  console.log(`Source: ${source}`);
  console.log(`Target: ${target}`);
  console.log(`Selected: ${selected.length} existing tracked or non-ignored untracked file(s)`);
  console.log(`Missing: ${missing.length} tracked path(s) absent from the working tree`);
  console.log(`Regular-file bytes: ${bytes}`);
  console.log(`Mode: ${execute ? "execute" : "dry-run"}`);
  if (missing.length === 0) {
    console.log("Missing-path policy: no omissions detected");
  } else {
    const heading = execute && allowMissing ? "Allowed omissions" : "Missing tracked paths";
    console.log(`${heading}:`);
    for (const path of missing) console.log(`- ${quotePathForLog(path)}`);
    if (execute && allowMissing) {
      console.log(
        `Missing-path policy: ${missing.length} omission(s) explicitly allowed by --allow-missing`,
      );
    } else if (execute) {
      console.log("Missing-path policy: execution refused unless every omission is reviewed");
    } else {
      console.log(
        "Missing-path policy: review every path; execute will refuse without --allow-missing",
      );
    }
  }
  if (list) {
    console.log("Selected paths:");
    for (const entry of selected) console.log(`- ${quotePathForLog(entry.path)}`);
  }
}

export async function exportPublicRoot(options) {
  const source = await resolveSource(options.source);
  const target = await resolveTarget(options.target, source);
  const { selected, missing } = await selectedFiles(source);
  if (selected.length === 0) throw new Error("Git selected no files for publication.");

  printSummary({
    source,
    target: target.path,
    selected,
    missing,
    execute: options.execute,
    allowMissing: options.allowMissing,
    list: options.list,
  });

  if (!options.execute) {
    console.log("Nothing was copied. Add --execute after reviewing this plan.");
    return { source, target: target.path, selected, missing, copied: 0 };
  }

  if (missing.length !== 0 && !options.allowMissing) {
    throw new Error(
      `refusing to execute because ${missing.length} tracked path(s) are missing; review the JSON-quoted paths above and use --allow-missing only when every omission is intentional.`,
    );
  }
  if (missing.length === 0 && options.allowMissing) {
    throw new Error(
      "refusing an unnecessary --allow-missing override because no tracked paths are missing.",
    );
  }

  if (!target.exists) await mkdir(target.path, { recursive: false });
  for (const entry of selected) await copyEntry(entry, target.path);
  console.log(
    `Copied ${selected.length} file(s). Git history and .git metadata were not exported.`,
  );
  return { source, target: target.path, selected, missing, copied: selected.length };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      await exportPublicRoot(options);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "Unexpected export failure.");
  }
}
