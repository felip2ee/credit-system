#!/usr/bin/env node
// Integrity gate for a completed import. Checks exact row counts, foreign keys,
// unique emails/documents, consultation<->result consistency, storage file
// SHA-256 (source manifest vs bytes on disk), audit append-only preservation,
// and the ABSENCE of any imported password / session / MFA data.
// Exits nonzero on ANY discrepancy.
//
//   node scripts/migration/verify.mjs <TARGET_DATABASE_URL> <IN_DIR>
// or DATABASE_OWNER_URL / MIGRATION_IN_DIR env vars.

import pg from "pg";

import { makePgStore, redactDsn, requireArg, verify } from "./lib.mjs";

const dsn = requireArg(
  "TARGET_DATABASE_URL",
  process.argv[2] || process.env.DATABASE_OWNER_URL,
);
const dir = requireArg("IN_DIR", process.argv[3] || process.env.MIGRATION_IN_DIR);

const client = new pg.Client({ connectionString: dsn });
console.log(`verify: ${dir} against target ${redactDsn(dsn)}`);
await client.connect();
try {
  const store = makePgStore(client, null); // read-only checks: no hasher needed
  const { ok, errors } = await verify({ dir, store });
  if (ok) {
    console.log("verify: PASS — all integrity gates green");
  } else {
    console.error(`verify: FAIL — ${errors.length} discrepancy(ies):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
  }
} finally {
  await client.end();
}
