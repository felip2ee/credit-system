import { defineConfig, devices } from "@playwright/test";

// E2E suite: runs in CI (job `test`) and in the release gate (verify-release.mjs gate 5).
// webServer starts the production build (`npm run start`); the run needs DATABASE_URL, TEST_DATABASE_OWNER_URL,
// NOTIFICATIONS_DISPATCH_SECRET and BETTER_AUTH_* in the environment (see the e2e step in ci.yml).
// Against a remote target, set PLAYWRIGHT_BASE_URL and a reachable TEST_DATABASE_OWNER_URL.
export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.(spec|setup)\.ts/,
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    // Full Chromium in new headless mode: one browser download serves CI and local runs.
    channel: "chromium",
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
  webServer: {
    command: "npm run start",
    url: "http://127.0.0.1:3000/api/health/live",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    { name: "chromium", testMatch: /.*\.spec\.ts/, use: { ...devices["Desktop Chrome"] }, dependencies: ["setup"] },
  ],
});
