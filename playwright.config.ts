import { defineConfig } from "@playwright/test";

// Smoke suite for the release gate (verify-release.mjs gate 5). Requires a
// running app + seeded Postgres reachable at PLAYWRIGHT_BASE_URL. The AUTH_E2E_*
// env vars are set directly in the CI or shell environment. No webServer is started
// here — point it at the real target during the cutover rehearsal.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
    trace: "on-first-retry",
  },
});
