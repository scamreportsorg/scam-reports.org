#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { parseArgs, requireArg } from "./operator-common.mjs";

const HELP = `Usage:
  node scripts/remote-smoke.mjs --base-url <https URL> --expected-commit <sha>
    --expected-version <version> [--bearer-env <environment variable>]
    [--expected-origin <https origin>]
    [--require-staging-fixture]
    [--samples <5..50>] [--max-p95-ms <positive integer>]
    [--min-reports <count>] [--min-reviews <count>]

The command follows no redirects, sends a bearer only to the exact configured
origin, validates /api/version and public payload bounds, then measures the
paginated reports API, FTS search, and rankings page. It performs no mutation.`;

function integerArg(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function safeBaseUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("--base-url must be a credential-free HTTPS origin.");
  }
  url.pathname = "/";
  return url;
}

async function request(baseUrl, path, bearer, maxBytes, expectedType) {
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) throw new Error("Smoke target escaped the configured origin.");
  const started = performance.now();
  const response = await fetch(url, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : undefined,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new Error(`${path} exceeded the ${maxBytes}-byte response bound.`);
  if (!response.body) throw new Error(`${path} returned no response body.`);
  const chunks = [];
  let responseBytes = 0;
  for await (const chunk of response.body) {
    responseBytes += chunk.byteLength;
    if (responseBytes > maxBytes)
      throw new Error(`${path} exceeded the ${maxBytes}-byte response bound.`);
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, responseBytes);
  const elapsedMs = performance.now() - started;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes(expectedType))
    throw new Error(`${path} returned an unexpected content type.`);
  return { text: bytes.toString("utf8"), bytes: responseBytes, elapsedMs };
}

