#!/usr/bin/env node

import { createHash, createHmac } from "node:crypto";
import { access, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export const MAX_D1_EXPORT_BYTES = 1024 * 1024 * 1024;

export function parseArgs(argv, options = {}) {
  const booleans = new Set(options.booleans ?? []);
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected positional argument: ${token}`);
    const name = token.slice(2);
    if (!name || name.includes("=")) throw new Error(`Unsupported argument syntax: ${token}`);
    if (Object.hasOwn(values, name))
      throw new Error(`Argument --${name} was provided more than once.`);
    if (booleans.has(name)) {
      values[name] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Argument --${name} requires a value.`);
    values[name] = value;
    index += 1;
  }
  return values;
}

export function requireArg(args, name) {
  const value = args[name];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Missing required argument --${name}.`);
  return value.trim();
}

export function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value || /^(?:replace|example|placeholder|not-set)/iu.test(value)) {
    throw new Error(`Required environment variable ${name} is unavailable.`);
  }
  return value;
}

export function assertEqual(label, actual, confirmation) {
  if (actual !== confirmation)
    throw new Error(`${label} confirmation does not match the selected target.`);
}

export function assertEnvironment(value, { allowProduction = true } = {}) {
  const environment = value.toLowerCase();
  const allowed = allowProduction
    ? new Set(["development", "staging", "production", "restore-test"])
    : new Set(["development", "staging", "restore-test"]);
  if (!allowed.has(environment)) throw new Error(`Unsupported environment: ${value}`);
  return environment;
}

export function assertUuid(value, label = "database ID") {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  if (/^0{8}-0{4}-[0-9a-f]{4}-[0-9a-f]{4}-0{12}$/iu.test(value)) {
    throw new Error(`${label} is still a placeholder.`);
  }
  return value;
}

export function assertAccountId(value) {
  if (!/^[0-9a-f]{32}$/iu.test(value))
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.");
  return value;
}

export function assertDatabaseName(value) {
  if (!/^[a-z0-9][a-z0-9_-]{2,62}$/iu.test(value))
    throw new Error("Database name contains unsupported characters.");
  return value;
}

export function assertBucketName(value) {
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(value) || value.includes("..")) {
    throw new Error(`Invalid R2 bucket name: ${value}`);
  }
  return value;
}

export function isProductionLike(value) {
  return (
    /(^|[-_.])(prod(?:uction)?|live)([-_.]|$)/iu.test(value) ||
    value.toLowerCase() === "scam-reports-org"
  );
}

export function assertSafeRestoreTarget(name, mode) {
  assertDatabaseName(name);
  if (isProductionLike(name))
    throw new Error("Restore rehearsals can never target a production-like database name.");
  const safeMarker =
    mode === "local"
      ? /(?:^|[-_])local(?:$|[-_])/iu
      : /(?:^|[-_])(?:restore[-_]?test|test[-_]?restore)(?:$|[-_])/iu;
  if (!safeMarker.test(name)) {
    throw new Error(
      mode === "local"
        ? "A local restore target name must contain a distinct 'local' segment."
        : "A remote restore target name must contain a distinct 'restore-test' segment.",
    );
  }
  return name;
}

export function safeOutputPath(value, label) {
  const path = resolve(value);
  const root = parse(path).root;
  const home = process.env.USERPROFILE ? resolve(process.env.USERPROFILE) : null;
  if (path === root || (home && path === home) || basename(path) === "..") {
    throw new Error(`${label} cannot be a filesystem root or home directory.`);
  }
  return path;
}

export async function ensureFreshDirectory(path, label) {
  const target = safeOutputPath(path, label);
  try {
    await access(target, fsConstants.F_OK);
    throw new Error(
      `${label} already exists; choose a fresh path so prior state cannot contaminate the rehearsal.`,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      return target;
    }
    throw error;
  }
}

export async function ensureOutputParent(path) {
  const target = safeOutputPath(path, "Output file");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  return target;
}

export async function writeJsonExclusive(path, value) {
  const target = await ensureOutputParent(path);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return target;
}

export async function sha256File(path) {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of handle.createReadStream()) {
      size += chunk.length;
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), size };
}

export async function downloadToExclusiveFile(urlValue, path, maxBytes = MAX_D1_EXPORT_BYTES) {
  const url = new URL(urlValue);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("D1 export returned an unsafe download URL.");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(120_000),
  });
  return downloadResponseToExclusiveFile(response, path, maxBytes, "D1 export");
}

export async function downloadResponseToExclusiveFile(
  response,
  path,
  maxBytes = MAX_D1_EXPORT_BYTES,
  label = "Download",
) {
  if (!response.ok || !response.body) throw new Error(`${label} returned HTTP ${response.status}.`);
  const target = await ensureOutputParent(path);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit.`);
  const handle = await open(target, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  let completed = false;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new Error(`${label} exceeds the ${maxBytes}-byte safety limit.`);
      hash.update(chunk);
      await handle.write(chunk);
    }
    completed = true;
  } finally {
    await handle.close();
    if (!completed) await rm(target, { force: true });
  }
  return { path: target, sha256: hash.digest("hex"), size };
}

