import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
