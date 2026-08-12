#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { normalize } from "node:path";
import { findUnsafeCredentialAssignments } from "./credential-assignment-scan.mjs";

const includeHistory = process.argv.includes("--history");
const strictHistoryIdentifiers = process.argv.includes("--strict-history-identifiers");
const selfTest = process.argv.includes("--self-test");
const maxTextBytes = 5 * 1024 * 1024;

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function publicationFiles() {
  return git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean);
}

const forbiddenPaths = [
  /(^|\/)\.openai(?:\/|$)/i,
  /^data\//i,
  /^scripts\/seed-demo\.mjs$/i,
  /(^|\/)(?:\.env(?:\..+)?|id_(?:rsa|dsa|ecdsa|ed25519))$/i,
  /\.(?:db|sqlite|sqlite3|d1|r2|pem|p12|pfx|key|keystore)$/i,
  /(^|\/)(?:production|prod)[-_]?(?:backup|export|dump|evidence|data)(?:\/|\.|$)/i,
  /(^|\/)(?:backup|export|dump)[-_]?(?:production|prod)(?:\/|\.|$)/i,
  /(^|\/)(?:operator[-_]?artifacts?|restore[-_]?verification|evidence[-_]?inventory|d1[-_]?(?:snapshot|export)|scheduled[-_]?backup)(?:\/|\.|[-_])/i,
  /\.(?:bak|dump|sqlitedb|tar|tgz|zip|7z|rar)$/i,
];

const pathExceptions = new Set([".env.example"]);
const genericAssignmentFixturePaths = new Set(["tests/credential-assignment-scan.test.mjs"]);

const approvedGeneratedMedia = new Map([
  [
    "assets/brand/scam-reports-wordmark-master.png",
    "d45f6cdd43976a13ca8e3cd64178fd59cc2c27d3a4d0abcdf799a96a0cedce27",
  ],
  [
    "assets/brand/scam-reports-emblem-chroma.png",
    "63c132bb17ca0b463624a4e605b871afde0e73a51fe1a4cb7bb60ca0b7ec700d",
  ],
  [
    "assets/brand/scam-reports-emblem-master.png",
    "4dc8360189e08c46cb395e88fb0352c984d01df19e6348e884de9c1d9b294e29",
  ],
  [
    "assets/brand/scam-reports-wordmark-original.png",
    "5e3c8bd644b9cd4bd15621ba6e07411339109cc13de5fb3373f2dbd0a9b12243",
  ],
]);

const highConfidencePatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Stripe live secret", /\bsk_live_[A-Za-z0-9]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["OpenAI secret", /\bsk-(?:proj-)?[A-Za-z0-9_-]{30,}\b/],
  ["Discord MFA token", /\bmfa\.[A-Za-z0-9_-]{40,}\b/],
  ["Discord bot token", /\b[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,39}\b/],
  [
    "Discord webhook credential",
    /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[A-Za-z0-9_-]{40,}/i,
  ],
  ["Cloudflare API token", /\bv1\.0-[A-Za-z0-9_-]{35,80}\b/],
  ["Cloudflare global API key", /\b[0-9a-f]{37}\b/i],
];