export async function cloudflareApi(path, options = {}) {
  const {
    accountId: providedAccountId,
    token: providedToken,
    headers: providedHeaders,
    ...requestOptions
  } = options;
  const accountId = assertAccountId(providedAccountId ?? requireEnv("CLOUDFLARE_ACCOUNT_ID"));
  const token = providedToken ?? requireEnv("CLOUDFLARE_API_TOKEN");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      ...requestOptions,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(providedHeaders ?? {}),
      },
      signal: requestOptions.signal ?? AbortSignal.timeout(60_000),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.success) {
    const code =
      Array.isArray(payload?.errors) && payload.errors[0]?.code
        ? ` (${payload.errors[0].code})`
        : "";
    throw new Error(`Cloudflare API request failed with HTTP ${response.status}${code}.`);
  }
  return payload.result;
}

export async function verifyD1Target({ accountId, token, databaseId, databaseName }) {
  const result = await cloudflareApi(`/d1/database/${encodeURIComponent(databaseId)}`, {
    accountId,
    token,
  });
  if (!result || result.uuid !== databaseId || result.name !== databaseName) {
    throw new Error(
      "Cloudflare D1 metadata does not match the explicitly confirmed database target.",
    );
  }
  return result;
}

export async function queryD1({ accountId, token, databaseId, sql, params = [] }) {
  const result = await cloudflareApi(`/d1/database/${encodeURIComponent(databaseId)}/query`, {
    accountId,
    token,
    method: "POST",
    body: JSON.stringify({ sql, params }),
  });
  const statements = Array.isArray(result) ? result : [result];
  for (const statement of statements) {
    if (!statement?.success) throw new Error("Cloudflare D1 query did not complete successfully.");
  }
  return statements.flatMap((statement) =>
    Array.isArray(statement.results) ? statement.results : [],
  );
}

export async function batchD1({ accountId, token, databaseId, statements }) {
  if (!Array.isArray(statements) || !statements.length || statements.length > 500) {
    throw new Error("D1 batch must contain between 1 and 500 statements.");
  }
  for (const statement of statements) {
    if (
      typeof statement?.sql !== "string" ||
      !statement.sql.trim() ||
      !Array.isArray(statement.params ?? [])
    ) {
      throw new Error("D1 batch contains an invalid statement.");
    }
  }
  const result = await cloudflareApi(`/d1/database/${encodeURIComponent(databaseId)}/query`, {
    accountId,
    token,
    method: "POST",
    body: JSON.stringify({
      batch: statements.map((statement) => ({
        sql: statement.sql,
        params: statement.params ?? [],
      })),
    }),
  });
  const completed = Array.isArray(result) ? result : [result];
  if (
    completed.length !== statements.length ||
    completed.some((statement) => !statement?.success)
  ) {
    throw new Error("Cloudflare D1 atomic batch did not complete every statement successfully.");
  }
  return completed;
}

