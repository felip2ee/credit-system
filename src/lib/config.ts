import { isIP } from "node:net";
import path from "node:path";

import { hydrateSecretEnv } from "./runtime-secrets.mjs";

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

function authUrl(env: Environment): string {
  const value = url(env, "BETTER_AUTH_URL");
  const protocol = new URL(value).protocol;
  if (
    protocol !== "https:" &&
    (protocol !== "http:" || (env.NODE_ENV !== "development" && env.NODE_ENV !== "test"))
  ) {
    throw new Error("BETTER_AUTH_URL must use HTTPS outside development and test");
  }
  return value;
}

function isCidr(value: string): boolean {
  const [address, prefix, extra] = value.split("/");
  const version = address && isIP(address);
  if (!version || !prefix || extra !== undefined || !/^\d+$/.test(prefix)) {
    return false;
  }
  return Number(prefix) <= (version === 4 ? 32 : 128);
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
  const traefikProxyCidr = env.TRAEFIK_PROXY_CIDR?.trim();
  if (env.NODE_ENV === "production" && !traefikProxyCidr) {
    throw new Error("TRAEFIK_PROXY_CIDR is required in production");
  }
  if (traefikProxyCidr && !isCidr(traefikProxyCidr)) {
    throw new Error("TRAEFIK_PROXY_CIDR must be a valid IPv4 or IPv6 CIDR");
  }

  return Object.freeze({
    databaseUrl: url(env, "DATABASE_URL"),
    betterAuthSecret,
    betterAuthUrl: authUrl(env),
    documentRoot,
    clamavHost: required(env, "CLAMAV_HOST"),
    clamavPort: port(env, "CLAMAV_PORT"),
    smtpHost: required(env, "SMTP_HOST"),
    smtpPort: port(env, "SMTP_PORT"),
    smtpSecure: smtpSecure === "true",
    smtpUser,
    smtpPass: required(env, "SMTP_PASS"),
    smtpFrom: env.SMTP_FROM?.trim() || `Rainha do Crédito <${smtpUser}>`,
    traefikProxyCidr: traefikProxyCidr || undefined,
  });
}

export type AsaasConfig =
  | { driver: "fake"; webhookToken: string }
  | { driver: "asaas"; apiKey: string; baseUrl: string; customerId: string; webhookToken: string };

// Lida sob demanda (não entra em readConfig): só a recarga PIX e o webhook precisam do Asaas.
// Sem driver explícito falha; "fake" nunca roda em produção.
export function readAsaasConfig(env: Environment): AsaasConfig {
  const driver = required(env, "ASAAS_DRIVER");
  if (driver !== "asaas" && driver !== "fake") {
    throw new Error("ASAAS_DRIVER must be asaas or fake");
  }
  if (driver === "fake" && env.NODE_ENV === "production") {
    throw new Error("ASAAS_DRIVER=fake is not allowed in production");
  }

  const webhookToken = required(env, "ASAAS_WEBHOOK_TOKEN");
  if (webhookToken.length < 32) {
    throw new Error("ASAAS_WEBHOOK_TOKEN must be at least 32 characters");
  }
  if (driver === "fake") return { driver, webhookToken };

  return {
    driver,
    apiKey: required(env, "ASAAS_API_KEY"),
    baseUrl: url(env, "ASAAS_API_BASE_URL"),
    customerId: required(env, "ASAAS_CUSTOMER_ID"),
    webhookToken,
  };
}

export const config = readConfig(hydrateSecretEnv(process.env));
