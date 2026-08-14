#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const shaPattern = /^[0-9a-f]{7,64}$/i;
const argumentsList = process.argv.slice(2);
const checkAll = argumentsList.length === 1 && argumentsList[0] === "--all";
const [baseArg, headArg] = checkAll ? [] : argumentsList;
const base = baseArg || process.env.GITHUB_BASE_SHA;
const head = headArg || process.env.GITHUB_HEAD_SHA || "HEAD";

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

if (base && !shaPattern.test(base)) {
  console.error("Invalid base commit identifier.");
  process.exit(2);
}
if (head !== "HEAD" && !shaPattern.test(head)) {
  console.error("Invalid head commit identifier.");
  process.exit(2);
}

let commits;
try {
  const revisionArguments = checkAll
    ? ["--all"]
    : [base ? `${base}..${head}` : `${head}^..${head}`];
  commits = git(["rev-list", "--no-merges", ...revisionArguments])
    .split(/\r?\n/)
    .filter(Boolean);
} catch {
  console.error("Unable to resolve the DCO commit range. Ensure CI checks out full history.");
  process.exit(2);
}

const unsigned = [];
for (const commit of commits) {
  const record = git(["show", "-s", "--format=%an%x00%ae%x00%aN%x00%aE%x00%B", commit]);
  const [
    authorName = "",
    authorEmail = "",
    canonicalAuthorName = "",
    canonicalAuthorEmail = "",
    ...bodyParts
  ] = record.split("\0");
  const body = bodyParts.join("\0");

  if (/\[bot\]$/i.test(authorName) || /\[bot\]$/i.test(canonicalAuthorName)) continue;

  const signoffs = [...body.matchAll(/^Signed-off-by:\s*.+?\s*<([^>]+)>\s*$/gim)].map((match) =>
    match[1].toLowerCase(),
  );
  const acceptedAuthorEmails = new Set(
    [authorEmail, canonicalAuthorEmail].filter(Boolean).map((email) => email.toLowerCase()),
  );
  if (!signoffs.some((email) => acceptedAuthorEmails.has(email))) {
    unsigned.push(commit.slice(0, 12));
  }
}

if (unsigned.length) {
  console.error("DCO check failed. These commits need an author-matching Signed-off-by trailer:");
  for (const commit of unsigned) console.error(`- ${commit}`);
  console.error("Amend each commit with: git commit --amend --signoff");
  process.exit(1);
}

console.log(`DCO check passed for ${commits.length} non-merge commit(s).`);
