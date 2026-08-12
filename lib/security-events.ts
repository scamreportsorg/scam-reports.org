import {
  OutboundRequestError,
  type OutboundFetch,
  readJsonWithinLimit,
  sendOutboundRequest,
} from "./outbound-http";

const OBSERVATION_RETENTION_MS = 20 * 60_000;
const INCIDENT_RETENTION_MS = 72 * 60 * 60_000;
const CLOUDFLARE_GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const CLOUDFLARE_API_ORIGIN = "https://api.cloudflare.com";
const CLOUDFLARE_GRAPHQL_PATH = "/client/v4/graphql";
const WAF_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const ZONE_ID_PATTERN = /^[a-f0-9]{32}$/u;
const COUNTRY_PATTERN = /^[A-Z]{2}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]{1,40}$/u;
const ID_LIKE_SEGMENT = /^(?:\d{4,}|[a-f0-9]{16,}|[a-f0-9-]{32,})$/iu;
const WAF_ACTIONS = new Set([
  "block",
  "challenge",
  "js_challenge",
  "managed_challenge",
  "connection_close",
  "log",
]);
const FIXED_API_ENDPOINTS = new Set([
  "/api/admin/accounts",
  "/api/admin/appeals",
  "/api/admin/audit",
  "/api/admin/comments",
  "/api/admin/evidence",
  "/api/admin/evidence/upload",
  "/api/admin/merge",
  "/api/admin/moderator-applications",
  "/api/admin/operations/backups",
  "/api/admin/operations/notifications",
  "/api/admin/operations/security-events",
  "/api/admin/reports",
  "/api/admin/report-submissions",
  "/api/admin/reviews",
  "/api/appeals",
  "/api/auth/account",
  "/api/auth/discord/callback",
  "/api/auth/discord/rank-sync",
  "/api/auth/discord/start",
  "/api/auth/logout",
  "/api/auth/magic/request",
  "/api/auth/magic/verify",
  "/api/auth/session",
  "/api/comments",
  "/api/moderator-applications",
  "/api/reports",
  "/api/report-submissions",
  "/api/reviews",
  "/api/version",
]);

export type SecurityMonitorEnvironment = {
  SECURITY_MONITOR_ENABLED?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_SECURITY_CHANNEL_ID?: string;
  CLOUDFLARE_SECURITY_API_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  INTAKE_PEPPER?: string;
};

export type SecurityIncidentRow = {
  id: string;
  source: "app" | "cloudflare";
  signal_type: string;
  action: string;
  method: string;
  endpoint: string;
  source_fingerprint: string;
  country: string;
  asn: number | null;
  event_count: number;
  first_seen_at: string;
  last_seen_at: string;
};

type Observation = {
  id: string;
  incidentId: string;
  source: "app" | "cloudflare";
  signalType: string;
  action: string;
  method: string;
  endpoint: string;
  sourceFingerprint: string;
  country: string;
  asn: number | null;
  observedAt: string;
  expiresAt: string;
};

type FirewallEvent = {
  action?: unknown;
  clientAsn?: unknown;
  clientCountryName?: unknown;
  clientIP?: unknown;
  clientRequestPath?: unknown;
  datetime?: unknown;
  source?: unknown;
};

type CloudflareGraphqlResponse = {
  data?: {
    viewer?: {
      zones?: Array<{ firewallEventsAdaptive?: FirewallEvent[] }>;
    };
  };
  errors?: unknown;
};

function wafGraphqlErrorCode(errors: unknown) {
  if (!Array.isArray(errors) || errors.length === 0) return "waf_invalid_response";
  const messages = errors
    .map((entry) =>
      entry && typeof entry === "object" && typeof entry.message === "string"
        ? entry.message.toLowerCase()
        : "",
    )
    .filter(Boolean)
    .join(" ");
  if (/unauthori[sz]ed|not authorized|does not have access|permission/u.test(messages)) {
    return "waf_auth_rejected";
  }
  if (/rate limit|too many quer|excessive resources/u.test(messages)) {
    return "waf_rate_limited";
  }
  if (/cannot query field|unknown field|validation/u.test(messages)) {
    return "waf_schema_rejected";
  }
  if (/older than|retention|time range|duration/u.test(messages)) {
    return "waf_window_rejected";
  }
  return "waf_query_rejected";
}

