import { isDiscordSnowflake } from "./discord-api";
import {
  OutboundRequestError,
  type OutboundFetch,
  readJsonWithinLimit,
  sendOutboundRequest,
} from "./outbound-http";
import {
  ingestCloudflareSecurityEvents,
  listActiveSecurityIncidents,
  purgeExpiredSecurityEvents,
  type SecurityIncidentRow,
  type SecurityMonitorEnvironment,
  type WafIngestResult,
} from "./security-events";

const DISCORD_API_ORIGIN = "https://discord.com";
const DISCORD_CHANNEL_PREFIX = "/api/v10/channels/";
const DISCORD_RESPONSE_BYTES = 256 * 1_024;
const LEASE_MS = 45_000;

type SecurityMonitorConfig = {
  botToken: string;
  channelId: string;
};

type MonitorState = {
  message_id: string | null;
  configuration_fingerprint: string;
  delivery_state: "active" | "disabled";
  last_waf_poll_at: string | null;
  last_waf_error_code: string;
  last_delivery_error_code: string;
  lease_token: string | null;
};

type DiscordMessage = {
  id?: unknown;
  channel_id?: unknown;
};

export type SecurityMonitorRunResult = {
  state: "disabled" | "busy" | "updated" | "delivery_disabled" | "failed";
  activeIncidents: number;
  waf: WafIngestResult["state"];
};

export class DiscordSecurityMonitorError extends Error {
  readonly retryable: boolean;
  readonly notFound: boolean;
  readonly terminal: boolean;

  constructor(
    message: string,
    options: { retryable?: boolean; notFound?: boolean; terminal?: boolean } = {},
  ) {
    super(message);
    this.name = "DiscordSecurityMonitorError";
    this.retryable = options.retryable ?? false;
    this.notFound = options.notFound ?? false;
    this.terminal = options.terminal ?? false;
  }
}

function configured(value: string | undefined) {
  const candidate = value?.trim() ?? "";
  return candidate && !candidate.startsWith("replace-with") ? candidate : "";
}

function deliveryErrorCode(error: unknown) {
  const code = error instanceof DiscordSecurityMonitorError ? error.message : "discord_failed";
  return /^discord_[a-z_]{1,40}$/u.test(code) ? code : "discord_failed";
}

export function readSecurityMonitorConfiguration(
  values: SecurityMonitorEnvironment,
):
  | { enabled: false }
  | { enabled: true; config: SecurityMonitorConfig }
  | { enabled: true; error: string } {
  if (values.SECURITY_MONITOR_ENABLED !== "true") return { enabled: false };
  const botToken = configured(values.DISCORD_BOT_TOKEN);
  const channelId = configured(values.DISCORD_SECURITY_CHANNEL_ID);
  if (
    botToken.length < 30 ||
    botToken.length > 200 ||
    /\s/u.test(botToken) ||
    !isDiscordSnowflake(channelId)
  ) {
    return { enabled: true, error: "invalid_security_monitor_config" };
  }
  return { enabled: true, config: { botToken, channelId } };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function configurationFingerprint(config: SecurityMonitorConfig) {
  return sha256(`discord-security:${config.channelId}:${config.botToken}`);
}

function discordTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function displaySignal(value: string) {
  const words = value
    .replace(/^waf_/u, "")
    .split("_")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`);
  return words.join(" ") || "Security event";
}

function safeIncident(row: SecurityIncidentRow) {
  const source = row.source === "cloudflare" ? "Cloudflare WAF" : "Application";
  const count = Math.max(1, Math.min(Number(row.event_count) || 1, 999_999_999));
  const action = /^[a-z_]{1,40}$/u.test(row.action) ? row.action.replaceAll("_", " ") : "rejected";
  const method = /^(?:ANY|GET|POST|PUT|PATCH|DELETE)$/u.test(row.method) ? row.method : "ANY";
  const endpoint = /^\/[A-Za-z0-9._~:/-]{0,180}$/u.test(row.endpoint) ? row.endpoint : "/unknown";
  const fingerprint = /^anon-[A-F0-9]{12}$/u.test(row.source_fingerprint)
    ? row.source_fingerprint
    : "anon-unknown";
  const country = /^[A-Z]{2}$/u.test(row.country) ? row.country : "ZZ";
  const asn = Number.isSafeInteger(row.asn) && Number(row.asn) > 0 ? ` · AS${row.asn}` : "";
  const firstSeen = discordTimestamp(row.first_seen_at);
  const lastSeen = discordTimestamp(row.last_seen_at);
  return {
    name: `🔴 ${count.toLocaleString("en-US")} hits · ${source} ${action}`.slice(0, 256),
    value: [
      `**Target:** \`${method} ${endpoint}\``,
      `**Detection:** ${displaySignal(row.signal_type)}`,
      `**Source:** \`${fingerprint}\` · ${country}${asn}`,
      `**Seen:** <t:${firstSeen}:R> → <t:${lastSeen}:R>`,
    ].join("\n"),
    inline: false,
  };
}

