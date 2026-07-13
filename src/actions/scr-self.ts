"use server";

import { randomUUID } from "crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getScrTermSettings } from "@/actions/settings";
import { sendMail } from "@/lib/email/mailer";
import { buildScrAuthorizationEmail } from "@/lib/email/scr-authorization-email";
import { buildScrConsentTerm } from "@/lib/scr/consent-term";
import { recordAudit } from "@/lib/audit";
import { formatCNPJ, formatCPF, formatDate, isValidEmail } from "@/lib/utils";
import type { EntityKind, ScrStatus } from "@/types/app";

const SCR_SELF_VALIDITY_DAYS = 365;

// Alfabeto sem caracteres ambíguos (0/O, 1/I) — código de 6 posições.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
    "http://localhost:3000"
  );
}

export interface SendSelfResult {
  error: string | null;
}

// Dispara a autorização SCR pelo canal interno: gera código + token, monta o
// termo (snapshot), persiste e envia o e-mail com o link da página pública.
export async function sendScrSelfAuthorization(
  scrId: string
): Promise<SendSelfResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sessão expirada." };

  const { data: row } = await supabase
    .from("scr_authorizations")
    .select("id, document, type, name, email, crm_client_id")
    .eq("id", scrId)
    .maybeSingle();
  if (!row) return { error: "Registro SCR não encontrado." };
  const scr = row as {
    id: string;
    document: string;
    type: EntityKind;
    name: string | null;
    email: string | null;
    crm_client_id: string | null;
  };

  // Resolve nome e e-mail do titular (linha SCR ou cadastro do cliente).
  let name = scr.name?.trim() || null;
  let email = scr.email?.trim() || null;
  if ((!name || !email) && scr.crm_client_id) {
    const { data: client } = await supabase
      .from("crm_clients")
      .select("name, email")
      .eq("id", scr.crm_client_id)
      .maybeSingle();
    const c = client as { name: string | null; email: string | null } | null;
    name = name || c?.name?.trim() || null;
    email = email || c?.email?.trim() || null;
  }
  if (!email || !isValidEmail(email)) {
    return { error: "Titular sem e-mail válido — cadastre o e-mail antes de enviar." };
  }
  const clientName = name || scr.document;
  const docFormatted =
    scr.type === "PJ" ? formatCNPJ(scr.document) : formatCPF(scr.document);

  const term = await getScrTermSettings();
  const consent = buildScrConsentTerm({
    authorizedName: term.authorizedName,
    authorizedDocument: term.authorizedDocument || undefined,
    institutionName: term.institutionName,
    clientName,
    document: docFormatted,
    city: term.city,
    date: formatDate(new Date()),
  });

  const code = generateCode();
  const token = randomUUID();
  const url = `${siteUrl()}/autorizacao-scr/${token}`;

  // Envia o e-mail primeiro: se falhar, não altera o registro (evita estado órfão).
  const mail = buildScrAuthorizationEmail({
    clientName,
    authorizedName: term.authorizedName,
    code,
    url,
  });
  try {
    await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? `Falha ao enviar o e-mail: ${err.message}`
          : "Falha ao enviar o e-mail.",
    };
  }

  const { error: upErr } = await supabase
    .from("scr_authorizations")
    .update({
      channel: "internal",
      auth_code: code,
      public_token: token,
      consent_text: consent.fullText,
      consent_name: clientName,
      consent_document: docFormatted,
      email,
      status: "pending",
      requested_at: new Date().toISOString(),
      requested_by: user.id,
      last_checked_at: new Date().toISOString(),
      authorized_at: null,
      consented_at: null,
      refused_at: null,
    })
    .eq("id", scrId);
  if (upErr) return { error: upErr.message };

  if (scr.crm_client_id) {
    await supabase.from("timeline_events").insert({
      entity_type: "crm_client",
      entity_id: scr.crm_client_id,
      event_type: "scr.self_requested",
      title: "Autorização SCR enviada por e-mail",
      description: `Código enviado para ${email}`,
      created_by: user.id,
    });
  }

  await recordAudit({
    action: "scr.self_request",
    tableName: "scr_authorizations",
    recordId: scrId,
    data: { document: scr.document, type: scr.type, email },
  });

  revalidatePath("/scr");
  return { error: null };
}

