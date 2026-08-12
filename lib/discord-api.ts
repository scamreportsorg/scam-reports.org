import {
  OutboundRequestError,
  type OutboundFetch,
  readJsonWithinLimit,
  sendOutboundRequest,
} from "./outbound-http";

const DISCORD_API_ORIGIN = "https://discord.com";
const DISCORD_API_PREFIX = "/api/v10/";
const DISCORD_SNOWFLAKE = /^\d{15,22}$/u;
const DEFAULT_TIMEOUT_MS = 12_000;
const ERROR_RESPONSE_BYTES = 4_096;
const MEMBER_RESPONSE_BYTES = 128 * 1_024;
const ROLE_RESPONSE_BYTES = 512 * 1_024;
const DISCORD_ADMINISTRATOR_PERMISSION = BigInt(8);
const DISCORD_MANAGE_ROLES_PERMISSION = BigInt(268_435_456);

export const DISCORD_RANK_LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type DiscordRankLevel = (typeof DISCORD_RANK_LEVELS)[number];

export type DiscordRoleSyncEnvironment = {
  DISCORD_ROLE_SYNC_ENABLED?: string;
  DISCORD_BOT_TOKEN?: string;
  DISCORD_GUILD_ID?: string;
  DISCORD_ROLE_LEVEL_1_ID?: string;
  DISCORD_ROLE_LEVEL_2_ID?: string;
  DISCORD_ROLE_LEVEL_3_ID?: string;
  DISCORD_ROLE_LEVEL_4_ID?: string;
  DISCORD_ROLE_LEVEL_5_ID?: string;
  DISCORD_ROLE_LEVEL_6_ID?: string;
  DISCORD_COMMUNITY_INVITE_URL?: string;
};

export type DiscordRoleSyncConfig = {
  botToken: string;
  guildId: string;
  roleIds: Readonly<Record<DiscordRankLevel, string>>;
};

export type DiscordRoleSyncConfiguration =
  | { enabled: false }
  | { enabled: true; config: DiscordRoleSyncConfig }
  | { enabled: true; error: "invalid_config" };

export type DiscordApiErrorKind = "rate_limited" | "retryable" | "not_in_guild" | "terminal";

export class DiscordApiError extends Error {
  readonly kind: DiscordApiErrorKind;
  readonly code: string;
  readonly retryAfterMs: number | null;

