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

export function readConfig(env: Environment) {
  const betterAuthSecret = required(env, "BETTER_AUTH_SECRET");
  if (betterAuthSecret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  }

  const documentRoot = required(env, "DOCUMENT_ROOT");
  if (!path.isAbsolute(documentRoot)) {
    throw new Error("DOCUMENT_ROOT must be an absolute path");
  }

  const clamavPort = Number(required(env, "CLAMAV_PORT"));
  if (!Number.isInteger(clamavPort) || clamavPort < 1 || clamavPort > 65535) {
    throw new Error("CLAMAV_PORT must be an integer between 1 and 65535");
  }

  return Object.freeze({
    databaseUrl: url(env, "DATABASE_URL"),
    betterAuthSecret,
    betterAuthUrl: url(env, "BETTER_AUTH_URL"),
    documentRoot,
    clamavHost: required(env, "CLAMAV_HOST"),
    clamavPort,
  });
}

export const config = readConfig(process.env);