export function buildSecurityMonitorPayload(
  incidents: SecurityIncidentRow[],
  waf: WafIngestResult,
  updatedAt: string,
) {
  const active = incidents.length > 0;
  const wafLabel =
    waf.state === "operational"
      ? "🟢 Connected"
      : waf.state === "not_configured"
        ? "⚪ Not configured"
        : "🟠 Unavailable";
  const monitorState = active
    ? {
        title: "🛡️ Attack activity detected",
        description:
          waf.state === "operational"
            ? "Suspicious traffic blocked or rejected during the last 15 minutes."
            : "Recent stored attack activity is shown below, but the current WAF check is unavailable.",
        color: 0xed4245,
      }
    : waf.state === "operational"
      ? {
          title: "🛡️ Attack monitor",
          description:
            "No active attack pattern crossed the alert threshold in the last 15 minutes.",
          color: 0x57f287,
        }
      : waf.state === "not_configured"
        ? {
            title: "🛡️ Attack monitor not configured",
            description:
              "Cloudflare WAF analytics is not configured. Current attack activity cannot be determined.",
            color: 0x99aab5,
          }
        : {
            title: "🛡️ Attack monitor unavailable",
            description:
              "The current Cloudflare WAF check failed. Current attack activity cannot be determined.",
            color: 0xfee75c,
          };
  const fields = incidents.map(safeIncident);
  fields.push({
    name: "Monitor coverage",
    value: `**Cloudflare WAF:** ${wafLabel}\n**Application response logging:** ⚪ Disabled (protects D1)`,
    inline: false,
  });
  return {
    content: "",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: monitorState.title,
        description: monitorState.description,
        color: monitorState.color,
        thumbnail: { url: "https://scam-reports.org/brand/sr-mark.png" },
        fields,
        footer: {
          text: "Sources are anonymized · no IPs, request bodies, cookies, or account data",
        },
        timestamp: updatedAt,
      },
    ],
  };
}

function discordEndpoint(channelId: string, messageId?: string) {
  if (
    !isDiscordSnowflake(channelId) ||
    (messageId !== undefined && !isDiscordSnowflake(messageId))
  ) {
    throw new DiscordSecurityMonitorError("discord_destination_invalid", { terminal: true });
  }
  const path = messageId
    ? `/api/v10/channels/${channelId}/messages/${messageId}`
    : `/api/v10/channels/${channelId}/messages`;
  return path;
}

