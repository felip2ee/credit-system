#!/usr/bin/env node
// Export active business rows + identity METADATA from the legacy Supabase
// Postgres into an immutable, newline-delimited-JSON directory + manifest.
//
// READ-ONLY. Connects over a plain Postgres DSN (no @supabase client needed).
// Never mutates the source. Run only during an authorized cutover rehearsal.
//
//   node scripts/migration/export-supabase.mjs <SOURCE_DATABASE_URL> <OUT_DIR>
// or SOURCE_DATABASE_URL / MIGRATION_OUT_DIR env vars.

import pg from "pg";

import { TABLE_ORDER, exportAll, redactDsn, requireArg } from "./lib.mjs";

const dsn = requireArg("SOURCE_DATABASE_URL", process.argv[2] || process.env.SOURCE_DATABASE_URL);
const outDir = requireArg("OUT_DIR", process.argv[3] || process.env.MIGRATION_OUT_DIR);

const client = new pg.Client({ connectionString: dsn });

const source = {
  // ponytail: whole active table into memory. This system's largest table is
  // ~1e5 rows of small JSON; fine for a one-shot cutover. Switch to a server-
  // side cursor if a future dataset makes that false.
  readTable: async (name) => {
    const { rows } = await client.query(`select * from "${name}"`);
    return rows;
  },
  listIdentities: async () => {
    const { rows } = await client.query(
      `select id, email, full_name as name, role, is_active, created_at, updated_at
         from profiles`,
    );
    return rows;
  },
};

console.log(`export: source ${redactDsn(dsn)} -> ${outDir}`);
await client.connect();
try {
  await client.query("set transaction read only").catch(() => {});
  const manifest = await exportAll(source, outDir);
  for (const name of TABLE_ORDER) {
    console.log(`  ${name}: ${manifest.tables[name].count}`);
  }
  console.log(`  identities: ${manifest.identities.count}`);
  console.log("export complete — run copy-storage.mjs next");
} finally {
  await client.end();
}