  constructor(kind: DiscordApiErrorKind, code: string, retryAfterMs: number | null = null) {
    super(code);
    this.name = "DiscordApiError";
    this.kind = kind;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

function configured(value: string | undefined) {
  return value?.trim() ?? "";
}

function roleEnvironmentKey(level: DiscordRankLevel): keyof DiscordRoleSyncEnvironment {
  return `DISCORD_ROLE_LEVEL_${level}_ID`;
}

export function isDiscordSnowflake(value: string): boolean {
  return DISCORD_SNOWFLAKE.test(value);
}

export function safeDiscordCommunityInviteUrl(value: string | undefined): string | null {
  const candidate = configured(value);
  if (!candidate || candidate.length > 300) return null;
  try {
    const url = new URL(candidate);
    const allowedHost = url.hostname === "discord.gg" || url.hostname === "discord.com";
    const validPath =
      url.hostname === "discord.gg"
        ? /^\/[A-Za-z0-9-]{2,100}\/?$/u.test(url.pathname)
        : /^\/invite\/[A-Za-z0-9-]{2,100}\/?$/u.test(url.pathname);
    return url.protocol === "https:" &&
      allowedHost &&
      validPath &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function readDiscordRoleSyncConfiguration(
  values: DiscordRoleSyncEnvironment,
): DiscordRoleSyncConfiguration {
  if (values.DISCORD_ROLE_SYNC_ENABLED !== "true") {
    return { enabled: false };
  }

  const botToken = values.DISCORD_BOT_TOKEN ?? "";
  const guildId = values.DISCORD_GUILD_ID ?? "";
  const roleIds = Object.fromEntries(
    DISCORD_RANK_LEVELS.map((level) => [level, values[roleEnvironmentKey(level)] ?? ""]),
  ) as Record<DiscordRankLevel, string>;
  const uniqueRoleIds = new Set(Object.values(roleIds));
  const validToken = /^[A-Za-z0-9._-]{30,200}$/u.test(botToken);
  const validSnowflakes =
    isDiscordSnowflake(guildId) && Object.values(roleIds).every(isDiscordSnowflake);

  if (!validToken || !validSnowflakes || uniqueRoleIds.size !== DISCORD_RANK_LEVELS.length) {
    return { enabled: true, error: "invalid_config" };
  }
  return {
    enabled: true,
    config: {
      botToken,
      guildId,
      roleIds: Object.freeze(roleIds),
    },
  };
}

type DiscordMember = {
  roles: string[];
};

type DiscordGuildRole = {
  id: string;
  managed: boolean;
  permissions: string;
  position: number;
};

async function errorBody(response: Response): Promise<{ code?: unknown; retry_after?: unknown }> {
  const body = await readJsonWithinLimit<unknown>(response, ERROR_RESPONSE_BYTES);
  return body && typeof body === "object"
    ? (body as { code?: unknown; retry_after?: unknown })
    : {};
}

function retryAfterMilliseconds(
  response: Response,
  body: { retry_after?: unknown },
): number | null {
  const bodySeconds =
    typeof body.retry_after === "number" ||
    (typeof body.retry_after === "string" && body.retry_after.trim() !== "")
      ? Number(body.retry_after)
      : Number.NaN;
  if (Number.isFinite(bodySeconds) && bodySeconds >= 0 && bodySeconds <= 86_400) {
    return Math.ceil(bodySeconds * 1_000);
  }
  const header = response.headers.get("retry-after");
  const headerSeconds = header && header.trim() !== "" ? Number(header) : Number.NaN;
  return Number.isFinite(headerSeconds) && headerSeconds >= 0 && headerSeconds <= 86_400
    ? Math.ceil(headerSeconds * 1_000)
    : null;
}

async function classifyDiscordError(response: Response, memberLookup: boolean): Promise<never> {
  const body = await errorBody(response);
  if (response.status === 429) {
    throw new DiscordApiError(
      "rate_limited",
      "discord_rate_limited",
      retryAfterMilliseconds(response, body),
    );
  }
  if (response.status === 401) {
    throw new DiscordApiError("terminal", "discord_auth_rejected");
  }
  if (response.status === 403) {
    throw new DiscordApiError("terminal", "discord_permission_rejected");
  }
  if (response.status === 404 && (memberLookup || Number(body.code) === 10_007)) {
    throw new DiscordApiError("not_in_guild", "discord_member_not_found");
  }
  if (response.status === 404) {
    throw new DiscordApiError("terminal", "discord_managed_role_not_found");
  }
  if (response.status >= 500) {
    throw new DiscordApiError("retryable", "discord_server_error");
  }
  throw new DiscordApiError("terminal", "discord_request_rejected");
}

export class DiscordRoleApi {
  readonly #config: DiscordRoleSyncConfig;
  readonly #fetch: OutboundFetch;
  readonly #timeoutMs: number;
  readonly #managedRoles: ReadonlySet<string>;

  constructor(
    config: DiscordRoleSyncConfig,
    options: { fetch?: OutboundFetch; timeoutMs?: number } = {},
  ) {
    this.#config = config;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 15_000));
    this.#managedRoles = new Set(Object.values(config.roleIds));
  }

  managedRoleId(level: DiscordRankLevel) {
    return this.#config.roleIds[level];
  }

  isManagedRole(roleId: string) {
    return this.#managedRoles.has(roleId);
  }

  async #currentBotUserId() {
    const response = await this.#request(`${DISCORD_API_PREFIX}users/@me`, "GET");
    const body = await readJsonWithinLimit<unknown>(response, MEMBER_RESPONSE_BYTES);
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : null;
    if (typeof id !== "string" || !isDiscordSnowflake(id)) {
      throw new DiscordApiError("retryable", "discord_invalid_response");
    }
    return id;
  }

  async #guildRoles(): Promise<DiscordGuildRole[]> {
    const response = await this.#request(
      `${DISCORD_API_PREFIX}guilds/${this.#config.guildId}/roles`,
      "GET",
    );
    const body = await readJsonWithinLimit<unknown>(response, ROLE_RESPONSE_BYTES);
    if (!Array.isArray(body) || body.length > 500) {
      throw new DiscordApiError("retryable", "discord_invalid_response");
    }
    const roles: DiscordGuildRole[] = [];
    const seen = new Set<string>();
    for (const candidate of body) {
      if (!candidate || typeof candidate !== "object") {
        throw new DiscordApiError("retryable", "discord_invalid_response");
      }
      const role = candidate as Record<string, unknown>;
      if (
        typeof role.id !== "string" ||
        !isDiscordSnowflake(role.id) ||
        seen.has(role.id) ||
        typeof role.managed !== "boolean" ||
        typeof role.permissions !== "string" ||
        !/^\d{1,30}$/u.test(role.permissions) ||
        typeof role.position !== "number" ||
        !Number.isSafeInteger(role.position) ||
        role.position < 0
      ) {
        throw new DiscordApiError("retryable", "discord_invalid_response");
      }
      seen.add(role.id);
      roles.push({
        id: role.id,
        managed: role.managed,
        permissions: role.permissions,
        position: role.position,
      });
    }
    return roles;
  }

  async #request(pathname: string, method: "GET" | "PUT" | "DELETE", memberLookup = false) {
    let response: Response;
    try {
      response = await sendOutboundRequest(
        pathname,
        {
          method,
          headers: {
            Authorization: `Bot ${this.#config.botToken}`,
            "User-Agent": "DiscordBot (https://scam-reports.org, 0.2.10)",
          },
        },
        {
          origin: DISCORD_API_ORIGIN,
          pathPrefix: DISCORD_API_PREFIX,
          fetchImpl: this.#fetch,
          timeoutMs: this.#timeoutMs,
        },
      );
    } catch (error) {
      if (error instanceof DiscordApiError) throw error;
      if (error instanceof OutboundRequestError && error.reason instanceof DiscordApiError) {
        throw error.reason;
      }
      if (error instanceof OutboundRequestError && error.problem === "invalid_destination") {
        throw new DiscordApiError("terminal", "discord_endpoint_invalid");
      }
      throw new DiscordApiError(
        "retryable",
        error instanceof OutboundRequestError && error.problem === "timeout"
          ? "discord_timeout"
          : "discord_network_error",
      );
    }
    return response.ok ? response : classifyDiscordError(response, memberLookup);
  }