function isText(buffer) {
  if (buffer.length > maxTextBytes || buffer.includes(0)) return false;
  const decoded = buffer.toString("utf8");
  return !decoded.includes("\uFFFD");
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

const findings = [];

function add(kind, file, line) {
  findings.push({ kind, file, line });
}

function isSyntheticDiscordIdentifier(value) {
  const hasCountingTail =
    value.length === 18 &&
    [...value.slice(1)].every((digit, index) => digit === String((index + 2) % 10));
  return (
    /^([0-9])\1{16,19}$/u.test(value) ||
    /^[1-9][0-9]?0{10,16}[0-9]{2,6}$/u.test(value) ||
    hasCountingTail
  );
}

function scanDiscordIdentifiers(file, text) {
  const snowflake = /(?<![0-9])[0-9]{17,20}(?![0-9])/gu;
  for (const match of text.matchAll(snowflake)) {
    if (!isSyntheticDiscordIdentifier(match[0])) {
      add("production-looking Discord identifier", file, lineNumber(text, match.index));
    }
  }
}

function isNumberedMigration(file) {
  return /^drizzle\/\d{4}_[a-z0-9_]+\.sql$/u.test(file);
}

function isAllowedBinary(file) {
  return (
    approvedGeneratedMedia.has(file) ||
    /^public\/[a-zA-Z0-9/_-]+\.(?:png|jpe?g|webp|gif|ico|woff2?)$/u.test(file) ||
    /^tests\/fixtures\/synthetic\/[a-zA-Z0-9/_-]+\.(?:png|jpe?g|webp)$/u.test(file)
  );
}

function classifyPath(file, buffer) {
  const approvedHash = approvedGeneratedMedia.get(file);
  const actualHash = approvedHash ? createHash("sha256").update(buffer).digest("hex") : null;
  const isApprovedGeneratedAsset = approvedHash === actualHash;
  if (approvedHash && !isApprovedGeneratedAsset) {
    add("approved brand source hash mismatch", file, 0);
  }

  if (!pathExceptions.has(file) && forbiddenPaths.some((rule) => rule.test(file))) {
    add("sensitive filename", file, 0);
  }
  if (file.toLowerCase().endsWith(".sql") && !isNumberedMigration(file)) {
    add("non-migration SQL/export file", file, 0);
  }
  if (
    !file.startsWith("drizzle/meta/") &&
    /(^|\/)[a-z0-9_-]*(?:snapshot|backup|export|inventory|verification|quarantine)(?:\.manifest)?\.json$/iu.test(
      file,
    )
  ) {
    add("potential operator output", file, 0);
  }
  if (!isText(buffer)) {
    const embeddedText = buffer.toString("latin1");
    if (
      !isApprovedGeneratedAsset &&
      /(?:trainedAlgorithmicMedia|OpenAI Media Service API|gpt-image)/iu.test(embeddedText)
    ) {
      add("generated-media provenance", file, 0);
    }
    if (/(^|\/)(?:evidence|proof|screenshots?|uploads?|attachments?)(?:\/|[-_.])/iu.test(file)) {
      add("potential evidence binary", file, 0);
    }
    if (!isAllowedBinary(file)) add("unexpected binary publication file", file, 0);
  }
}

function scanText(file, text) {
  for (const [kind, pattern] of highConfidencePatterns) {
    const match = pattern.exec(text);
    if (match) add(kind, file, lineNumber(text, match.index));
  }

  if (
    file !== "package-lock.json" &&
    !genericAssignmentFixturePaths.has(file) &&
    !/^drizzle\/meta\/\d{4}_snapshot\.json$/u.test(file)
  ) {
    const context = /\.(?:[cm]?[jt]sx?)$/iu.test(file)
      ? "code"
      : /\.md$/iu.test(file)
        ? "documentation"
        : "data";
    for (const assignment of findUnsafeCredentialAssignments(text, { context })) {
      add("generic credential assignment", file, assignment.line);
    }
  }

  if (
    /^(?:app|components|lib|worker)\//u.test(file) &&
    /(?:ALLOW_DEMO_FIXTURES|@\/data\/(?:reports|reviews)\.json|public demo|Local demo administrator)/iu.test(
      text,
    )
  ) {
    add("runtime demo content", file, 1);
  }

  if (file === "vite.config.ts" && /CODEX_(?:SANDBOX|HOME)/u.test(text)) {
    add("tool-specific runtime branch", file, 1);
  }

  if (/(^|\/)wrangler\.[^/]+$/i.test(file)) {
    const databaseId = /["']?database_id["']?\s*:\s*["']([0-9a-f-]{36})["']/gi;
    for (const match of text.matchAll(databaseId)) {
      const value = match[1];
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value) &&
        !/^0{8}-0{4}-[0-9a-f]{4}-[0-9a-f]{4}-0{12}$/iu.test(value)
      ) {
        add("embedded Cloudflare D1 resource ID", file, lineNumber(text, match.index));
      }
    }
  }

  if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(file)) {
    const actionUse = /^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gim;
    for (const match of text.matchAll(actionUse)) {
      const reference = match[1];
      if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
      if (!/@[0-9a-f]{40}$/i.test(reference)) {
        add(
          "GitHub Action is not pinned to a full commit SHA",
          file,
          lineNumber(text, match.index),
        );
      }
    }
  }
}