async function discordError(response: Response, editing: boolean): Promise<never> {
  console.warn("security_monitor_discord_http_rejected", response.status);
  if (editing && response.status === 404) {
    throw new DiscordSecurityMonitorError("discord_message_missing", { notFound: true });
  }
  if (response.status === 429 || response.status >= 500) {
    throw new DiscordSecurityMonitorError("discord_temporarily_unavailable", { retryable: true });
  }
  const code =
    response.status === 400
      ? "discord_payload_rejected"
      : response.status === 401
        ? "discord_auth_rejected"
        : response.status === 403
          ? "discord_permission_rejected"
          : response.status === 404
            ? "discord_channel_missing"
            : response.status >= 300 && response.status < 400
              ? "discord_redirect_rejected"
              : "discord_delivery_rejected";
  throw new DiscordSecurityMonitorError(code, { terminal: true });
}

async function writeDiscordMessage(
  config: SecurityMonitorConfig,
  payload: ReturnType<typeof buildSecurityMonitorPayload>,
  options: { messageId?: string; fetchImpl?: OutboundFetch } = {},
) {
  let response: Response;
  try {
    response = await sendOutboundRequest(
      discordEndpoint(config.channelId, options.messageId),
      {
        method: options.messageId ? "PATCH" : "POST",
        headers: {
          Authorization: `Bot ${config.botToken}`,
          "Content-Type": "application/json",
          "User-Agent": "Scam-Reports.org (https://scam-reports.org, security monitor)",
        },
        body: JSON.stringify(payload),
      },
      {
        origin: DISCORD_API_ORIGIN,
        pathPrefix: DISCORD_CHANNEL_PREFIX,
        fetchImpl: options.fetchImpl,
        timeoutMs: 10_000,
      },
    );
  } catch (error) {
    if (error instanceof DiscordSecurityMonitorError) throw error;
    if (
      error instanceof OutboundRequestError &&
      error.reason instanceof DiscordSecurityMonitorError
    ) {
      throw error.reason;
    }
    if (error instanceof OutboundRequestError && error.problem === "invalid_destination") {
      throw new DiscordSecurityMonitorError("discord_destination_invalid", { terminal: true });
    }
    const detail = error instanceof OutboundRequestError ? error.detail : "unknown";
    console.warn("security_monitor_discord_fetch_failed", detail);
    const code =
      error instanceof OutboundRequestError && error.problem === "timeout"
        ? "discord_timeout"
        : `discord_network_${detail}`.slice(0, 48);
    throw new DiscordSecurityMonitorError(code, { retryable: true });
  }
  if (!response.ok) await discordError(response, Boolean(options.messageId));
  const body = await readJsonWithinLimit<DiscordMessage>(response, DISCORD_RESPONSE_BYTES);
  if (
    !body ||
    typeof body.id !== "string" ||
    !isDiscordSnowflake(body.id) ||
    body.channel_id !== config.channelId
  ) {
    console.warn("security_monitor_discord_invalid_response", response.status);
    throw new DiscordSecurityMonitorError("discord_invalid_response", { retryable: true });
  }
  return body.id;
}

async function acquireState(
  database: D1Database,
  fingerprint: string,
  now: Date,
): Promise<MonitorState | null> {
  const nowText = now.toISOString();
  await database
    .prepare(
      `INSERT OR IGNORE INTO security_monitor_state
       (id, message_id, configuration_fingerprint, delivery_state,
        last_waf_poll_at, last_waf_error_code, last_delivery_error_code,
        lease_token, lease_expires_at, updated_at)
       VALUES ('primary', NULL, ?, 'active', NULL, '', '', NULL, NULL, ?)`,
    )
    .bind(fingerprint, nowText)
    .run();
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
  return database
    .prepare(
      `UPDATE security_monitor_state
       SET message_id = CASE WHEN configuration_fingerprint = ? THEN message_id ELSE NULL END,
           delivery_state = CASE WHEN configuration_fingerprint = ? THEN delivery_state ELSE 'active' END,
           configuration_fingerprint = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE id = 'primary' AND (lease_token IS NULL OR lease_expires_at < ?)
       RETURNING message_id, configuration_fingerprint, delivery_state,
         last_waf_poll_at, last_waf_error_code, last_delivery_error_code, lease_token`,
    )
    .bind(fingerprint, fingerprint, fingerprint, leaseToken, leaseExpiresAt, nowText, nowText)
    .first<MonitorState>();
}

