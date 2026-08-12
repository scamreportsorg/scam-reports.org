import { env } from "cloudflare:workers";

export const SCHEMA_VERSION = 22;
export const LATEST_MIGRATION_NAME = "0021_magic_login_browser_context.sql";

type VersionEnv = {
  PUBLIC_RELEASE_VERSION?: string;
  PUBLIC_SOURCE_COMMIT?: string;
  PUBLIC_SOURCE_URL?: string;
  PUBLIC_SOURCE_AVAILABLE?: string;
  PUBLIC_BUILD_TIME?: string;
  PUBLIC_SCHEMA_VERSION?: string;
};

export type PublicVersion = {
  version: string;
  commit: string;
  buildTime: string;
  schemaVersion: number;
  sourceUrl: string;
  sourceArchiveUrl: string;
  sourceAvailable: boolean;
};

function runtimeEnv(): VersionEnv {
  try {
    return env as unknown as VersionEnv;
  } catch {
    return {};
  }
}

function safeText(value: string | undefined, fallback: string, maximum = 200) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : fallback;
}

export function getPublicVersion(): PublicVersion {
  const values = runtimeEnv();
  const sourceUrl = safeText(
    values.PUBLIC_SOURCE_URL ?? process.env.PUBLIC_SOURCE_URL,
    "https://github.com/scamreportsorg/scam-reports.org",
  ).replace(/\/$/, "");
  const sourceAvailable =
    safeText(
      values.PUBLIC_SOURCE_AVAILABLE ?? process.env.PUBLIC_SOURCE_AVAILABLE,
      "false",
      5,
    ).toLowerCase() === "true";
  const version = safeText(
    values.PUBLIC_RELEASE_VERSION ?? process.env.PUBLIC_RELEASE_VERSION,
    "0.2.10-dev",
    80,
  );
  const commit = safeText(
    values.PUBLIC_SOURCE_COMMIT ?? process.env.PUBLIC_SOURCE_COMMIT,
    "development",
    64,
  );
  const buildTime = safeText(
    values.PUBLIC_BUILD_TIME ?? process.env.PUBLIC_BUILD_TIME,
    "unreleased",
    64,
  );
  const configuredSchema = Number(
    values.PUBLIC_SCHEMA_VERSION ?? process.env.PUBLIC_SCHEMA_VERSION,
  );
  const schemaVersion =
    Number.isInteger(configuredSchema) && configuredSchema > 0 ? configuredSchema : SCHEMA_VERSION;
  const releaseRef = /^v?\d+\.\d+\.\d+([-.+][0-9A-Za-z.-]+)?$/.test(version)
    ? version.startsWith("v")
      ? version
      : `v${version}`
    : commit;
  return {
    version,
    commit,
    buildTime,
    schemaVersion,
    sourceUrl,
    sourceAvailable,
    sourceArchiveUrl: releaseRef.startsWith("v")
      ? `${sourceUrl}/archive/refs/tags/${encodeURIComponent(releaseRef)}.tar.gz`
      : `${sourceUrl}/archive/${encodeURIComponent(releaseRef)}.tar.gz`,
  };
}

export function exactSourceUrl(info = getPublicVersion()) {
  return /^[0-9a-f]{7,64}$/i.test(info.commit)
    ? `${info.sourceUrl}/tree/${info.commit}`
    : info.sourceUrl;
}