if (selfTest) {
  const credentialName = (...parts) => parts.join("_");
  const keyOne = credentialName("DISCORD", "CLIENT", "SECRET");
  const keyTwo = credentialName("INTERNAL", "SERVICE", "TOKEN");
  const keyThree = credentialName("INTERNAL", "API", "KEY");
  const keyFour = credentialName("CLOUDFLARE", "API", "TOKEN");
  const expectTextFinding = (file, text, expectedKind) => {
    const before = findings.length;
    scanText(file, text);
    if (!findings.slice(before).some((finding) => finding.kind === expectedKind)) {
      throw new Error(`Publication audit self-test did not detect ${expectedKind} in ${file}.`);
    }
  };
  classifyPath(
    "operator-artifacts/staging-snapshot.sql",
    Buffer.from("CREATE TABLE private_data(value TEXT);"),
  );
  classifyPath("private/staging-snapshot.manifest.json", Buffer.from("{}"));
  classifyPath("evidence/raw-upload.bin", Buffer.from([0, 1, 2, 3]));
  classifyPath(
    "public/generated-card.png",
    Buffer.from([0, 1, ...Buffer.from("trainedAlgorithmicMedia"), 0]),
  );
  expectTextFinding(
    "lib/runtime-demo.ts",
    "const source = '@/data/reports.json';",
    "runtime demo content",
  );
  for (const [file, text, expectedKind] of [
    ["self-test-generic.ts", `${keyOne}=live-${"d".repeat(32)}`, "generic credential assignment"],
    [
      "self-test-declaration.ts",
      `const ${keyTwo} = "live-${"i".repeat(32)}";`,
      "generic credential assignment",
    ],
    [
      "self-test-discord.ts",
      `${"M"}${"a".repeat(23)}.${"b".repeat(6)}.${"c".repeat(30)}`,
      "Discord bot token",
    ],
    ["self-test-cloudflare.ts", `${keyFour}=cf-${"z".repeat(48)}`, "generic credential assignment"],
    [
      "tests/substring-bypass.test.ts",
      `const ${keyTwo} = "prod_${"q".repeat(12)}test${"r".repeat(12)}";`,
      "generic credential assignment",
    ],
    [
      "tests/dotted-bypass.test.ts",
      `const ${keyThree} = "prod_env.${"s".repeat(24)}";`,
      "generic credential assignment",
    ],
  ]) {
    expectTextFinding(file, text, expectedKind);
  }
  const placeholderFindingCount = findings.length;
  scanText(
    "tests/explicit-placeholder.test.ts",
    `const ${keyTwo} = "test-internal-service-token-placeholder";`,
  );
  if (findings.length !== placeholderFindingCount) {
    throw new Error("Publication audit self-test rejected an explicit test placeholder.");
  }
  const productionLikeDiscordId = String(1_456_789_012_345_678_901n);
  const syntheticDiscordId = `9${"0".repeat(14)}001`;
  scanDiscordIdentifiers(
    "self-test-production-discord.ts",
    `const DISCORD_SECURITY_CHANNEL_ID = "${productionLikeDiscordId}";`,
  );
  scanDiscordIdentifiers(
    "tests/synthetic-discord-fixture.test.ts",
    `const DISCORD_SECURITY_CHANNEL_ID = "${syntheticDiscordId}";`,
  );
  const kinds = new Set(findings.map((finding) => finding.kind));
  for (const expected of [
    "sensitive filename",
    "non-migration SQL/export file",
    "potential operator output",
    "unexpected binary publication file",
    "potential evidence binary",
    "generated-media provenance",
    "runtime demo content",
    "Discord bot token",
    "production-looking Discord identifier",
    "generic credential assignment",
  ]) {
    if (!kinds.has(expected))
      throw new Error(`Publication audit self-test did not detect ${expected}.`);
  }
  if (findings.some((finding) => finding.file === "tests/synthetic-discord-fixture.test.ts")) {
    throw new Error("Publication audit self-test rejected a synthetic Discord fixture ID.");
  }
  console.log("Publication audit self-test passed.");
  process.exit(0);
}

const files = publicationFiles();

for (const rawPath of files) {
  if (!existsSync(rawPath)) continue;
  const file = normalize(rawPath).replaceAll("\\", "/");
  const buffer = readFileSync(rawPath);
  classifyPath(file, buffer);
  if (isText(buffer)) {
    const text = buffer.toString("utf8");
    scanText(file, text);
    scanDiscordIdentifiers(file, text);
  }
}

if (includeHistory) {
  const commits = git(["rev-list", "--all"]).split(/\r?\n/u).filter(Boolean);
  const scannedBlobs = new Set();

  for (const commit of commits) {
    const entries = git(["ls-tree", "-r", "-z", "--format=%(objectname)%x09%(path)", commit])
      .split("\0")
      .filter(Boolean);

    for (const entry of entries) {
      const separator = entry.indexOf("\t");
      if (separator === -1) continue;
      const object = entry.slice(0, separator);
      const file = entry.slice(separator + 1).replaceAll("\\", "/");
      if (file === "package-lock.json" || scannedBlobs.has(object)) continue;
      scannedBlobs.add(object);

      const buffer = execFileSync("git", ["cat-file", "blob", object], {
        encoding: null,
        maxBuffer: 128 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (isText(buffer)) {
        const text = buffer.toString("utf8");
        scanText(file, text);
        if (strictHistoryIdentifiers) scanDiscordIdentifiers(file, text);
      }
    }
  }
}

const unique = [
  ...new Map(
    findings.map((finding) => [`${finding.kind}\0${finding.file}\0${finding.line}`, finding]),
  ).values(),
];

if (unique.length) {
  console.error("Publication audit failed. Potentially sensitive material found:");
  for (const finding of unique) {
    const location = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    console.error(`- ${finding.kind} at ${location}`);
  }
  console.error("Values are intentionally omitted. Inspect and remove or replace each item.");
  process.exit(1);
}

console.log(
  `Publication audit passed for ${files.length} tracked or untracked publication files${
    includeHistory ? " and reachable Git history" : ""
  }${strictHistoryIdentifiers ? " with strict historical identifier checks" : ""}.`,
);
