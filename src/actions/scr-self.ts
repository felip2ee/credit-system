"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { getScrTermSettings } from "@/actions/settings";
import { requestMeta } from "@/lib/account/request-meta";
import { getRequiredSession } from "@/lib/auth/session";
import { config } from "@/lib/config";
import { generateScrCode } from "@/lib/scr/code";
import { buildScrConsentTerm } from "@/lib/scr/consent-term";
import { confirmPublicScrAuthorization, getPublicScrAuthorization, issueSelfScrAuthorization, resolveScrContact, type PublicScrAuthorization } from "@/lib/scr/queries";
import { formatCNPJ, formatCPF, formatDate, isValidEmail } from "@/lib/utils";

const siteUrl = () => config.betterAuthUrl.replace(/\/$/, "");

const EMAIL_ERROR = "Titular sem e-mail v\u00e1lido \u2014 cadastre o e-mail antes de enviar.";
const ENQUEUE_ERROR = "N\u00e3o foi poss\u00edvel enfileirar o e-mail.";
const ISSUE_ERRORS: Record<string, string> = { not_found: "Registro SCR n\u00e3o encontrado.", invalid_recipient: EMAIL_ERROR };

export interface SendSelfResult { error: string | null; }

export async function sendScrSelfAuthorization(scrId: string): Promise<SendSelfResult> {
  let session;
  try { session = await getRequiredSession(); } catch { return { error: "Sess\u00e3o expirada." }; }
  const scr = await resolveScrContact(session, scrId);
  if (!scr) return { error: "Registro SCR n\u00e3o encontrado." };
  const email = scr.email?.trim() || scr.holder_email?.trim() || null;
  if (!email || !isValidEmail(email)) return { error: EMAIL_ERROR };
  const clientName = scr.name?.trim() || scr.holder_name?.trim() || scr.document;
  const document = scr.type === "PJ" ? formatCNPJ(scr.document) : formatCPF(scr.document);
  const term = await getScrTermSettings();
  const consent = buildScrConsentTerm({ authorizedName: term.authorizedName, authorizedDocument: term.authorizedDocument || undefined, institutionName: term.institutionName, clientName, document, city: term.city, date: formatDate(new Date()) });
  const code = generateScrCode();
  const issued = await issueSelfScrAuthorization(session, scrId, {
    code, email, consentText: consent.fullText, consentName: clientName, consentDocument: document,
    notification: { recipient: email, clientName: scr.name?.trim() || scr.holder_name?.trim() || "cliente", authorizedName: term.authorizedName, siteUrl: siteUrl(), phone: scr.phone_e164 },
  });
  if (!issued.ok) return { error: ISSUE_ERRORS[issued.reason] ?? ENQUEUE_ERROR };
  revalidatePath("/scr");
  return { error: null };
}

export type { PublicScrAuthorization };
export async function getScrSelfAuthorizationByToken(token: string): Promise<PublicScrAuthorization | null> { return getPublicScrAuthorization(token); }

export interface ConfirmResult { status: "authorized" | "refused" | "invalid_code" | "not_found" | "already" | "expired"; message: string; }

export async function confirmScrSelfAuthorization(token: string, code: string, decision: "authorize" | "refuse"): Promise<ConfirmResult> {
  const provided = code.trim().toUpperCase().replace(/\s+/g, "");
  const { ip } = requestMeta(await headers());
  const result = await confirmPublicScrAuthorization(token, provided, decision, ip);
  revalidatePath("/scr");
  const messages = { authorized: "Autoriza\u00e7\u00e3o concedida. Obrigado!", refused: "Autoriza\u00e7\u00e3o recusada.", invalid_code: "C\u00f3digo incorreto. Confira o e-mail.", not_found: "Autoriza\u00e7\u00e3o n\u00e3o encontrada.", already: "Esta autoriza\u00e7\u00e3o j\u00e1 foi respondida.", expired: "Este pedido de autoriza\u00e7\u00e3o expirou. Pe\u00e7a um novo a quem solicitou a pesquisa." };
  return { status: result.status, message: messages[result.status] };
}
