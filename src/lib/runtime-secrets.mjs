import { readFileSync } from "node:fs";

const secretNames = [
  "DATABASE_URL",
  "DATABASE_OWNER_URL",
  "DATABASE_WEBHOOK_URL",
  "DISPATCH_DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "SMTP_PASS",
  "DEPS_API_PASSWORDL",
  "DEPS_API_PASSWORD",
  "OPENAI_API_KEY",
  "ASAAS_API_KEY",
  "ASAAS_WEBHOOK_TOKEN",
  "PII_ENCRYPTION_KEY",
  "SUPERADMIN_PASSWORD",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_APP_SECRET",
  "WHATSAPP_VERIFY_TOKEN",
  "NOTIFICATIONS_DISPATCH_SECRET",
  "WEB_PUSH_VAPID_PRIVATE_KEY",
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