export type WafIngestResult = {
  state: "operational" | "not_configured" | "failed";
  errorCode: string;
  observations: number;
};

function configured(value: string | undefined) {
  const candidate = value?.trim() ?? "";
  return candidate && !candidate.startsWith("replace-with") ? candidate : "";
}

function securityPepper(values: SecurityMonitorEnvironment) {
  const pepper = configured(values.INTAKE_PEPPER);
  return pepper.length >= 32 ? pepper : "";
}

async function hmacHex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function countryCode(value: unknown) {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : "";
  return COUNTRY_PATTERN.test(candidate) ? candidate : "ZZ";
}

function asnNumber(value: unknown): number | null {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate > 0 && candidate <= 4_294_967_295
    ? candidate
    : null;
}

function safeSlug(value: unknown, fallback: string) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[a-z0-9_-]{1,40}$/u.test(candidate) ? candidate : fallback;
}

export function normalizeSecurityEndpoint(value: string) {
  let pathname = value;
  try {
    pathname = value.startsWith("http")
      ? new URL(value).pathname
      : new URL(value, "https://x").pathname;
  } catch {
    pathname = "/invalid";
  }
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 8)
    .map((part) => {
      if (ID_LIKE_SEGMENT.test(part)) return ":id";
      if (SAFE_SEGMENT.test(part)) return part;
      const cleaned = part.replace(/[^A-Za-z0-9._~-]/gu, "_").slice(0, 40);
      return cleaned || ":value";
    });
  const normalized = `/${parts.join("/")}`;
  if (FIXED_API_ENDPOINTS.has(normalized)) return normalized;
  if (/^\/api\/(?:evidence|reports)\/[^/]+$/u.test(normalized)) {
    return normalized.replace(/\/[^/]+$/u, "/:id");
  }
  if (/^\/api\/auth\/identities\/[^/]+$/u.test(normalized)) {
    return "/api/auth/identities/:provider";
  }
  if (/^\/api\/admin\/evidence\/[^/]+(?:\/(?:derivative|original))?$/u.test(normalized)) {
    return normalized.replace(/^\/api\/admin\/evidence\/[^/]+/u, "/api/admin/evidence/:id");
  }
  if (/^\/api\/admin\/operations\/notifications\/[^/]+\/retry$/u.test(normalized)) {
    return "/api/admin/operations/notifications/:id/retry";
  }
  if (/^\/api\/(?:intake-files|uploads)(?:\/.*)?$/u.test(normalized)) {
    return normalized.startsWith("/api/intake-files")
      ? "/api/intake-files/:key"
      : "/api/uploads/:key";
  }
  return normalized.startsWith("/api/") ? "/api/other" : "/page";
}

async function sourceFingerprint(secret: string, address: string, observedAt: Date) {
  const day = observedAt.toISOString().slice(0, 10);
  const digest = await hmacHex(secret, `security-source:${day}:${address}`);
  return `anon-${digest.slice(0, 12).toUpperCase()}`;
}

async function incidentId(secret: string, observation: Omit<Observation, "id" | "incidentId">) {
  const day = observation.observedAt.slice(0, 10);
  return hmacHex(
    secret,
    [
      "security-incident",
      day,
      observation.source,
      observation.signalType,
      observation.action,
      observation.method,
      observation.endpoint,
      observation.sourceFingerprint,
    ].join(":"),
  );
}

