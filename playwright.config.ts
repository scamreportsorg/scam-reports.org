import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4173);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;
const artifactsRoot = process.env.PLAYWRIGHT_ARTIFACTS_DIR ?? ".wrangler/playwright";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: `${artifactsRoot}/test-results`,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: `${artifactsRoot}/report` }]]
    : "list",
  use: {
    baseURL,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `node scripts/e2e-server-launcher.mjs --port=${port}`,
    url: `${baseURL}/api/version`,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