function p95(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ["help", "require-staging-fixture"] });
  if (args.help) {
    console.log(HELP);
    return;
  }
  const baseUrl = safeBaseUrl(requireArg(args, "base-url"));
  const expectedOrigin = args["expected-origin"] ? safeBaseUrl(args["expected-origin"]) : null;
  if (expectedOrigin && baseUrl.origin !== expectedOrigin.origin) {
    throw new Error("--base-url does not match --expected-origin.");
  }
  const expectedCommit = requireArg(args, "expected-commit");
  const expectedVersion = requireArg(args, "expected-version");
  if (!/^[0-9a-f]{40}$/iu.test(expectedCommit))
    throw new Error("--expected-commit must be a full Git SHA.");
  const samples = integerArg(args.samples ?? "20", "--samples", 5, 50);
  const maxP95Ms = integerArg(args["max-p95-ms"] ?? "500", "--max-p95-ms", 1, 60_000);
  const minReports = integerArg(args["min-reports"] ?? "0", "--min-reports", 0, 1_000_000);
  const minReviews = integerArg(args["min-reviews"] ?? "0", "--min-reviews", 0, 10_000_000);
  const bearerName = args["bearer-env"];
  const bearer = bearerName ? process.env[bearerName]?.trim() : undefined;
  if (bearerName && (!bearer || bearer.length < 32))
    throw new Error(`Bearer environment variable ${bearerName} is missing or too short.`);

  const versionResponse = await request(
    baseUrl,
    "/api/version",
    bearer,
    64 * 1024,
    "application/json",
  );
  const version = JSON.parse(versionResponse.text);
  if (version.commit !== expectedCommit)
    throw new Error("Remote source commit does not match the reviewed artifact.");
  if (version.version !== expectedVersion)
    throw new Error("Remote version does not match the reviewed artifact.");
  await request(baseUrl, "/", bearer, 200 * 1024, "text/html");

  const cardinalityReports = await request(
    baseUrl,
    "/api/reports?page=1",
    bearer,
    200 * 1024,
    "application/json",
  );
  const reportCardinality = JSON.parse(cardinalityReports.text).pagination?.totalItems;
  const cardinalityReviews = await request(
    baseUrl,
    "/api/reviews?page=1",
    bearer,
    200 * 1024,
    "application/json",
  );
  const reviewCardinality = JSON.parse(cardinalityReviews.text).pagination?.totalItems;
  if (!Number.isSafeInteger(reportCardinality) || reportCardinality < minReports) {
    throw new Error(
      `Remote dataset has ${String(reportCardinality)} reports; at least ${minReports} are required.`,
    );
  }
  if (!Number.isSafeInteger(reviewCardinality) || reviewCardinality < minReviews) {
    throw new Error(
      `Remote dataset has ${String(reviewCardinality)} approved reviews; at least ${minReviews} are required.`,
    );
  }
  if (args["require-staging-fixture"]) {
    const fixtureReports = await request(
      baseUrl,
      "/api/reports?q=smokeprobe&page=1&sort=newest",
      bearer,
      200 * 1024,
      "application/json",
    );
    const fixtureReportPayload = JSON.parse(fixtureReports.text);
    if (fixtureReportPayload.pagination?.totalItems !== 1_000) {
      throw new Error(
        `Remote staging fixture exposed ${String(fixtureReportPayload.pagination?.totalItems)} reports; exactly 1000 are required.`,
      );
    }
    const fixtureReviews = await request(
      baseUrl,
      "/api/reviews?reportId=SR-STAGEPERF-0001&page=1",
      bearer,
      200 * 1024,
      "application/json",
    );
    const fixtureReviewPayload = JSON.parse(fixtureReviews.text);
    if (
      fixtureReviewPayload.pagination?.totalItems !== 10 ||
      !Array.isArray(fixtureReviewPayload.reviews) ||
      fixtureReviewPayload.reviews.length !== 10 ||
      fixtureReviewPayload.reviews.some((review) => review.reportId !== "SR-STAGEPERF-0001")
    ) {
      throw new Error(
        "Remote staging fixture did not expose exactly ten reviews for its first report.",
      );
    }
  }

  const listTimings = [];
  const searchTimings = [];
  const rankingTimings = [];
  let largestResponseBytes = 0;
  for (let index = 0; index < samples; index += 1) {
    const listResult = await request(
      baseUrl,
      "/api/reports?page=1&sort=newest",
      bearer,
      200 * 1024,
      "application/json",
    );
    const payload = JSON.parse(listResult.text);
    if (
      !Array.isArray(payload.items) ||
      payload.items.length > 25 ||
      payload.pagination?.pageSize !== 25
    ) {
      throw new Error("Paginated reports API returned an invalid bounded payload.");
    }
    const searchResult = await request(
      baseUrl,
      "/api/reports?q=smokeprobe&page=1&sort=newest",
      bearer,
      200 * 1024,
      "application/json",
    );
    const searchPayload = JSON.parse(searchResult.text);
    if (
      !Array.isArray(searchPayload.items) ||
      searchPayload.items.length > 25 ||
      searchPayload.pagination?.pageSize !== 25
    ) {
      throw new Error("Search API returned an invalid bounded payload.");
    }
    if (args["require-staging-fixture"] && searchPayload.pagination?.totalItems !== 1_000) {
      throw new Error("Search API no longer exposes the exact 1,000-report staging fixture.");
    }
    const rankingResult = await request(baseUrl, "/rankings", bearer, 200 * 1024, "text/html");
    listTimings.push(listResult.elapsedMs);
    searchTimings.push(searchResult.elapsedMs);
    rankingTimings.push(rankingResult.elapsedMs);
    largestResponseBytes = Math.max(
      largestResponseBytes,
      listResult.bytes,
      searchResult.bytes,
      rankingResult.bytes,
    );
  }
  const listP95Ms = p95(listTimings);
  const searchP95Ms = p95(searchTimings);
  const rankingP95Ms = p95(rankingTimings);
  for (const [label, value] of [
    ["reports", listP95Ms],
    ["search", searchP95Ms],
    ["rankings", rankingP95Ms],
  ]) {
    if (value > maxP95Ms)
      throw new Error(`Remote ${label} p95 ${value.toFixed(1)} ms exceeded ${maxP95Ms} ms.`);
  }
  console.log(
    JSON.stringify(
      {
        status: "passed",
        origin: baseUrl.origin,
        commit: expectedCommit,
        version: expectedVersion,
        samples,
        cardinality: { reports: reportCardinality, reviews: reviewCardinality },
        fixture: args["require-staging-fixture"]
          ? { reports: 1_000, reviewsOnSampleReport: 10 }
          : null,
        p95Ms: {
          reports: Number(listP95Ms.toFixed(1)),
          search: Number(searchP95Ms.toFixed(1)),
          rankings: Number(rankingP95Ms.toFixed(1)),
        },
        largestResponseBytes,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(`remote-smoke: ${error instanceof Error ? error.message : "unexpected failure"}`);
  process.exitCode = 1;
});
