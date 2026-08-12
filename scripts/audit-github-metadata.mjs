#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findUnsafeCredentialAssignments } from "./credential-assignment-scan.mjs";

const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/u],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ["Stripe live secret", /\bsk_live_[A-Za-z0-9]{20,}\b/u],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ["OpenAI secret", /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/u],
  ["Discord MFA token", /\bmfa\.[A-Za-z0-9_-]{40,}\b/u],
  ["Discord bot token", /\b[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,39}\b/u],
  [
    "Discord webhook credential",
    /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{40,}/iu,
  ],
  ["Cloudflare API token", /\bv1\.0-[A-Za-z0-9_-]{35,80}\b/u],
];
const publicationTracePatterns = [
  ["tool-specific review trace", /\b(?:Codex Security|Codex review|ChatGPT)\b/iu],
  ["local Windows path", /\b[A-Z]:\\Users\\[^\s\\]+\\/iu],
  ["local Unix home path", /\/(?:Users|home)\/[^\s/]+\//u],
];
const textPatterns = [...secretPatterns, ...publicationTracePatterns];
const maxResponseBytes = 16 * 1024 * 1024;

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function inspectText(findings, location, text, options = {}) {
  if (typeof text !== "string" || !text) return;
  for (const [kind, pattern] of textPatterns) {
    const match = pattern.exec(text);
    if (match) findings.push({ kind, location, line: lineNumber(text, match.index) });
  }
  for (const assignment of findUnsafeCredentialAssignments(text)) {
    findings.push({
      kind: "generic credential assignment",
      location,
      line: assignment.line,
    });
  }
  if (options.rejectEscapedNewlines && /\\n/u.test(text)) {
    findings.push({
      kind: "literal escaped newline in published prose",
      location,
      line: lineNumber(text, text.indexOf("\\n")),
    });
  }
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const selfTest = process.argv.includes("--self-test");
const repositoryArgument = argumentValue("--repository");
const knownArguments = new Set(["--self-test", "--repository"]);
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!knownArguments.has(argument) && process.argv[index - 1] !== "--repository") {
    console.error(`Unknown GitHub metadata audit option: ${argument}`);
    process.exit(2);
  }
}

if (selfTest) {
  const findings = [];
  const credentialName = (...parts) => parts.join("_");
  const keyOne = credentialName("RESEND", "API", "KEY");
  const keyTwo = credentialName("DISCORD", "CLIENT", "SECRET");
  const keyThree = credentialName("INTERNAL", "SERVICE", "TOKEN");
  const keyFour = credentialName("CLOUDFLARE", "API", "TOKEN");
  const fakeDiscordFixture = `${"M"}${"a".repeat(23)}.${"b".repeat(6)}.${"c".repeat(30)}`;
  const expectInspectFinding = (location, text, expectedKind, options = {}) => {
    const before = findings.length;
    inspectText(findings, location, text, options);
    if (!findings.slice(before).some((finding) => finding.kind === expectedKind)) {
      throw new Error(`GitHub metadata self-test missed ${expectedKind} in ${location}.`);
    }
  };
  expectInspectFinding(
    "synthetic pull request body",
    "Codex Security review completed.",
    "tool-specific review trace",
  );
  expectInspectFinding(
    "synthetic release body",
    "first line\\nsecond line",
    "literal escaped newline in published prose",
    { rejectEscapedNewlines: true },
  );
  expectInspectFinding("synthetic issue comment", fakeDiscordFixture, "Discord bot token");
  for (const [location, text] of [
    ["synthetic export assignment", `export ${keyOne}="prod_${"q".repeat(32)}"`],
    ["synthetic JSON assignment", `{"${keyTwo}":"prod_${"r".repeat(32)}"}`],
    ["synthetic dotted assignment", `${keyThree}=prod_env.${"s".repeat(24)}`],
  ]) {
    expectInspectFinding(location, text, "generic credential assignment");
  }
  const placeholderFindingCount = findings.length;
  inspectText(
    findings,
    "synthetic placeholder description",
    [
      `${keyOne}=test-resend-api-key-placeholder`,
      `${keyTwo}=<discord-client-secret>`,
      `${keyFour}=\${{ secrets.${keyFour} }}`,
    ].join("\n"),
  );
  if (findings.length !== placeholderFindingCount) {
    throw new Error("GitHub metadata self-test rejected an explicit test placeholder.");
  }
  const kinds = new Set(findings.map((finding) => finding.kind));
  for (const expected of [
    "tool-specific review trace",
    "literal escaped newline in published prose",
    "Discord bot token",
    "generic credential assignment",
  ]) {
    if (!kinds.has(expected)) throw new Error(`GitHub metadata self-test missed ${expected}.`);
  }
  console.log("GitHub metadata audit self-test passed without printing inspected values.");
  process.exit(0);
}

if (process.argv.includes("--repository") && !repositoryArgument) {
  console.error("--repository requires an owner/name value.");
  process.exit(2);
}

function defaultRepository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const url = String(manifest.repository?.url ?? "");
  return url.match(/github\.com[/:]([^/\s]+\/[^/\s]+)$/iu)?.[1]?.replace(/\.git$/iu, "");
}

const repository = repositoryArgument ?? defaultRepository();
if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
  console.error("Set GITHUB_REPOSITORY or pass --repository owner/name.");
  process.exit(2);
}

function authenticationToken() {
  const environmentToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (environmentToken) return environmentToken.trim();
  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

const token = authenticationToken();
const apiRoot = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/$/u, "");
let apiUrl;
try {
  apiUrl = new URL(apiRoot);
} catch {
  console.error("GITHUB_API_URL is invalid.");
  process.exit(2);
}
if (apiUrl.protocol !== "https:" || apiUrl.hostname !== "api.github.com") {
  console.error("This audit sends credentials only to https://api.github.com.");
  process.exit(2);
}

