import { parse } from "pg-connection-string";

// DSNs for the live-Postgres integration suites. Defaults match
// docker-compose.dev.yml; CI and other machines override via env.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Integration suites truncate and rewrite data: never let them reach a remote database.
function assertLocal(name: string, url: string): string {
  const { host } = parse(url);
  if (!host || !(LOCAL_HOSTS.has(host) || host.startsWith("/"))) {
    throw new Error(`${name} must point to a local database (got host "${host ?? ""}")`);
  }
  return url;
}

export const TEST_DATABASE_URL = assertLocal(
  "TEST_DATABASE_URL",
  process.env.TEST_DATABASE_URL ??
    "postgres://app_runtime:test@localhost:54329/credit_system",
);

export const TEST_DATABASE_OWNER_URL = assertLocal(
  "TEST_DATABASE_OWNER_URL",
  process.env.TEST_DATABASE_OWNER_URL ??
    "postgres://postgres:test@localhost:54329/credit_system",
);

export const TEST_DATABASE_WEBHOOK_URL = assertLocal(
  "TEST_DATABASE_WEBHOOK_URL",
  process.env.TEST_DATABASE_WEBHOOK_URL ??
    "postgres://app_webhook:test@localhost:54329/credit_system",
);

// Role do worker de notificações (claim_notifications, complete_notification), migração 020.
export const TEST_DATABASE_DISPATCH_URL = assertLocal(
  "TEST_DATABASE_DISPATCH_URL",
  process.env.TEST_DATABASE_DISPATCH_URL ??
    "postgres://app_dispatch:test@localhost:54329/credit_system",
);
