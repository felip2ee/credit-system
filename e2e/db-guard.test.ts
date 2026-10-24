import { describe, expect, it } from "vitest";

import { assertE2eDatabase } from "./db-guard";

const REFUSAL = /e2e refuses a non-local database/;

describe("assertE2eDatabase", () => {
  it("accepts local hosts", () => {
    expect(() => assertE2eDatabase("postgres://u:p@127.0.0.1:54329/db", {})).not.toThrow();
    expect(() => assertE2eDatabase("postgres://u:p@localhost/db", {})).not.toThrow();
  });
  it("refuses a remote host", () => {
    expect(() => assertE2eDatabase("postgres://u:p@db.example.com/db", {})).toThrow(REFUSAL);
  });
  it("accepts a remote host with E2E_ALLOW_REMOTE_DB=1", () => {
    expect(() => assertE2eDatabase("postgres://u:p@db.example.com/db", { E2E_ALLOW_REMOTE_DB: "1" })).not.toThrow();
  });
  it("refuses in production even with the flag", () => {
    const env = { NODE_ENV: "production", E2E_ALLOW_REMOTE_DB: "1" };
    expect(() => assertE2eDatabase("postgres://u:p@127.0.0.1/db", env)).toThrow(REFUSAL);
  });
  it("refuses a remote ?host= or ?hostaddr= on a local URL", () => {
    expect(() => assertE2eDatabase("postgres://u:p@127.0.0.1/db?host=db.example.com", {})).toThrow(REFUSAL);
    expect(() => assertE2eDatabase("postgres://u:p@127.0.0.1/db?hostaddr=10.0.0.5", {})).toThrow(REFUSAL);
  });
});
