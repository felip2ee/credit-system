import { readFileSync } from "node:fs";

const secretNames = [
  "DATABASE_URL",
  "DATABASE_OWNER_URL",
  "BETTER_AUTH_SECRET",
  "SMTP_PASS",
  "DEPS_API_PASSWORDL",
  "DEPS_API_PASSWORD",
  "OPENAI_API_KEY",
];

export function hydrateSecretEnv(env = process.env) {
  for (const name of secretNames) {
    const file = env[`${name}_FILE`];
    if (!file) continue;

    const value = readFileSync(file, "utf8").trim();
    if (!value) throw new Error(`${name} secret file is empty`);
    env[name] = value;
  }
  return env;
}
