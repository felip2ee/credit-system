import "server-only";
import nodemailer from "nodemailer";

// Envio de e-mail via SMTP (Hostinger). Credenciais só no .env.local (server).
// Nunca importar este módulo em código client-side.

export interface SendMailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

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
  const from = process.env.SMTP_FROM || `Rainha do Crédito <${user}>`;
  return { host, port, secure, user, pass, from };
}

export function isMailConfigured(): boolean {
  return readConfig() !== null;
}

export async function sendMail(input: SendMailInput): Promise<void> {
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
  });
  await transporter.sendMail({
    from: cfg.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
}
