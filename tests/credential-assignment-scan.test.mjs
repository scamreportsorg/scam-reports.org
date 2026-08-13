import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  findCredentialAssignments,
  findUnsafeCredentialAssignments,
  isExplicitCredentialPlaceholder,
} from "../scripts/credential-assignment-scan.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const metadataAudit = fileURLToPath(
  new URL("../scripts/audit-github-metadata.mjs", import.meta.url),
);
const name = (...parts) => parts.join("_");
const assignment = (key, value, separator = "=") => `${key}${separator}${value}`;
const liveValue = `live-${"q".repeat(32)}`;

test("credential scan covers common assignment forms", () => {
  const candidateKey = name("RESEND", "API", "KEY");
  const snakeCandidate = ["client", "secret"].join("_");
  const camelCandidate = ["client", "Secret"].join("");
  const cases = [
    assignment(candidateKey, liveValue),
    JSON.stringify({ [snakeCandidate]: liveValue }),
    `config[${JSON.stringify(candidateKey)}] = ${JSON.stringify(liveValue)};`,
    `config.${camelCandidate} = ${JSON.stringify(liveValue)};`,
    `**${assignment(candidateKey, liveValue)}**`,
    `\`${assignment(candidateKey, liveValue)}\``,
    `> - ${assignment(snakeCandidate, liveValue, ": ")}`,
  ];

  for (const source of cases) {
    const findings = findUnsafeCredentialAssignments(source);
    assert.equal(findings.length, 1, source);
  }
});

test("credential scan checks the whole value", () => {
  const key = name("INTERNAL", "SERVICE", "TOKEN");
  const unsafe = [
    assignment(key, `process.env.${key} ?? ${JSON.stringify(liveValue)}`),
    assignment(key, `${JSON.stringify("test-token-placeholder")} + ${JSON.stringify(liveValue)}`),
    assignment(key, `\`\${TOKEN_FROM_VAULT}-${liveValue}\``),
    assignment(key, `test-${"z".repeat(40)}`),
    assignment(key, `${JSON.stringify("live-value")}.repeat(2)`),
    assignment(key, `process.env.${key} ??\n${JSON.stringify(liveValue)}`),
    `${key} =\n  ${JSON.stringify(liveValue)}`,
    assignment(key, `useFallback\n ? ${JSON.stringify(liveValue)}\n : process.env.${key}`),
    assignment(key, `String.raw\`${liveValue}\``),
    assignment(key, "ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"),
    assignment(key, "abcDefGhiJklMnoPqrStuVwxYz123456"),
    assignment(key, `prod_env.${"s".repeat(24)}`),
  ];

  for (const source of unsafe) {
    const [finding] = findUnsafeCredentialAssignments(source);
    assert.ok(finding, source);
    assert.match(finding.value, /live|test-|\.repeat|prod_env|[A-Z]{12}|abcDef/u, source);
  }
});

test("credential scan handles alternate key syntax", () => {
  const key = name("RESEND", "API", "KEY");
  const reviewedConfig = ["/", "* reviewed config *", "/"].join("");
  const cases = [
    `\`${key}\`: \`${liveValue}\``,
    assignment("password", JSON.stringify(liveValue), ": "),
    assignment("clientSecretValue", JSON.stringify(liveValue)),
    assignment("secret_key_base", JSON.stringify(liveValue), ": "),
    assignment(key, liveValue, " := "),
    `const ${key} ${reviewedConfig} = ${JSON.stringify(liveValue)};`,
  ];

  for (const source of cases) {
    assert.equal(findUnsafeCredentialAssignments(source).length, 1, source);
  }
});

test("credential scan bounds block-comment parsing", () => {
  const key = name("INTERNAL", "SERVICE", "TOKEN");
  const source = `xx\n  ${key} /* reviewed config */ = ${JSON.stringify(liveValue)};`;
  const adversarialComment = `/*${"*//*".repeat(30)}!`;
  const startedAt = performance.now();

  assert.deepEqual(findUnsafeCredentialAssignments(source), [
    {
      index: 5,
      line: 2,
      name: key,
      style: "bare",
      value: JSON.stringify(liveValue),
    },
  ]);
  assert.deepEqual(findCredentialAssignments(`${key} ${adversarialComment}`), []);
  assert.ok(performance.now() - startedAt < 1_000);
});

