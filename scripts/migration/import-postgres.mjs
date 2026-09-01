#!/usr/bin/env node
// Import an export directory into a freshly-migrated target Postgres, inside one
// explicit transaction. Preserves source UUIDs + timestamps. For every preserved
// identity it creates a Better Auth user with a FRESH cryptographically random
// 32-byte password (hashed, plaintext discarded immediately) and marks the
// profile must_reset_password = true. NO legacy credential is ever imported.
// One-time reset links are generated only during authorized cutover, not here.
//
// Historical raw bureau payloads are replayed through the production adapter
// (version 1): valid -> bureau_results + status completed; invalid -> raw
// preserved, status payload_incompatible with structural errors.
//
// Idempotent: rerunning against a partially-imported target inserts only what
// is missing.
//
//   node scripts/migration/import-postgres.mjs <TARGET_DATABASE_URL> <IN_DIR>
// or DATABASE_OWNER_URL / MIGRATION_IN_DIR env vars.

import { register } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import pg from "pg";
import { hashPassword } from "better-auth/crypto";

import { importAll, makePgStore, redactDsn, requireArg } from "./lib.mjs";

// Load the REAL production DEPS adapter (version 1) — no re-implementation.
// It is TypeScript with the `@/` alias; Node strips types natively and this
// resolve hook maps `@/x` -> `<repo>/src/x`.
const srcRoot = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../src/"),
).href;
register(
  `data:text/javascript,
   const srcRoot = ${JSON.stringify(srcRoot)};
   export async function resolve(spec, ctx, next) {
     if (spec.startsWith("@/")) {
       for (const ext of ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts"]) {
         try { return await next(srcRoot + spec.slice(2) + ext, ctx); } catch {}
       }
     }
     return next(spec, ctx);
   }`,
  import.meta.url,
);
const { adapt } = await import("../../src/lib/deps/adapter.ts");

const dsn = requireArg(
  "TARGET_DATABASE_URL",
  process.argv[2] || process.env.DATABASE_OWNER_URL,
);
const dir = requireArg("IN_DIR", process.argv[3] || process.env.MIGRATION_IN_DIR);

const client = new pg.Client({ connectionString: dsn });
console.log(`import: ${dir} -> target ${redactDsn(dsn)}`);
await client.connect();
try {
  const store = makePgStore(client, hashPassword);
  const summary = await importAll({ dir, store, adapt });
  console.log(JSON.stringify(summary, null, 2));
  console.log("import complete — run verify.mjs before any cutover");
} finally {
  await client.end();
}