let requestCount = 0;

async function requestJson(path) {
  requestCount += 1;
  if (requestCount > 500)
    throw new Error("GitHub metadata request count exceeded the safety bound.");
  const response = await fetch(`${apiRoot}${path}`, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "scam-reports-publication-audit",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status} for a read-only metadata request.`);
  }
  const declaredBytes = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > maxResponseBytes) {
    throw new Error("GitHub metadata response exceeded the size safety bound.");
  }
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > maxResponseBytes) {
    throw new Error("GitHub metadata response exceeded the size safety bound.");
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("GitHub returned invalid JSON for a metadata request.");
  }
}

async function paged(path, property) {
  const result = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const payload = await requestJson(`${path}${separator}per_page=100&page=${page}`);
    const items = property ? payload?.[property] : payload;
    if (!Array.isArray(items)) throw new Error("GitHub returned an unexpected metadata shape.");
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error("GitHub metadata pagination exceeded the 10,000-item safety bound.");
}

const prefix = `/repos/${repository}`;
const findings = [];
let inspectedFields = 0;
function scan(location, value, options) {
  inspectedFields += 1;
  inspectText(findings, location, value, options);
}

function positiveInteger(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("GitHub returned an unexpected numeric identifier.");
  }
  return value;
}

try {
  const repo = await requestJson(prefix);
  scan("repository description", repo.description);
  scan("repository homepage", repo.homepage);

  const [issues, issueComments, pullComments, pulls, releases, labels, milestones] =
    await Promise.all([
      paged(`${prefix}/issues?state=all`),
      paged(`${prefix}/issues/comments`),
      paged(`${prefix}/pulls/comments`),
      paged(`${prefix}/pulls?state=all`),
      paged(`${prefix}/releases`),
      paged(`${prefix}/labels`),
      paged(`${prefix}/milestones?state=all`),
    ]);

  for (const [issueIndex, issue] of issues.entries()) {
    const kind = issue.pull_request ? "pull request" : "issue";
    scan(`${kind} item ${issueIndex + 1} title`, issue.title);
    scan(`${kind} item ${issueIndex + 1} body`, issue.body);
  }
  for (const [commentIndex, comment] of issueComments.entries()) {
    scan(`issue or pull-request comment item ${commentIndex + 1}`, comment.body);
  }
  for (const [commentIndex, comment] of pullComments.entries()) {
    scan(`pull-request review comment item ${commentIndex + 1}`, comment.body);
  }
  for (const [pullIndex, pull] of pulls.entries()) {
    const pullNumber = positiveInteger(pull.number);
    const reviews = await paged(`${prefix}/pulls/${pullNumber}/reviews`);
    for (const [reviewIndex, review] of reviews.entries()) {
      scan(`pull request item ${pullIndex + 1} review ${reviewIndex + 1} body`, review.body);
    }
  }
  for (const [releaseIndex, release] of releases.entries()) {
    const releaseLocation = `release item ${releaseIndex + 1}`;
    scan(`${releaseLocation} tag`, release.tag_name);
    scan(`${releaseLocation} name`, release.name);
    scan(`${releaseLocation} body`, release.body, { rejectEscapedNewlines: true });
    const assets = Array.isArray(release.assets) ? release.assets : [];
    for (const [assetIndex, asset] of assets.entries()) {
      scan(`${releaseLocation} asset ${assetIndex + 1} name`, asset.name);
      scan(`${releaseLocation} asset ${assetIndex + 1} label`, asset.label);
    }
  }
  for (const [labelIndex, label] of labels.entries()) {
    scan(`label item ${labelIndex + 1} name`, label.name);
    scan(`label item ${labelIndex + 1} description`, label.description);
  }
  for (const [milestoneIndex, milestone] of milestones.entries()) {
    scan(`milestone item ${milestoneIndex + 1} title`, milestone.title);
    scan(`milestone item ${milestoneIndex + 1} description`, milestone.description);
  }

  const [workflowRuns, artifacts] = await Promise.all([
    paged(`${prefix}/actions/runs`, "workflow_runs"),
    paged(`${prefix}/actions/artifacts`, "artifacts"),
  ]);
  for (const [runIndex, run] of workflowRuns.entries()) {
    scan(`Actions run item ${runIndex + 1} name`, run.name);
    scan(`Actions run item ${runIndex + 1} title`, run.display_title);
    scan(`Actions run item ${runIndex + 1} commit message`, run.head_commit?.message);
  }
  for (const [artifactIndex, artifact] of artifacts.entries()) {
    scan(`Actions artifact item ${artifactIndex + 1} name`, artifact.name);
  }
} catch (error) {
  console.error(
    `GitHub metadata audit could not complete: ${error instanceof Error ? error.message : "unexpected failure"}`,
  );
  console.error("No response body or inspected metadata value was printed.");
  process.exit(2);
}

const uniqueFindings = [
  ...new Map(
    findings.map((finding) => [`${finding.kind}\0${finding.location}\0${finding.line}`, finding]),
  ).values(),
];
if (uniqueFindings.length) {
  console.error("GitHub metadata audit failed. Review these fields without copying their values:");
  for (const finding of uniqueFindings) {
    console.error(`- ${finding.kind} at ${finding.location}, line ${finding.line}`);
  }
  console.error("Inspected values are intentionally omitted from this output.");
  process.exit(1);
}

console.log(
  `GitHub metadata audit passed for ${repository} (${inspectedFields} text field(s) inspected).`,
);
console.log(
  "Release asset bytes and Actions log archives are not downloaded by this metadata-only check.",
);