function observationStatement(database: D1Database, observation: Observation) {
  return database
    .prepare(
      `INSERT OR IGNORE INTO security_observations
       (id, incident_id, source, signal_type, action, method, endpoint,
        source_fingerprint, country, asn, observed_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      observation.id,
      observation.incidentId,
      observation.source,
      observation.signalType,
      observation.action,
      observation.method,
      observation.endpoint,
      observation.sourceFingerprint,
      observation.country,
      observation.asn,
      observation.observedAt,
      observation.expiresAt,
    );
}

function observationRollupStatement(database: D1Database, observation: Observation) {
  return database
    .prepare(
      `INSERT INTO security_incidents
       (id, source, signal_type, action, method, endpoint, source_fingerprint,
        country, asn, event_count, first_seen_at, last_seen_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, COUNT(*), MIN(observed_at), MAX(observed_at)
       FROM security_observations
       WHERE incident_id = ?
       HAVING COUNT(*) > 0
       ON CONFLICT(id) DO UPDATE SET
         event_count = excluded.event_count,
         first_seen_at = excluded.first_seen_at,
         last_seen_at = excluded.last_seen_at,
         country = excluded.country,
         asn = excluded.asn`,
    )
    .bind(
      observation.incidentId,
      observation.source,
      observation.signalType,
      observation.action,
      observation.method,
      observation.endpoint,
      observation.sourceFingerprint,
      observation.country,
      observation.asn,
      observation.incidentId,
    );
}

async function insertObservations(database: D1Database, observations: Observation[]) {
  for (let index = 0; index < observations.length; index += 40) {
    const chunk = observations.slice(index, index + 40);
    await database.batch(
      chunk.flatMap((observation) => [
        observationStatement(database, observation),
        observationRollupStatement(database, observation),
      ]),
    );
  }
}

function wafConfiguration(values: SecurityMonitorEnvironment) {
  const apiToken = configured(values.CLOUDFLARE_SECURITY_API_TOKEN);
  const zoneId = configured(values.CLOUDFLARE_ZONE_ID).toLowerCase();
  const secret = securityPepper(values);
  if (!apiToken && !zoneId) return null;
  if (
    apiToken.length < 20 ||
    apiToken.length > 200 ||
    /\s/u.test(apiToken) ||
    !ZONE_ID_PATTERN.test(zoneId) ||
    !secret
  ) {
    throw new Error("invalid_waf_config");
  }
  return { apiToken, zoneId, secret };
}

async function fetchFirewallEvents(
  config: { apiToken: string; zoneId: string },
  start: Date,
  end: Date,
  fetchImpl: OutboundFetch,
) {
  let response: Response;
  try {
    response = await sendOutboundRequest(
      CLOUDFLARE_GRAPHQL_ENDPOINT,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${config.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query:
            "query SecurityEvents($zoneTag: string, $filter: FirewallEventsAdaptiveFilter_InputObject) { viewer { zones(filter: { zoneTag: $zoneTag }) { firewallEventsAdaptive(filter: $filter, limit: 250, orderBy: [datetime_DESC]) { action clientAsn clientCountryName clientIP clientRequestPath datetime source } } } }",
          variables: {
            zoneTag: config.zoneId,
            filter: { datetime_geq: start.toISOString(), datetime_leq: end.toISOString() },
          },
        }),
      },
      {
        origin: CLOUDFLARE_API_ORIGIN,
        pathname: CLOUDFLARE_GRAPHQL_PATH,
        fetchImpl,
        timeoutMs: 10_000,
      },
    );
  } catch (error) {
    const detail = error instanceof OutboundRequestError ? error.detail : "unknown";
    console.warn("security_monitor_waf_fetch_failed", detail);
    if (error instanceof OutboundRequestError && error.problem === "timeout") {
      throw new Error("waf_timeout");
    }
    if (error instanceof OutboundRequestError && error.problem === "invalid_destination") {
      throw new Error("waf_destination_rejected");
    }
    throw new Error(`waf_${detail}`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error("waf_redirect_rejected");
  }
  if (!response.ok) {
    console.warn("security_monitor_waf_http_rejected", response.status);
    throw new Error(
      response.status === 401 || response.status === 403 ? "waf_auth_rejected" : "waf_unavailable",
    );
  }
  const body = await readJsonWithinLimit<CloudflareGraphqlResponse>(response, WAF_RESPONSE_BYTES);
  if (!body) {
    throw new Error("waf_invalid_response");
  }
  if (body.errors) throw new Error(wafGraphqlErrorCode(body.errors));
  if (!Array.isArray(body.data?.viewer?.zones)) throw new Error("waf_invalid_response");
  if (body.data.viewer.zones.length !== 1) throw new Error("waf_zone_unavailable");
  const events = body.data.viewer.zones[0]?.firewallEventsAdaptive;
  if (!Array.isArray(events) || events.length > 250) throw new Error("waf_invalid_response");
  return events;
}

async function firewallObservation(
  event: FirewallEvent,
  secret: string,
  start: Date,
  end: Date,
): Promise<Observation | null> {
  const action = safeSlug(event.action, "unknown");
  if (!WAF_ACTIONS.has(action)) return null;
  const address = typeof event.clientIP === "string" ? event.clientIP.trim() : "";
  const timestamp = typeof event.datetime === "string" ? Date.parse(event.datetime) : Number.NaN;
  if (!address || address.length > 64 || !Number.isFinite(timestamp)) return null;
  if (timestamp < start.getTime() - 60_000 || timestamp > end.getTime() + 60_000) return null;
  const observed = new Date(timestamp);
  const observedAt = observed.toISOString();
  const source = safeSlug(event.source, "cloudflare");
  const base = {
    source: "cloudflare" as const,
    signalType: `waf_${source}`.slice(0, 64),
    action,
    method: "ANY",
    endpoint: normalizeSecurityEndpoint(
      typeof event.clientRequestPath === "string" ? event.clientRequestPath : "/unknown",
    ),
    sourceFingerprint: await sourceFingerprint(secret, address, observed),
    country: countryCode(event.clientCountryName),
    asn: asnNumber(event.clientAsn),
    observedAt,
    expiresAt: new Date(timestamp + OBSERVATION_RETENTION_MS).toISOString(),
  };
  const id = await hmacHex(
    secret,
    [
      "waf-observation",
      observedAt,
      address,
      base.action,
      base.signalType,
      base.endpoint,
      base.asn ?? "",
    ].join(":"),
  );
  return { ...base, id, incidentId: await incidentId(secret, base) };
}

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /^waf_[a-z_]{1,40}$/u.test(message) || message === "invalid_waf_config"
    ? message
    : "waf_failed";
}

export async function ingestCloudflareSecurityEvents(
  database: D1Database,
  values: SecurityMonitorEnvironment,
  options: { fetchImpl?: OutboundFetch; now?: Date } = {},
): Promise<WafIngestResult> {
  if (values.SECURITY_MONITOR_ENABLED !== "true") {
    return { state: "not_configured", errorCode: "", observations: 0 };
  }
  let config: ReturnType<typeof wafConfiguration>;
  try {
    config = wafConfiguration(values);
  } catch (error) {
    return { state: "failed", errorCode: errorCode(error), observations: 0 };
  }
  if (!config) return { state: "not_configured", errorCode: "", observations: 0 };

  const end = options.now ?? new Date();
  const start = new Date(end.getTime() - 2 * 60_000);
  try {
    const events = await fetchFirewallEvents(config, start, end, options.fetchImpl ?? fetch);
    const observations = (
      await Promise.all(
        events.map((event) => firewallObservation(event, config.secret, start, end)),
      )
    ).filter((event): event is Observation => event !== null);
    await insertObservations(database, observations);
    return { state: "operational", errorCode: "", observations: observations.length };
  } catch (error) {
    return { state: "failed", errorCode: errorCode(error), observations: 0 };
  }
}

export async function listActiveSecurityIncidents(
  database: D1Database,
  now = new Date(),
  limit = 8,
) {
  const activeSince = new Date(now.getTime() - 15 * 60_000).toISOString();
  const rows = await database
    .prepare(
      `SELECT id, source, signal_type, action, method, endpoint, source_fingerprint,
        country, asn, event_count, first_seen_at, last_seen_at
       FROM security_incidents
       WHERE last_seen_at >= ?
         AND event_count >= CASE
           WHEN source = 'cloudflare' AND action = 'log' THEN 10
           WHEN source = 'cloudflare' THEN 3
           WHEN signal_type = 'security_rejection' THEN 10
           ELSE 3
         END
       ORDER BY event_count DESC, last_seen_at DESC, id ASC
       LIMIT ?`,
    )
    .bind(activeSince, Math.max(1, Math.min(Math.floor(limit), 10)))
    .all<SecurityIncidentRow>();
  return rows.results;
}

export async function purgeExpiredSecurityEvents(database: D1Database, now = new Date()) {
  const timestamp = now.toISOString();
  const [observations, incidents] = await database.batch([
    database.prepare("DELETE FROM security_observations WHERE expires_at < ?").bind(timestamp),
    database
      .prepare("DELETE FROM security_incidents WHERE last_seen_at < ?")
      .bind(new Date(now.getTime() - INCIDENT_RETENTION_MS).toISOString()),
  ]);
  return {
    observations: observations.meta.changes ?? 0,
    incidents: incidents.meta.changes ?? 0,
  };
}
