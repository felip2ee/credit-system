// Dev-only: drops and recreates the public schema, then reapplies every
// migration. Refuses anything that is not a local database.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import pg from "pg";

import { hydrateSecretEnv } from "../../src/lib/runtime-secrets.mjs";
import { migrate } from "./migrate.mjs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function assertResettable(connectionString, env) {
  if (!connectionString) throw new Error("DATABASE_OWNER_URL is required");
  if (env.NODE_ENV === "production") {
    throw new Error("db:reset refuses to run with NODE_ENV=production");
  }
  const host = new URL(connectionString).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`db:reset only runs against a local database (got host "${host}")`);
  }
}

export async function reset(connectionString = process.env.DATABASE_OWNER_URL, env = process.env) {
  assertResettable(connectionString, env);
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("drop schema public cascade");
    await client.query("create schema public");
    await client.query("alter schema public owner to pg_database_owner");
  } finally {
    await client.end();
  }
  await migrate(connectionString);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  hydrateSecretEnv(process.env);
  reset().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