// ── Página pública ─────────────────────────────────────────────────────────

export interface PublicScrAuthorization {
  status: ScrStatus;
  type: EntityKind;
  consentText: string;
  clientName: string;
  document: string;
  expiresAt: string | null;
}

// Lê a autorização pelo token público (sem sessão → service client).
export async function getScrSelfAuthorizationByToken(
  token: string
): Promise<PublicScrAuthorization | null> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("scr_authorizations")
    .select(
      "status, type, channel, consent_text, consent_name, consent_document, document, expires_at"
    )
    .eq("public_token", token)
    .eq("channel", "internal")
    .maybeSingle();
  if (!data) return null;
  const row = data as {
    status: ScrStatus;
    type: EntityKind;
    consent_text: string | null;
    consent_name: string | null;
    consent_document: string | null;
    document: string;
    expires_at: string | null;
  };
  return {
    status: row.status,
    type: row.type,
    consentText: row.consent_text ?? "",
    clientName: row.consent_name ?? "",
    document: row.consent_document ?? row.document,
    expiresAt: row.expires_at,
  };
}

export interface ConfirmResult {
  status: "authorized" | "refused" | "invalid_code" | "not_found" | "already";
  message: string;
}

// Confirma (ou recusa) a autorização SCR pelo token + código. Pública.
export async function confirmScrSelfAuthorization(
  token: string,
  code: string,
  decision: "authorize" | "refuse"
): Promise<ConfirmResult> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("scr_authorizations")
    .select("id, auth_code, status, crm_client_id, document")
    .eq("public_token", token)
    .eq("channel", "internal")
    .maybeSingle();
  if (!data) {
    return { status: "not_found", message: "Autorização não encontrada." };
  }
  const row = data as {
    id: string;
    auth_code: string | null;
    status: ScrStatus;
    crm_client_id: string | null;
    document: string;
  };

  if (row.status === "authorized") {
    return { status: "already", message: "Esta autorização já foi concedida." };
  }

  const now = new Date().toISOString();

  if (decision === "refuse") {
    await admin
      .from("scr_authorizations")
      .update({ status: "not_authorized", refused_at: now, last_checked_at: now })
      .eq("id", row.id);
    if (row.crm_client_id) {
      await admin.from("timeline_events").insert({
        entity_type: "crm_client",
        entity_id: row.crm_client_id,
        event_type: "scr.self_refused",
        title: "Autorização SCR recusada pelo titular",
      });
    }
    revalidatePath("/scr");
    return { status: "refused", message: "Autorização recusada." };
  }

  // Autorizar: valida o código (ignora caixa e espaços).
  const provided = code.trim().toUpperCase().replace(/\s+/g, "");
  if (!row.auth_code || provided !== row.auth_code.toUpperCase()) {
    return { status: "invalid_code", message: "Código incorreto. Confira o e-mail." };
  }

  const ip =
    headers().get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers().get("x-real-ip") ||
    null;
  const expiresAt = new Date(
    Date.now() + SCR_SELF_VALIDITY_DAYS * 86400000
  ).toISOString();

  await admin
    .from("scr_authorizations")
    .update({
      status: "authorized",
      authorized_at: now,
      consented_at: now,
      consent_ip: ip,
      expires_at: expiresAt,
      last_checked_at: now,
    })
    .eq("id", row.id);

  if (row.crm_client_id) {
    await admin.from("timeline_events").insert({
      entity_type: "crm_client",
      entity_id: row.crm_client_id,
      event_type: "scr.self_authorized",
      title: "Autorização SCR concedida pelo titular",
      description: `Válida por ${SCR_SELF_VALIDITY_DAYS} dias`,
    });
  }

  revalidatePath("/scr");
  return {
    status: "authorized",
    message: "Autorização concedida. Obrigado!",
  };
}
