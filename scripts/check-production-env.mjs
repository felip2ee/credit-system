#!/usr/bin/env node
// Production env gate for the Asaas fees. Reads `.env.production` (or the process env when the file is absent).
// PIX_FEE_CENTS empty or invalid = FAIL (the app refuses Pix in production). CARD_FEE_TABLE empty = WARN (card off).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Parses `KEY=value` lines; the setup script writes values with shell quoting, so one pair of quotes is stripped.
export function parseEnvFile(text) {
  const env = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

export function checkProductionEnv(env) {
  const errors = [];
  const warnings = [];
  const pix = env.PIX_FEE_CENTS?.trim();
  if (!pix) errors.push("PIX_FEE_CENTS is empty or missing (199 = R$ 1,99; 0 = no fee).");
  else if (!/^\d{1,4}$/.test(pix) || Number(pix) > 1000) errors.push("PIX_FEE_CENTS must be an integer from 0 to 1000.");
  if (!env.CARD_FEE_TABLE?.trim()) warnings.push("CARD_FEE_TABLE is empty: card payment is off.");
  return { errors, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = ".env.production";
  const env = existsSync(file) ? parseEnvFile(readFileSync(file, "utf8")) : process.env;
  const { errors, warnings } = checkProductionEnv(env);
  for (const warning of warnings) console.warn(`WARN: ${warning}`);
  for (const error of errors) console.error(`FAIL: ${error}`);
  process.exit(errors.length > 0 ? 1 : 0);
}
