"use server";

import { revalidatePath } from "next/cache";

import type { SupabaseClient, User } from "@supabase/supabase-js";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getCurrentProfile } from "@/lib/auth";
import { sendMail } from "@/lib/email/mailer";
import { buildPortalInviteEmail } from "@/lib/email/portal-invite-email";
import { recordAudit } from "@/lib/audit";

const BUCKET = "opportunity-docs";
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB por arquivo

// Senha padrão de primeiro acesso ao portal. O cliente é OBRIGADO a trocá-la no
// primeiro login (flag must_change_password no metadata → middleware força
// /update-password). Mantida fixa para a equipe comunicar com facilidade.
const DEFAULT_CLIENT_PASSWORD = "Reinodocredito123@";

export interface ActionResult {
  error: string | null;
  id?: string;
}

function siteUrl(): string {
  return (
    process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ||
    "http://localhost:3000"
  );
}

// Procura um usuário do Auth pelo e-mail (paginado). Necessário porque o admin
// SDK não expõe busca direta por e-mail; usado para recuperar um login que já
// exista (ex.: convite anterior) sem duplicar.
async function findAuthUserByEmail(
  admin: SupabaseClient,
  email: string
): Promise<User | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error || !data) return null;
    const found = data.users.find((u) => u.email?.toLowerCase() === email);
    if (found) return found;
    if (data.users.length < 200) break;
  }
  return null;
}