export function awsUriEncode(value, encodeSlash = true) {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? encoded : encoded.replaceAll("%2F", "/");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function signedR2Request({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  key = "",
  method = "GET",
  query = {},
  timeoutMs = 60_000,
}) {
  assertAccountId(accountId);
  assertBucketName(bucket);
  if (!/^[A-Za-z0-9]{10,128}$/u.test(accessKeyId))
    throw new Error("R2_ACCESS_KEY_ID has an invalid format.");
  if (secretAccessKey.length < 20) throw new Error("R2_SECRET_ACCESS_KEY has an invalid format.");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 10 * 60_000)
    throw new Error("R2 request timeout is outside the operator safety range.");
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, "");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = `/${awsUriEncode(bucket)}/${key ? awsUriEncode(key, false) : ""}`;
  const queryEntries = Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [awsUriEncode(name), awsUriEncode(String(value))])
    .sort(([left], [right]) => left.localeCompare(right));
  const canonicalQuery = queryEntries.map(([name, value]) => `${name}=${value}`).join("&");
  const payloadHash = sha256("");
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, "auto");
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const suffix = canonicalQuery ? `?${canonicalQuery}` : "";
  return {
    url: `https://${host}${canonicalUri}${suffix}`,
    options: {
      method,
      headers: {
        Authorization: authorization,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    },
  };
}

export async function r2Request(options) {
  const request = signedR2Request(options);
  return fetch(request.url, request.options);
}

export function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export async function listR2Objects(options, prefix) {
  const objects = [];
  let continuationToken;
  do {
    const response = await r2Request({
      ...options,
      method: "GET",
      query: {
        "continuation-token": continuationToken,
        "encoding-type": "url",
        "list-type": "2",
        "max-keys": "1000",
        prefix,
      },
    });
    if (!response.ok) throw new Error(`R2 list request failed with HTTP ${response.status}.`);
    const xml = await response.text();
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/gu)) {
      const block = match[1];
      const keyMatch = /<Key>([\s\S]*?)<\/Key>/u.exec(block);
      const sizeMatch = /<Size>(\d+)<\/Size>/u.exec(block);
      if (!keyMatch || !sizeMatch) throw new Error("R2 returned an invalid object listing.");
      objects.push({
        key: decodeURIComponent(decodeXml(keyMatch[1])),
        size: Number(sizeMatch[1]),
      });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/u.test(xml);
    const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/u.exec(xml);
    continuationToken = truncated && tokenMatch ? decodeXml(tokenMatch[1]) : undefined;
    if (truncated && !continuationToken)
      throw new Error("R2 object listing was truncated without a continuation token.");
    if (objects.length > 250_000)
      throw new Error("R2 inventory exceeded the 250,000-object operator safety limit.");
  } while (continuationToken);
  return objects;
}

export async function headR2Object(options, key) {
  const response = await r2Request({ ...options, key, method: "HEAD" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`R2 metadata request failed with HTTP ${response.status}.`);
  const metadata = {};
  for (const [name, value] of response.headers.entries()) {
    if (name.startsWith("x-amz-meta-")) metadata[name.slice("x-amz-meta-".length)] = value;
  }
  return {
    size: Number(response.headers.get("content-length") ?? -1),
    etag: response.headers.get("etag")?.replaceAll('"', "") ?? "",
    uploadedAt: response.headers.get("last-modified") ?? "",
    metadata,
  };
}

export async function mapConcurrent(items, concurrency, callback) {
  const result = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), items.length || 1) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        result[index] = await callback(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return result;
}

export async function loadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function assertFile(path, label) {
  const target = resolve(path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error(`${label} must be a regular file.`);
  return target;
}

export function pathWithin(parent, child) {
  const relation = relative(resolve(parent), resolve(child));
  return (
    relation === "" ||
    (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation))
  );
}

export async function removeOwnedTemporaryDirectory(path, prefix) {
  const systemTemp = resolve(tmpdir());
  const target = resolve(path);
  if (!pathWithin(systemTemp, target) || !basename(target).startsWith(prefix)) {
    throw new Error("Refusing to remove a temporary directory outside the owned operator prefix.");
  }
  await rm(target, { recursive: true, force: true });
}