  async getGuildMember(discordUserId: string): Promise<DiscordMember> {
    if (!isDiscordSnowflake(discordUserId)) {
      throw new DiscordApiError("terminal", "discord_identity_invalid");
    }
    const response = await this.#request(
      `${DISCORD_API_PREFIX}guilds/${this.#config.guildId}/members/${discordUserId}`,
      "GET",
      true,
    );
    const body = await readJsonWithinLimit<unknown>(response, MEMBER_RESPONSE_BYTES);
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as { roles?: unknown }).roles) ||
      !(body as { roles: unknown[] }).roles.every(
        (role): role is string => typeof role === "string" && isDiscordSnowflake(role),
      )
    ) {
      throw new DiscordApiError("retryable", "discord_invalid_response");
    }
    return { roles: [...(body as { roles: string[] }).roles] };
  }

  async preflightManagedRoles(): Promise<void> {
    const botUserId = await this.#currentBotUserId();
    let botMember: DiscordMember;
    try {
      botMember = await this.getGuildMember(botUserId);
    } catch (error) {
      if (error instanceof DiscordApiError && error.kind === "not_in_guild") {
        throw new DiscordApiError("terminal", "discord_bot_not_in_guild");
      }
      throw error;
    }
    const roles = await this.#guildRoles();
    const rolesById = new Map(roles.map((role) => [role.id, role]));
    const botPermissions = botMember.roles.reduce((permissions, roleId) => {
      const role = rolesById.get(roleId);
      return role ? permissions | BigInt(role.permissions) : permissions;
    }, BigInt(0));
    if (
      (botPermissions & DISCORD_ADMINISTRATOR_PERMISSION) !== BigInt(0) ||
      botPermissions !== DISCORD_MANAGE_ROLES_PERMISSION
    ) {
      throw new DiscordApiError("terminal", "discord_bot_permissions_invalid");
    }
    const highestBotPosition = botMember.roles.reduce((highest, roleId) => {
      return Math.max(highest, rolesById.get(roleId)?.position ?? -1);
    }, -1);
    if (highestBotPosition < 0) {
      throw new DiscordApiError("terminal", "discord_bot_role_hierarchy_invalid");
    }

    for (const roleId of this.#managedRoles) {
      const role = rolesById.get(roleId);
      if (!role) {
        throw new DiscordApiError("terminal", "discord_managed_role_not_found");
      }
      if (role.managed) {
        throw new DiscordApiError("terminal", "discord_rank_role_is_managed");
      }
      if (BigInt(role.permissions) !== BigInt(0)) {
        throw new DiscordApiError("terminal", "discord_rank_role_has_permissions");
      }
      if (role.position >= highestBotPosition) {
        throw new DiscordApiError("terminal", "discord_rank_role_hierarchy_invalid");
      }
    }
  }

  async #changeMemberRole(discordUserId: string, roleId: string, method: "PUT" | "DELETE") {
    if (!isDiscordSnowflake(discordUserId) || !this.#managedRoles.has(roleId)) {
      throw new DiscordApiError("terminal", "discord_role_target_invalid");
    }
    const response = await this.#request(
      `${DISCORD_API_PREFIX}guilds/${this.#config.guildId}/members/${discordUserId}/roles/${roleId}`,
      method,
    );
    if (response.status !== 204) {
      throw new DiscordApiError("retryable", "discord_invalid_response");
    }
  }

  addMemberRole(discordUserId: string, roleId: string) {
    return this.#changeMemberRole(discordUserId, roleId, "PUT");
  }

  removeMemberRole(discordUserId: string, roleId: string) {
    return this.#changeMemberRole(discordUserId, roleId, "DELETE");
  }
}
