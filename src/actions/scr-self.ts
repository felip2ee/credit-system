"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { getScrTermSettings } from "@/actions/settings";
import { getRequiredSession } from "@/lib/auth/session";
import { config } from "@/lib/config";
import { sendMail } from "@/lib/email/mailer";
import { buildScrAuthorizationEmail } from "@/lib/email/scr-authorization-email";
import { buildScrConsentTerm } from "@/lib/scr/consent-term";
import { confirmPublicScrAuthorization, getPublicScrAuthorization, issueSelfScrAuthorization, resolveScrContact, type PublicScrAuthorization } from "@/lib/scr/queries";
import { formatCNPJ, formatCPF, formatDate, isValidEmail } from "@/lib/utils";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function generateCode() {
  let code = "";
  for (let index = 0; index < 6; index += 1) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}
const siteUrl = () => config.betterAuthUrl.replace(/\/$/, "");

export interface SendSelfResult { error: string | null; }

export async function sendScrSelfAuthorization(scrId: string): Promise<SendSelfResult> {
  let session;
  try { session = await getRequiredSession(); } catch { return { error: "Sess\u00e3o expirada." }; }
  const identity = { userId: session.userId, role: session.role } as const;
  const scr = await resolveScrContact(identity, scrId);
  if (!scr) return { error: "Registro SCR n\u00e3o encontrado." };
  const email = scr.email?.trim() || scr.client_email?.trim() || null;
  if (!email || !isValidEmail(email)) return { error: "Titular sem e-mail v\u00e1lido \u2014 cadastre o e-mail antes de enviar." };
  const clientName = scr.name?.trim() || scr.client_name?.trim() || scr.document;
  const document = scr.type === "PJ" ? formatCNPJ(scr.document) : formatCPF(scr.document);
  const term = await getScrTermSettings();
  const consent = buildScrConsentTerm({ authorizedName: term.authorizedName, authorizedDocument: term.authorizedDocument || undefined, institutionName: term.institutionName, clientName, document, city: term.city, date: formatDate(new Date()) });
  const code = generateCode();
  const issued = await issueSelfScrAuthorization(identity, scrId, { code, email, consentText: consent.fullText, consentName: clientName, consentDocument: document });
  if (!issued) return { error: "Registro SCR n\u00e3o encontrado." };
  const mail = buildScrAuthorizationEmail({ clientName, authorizedName: term.authorizedName, code, url: `${siteUrl()}/autorizacao-scr/${issued.public_token}` });
  try { await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text }); }
  catch (error) { return { error: error instanceof Error ? `Falha ao enviar o e-mail: ${error.message}` : "Falha ao enviar o e-mail." }; }
  revalidatePath("/scr");
  return { error: null };
}

export type { PublicScrAuthorization };
export async function getScrSelfAuthorizationByToken(token: string): Promise<PublicScrAuthorization | null> { return getPublicScrAuthorization(token); }

export interface ConfirmResult { status: "authorized" | "refused" | "invalid_code" | "not_found" | "already"; message: string; }

export async function confirmScrSelfAuthorization(token: string, code: string, decision: "authorize" | "refuse"): Promise<ConfirmResult> {
  const provided = code.trim().toUpperCase().replace(/\s+/g, "");
  const requestHeaders = await headers();
  const ip = requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() || requestHeaders.get("x-real-ip") || null;
  const result = await confirmPublicScrAuthorization(token, provided, decision, ip);
  revalidatePath("/scr");
  const messages = { authorized: "Autoriza\u00e7\u00e3o concedida. Obrigado!", refused: "Autoriza\u00e7\u00e3o recusada.", invalid_code: "C\u00f3digo incorreto. Confira o e-mail.", not_found: "Autoriza\u00e7\u00e3o n\u00e3o encontrada.", already: "Esta autoriza\u00e7\u00e3o j\u00e1 foi respondida." };
  return { status: result.status, message: messages[result.status] };
}
