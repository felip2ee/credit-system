import { defineConfig } from "@playwright/test";

// Smoke suite for the release gate (verify-release.mjs gate 5). Requires a
// running app + seeded Postgres reachable at PLAYWRIGHT_BASE_URL and the
// AUTH_E2E_* env vars (see docs/operations/cutover.md). No webServer is started
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
