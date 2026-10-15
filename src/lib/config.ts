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

// Valor de exemplo do .env.example: público, nunca vale como token real.
export const ASAAS_WEBHOOK_TOKEN_EXAMPLE = "local-webhook-token-0123456789abcdef";

// DSN da role app_webhook. Fora de readConfig: só o webhook precisa dele.
export function readWebhookDatabaseUrl(env: Environment): string {
  return url(env, "DATABASE_WEBHOOK_URL");
}

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
  if ((driver === "asaas" || env.NODE_ENV === "production") && webhookToken === ASAAS_WEBHOOK_TOKEN_EXAMPLE) {
    throw new Error("ASAAS_WEBHOOK_TOKEN must not be the .env.example placeholder");
  }
  if (driver === "fake") return { driver, webhookToken };

  // A chave de API segue neste endereço: só https.
  const baseUrl = url(env, "ASAAS_API_BASE_URL");
  if (new URL(baseUrl).protocol !== "https:") throw new Error("ASAAS_API_BASE_URL must use https");

  return {
    driver,
    apiKey: required(env, "ASAAS_API_KEY"),
    baseUrl,
    customerId: required(env, "ASAAS_CUSTOMER_ID"),
    webhookToken,
  };
}

export type NfseConfig = {
  municipalServiceId?: string;
  municipalServiceCode?: string;
  municipalServiceName: string;
  serviceDescription: string;
  // Percentual (2.5 = 2,5%).
  issRate: number;
  retainIss: boolean;
};

// Lida sob demanda, como o Asaas. Sem serviço municipal (id ou código) a NFS-e fica desligada: null.
// Com serviço informado, o resto é obrigatório (configuração pela metade falha em vez de emitir nota errada).
export function readNfseConfig(env: Environment): NfseConfig | null {
  const municipalServiceId = env.NFSE_MUNICIPAL_SERVICE_ID?.trim() || undefined;
  const municipalServiceCode = env.NFSE_MUNICIPAL_SERVICE_CODE?.trim() || undefined;
  if (!municipalServiceId && !municipalServiceCode) return null;

  const rate = required(env, "NFSE_ISS_RATE");
  const issRate = Number(rate);
  // A LC 116/2003 limita a alíquota de ISS a 5%.
  if (!/^\d+(\.\d+)?$/.test(rate) || issRate > 5) throw new Error("NFSE_ISS_RATE must be a number between 0 and 5");

  const retain = env.NFSE_RETAIN_ISS?.trim() || "false";
  if (retain !== "true" && retain !== "false") throw new Error("NFSE_RETAIN_ISS must be true or false");

  return {
    municipalServiceId,
    municipalServiceCode,
    municipalServiceName: required(env, "NFSE_MUNICIPAL_SERVICE_NAME"),
    serviceDescription: required(env, "NFSE_SERVICE_DESCRIPTION"),
    issRate,
    retainIss: retain === "true",
  };
}

export type WhatsappConfig =
  | { driver: "fake"; phoneNumberId: string; appSecret: string; verifyToken: string }
  | {
      driver: "meta";
      accessToken: string;
      phoneNumberId: string;
      appSecret: string;
      verifyToken: string;
      graphBaseUrl: string;
      graphVersion: string;
    };

const WHATSAPP_DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com";

function secretOfMinLength(env: Environment, name: string, min: number): string {
  const value = required(env, name);
  if (value.length < min) throw new Error(`${name} must be at least ${min} characters`);
  return value;
}

// Lida sob demanda (fora de readConfig). Driver vazio = WhatsApp desligado: null.
// O webhook compara phoneNumberId nos dois drivers; "fake" nunca roda em produção.
export function readWhatsappConfig(env: Environment): WhatsappConfig | null {
  const driver = env.WHATSAPP_DRIVER?.trim();
  if (!driver) return null;
  if (driver !== "meta" && driver !== "fake") throw new Error("WHATSAPP_DRIVER must be meta or fake");
  if (driver === "fake" && env.NODE_ENV === "production") {
    throw new Error("WHATSAPP_DRIVER=fake is not allowed in production");
  }

  const phoneNumberId = required(env, "WHATSAPP_PHONE_NUMBER_ID");
  if (!/^\d+$/.test(phoneNumberId)) throw new Error("WHATSAPP_PHONE_NUMBER_ID must contain only digits");
  const appSecret = secretOfMinLength(env, "WHATSAPP_APP_SECRET", 32);
  const verifyToken = secretOfMinLength(env, "WHATSAPP_VERIFY_TOKEN", 32);
  if (driver === "fake") return { driver, phoneNumberId, appSecret, verifyToken };

  const graphVersion = required(env, "WHATSAPP_GRAPH_VERSION");
  if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error("WHATSAPP_GRAPH_VERSION must look like v21.0");
  // O token de acesso segue neste endereço: só https.
  const graphBaseUrl = env.WHATSAPP_GRAPH_BASE_URL?.trim()
    ? url(env, "WHATSAPP_GRAPH_BASE_URL")
    : WHATSAPP_DEFAULT_GRAPH_BASE_URL;
  if (new URL(graphBaseUrl).protocol !== "https:") throw new Error("WHATSAPP_GRAPH_BASE_URL must use https");

  return {
    driver,
    accessToken: required(env, "WHATSAPP_ACCESS_TOKEN"),
    phoneNumberId,
    appSecret,
    verifyToken,
    graphBaseUrl,
    graphVersion,
  };
}

// Valor de exemplo do .env.example: público, nunca vale como segredo em produção.
export const NOTIFICATIONS_DISPATCH_SECRET_EXAMPLE = "local-dispatch-secret-0123456789abcdef";

// Lida sob demanda. Protege a rota que roda o worker de notificações.
export function readNotificationsDispatchSecret(env: Environment): string {
  const secret = secretOfMinLength(env, "NOTIFICATIONS_DISPATCH_SECRET", 32);
  if (env.NODE_ENV === "production" && secret === NOTIFICATIONS_DISPATCH_SECRET_EXAMPLE) {
    throw new Error("NOTIFICATIONS_DISPATCH_SECRET must not be the .env.example placeholder");
  }
  return secret;
}

export const config = readConfig(hydrateSecretEnv(process.env));
