import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { hydrateSecretEnv } from "../../src/lib/runtime-secrets.mjs";

hydrateSecretEnv(process.env);

const migrationsDirectory =
  process.env.MIGRATIONS_DIR ||
  resolve(dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

export async function loadMigrations(directory = migrationsDirectory) {
  const names = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();

  return Promise.all(
    names.map(async (version) => {
      const sql = await readFile(resolve(directory, version), "utf8");
      return {
        version,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export function pendingMigrations(migrations, history) {
  const available = new Set(migrations.map(({ version }) => version));
  for (const version of history.keys()) {
    if (!available.has(version)) {
      throw new Error(`applied migration ${version} is missing from disk`);
    }
  }

  for (const migration of migrations) {
    const appliedChecksum = history.get(migration.version);
    if (appliedChecksum && appliedChecksum !== migration.checksum) {
      throw new Error(`checksum mismatch for migration ${migration.version}`);
    }
  }

  return migrations.filter(({ version }) => !history.has(version));
}

export async function migrate(connectionString = process.env.DATABASE_OWNER_URL) {
  if (!connectionString) {
    throw new Error("DATABASE_OWNER_URL is required");
  }

  const client = new pg.Client({ connectionString });
  let locked = false;

  try {
    await client.connect();
    await client.query(
      "select pg_advisory_lock(hashtext('credit-system-migrate'))",
    );
    locked = true;
    await client.query(`
      create table if not exists schema_migrations (
        version text primary key,
        checksum text not null check (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz not null default now()
      )
    `);

    const { rows } = await client.query(
      "select version, checksum from schema_migrations order by version",
    );
    const pending = pendingMigrations(
      await loadMigrations(),
      new Map(rows.map(({ version, checksum }) => [version, checksum])),
    );

    for (const migration of pending) {
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query(
          "insert into schema_migrations (version, checksum) values ($1, $2)",
          [migration.version, migration.checksum],
        );
        await client.query("commit");
        console.log(`applied ${migration.version}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }

    // --check runs as app_runtime and only needs to read the history. Granted after
    // the loop: migration 001 moves the table to schema_owner.
    await client.query(`
      do $$
      begin
        if exists (select 1 from pg_roles where rolname = 'app_runtime') then
          grant select on schema_migrations to app_runtime;
        end if;
      end
      $$
    `);

    if (pending.length === 0) console.log("database schema is current");
  } finally {
    try {
      if (locked) {
        await client.query(
          "select pg_advisory_unlock(hashtext('credit-system-migrate'))",
        );
      }
    } finally {
      await client.end();
    }
  }
}

// Read-only, lock-free: exit 0 current, 2 pending migrations, 1 error.
export async function checkSchema(
  connectionString = process.env.DATABASE_URL || process.env.DATABASE_OWNER_URL,
) {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    const { rows } = await client.query(
      "select version, checksum from schema_migrations order by version",
    );
    return pendingMigrations(
      await loadMigrations(),
      new Map(rows.map(({ version, checksum }) => [version, checksum])),
    ).length;
  } finally {
    await client.end();
  }
}

const isMain =
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain && process.argv.includes("--check")) {
  checkSchema()
    .then((pending) => {
      if (pending > 0) {
        console.error(`schema has ${pending} pending migration(s)`);
        process.exitCode = 2;
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
} else if (isMain) {
  migrate().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