// ── Convite ao Portal (staff) ─────────────────────────────────────────────
// Cria (ou recupera) o login do cliente (papel `client`) com a SENHA PADRÃO de
// primeiro acesso, vincula ao crm_client e envia o e-mail com as credenciais.
// O cliente é forçado a trocar a senha no primeiro login (must_change_password).
export async function inviteClientToPortal(
  crmClientId: string
): Promise<ActionResult> {
  const profile = await getCurrentProfile();
  if (!profile || !["admin", "consultant"].includes(profile.role)) {
    return { error: "Apenas a equipe pode conceder acesso ao portal." };
  }

  const admin = createAdminClient();

  const { data: clientRow } = await admin
    .from("crm_clients")
    .select("id, name, email, user_id")
    .eq("id", crmClientId)
    .maybeSingle();

  if (!clientRow) return { error: "Cliente não encontrado." };
  const client = clientRow as {
    id: string;
    name: string;
    email: string | null;
    user_id: string | null;
  };

  if (client.user_id) {
    return {
      error: "Este cliente já tem acesso ao portal. Revogue antes de reenviar.",
    };
  }

  const email = client.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { error: "Cadastre um e-mail válido no cliente antes de convidar." };
  }

  const metadata = {
    full_name: client.name,
    role: "client",
    must_change_password: true,
  };

  // Tenta criar o login já confirmado e com a senha padrão.
  let userId: string | null = null;
  const { data: created, error: createErr } =
    await admin.auth.admin.createUser({
      email,
      password: DEFAULT_CLIENT_PASSWORD,
      email_confirm: true,
      user_metadata: metadata,
    });

  if (created?.user) {
    userId = created.user.id;
  } else {
    // E-mail já existe no Auth (ex.: convite anterior). Recupera e reseta para a
    // senha padrão, reativa e remarca a troca obrigatória.
    const existing = await findAuthUserByEmail(admin, email);
    if (!existing) {
      return {
        error: createErr?.message ?? "Não foi possível criar o acesso.",
      };
    }
    userId = existing.id;
    const { error: updErr } = await admin.auth.admin.updateUserById(userId, {
      password: DEFAULT_CLIENT_PASSWORD,
      ban_duration: "none",
      user_metadata: metadata,
    });
    if (updErr) return { error: updErr.message };
  }

  // Garante papel/nome/ativo no profile (idempotente; o trigger já cria via metadata).
  await admin
    .from("profiles")
    .update({ role: "client", full_name: client.name, is_active: true })
    .eq("id", userId);

  // Vincula o login ao cliente do CRM (chave do RLS do portal).
  const { error: linkUpdateError } = await admin
    .from("crm_clients")
    .update({ user_id: userId })
    .eq("id", crmClientId);
  if (linkUpdateError) return { error: linkUpdateError.message };

  try {
    const mail = buildPortalInviteEmail({
      clientName: client.name,
      email,
      password: DEFAULT_CLIENT_PASSWORD,
      loginUrl: `${siteUrl()}/login`,
    });
    await sendMail({
      to: email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (err) {
    return {
      error:
        err instanceof Error
          ? `Acesso criado, mas o e-mail falhou: ${err.message}`
          : "Acesso criado, mas o e-mail falhou.",
    };
  }

  await recordAudit({
    action: "portal.invite",
    tableName: "crm_clients",
    recordId: crmClientId,
    data: { email },
  });

  revalidatePath(`/clients/${crmClientId}`);
  return { error: null, id: userId };
}

// ── Revogar acesso (staff) ────────────────────────────────────────────────
// Desvincula o login do cliente e bane o usuário no Auth (sem apagar histórico).
export async function revokeClientPortalAccess(
  crmClientId: string
): Promise<ActionResult> {
  const profile = await getCurrentProfile();
  if (!profile || !["admin", "consultant"].includes(profile.role)) {
    return { error: "Apenas a equipe pode revogar o acesso ao portal." };
  }

  const admin = createAdminClient();

  const { data: clientRow } = await admin
    .from("crm_clients")
    .select("id, user_id")
    .eq("id", crmClientId)
    .maybeSingle();
  if (!clientRow) return { error: "Cliente não encontrado." };
  const userId = (clientRow as { user_id: string | null }).user_id;
  if (!userId) return { error: "Este cliente não tem acesso ativo." };

  const { error: unlinkError } = await admin
    .from("crm_clients")
    .update({ user_id: null })
    .eq("id", crmClientId);
  if (unlinkError) return { error: unlinkError.message };

  // Bane o login (impede acesso) e marca o profile como inativo.
  await admin.auth.admin.updateUserById(userId, { ban_duration: "876000h" });
  await admin.from("profiles").update({ is_active: false }).eq("id", userId);

  await recordAudit({
    action: "portal.revoke",
    tableName: "crm_clients",
    recordId: crmClientId,
    data: { user_id: userId },
  });

  revalidatePath(`/clients/${crmClientId}`);
  return { error: null };
}

// ── Upload de documento pelo cliente (portal) ─────────────────────────────
// O binário sobe via service-role após validação de posse. Não há policy de
// storage para o cliente — toda a confiança é validada aqui no servidor.
async function ownedDoc(
  docId: string,
  userId: string
): Promise<
  | { error: string }
  | {
      error: null;
      doc: {
        id: string;
        opportunity_id: string;
        label: string;
        status: string;
        file_path: string | null;
      };
      crmClientId: string;
    }
> {
  const service = createServiceClient();
  const { data: docRow } = await service
    .from("opportunity_documents")
    .select("id, opportunity_id, label, status, file_path")
    .eq("id", docId)
    .maybeSingle();
  if (!docRow) return { error: "Documento não encontrado." };
  const doc = docRow as {
    id: string;
    opportunity_id: string;
    label: string;
    status: string;
    file_path: string | null;
  };

  const { data: oppRow } = await service
    .from("opportunities")
    .select("id, crm_client_id")
    .eq("id", doc.opportunity_id)
    .maybeSingle();
  if (!oppRow) return { error: "Oportunidade não encontrada." };
  const crmClientId = (oppRow as { crm_client_id: string }).crm_client_id;

  const { data: clientRow } = await service
    .from("crm_clients")
    .select("id, user_id")
    .eq("id", crmClientId)
    .maybeSingle();
  if (!clientRow || (clientRow as { user_id: string | null }).user_id !== userId) {
    return { error: "Você não tem acesso a este documento." };
  }

  return { error: null, doc, crmClientId };
}

export async function uploadPortalDocument(
  formData: FormData
): Promise<ActionResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sessão expirada." };

  const profile = await getCurrentProfile();
  if (profile?.role !== "client") {
    return { error: "Ação disponível apenas no portal do cliente." };
  }

  const docId = String(formData.get("docId") ?? "");
  const file = formData.get("file");
  if (!docId || !(file instanceof File) || file.size === 0) {
    return { error: "Selecione um arquivo válido." };
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return { error: "Arquivo muito grande (máximo 15 MB)." };
  }

  const owned = await ownedDoc(docId, user.id);
  if (owned.error !== null) return { error: owned.error };
  const { doc, crmClientId } = owned;

  if (doc.status === "approved") {
    return { error: "Este documento já foi aprovado e não pode ser alterado." };
  }

  const service = createServiceClient();
  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `${doc.opportunity_id}/${doc.id}-${safeName}`;
  const buffer = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await service.storage
    .from(BUCKET)
    .upload(path, buffer, {
      upsert: true,
      contentType: file.type || "application/octet-stream",
    });
  if (upErr) return { error: upErr.message };

  const { error: updErr } = await service
    .from("opportunity_documents")
    .update({
      status: "uploaded",
      file_name: file.name,
      file_path: path,
      file_size: file.size,
      file_mime: file.type || "application/octet-stream",
      uploaded_by: user.id,
      uploaded_at: new Date().toISOString(),
      rejection_reason: null,
    })
    .eq("id", doc.id);
  if (updErr) return { error: updErr.message };

  // Timeline da oportunidade (e espelho na do cliente) — autor é o cliente.
  await service.from("timeline_events").insert([
    {
      entity_type: "opportunity" as const,
      entity_id: doc.opportunity_id,
      event_type: "document.uploaded",
      title: `Documento enviado pelo cliente: ${doc.label}`,
      description: file.name,
      created_by: user.id,
    },
    {
      entity_type: "crm_client" as const,
      entity_id: crmClientId,
      event_type: "document.uploaded",
      title: `Documento enviado pelo cliente: ${doc.label}`,
      description: file.name,
      metadata: { opportunity_id: doc.opportunity_id },
      created_by: user.id,
    },
  ]);

  await recordAudit({
    action: "portal.document.upload",
    tableName: "opportunity_documents",
    recordId: doc.id,
    data: { opportunity_id: doc.opportunity_id, file_name: file.name },
  });

  revalidatePath(`/portal/oportunidades/${doc.opportunity_id}`);
  revalidatePath("/portal");
  return { error: null, id: doc.id };
}

// ── Download seguro pelo cliente ──────────────────────────────────────────
// Gera URL assinada SOMENTE se o documento pertencer ao cliente autenticado.
export interface SignedUrlResult {
  error: string | null;
  url?: string;
}

export async function getPortalDocUrl(docId: string): Promise<SignedUrlResult> {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sessão expirada." };

  const profile = await getCurrentProfile();
  if (profile?.role !== "client") {
    return { error: "Ação disponível apenas no portal do cliente." };
  }

  const owned = await ownedDoc(docId, user.id);
  if (owned.error !== null) return { error: owned.error };
  if (!owned.doc.file_path) return { error: "Documento ainda não enviado." };

  const service = createServiceClient();
  const { data, error } = await service.storage
    .from(BUCKET)
    .createSignedUrl(owned.doc.file_path, 60 * 10);
  if (error || !data) {
    return { error: error?.message ?? "Falha ao gerar o link." };
  }
  return { error: null, url: data.signedUrl };
}