test("credential scan allows placeholders and references", () => {
  const key = name("INTERNAL", "SERVICE", "TOKEN");
  const safe = [
    ["", "metadata"],
    ['""', "metadata"],
    ["<internal-service-token>", "metadata"],
    ["test-internal-service-token-placeholder", "metadata"],
    ["synthetic-internal-service-token-fixture", "metadata"],
    ["replace-with-internal-service-token", "metadata"],
    ["${TOKEN_FROM_VAULT}", "metadata"],
    ["${{ secrets.INTERNAL_SERVICE_TOKEN }}", "metadata"],
    ["TOKEN_FROM_VAULT", "metadata"],
    [`process.env.${key}`, "metadata"],
    [`process.env.${key} ?? env.${key}`, "metadata"],
    ["await getToken()", "metadata"],
    [`requireEnv(${JSON.stringify(key)})`, "metadata"],
    [`required(this.env.${key}, ${JSON.stringify(key)})`, "metadata"],
    ["stagingToken", "code"],
    ["?", "data"],
    ["null", "metadata"],
    ["3600", "data"],
    ["required", "data"],
  ];

  for (const [value, context] of safe) {
    assert.equal(isExplicitCredentialPlaceholder(value, { context }), true, value);
    assert.equal(
      findUnsafeCredentialAssignments(assignment(key, value), { context }).length,
      0,
      value,
    );
  }

  for (const value of [
    JSON.stringify("TOKEN_FROM_VAULT"),
    "${TOKEN_FROM_VAULT:-live-value}",
    "${{ unknown.INTERNAL_SERVICE_TOKEN }}",
    "test-not-safe",
    "prod_qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
    'readSecret("live-value")',
  ]) {
    assert.equal(isExplicitCredentialPlaceholder(value), false, value);
    assert.equal(
      findUnsafeCredentialAssignments(assignment(key, value), { context: "metadata" }).length,
      1,
      value,
    );
  }
});

test("credential scan ignores types and ordinary names", () => {
  const camelCandidate = ["client", "Secret"].join("");
  assert.equal(
    findUnsafeCredentialAssignments(`${camelCandidate}: string | null;`, { context: "code" })
      .length,
    0,
  );
  assert.equal(
    findCredentialAssignments("const tokenization = 1; const secretPatterns = [];").length,
    0,
  );
});

test("credential scan understands code and docs", () => {
  const key = name("INTERNAL", "SERVICE", "TOKEN");
  const lineComment = ["/", "/"].join("");
  const safeCode = [
    `const ${key} = credential;`,
    `fetch("/", { credentials: "same-origin" });`,
    `<Panel initialCsrfToken={auth.csrfToken} />`,
    `database.prepare("DELETE WHERE token_hash = ?1");`,
    `const accessToken = linked ? "test-link-token-placeholder" : "test-login-token-placeholder";`,
    `const ${key} = process.env["SERVICE_CREDENTIAL"];`,
    `const TOKEN_TTL = 3600; const PASSWORD_MIN_LENGTH = 12;`,
    `type Props = { clientSecret: "literal" | undefined };`,
    `assert.doesNotMatch(value, /password=private/u);`,
  ];
  for (const source of safeCode) {
    assert.equal(findUnsafeCredentialAssignments(source, { context: "code" }).length, 0, source);
  }

  assert.equal(
    findUnsafeCredentialAssignments("- Secret: `PRODUCTION_D1_DATABASE_ID`", {
      context: "documentation",
    }).length,
    0,
  );
  for (const source of [
    `${lineComment} ${assignment(key, liveValue)}`,
    `const note = ${JSON.stringify(assignment(key, liveValue))};`,
    assignment(key, liveValue),
  ]) {
    assert.equal(findUnsafeCredentialAssignments(source, { context: "code" }).length, 1, source);
  }
});

test("metadata findings never echo inspected values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "scam-reports-metadata-audit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const key = name("RESEND", "API", "KEY");
  const labelValue = assignment(key, liveValue);
  const tagValue = assignment(name("DISCORD", "CLIENT", "SECRET"), `tag-${"r".repeat(32)}`);
  const preload = join(directory, "mock-fetch.mjs");
  await writeFile(
    preload,
    [
      `const labelValue = ${JSON.stringify(labelValue)};`,
      `const tagValue = ${JSON.stringify(tagValue)};`,
      "globalThis.fetch = async (input) => {",
      "  const url = new URL(String(input));",
      "  let payload = [];",
      "  if (/\\/repos\\/[^/]+\\/[^/?]+$/.test(url.pathname)) payload = { description: null, homepage: null };",
      "  else if (url.pathname.endsWith('/labels')) payload = [{ id: 1, name: labelValue, description: null }];",
      "  else if (url.pathname.endsWith('/releases')) payload = [{ id: 1, tag_name: tagValue, name: null, body: null, assets: [] }];",
      "  else if (url.pathname.endsWith('/actions/runs')) payload = { workflow_runs: [] };",
      "  else if (url.pathname.endsWith('/actions/artifacts')) payload = { artifacts: [] };",
      "  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });",
      "};",
      "",
    ].join("\n"),
  );

  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(preload).href, metadataAudit, "--repository", "owner/repository"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, GITHUB_TOKEN: "test-github-token-placeholder" },
    },
  );

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /generic credential assignment at label item 1 name/u);
  assert.match(result.stderr, /generic credential assignment at release item 1 tag/u);
  assert.doesNotMatch(result.stderr, new RegExp(liveValue, "u"));
  assert.doesNotMatch(result.stderr, new RegExp(tagValue, "u"));
  assert.doesNotMatch(result.stdout, new RegExp(`${liveValue}|${tagValue}`, "u"));
});
