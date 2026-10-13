// DSNs for the live-Postgres integration suites. Defaults match
// docker-compose.dev.yml; CI and other machines override via env.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://app_runtime:test@localhost:54329/credit_system";

export const TEST_DATABASE_OWNER_URL =
  process.env.TEST_DATABASE_OWNER_URL ??
  "postgres://postgres:test@localhost:54329/credit_system";
