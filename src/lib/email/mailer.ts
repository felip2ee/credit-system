import "server-only";
import nodemailer from "nodemailer";

import { BRAND_NAME } from "@/lib/brand/brand";

// Envio de e-mail via SMTP (Hostinger). Credenciais só no .env.local (server).
// Nunca importar este módulo em código client-side.

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  // Message-ID próprio (ex.: <id@dominio>), para o log do provedor casar com a notificação.
  messageId?: string;
}

// Limite por etapa da conexão SMTP: um servidor mudo não pode prender o worker.
const SMTP_TIMEOUT_MS = 10_000;

function readConfig() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const port = Number(process.env.SMTP_PORT ?? "465");
  // 465 = SSL implícito; 587 = STARTTLS.
  const secure = process.env.SMTP_SECURE
    ? process.env.SMTP_SECURE === "true"
    : port === 465;
  const from = process.env.SMTP_FROM || `${BRAND_NAME} <${user}>`;
  return { host, port, secure, user, pass, from };
}

export function isMailConfigured(): boolean {
  return readConfig() !== null;
}

// Domínio do remetente (para o Message-ID). Sem domínio no SMTP_FROM, cai no host SMTP.
export function senderDomain(): string | null {
  const cfg = readConfig();
  if (!cfg) return null;
  const address = /<([^>]+)>/.exec(cfg.from)?.[1] ?? cfg.from;
  const domain = address.split("@")[1]?.trim();
  return domain || cfg.host;
}

export async function sendMail(input: SendMailInput): Promise<{ messageId: string }> {
  const cfg = readConfig();
  if (!cfg) {
    throw new Error(
      "Envio de e-mail não configurado (defina SMTP_HOST, SMTP_USER e SMTP_PASS em .env.local)."
    );
  }
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });
  const info = await transporter.sendMail({
    from: cfg.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    messageId: input.messageId,
  });
  return { messageId: info.messageId };
}
