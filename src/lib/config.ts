import { isIP } from "node:net";
import path from "node:path";

import { BRAND_NAME } from "@/lib/brand/brand";
import { MAX_CARD_INSTALLMENTS } from "@/lib/wallet/card-fees";

import { hydrateSecretEnv } from "./runtime-secrets.mjs";

const DEFAULT_SUPPORT_EMAIL = "suporte@rainhacred.com.br";

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
    smtpFrom: env.SMTP_FROM?.trim() || `${BRAND_NAME} <${smtpUser}>`,
    traefikProxyCidr: traefikProxyCidr || undefined,
    supportEmail: env.SUPPORT_EMAIL?.trim() || DEFAULT_SUPPORT_EMAIL,
  });
}

// Saque de comissão de afiliado. Fica desligado até o contador validar o tratamento fiscal (docs/operations/affiliates.md).
// Lida sob demanda: só o portal e a action de saque precisam dela. Fail closed: só "true" liga.
export function readAffiliateWithdrawalsEnabled(env: Environment): boolean {
  return env.AFFILIATE_WITHDRAWALS_ENABLED?.trim() === "true";
}

export type AsaasConfig =
  | { driver: "fake"; webhookToken: string }
  | { driver: "asaas"; apiKey: string; baseUrl: string; webhookToken: string };

// Valor de exemplo do .env.example: público, nunca vale como token real.
export const ASAAS_WEBHOOK_TOKEN_EXAMPLE = "local-webhook-token-0123456789abcdef";

// DSN da role app_webhook. Fora de readConfig: só o webhook precisa dele.
export function readWebhookDatabaseUrl(env: Environment): string {
  return url(env, "DATABASE_WEBHOOK_URL");
}

// DSN da role app_dispatch (worker de notificações: claim_notifications, complete_notification).
export function readDispatchDatabaseUrl(env: Environment): string {
  return url(env, "DISPATCH_DATABASE_URL");
}

// Lida sob demanda (não entra em readConfig): só a recarga (Pix e cartão) e o webhook precisam do Asaas.
// O cliente Asaas é por pagador (payer_profiles); não existe cliente fixo na configuração.
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
    webhookToken,
  };
}

const PII_KEY_BYTES = 32;
const PII_KEY_ID = /^[a-z0-9_-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type PiiKeyring = { activeKeyId: string; keys: ReadonlyMap<string, Buffer> };

// Lida sob demanda (src/lib/pii). Formato "id:base64,id:base64": a primeira chave cifra, todas decifram.
// As mensagens de erro nunca levam o valor da variável.
// Chave pública do .env.example (id `dev`): quem a conhece decifra os dados. Recusada em produção.
export const PII_DEV_KEY_EXAMPLE = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";

export function readPiiKeyring(env: Environment): PiiKeyring {
  const raw = required(env, "PII_ENCRYPTION_KEY");
  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(",")) {
    const [id, encoded, extra] = entry.trim().split(":");
    if (!id || !encoded || extra !== undefined || !PII_KEY_ID.test(id) || !BASE64.test(encoded)) {
      throw new Error("PII_ENCRYPTION_KEY must look like id:base64,id:base64");
    }
    const key = Buffer.from(encoded, "base64");
    if (key.length !== PII_KEY_BYTES) throw new Error(`PII_ENCRYPTION_KEY keys must have ${PII_KEY_BYTES} bytes`);
    if (keys.has(id)) throw new Error("PII_ENCRYPTION_KEY has a repeated key id");
    if (env.NODE_ENV === "production" && (id === "dev" || encoded === PII_DEV_KEY_EXAMPLE)) {
      throw new Error("PII_ENCRYPTION_KEY must not be the .env.example dev key");
    }
    keys.set(id, key);
  }
  return { activeKeyId: keys.keys().next().value as string, keys };
}

export type CardFeeBand = { maxInstallments: number; percent: number; fixedCents: number };
export type CardFeeConfig = { bands: CardFeeBand[]; minInstallmentCents: number };