async function releaseState(
  database: D1Database,
  state: MonitorState,
  values: {
    messageId: string | null;
    deliveryState: "active" | "disabled";
    deliveryErrorCode: string;
    waf: WafIngestResult;
    updatedAt: string;
  },
) {
  await database
    .prepare(
      `UPDATE security_monitor_state
       SET message_id = ?, delivery_state = ?, last_waf_poll_at = ?,
           last_waf_error_code = ?, last_delivery_error_code = ?,
           lease_token = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = 'primary' AND lease_token = ?`,
    )
    .bind(
      values.messageId,
      values.deliveryState,
      values.waf.state === "operational" ? values.updatedAt : state.last_waf_poll_at,
      values.waf.errorCode,
      values.deliveryErrorCode,
      values.updatedAt,
      state.lease_token,
    )
    .run();
}

export async function runDiscordSecurityMonitor(
  database: D1Database,
  values: SecurityMonitorEnvironment,
  options: { fetchImpl?: OutboundFetch; now?: Date } = {},
): Promise<SecurityMonitorRunResult> {
  const configuration = readSecurityMonitorConfiguration(values);
  if (!configuration.enabled) {
    return { state: "disabled", activeIncidents: 0, waf: "not_configured" };
  }
  if ("error" in configuration) {
    return { state: "failed", activeIncidents: 0, waf: "not_configured" };
  }
  const now = options.now ?? new Date();
  const fingerprint = await configurationFingerprint(configuration.config);
  const state = await acquireState(database, fingerprint, now);
  if (!state) return { state: "busy", activeIncidents: 0, waf: "not_configured" };
  if (state.delivery_state === "disabled") {
    await releaseState(database, state, {
      messageId: state.message_id,
      deliveryState: "disabled",
      deliveryErrorCode: state.last_delivery_error_code,
      waf: { state: "not_configured", errorCode: "", observations: 0 },
      updatedAt: now.toISOString(),
    });
    return { state: "delivery_disabled", activeIncidents: 0, waf: "not_configured" };
  }

  const waf = await ingestCloudflareSecurityEvents(database, values, {
    fetchImpl: options.fetchImpl,
    now,
  });
  await purgeExpiredSecurityEvents(database, now);
  const incidents = await listActiveSecurityIncidents(database, now);
  const payload = buildSecurityMonitorPayload(incidents, waf, now.toISOString());
  let messageId = state.message_id;
  try {
    if (messageId) {
      try {
        messageId = await writeDiscordMessage(configuration.config, payload, {
          messageId,
          fetchImpl: options.fetchImpl,
        });
      } catch (error) {
        if (!(error instanceof DiscordSecurityMonitorError) || !error.notFound) throw error;
        messageId = await writeDiscordMessage(configuration.config, payload, {
          fetchImpl: options.fetchImpl,
        });
      }
    } else {
      messageId = await writeDiscordMessage(configuration.config, payload, {
        fetchImpl: options.fetchImpl,
      });
    }
    await releaseState(database, state, {
      messageId,
      deliveryState: "active",
      deliveryErrorCode: "",
      waf,
      updatedAt: now.toISOString(),
    });
    return { state: "updated", activeIncidents: incidents.length, waf: waf.state };
  } catch (error) {
    const terminal = error instanceof DiscordSecurityMonitorError && error.terminal;
    await releaseState(database, state, {
      messageId,
      deliveryState: terminal ? "disabled" : "active",
      deliveryErrorCode: deliveryErrorCode(error),
      waf,
      updatedAt: now.toISOString(),
    });
    return {
      state: terminal ? "delivery_disabled" : "failed",
      activeIncidents: incidents.length,
      waf: waf.state,
    };
  }
}
