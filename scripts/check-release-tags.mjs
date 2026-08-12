#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const semverTag = /^v\d+\.\d+\.\d+$/u;
const selectedTagArgument = process.argv.indexOf("--tag");
const selectedTag = selectedTagArgument === -1 ? undefined : process.argv[selectedTagArgument + 1];

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseJson(text, location) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${location} is not valid JSON.`);
  }
}

if (selectedTagArgument !== -1 && (!selectedTag || !semverTag.test(selectedTag))) {
  console.error("--tag requires a vMAJOR.MINOR.PATCH value.");
  process.exit(2);
}

if (git(["rev-parse", "--is-shallow-repository"]) === "true") {
  console.error("Release-tag verification requires complete Git history and tags.");
  console.error("Fetch with --unshallow --tags, or configure checkout with fetch-depth: 0.");
  process.exit(2);
}

const tags = git(["tag", "--list", "v*", "--sort=version:refname"]).split(/\r?\n/u).filter(Boolean);
const tagSet = new Set(tags);
const problems = [];

for (const tag of tags) {
  if (!semverTag.test(tag)) {
    problems.push(`release tag is not vMAJOR.MINOR.PATCH: ${tag}`);
    continue;
  }

  let objectType;
  let commit;
  let manifest;
  let lockfile;
  try {
    objectType = git(["cat-file", "-t", `refs/tags/${tag}`]);
    commit = git(["rev-parse", `refs/tags/${tag}^{commit}`]);
    manifest = parseJson(git(["show", `${commit}:package.json`]), `${tag}:package.json`);
    lockfile = parseJson(git(["show", `${commit}:package-lock.json`]), `${tag}:package-lock.json`);
  } catch {
    problems.push(`${tag} cannot be resolved to package.json and package-lock.json`);
    continue;
  }

  if (objectType !== "tag") problems.push(`${tag} is lightweight; release tags must be annotated`);
  if (!/^\d+\.\d+\.\d+$/u.test(manifest.version ?? "")) {
    problems.push(`${tag} has an invalid package.json version`);
    continue;
  }
  if (
    lockfile.version !== manifest.version ||
    lockfile.packages?.[""]?.version !== manifest.version
  ) {
    problems.push(`${tag} has inconsistent package and lockfile versions`);
  }

  if (tag !== `v${manifest.version}`) {
    problems.push(`${tag} points to package version ${manifest.version}`);
  }
}

if (selectedTag) {
  if (!tagSet.has(selectedTag))
    problems.push(`selected release tag does not exist: ${selectedTag}`);
  const rootManifest = parseJson(readFileSync("package.json", "utf8"), "package.json");
  const rootLockfile = parseJson(readFileSync("package-lock.json", "utf8"), "package-lock.json");
  if (selectedTag !== `v${rootManifest.version}`) {
    problems.push(`${selectedTag} does not match package.json version ${rootManifest.version}`);
  }
  if (
    rootLockfile.version !== rootManifest.version ||
    rootLockfile.packages?.[""]?.version !== rootManifest.version
  ) {
    problems.push("working package.json and package-lock.json versions do not agree");
  }
  if (tagSet.has(selectedTag)) {
    const tagCommit = git(["rev-parse", `refs/tags/${selectedTag}^{commit}`]);
    const headCommit = git(["rev-parse", "HEAD"]);
    if (tagCommit !== headCommit) problems.push(`${selectedTag} does not point to HEAD`);
  }
}

if (problems.length) {
  console.error("Release-tag verification failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`Release-tag verification passed for ${tags.length} tag(s).`);
