import vinext from "vinext";
import { defineConfig, loadEnv } from "vite";

function deploymentDatabaseId(environment: string | undefined) {
  if (environment === "staging") return process.env.STAGING_D1_DATABASE_ID;
  if (environment === "production") return process.env.PRODUCTION_D1_DATABASE_ID;
  return undefined;
}

function assertDeploymentValue(value: string | undefined, label: string) {
  const normalized = value?.trim();
  const isNamedPlaceholder = /^(?:replace|example|placeholder|not-set)/iu.test(normalized ?? "");
  const isZeroIdentifier = /^0+(?:-0+)*$/u.test(normalized ?? "");

  if (!normalized || isNamedPlaceholder || isZeroIdentifier) {
    throw new Error(`${label} is required for a staging or production build.`);
  }
  return normalized;
}

function assertDeploymentTurnstileSiteKey(value: string | undefined) {
  const siteKey = assertDeploymentValue(value, "NEXT_PUBLIC_TURNSTILE_SITE_KEY");
  if (/^[123]x0{20}(?:AA|AB|BB|FF)$/u.test(siteKey)) {
    throw new Error("Production and staging builds cannot use a Cloudflare Turnstile test key.");
  }
  return siteKey;
}

function assertDeploymentDatabaseId(value: string | undefined, label: string) {
  const databaseId = assertDeploymentValue(value, label);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(databaseId)
  ) {
    throw new Error(`${label} must be a non-placeholder D1 UUID.`);
  }
  return databaseId;
}

export default defineConfig(async ({ mode }) => {
  const deploymentEnvironment = process.env.CLOUDFLARE_ENV;
  const isDeploymentBuild =
    deploymentEnvironment === "staging" || deploymentEnvironment === "production";
  if (!isDeploymentBuild) {
    const localPublicEnv = loadEnv(mode, process.cwd(), ["NEXT_PUBLIC_"]);
    process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ??= localPublicEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  }
  if (isDeploymentBuild) {
    assertDeploymentDatabaseId(
      deploymentDatabaseId(deploymentEnvironment),
      `${deploymentEnvironment.toUpperCase()}_D1_DATABASE_ID`,
    );
  }
  const turnstileSiteKey = isDeploymentBuild
    ? assertDeploymentTurnstileSiteKey(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)
    : process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  const { cloudflare } = await import("@cloudflare/vite-plugin");
  return {
    plugins: [
      vinext(),
      cloudflare({
        configPath: "./wrangler.jsonc",
        config: (config) => ({
          vars: {
            ...config.vars,
            ...(process.env.PUBLIC_RELEASE_VERSION
              ? { PUBLIC_RELEASE_VERSION: process.env.PUBLIC_RELEASE_VERSION }
              : {}),
            ...(process.env.PUBLIC_SOURCE_COMMIT
              ? { PUBLIC_SOURCE_COMMIT: process.env.PUBLIC_SOURCE_COMMIT }
              : {}),
            ...(process.env.PUBLIC_SOURCE_AVAILABLE
              ? { PUBLIC_SOURCE_AVAILABLE: process.env.PUBLIC_SOURCE_AVAILABLE }
              : {}),
            ...(process.env.PUBLIC_BUILD_TIME
              ? { PUBLIC_BUILD_TIME: process.env.PUBLIC_BUILD_TIME }
              : {}),
            ...(turnstileSiteKey ? { PUBLIC_TURNSTILE_SITE_KEY: turnstileSiteKey } : {}),
          },
        }),
        persistState: { path: ".wrangler/state" },
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      }),
    ],
  };
});
