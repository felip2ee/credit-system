import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadMigrations, pendingMigrations } from "./migrate.mjs";

test("rejects a changed checksum for an applied migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "credit-system-migrations-"));

  try {
    const file = join(directory, "001_example.sql");
    await writeFile(file, "select 1;\n");
    const [applied] = await loadMigrations(directory);
    const history = new Map([[applied.version, applied.checksum]]);

    await writeFile(file, "select 2;\n");
    const [changed] = await loadMigrations(directory);

    assert.throws(
      () => pendingMigrations([changed], history),
      /checksum mismatch for migration 001_example\.sql/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an applied migration missing from disk", () => {
  assert.throws(
    () => pendingMigrations([], new Map([["001_removed.sql", "a".repeat(64)]])),
    /applied migration 001_removed\.sql is missing from disk/,
  );
});

test("limits profile and credit-product SELECT policies to staff", async () => {
  const sql = await readFile("db/migrations/004_rls.sql", "utf8");

  assert.match(
    sql,
    /create policy profiles_select on profiles for select\s+using \(\s+app_context_present\(\)\s+and app_user_role\(\) in \('admin', 'consultant'\)\s+\);/s,
  );
  assert.match(
    sql,
    /create policy credit_products_select on credit_products for select\s+using \(\s+app_context_present\(\)\s+and app_user_role\(\) in \('admin', 'consultant'\)\s+\);/s,
  );
});
