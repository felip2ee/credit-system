import assert from "node:assert/strict";
import test from "node:test";

import { assertResettable } from "./reset.mjs";

test("refuses production NODE_ENV", () => {
  assert.throws(
    () => assertResettable("postgres://postgres:test@localhost:54329/credit_system", { NODE_ENV: "production" }),
    /production/,
  );
});

test("refuses non-local hosts", () => {
  for (const host of ["postgres", "db.example.com", "10.0.0.5"]) {
    assert.throws(
      () => assertResettable(`postgres://postgres:test@${host}:5432/credit_system`, {}),
      /local/,
    );
  }
});

test("refuses a missing URL", () => {
  assert.throws(() => assertResettable(undefined, {}), /DATABASE_OWNER_URL/);
});

test("accepts local hosts", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.doesNotThrow(() =>
      assertResettable(`postgres://postgres:test@${host}:54329/credit_system`, { NODE_ENV: "development" }),
    );
  }
});
