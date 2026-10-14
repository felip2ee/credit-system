// Dev-only: drops and recreates the public schema, then reapplies every
// migration. Refuses anything that is not a local database.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import pg from "pg";
import { parse as parseConnectionString } from "pg-connection-string";

import { hydrateSecretEnv } from "../../src/lib/runtime-secrets.mjs";
import { migrate } from "./migrate.mjs";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function assertResettable(connectionString, env) {
  if (!connectionString) throw new Error("DATABASE_OWNER_URL is required");
  if (env.NODE_ENV === "production") {
    throw new Error("db:reset refuses to run with NODE_ENV=production");
  }
  // Resolve the host exactly as pg does: ?host= overrides the URL host. The parser
  // copies every query param, so ?hostaddr= is checked too (fail closed).
  let params;
  try {
    params = parseConnectionString(connectionString);
  } catch {
    throw new Error("db:reset: invalid DATABASE_OWNER_URL");
  }
  for (const host of [params.host, params.hostaddr].filter((value) => value !== undefined)) {
    if (!isLocalHost(host)) {
      throw new Error(`db:reset only runs against a local database (got host "${host}")`);
    }
  }
  if (!params.host) {
    throw new Error("db:reset only runs against a local database (no explicit host)");
  }
}

function isLocalHost(host) {
  return !host.includes(",") && (LOCAL_HOSTS.has(host) || host.startsWith("/"));
}

// The host check cannot see through an SSH tunnel to localhost, so the database
// itself must carry the dev marker.
export async function assertDevDatabase(client) {
  const { rows } = await client.query(
    "select current_setting('app.env', true) as app_env, current_database() as db",
  );
  const { app_env: appEnv, db } = rows[0];
  if (appEnv !== "dev") {
    throw new Error(
      `db:reset recusado: o banco "${db}" não tem o marcador de desenvolvimento. ` +
        `Se for um banco de dev, execute como superusuário: ALTER DATABASE ${db} SET app.env = 'dev';`,
    );
  }
}

export async function reset(connectionString = process.env.DATABASE_OWNER_URL, env = process.env) {
  assertResettable(connectionString, env);
  const client = new pg.Client({ connectionString });
  client.on("error", (error) => {
    console.error(`db:reset: conexão com o banco perdida (${error.message})`);
    process.exitCode = 1;
  });
  await client.connect();
  try {
    await assertDevDatabase(client);
    // Only the public schema is rebuilt; other schemas and roles are untouched.
    await client.query("begin");
    try {
      await client.query("drop schema public cascade");
      await client.query("create schema public");
      await client.query("alter schema public owner to pg_database_owner");
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.end();
  }
  await migrate(connectionString);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hydrateSecretEnv(process.env);
  reset().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
