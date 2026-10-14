import assert from "node:assert/strict";
import test from "node:test";

import { assertDevDatabase, assertResettable, reset } from "./reset.mjs";

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

test("refuses a ?host= override pointing at a remote server", () => {
  assert.throws(
    () => assertResettable("postgres://postgres:test@localhost:54329/credit_system?host=db.example.com", {}),
    /local/,
  );
});

test("refuses a remote ?hostaddr= override", () => {
  assert.throws(
    () => assertResettable("postgres://postgres:test@localhost:54329/credit_system?hostaddr=10.0.0.5", {}),
    /local/,
  );
});

test("refuses a URL without an explicit host", () => {
  assert.throws(() => assertResettable("postgres:///credit_system", {}), /local/);
});

test("accepts a unix-socket host", () => {
  assert.doesNotThrow(() =>
    assertResettable("postgres://postgres@localhost/credit_system?host=/var/run/postgresql", {}),
  );
});

test("reports a malformed URL as a guard error", () => {
  assert.throws(() => assertResettable("postgres://[bad", {}), /invalid DATABASE_OWNER_URL/);
  // The parser accepts this one but yields no host: still refused.
  assert.throws(() => assertResettable("not a url", {}), /local/);
});

test("refuses a comma-separated multi-host", () => {
  assert.throws(
    () => assertResettable("postgres://postgres:test@localhost:54329/credit_system?host=localhost,db.example.com", {}),
    /local/,
  );
});

const fakeClient = (value) => ({ query: async () => ({ rows: [{ app_env: value, db: "credit_system" }] }) });

test("assertDevDatabase accepts app.env = dev", async () => {
  await assert.doesNotReject(assertDevDatabase(fakeClient("dev")));
});

test("assertDevDatabase rejects a missing or different marker with the fix command", async () => {
  for (const value of [null, "", "production"]) {
    await assert.rejects(assertDevDatabase(fakeClient(value)), /ALTER DATABASE credit_system SET app\.env = 'dev';/);
  }
});

test("reset rejects with the guard error before opening any connection", async () => {
  // Port 1 is unreachable: a connect attempt would fail with ECONNREFUSED instead.
  await assert.rejects(reset("postgres://postgres:test@db.example.com:1/credit_system", {}), /local database/);
  await assert.rejects(
    reset("postgres://postgres:test@localhost:1/credit_system", { NODE_ENV: "production" }),
    /production/,
  );
});
