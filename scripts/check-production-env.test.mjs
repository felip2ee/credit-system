import assert from "node:assert/strict";
import { test } from "node:test";
import { checkProductionEnv, parseEnvFile } from "./check-production-env.mjs";

test("empty or missing PIX_FEE_CENTS fails", () => {
  assert.equal(checkProductionEnv({}).errors.length, 1);
  assert.equal(checkProductionEnv({ PIX_FEE_CENTS: "  " }).errors.length, 1);
});

test("invalid PIX_FEE_CENTS fails; 0 and 199 pass", () => {
  for (const value of ["1.99", "-1", "abc", "1001"]) assert.equal(checkProductionEnv({ PIX_FEE_CENTS: value }).errors.length, 1);
  for (const value of ["0", "199"]) assert.deepEqual(checkProductionEnv({ PIX_FEE_CENTS: value }).errors, []);
});

test("empty CARD_FEE_TABLE only warns", () => {
  const empty = checkProductionEnv({ PIX_FEE_CENTS: "199", CARD_FEE_TABLE: "" });
  assert.deepEqual(empty.errors, []);
  assert.equal(empty.warnings.length, 1);
  assert.deepEqual(checkProductionEnv({ PIX_FEE_CENTS: "199", CARD_FEE_TABLE: "1:2.99:49" }).warnings, []);
});

test("parses the quoted .env.production lines", () => {
  const env = parseEnvFile("# c\nPIX_FEE_CENTS=199\nCARD_FEE_TABLE=''\nSMTP_FROM='a b'\n");
  assert.deepEqual(env, { PIX_FEE_CENTS: "199", CARD_FEE_TABLE: "", SMTP_FROM: "a b" });
});