const DEFAULT_MIN_INSTALLMENT_CENTS = 500;
const CARD_FEE_BAND = /^(\d+):(\d{1,3}(?:\.\d{1,2})?):(\d+)$/;
const CARD_FEE_FORMAT = "CARD_FEE_TABLE must look like maxInstallments:percent:fixedCents,...";

// Lida sob demanda. Tabela vazia = cartão desligado (null). Falha fechada: tabela inválida lança.
// Formato "maxParcelas:percent:fixoCentavos,..." (ex.: 1:2.99:49,6:3.49:49,12:3.99:49). Percentual com até 2 casas.
export function readCardFeeConfig(env: Environment): CardFeeConfig | null {
  const table = env.CARD_FEE_TABLE?.trim();
  if (!table) return null;

  const bands = table.split(",").map((entry): CardFeeBand => {
    const match = CARD_FEE_BAND.exec(entry.trim());
    if (!match) throw new Error(CARD_FEE_FORMAT);
    const band = { maxInstallments: Number(match[1]), percent: Number(match[2]), fixedCents: Number(match[3]) };
    if (band.maxInstallments < 1 || band.maxInstallments > MAX_CARD_INSTALLMENTS) {
      throw new Error(`CARD_FEE_TABLE installments must be between 1 and ${MAX_CARD_INSTALLMENTS}`);
    }
    if (band.percent >= 100) throw new Error("CARD_FEE_TABLE percent must be below 100");
    return band;
  });
  if (bands.some((band, i) => i > 0 && band.maxInstallments <= bands[i - 1].maxInstallments)) {
    throw new Error("CARD_FEE_TABLE bands must have increasing installments");
  }

  const minRaw = env.CARD_MIN_INSTALLMENT_CENTS?.trim();
  const minInstallmentCents = minRaw ? Number(minRaw) : DEFAULT_MIN_INSTALLMENT_CENTS;
  if (minRaw && !/^[1-9]\d*$/.test(minRaw)) throw new Error("CARD_MIN_INSTALLMENT_CENTS must be a positive integer");
  return { bands, minInstallmentCents };
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
// Em produção, "fake" e WHATSAPP_PHONE_NUMBER_ID vazio também desligam o canal (o docker-stack.yml entrega esses
// padrões quando o WhatsApp não foi configurado); fora dela, "fake" é permitido e o número vazio é erro.
// O webhook compara phoneNumberId nos dois drivers.
export function readWhatsappConfig(env: Environment): WhatsappConfig | null {
  const driver = env.WHATSAPP_DRIVER?.trim();
  if (!driver) return null;
  if (driver !== "meta" && driver !== "fake") throw new Error("WHATSAPP_DRIVER must be meta or fake");
  const isProduction = env.NODE_ENV === "production";
  if (isProduction && (driver === "fake" || !env.WHATSAPP_PHONE_NUMBER_ID?.trim())) return null;

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

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

// Lida sob demanda (fora de readConfig): só o worker de envio e a tela de inscrição precisam das chaves VAPID.
// Chave pública e contato vazios = push desligado: null. A chave privada vem de um Docker secret que o Swarm exige
// preenchido, então com o push desligado ela carrega um marcador e é ignorada. Config pela metade ou inválida falha
// em vez de enviar com chave errada.
export function readPushConfig(env: Environment): PushConfig | null {
  const names = ["WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY", "WEB_PUSH_VAPID_SUBJECT"] as const;
  if (!env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim() && !env.WEB_PUSH_VAPID_SUBJECT?.trim()) return null;

  const [publicKey, privateKey, subject] = names.map((name) => required(env, name));
  if (!/^[A-Za-z0-9_-]{87}$/.test(publicKey)) throw new Error("WEB_PUSH_VAPID_PUBLIC_KEY must be 87 base64url characters");
  if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey)) throw new Error("WEB_PUSH_VAPID_PRIVATE_KEY must be 43 base64url characters");
  if (!/^(mailto:|https:\/\/)\S+$/.test(subject)) throw new Error("WEB_PUSH_VAPID_SUBJECT must start with mailto: or https://");
  return { publicKey, privateKey, subject };
}

export const config = readConfig(hydrateSecretEnv(process.env));
