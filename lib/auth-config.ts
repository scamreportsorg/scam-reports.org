import { env } from "cloudflare:workers";

export type AuthRuntime = "development" | "test" | "staging" | "production";

type RuntimeBindings = Record<string, string | undefined>;

function bindings(): RuntimeBindings {
  return env as unknown as RuntimeBindings;
}

export function readAuthEnv(name: string): string | undefined {
  const value = bindings()[name] ?? process.env[name];
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim();
  return normalized.startsWith("replace-with") ? undefined : normalized;
}

export function authRuntime(): AuthRuntime {
  const configured = readAuthEnv("AUTH_RUNTIME_ENV");
  if (
    configured === "development" ||
    configured === "test" ||
    configured === "staging" ||
    configured === "production"
  ) {
    return configured;
  }

  if (process.env.NODE_ENV === "production") return "production";
  if (process.env.NODE_ENV === "test") return "test";
  return "development";
}

function required(name: string): string {
  const value = readAuthEnv(name);
  if (!value) {
    throw new Error(`Required authentication setting ${name} is unavailable.`);
  }
  return value;
}

function secret(name: string): string {
  const value = required(name);
  if (value.length < 32) {
    throw new Error(`Authentication setting ${name} must contain at least 32 characters.`);
  }
  return value;
}

const EMAIL_ADDRESS_PATTERN = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u;

export function isValidResendFrom(value: string | undefined): boolean {
  if (!value) return false;
  const sender = value.trim();
  const named = /^[^<>\r\n]+<([^<>\r\n]+)>$/u.exec(sender);
  const address = named ? named[1].trim() : sender;
  return address.length <= 254 && EMAIL_ADDRESS_PATTERN.test(address);
}

function resendFrom(): string {
  const value = required("RESEND_FROM");
  if (!isValidResendFrom(value)) {
    throw new Error("RESEND_FROM must be an email address or a name followed by <email address>.");
  }
  return value;
}

function normalizeOrigin(value: string): string {
  const parsed = new URL(value);
  const runtime = authRuntime();
  const mayUseHttp =
    runtime === "development" ||
    runtime === "test" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(mayUseHttp && parsed.protocol === "http:")) {
    throw new Error("AUTH_APP_ORIGIN must use HTTPS outside local development and tests.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("AUTH_APP_ORIGIN must be an origin without a path, query, or fragment.");
  }
  return parsed.origin;
}

export type CoreAuthConfig = {
  appOrigin: string;
  identityHashKey: string;
  identityEncryptionKey: string;
  intakePepper: string;
  runtime: AuthRuntime;
};

export function getCoreAuthConfig(): CoreAuthConfig {
  return {
    appOrigin: normalizeOrigin(required("AUTH_APP_ORIGIN")),
    identityHashKey: secret("IDENTITY_HASH_KEY"),
    identityEncryptionKey: required("IDENTITY_ENCRYPTION_KEY"),
    intakePepper: secret("INTAKE_PEPPER"),
    runtime: authRuntime(),
  };
}

export type DiscordAuthConfig = CoreAuthConfig & {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export function getDiscordAuthConfig(): DiscordAuthConfig {
  const core = getCoreAuthConfig();
  return {
    ...core,
    clientId: required("DISCORD_CLIENT_ID"),
    clientSecret: secret("DISCORD_CLIENT_SECRET"),
    redirectUri: `${core.appOrigin}/api/auth/discord/callback`,
  };
}

export type EmailAuthConfig = CoreAuthConfig & {
  resendApiKey: string;
  resendFrom: string;
};

export function getEmailAuthConfig(): EmailAuthConfig {
  return {
    ...getCoreAuthConfig(),
    resendApiKey: secret("RESEND_API_KEY"),
    resendFrom: resendFrom(),
  };
}

export function authProviderAvailability() {
  const discordClientId = readAuthEnv("DISCORD_CLIENT_ID");
  const discordClientSecret = readAuthEnv("DISCORD_CLIENT_SECRET");
  const resendApiKey = readAuthEnv("RESEND_API_KEY");
  const resendFrom = readAuthEnv("RESEND_FROM");
  return {
    discord: Boolean(discordClientId && discordClientSecret && discordClientSecret.length >= 32),
    email: Boolean(resendApiKey && resendApiKey.length >= 32 && isValidResendFrom(resendFrom)),
  };
}

export function optionalBootstrapConfig() {
  const discordId = readAuthEnv("BOOTSTRAP_DISCORD_ID");
  const email = readAuthEnv("BOOTSTRAP_ADMIN_EMAIL")?.toLowerCase();
  if (!discordId && !email) return null;
  if (!discordId || !email) {
    throw new Error("BOOTSTRAP_DISCORD_ID and BOOTSTRAP_ADMIN_EMAIL must be configured together.");
  }
  return { discordId, email };
}
