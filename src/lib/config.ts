import path from "node:path";

type Environment = Record<string, string | undefined>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function url(env: Environment, name: string): string {
  const value = required(env, name);
  try {
    new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  return value;
}

function port(env: Environment, name: string): number {
  const value = required(env, name);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }

  const number = Number(value);
  if (number < 1 || number > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return number;
}

export function readConfig(env: Environment) {
  const betterAuthSecret = required(env, "BETTER_AUTH_SECRET");
  if (betterAuthSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }

  const documentRoot = required(env, "DOCUMENT_ROOT");
  if (!path.isAbsolute(documentRoot)) {
    throw new Error("DOCUMENT_ROOT must be an absolute path");
  }

  const smtpSecure = required(env, "SMTP_SECURE");
  if (smtpSecure !== "true" && smtpSecure !== "false") {
    throw new Error("SMTP_SECURE must be true or false");
  }

  const smtpUser = required(env, "SMTP_USER");

  return Object.freeze({
    databaseUrl: url(env, "DATABASE_URL"),
    betterAuthSecret,
    betterAuthUrl: url(env, "BETTER_AUTH_URL"),
    documentRoot,
    clamavHost: required(env, "CLAMAV_HOST"),
    clamavPort: port(env, "CLAMAV_PORT"),
    smtpHost: required(env, "SMTP_HOST"),
    smtpPort: port(env, "SMTP_PORT"),
    smtpSecure: smtpSecure === "true",
    smtpUser,
    smtpPass: required(env, "SMTP_PASS"),
    smtpFrom: env.SMTP_FROM?.trim() || `Rainha do Crédito <${smtpUser}>`,
  });
}

export const config = readConfig(process.env);
