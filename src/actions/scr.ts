"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { getDepsClient } from "@/lib/deps/client";
import { executeConsultation } from "@/lib/consultations/service";
import { depsProductName } from "@/lib/deps/products";
import { refreshBatchCounters } from "@/actions/company";
import { recordAudit } from "@/lib/audit";
import { onlyDigits } from "@/lib/utils";
import type { Database } from "@/types/supabase";
import type { EntityKind, ScrStatus } from "@/types/app";

function db(): SupabaseClient<Database> {
  return createClient();
}

async function currentUserId(): Promise<string | null> {
  const {
    data: { user },
  } = await createClient().auth.getUser();
  return user?.id ?? null;
}

const SCR_VALIDITY_DAYS = 90;

export interface VerifyScrResult {
  status: ScrStatus;
  queryId?: string;
  message: string;
}

// Verifica o SCR conforme o doc oficial da deps (§4.2): NÃO há endpoint de
// status. A única forma é tentar a consulta — HTTP 200 = autorizado, HTTP 400 =
// ainda pendente. Usamos `reuseExisting: true` para reaproveitar dados já
// existentes na deps (sem nova cobrança). Em caso de sucesso, já gravamos o
// resultado e concluímos a consulta vinculada.
export async function verifyScr(
  scrId: string,
  document: string
): Promise<VerifyScrResult> {
  const supabase = db();
  const { data: row } = await supabase
    .from("scr_authorizations")
    .select("type, name, email, query_id, crm_client_id")
    .eq("id", scrId)
    .maybeSingle();
  if (!row) {
    return { status: "not_authorized", message: "Registro SCR não encontrado." };
  }
  const scr = row as {
    type: EntityKind;
    name: string | null;
    email: string | null;
    query_id: string | null;
    crm_client_id: string | null;
  };

  const deps = getDepsClient();
  const doc = onlyDigits(document);
  const product = depsProductName(scr.type);

  // Honra o modo de autorização SCR da consulta vinculada (default internal).
  // deps → autorizacaoScr=false (a deps checa a própria autorização); internal →
  // true (autogestão). Sem query vinculada, mantém o default internal.
  let autorizacaoScr = true;
  if (scr.query_id) {
    const { data: qm } = await supabase
      .from("queries")
      .select("scr_mode")
      .eq("id", scr.query_id)
      .maybeSingle();
    autorizacaoScr = (qm as { scr_mode: string | null } | null)?.scr_mode !== "deps";
  }

  // E-mail do titular: usa o da linha SCR ou, na falta, o do cadastro do cliente.
  let email = scr.email?.trim() || null;
  if (!email && scr.crm_client_id) {
    const { data: client } = await supabase
      .from("crm_clients")
      .select("email")
      .eq("id", scr.crm_client_id)
      .maybeSingle();
    email = (client as { email: string | null } | null)?.email?.trim() || null;
  }

  // Marca pendente. A autorização SCR é concedida pelo operador no portal da deps;
  // aqui apenas reverificamos. Persiste o e-mail resolvido na linha SCR.
  const stayPending = async (): Promise<VerifyScrResult> => {
    await supabase
      .from("scr_authorizations")
      .update({
        status: "pending",
        last_checked_at: new Date().toISOString(),
        ...(email ? { email } : {}),
      })
      .eq("id", scrId);
    revalidatePath("/scr");
    return {
      status: "pending",
      message:
        "Autorização SCR ainda pendente. Conceda a autorização no portal da deps e clique em Tentar novamente.",
    };
  };

  // Tenta a consulta reaproveitando dados existentes (sem nova cobrança) e, com
  // e-mail, embute a solicitação SCR. Não-autorizado / sem dados retorna 400 →
  // tratado como pendente (e o e-mail é reenviado pela deps).
  const opts = {
    product,
    reuseExisting: true,
    authorization: { name: scr.name ?? undefined, email: email ?? undefined },
    autorizacaoScr,
  };
  let result;
  try {
    result =
      scr.type === "PJ"
        ? await deps.consultPJ(doc, opts)
        : await deps.consultPF(doc, opts);
  } catch {
    return stayPending();
  }

  // Sem consulta vinculada não há o que persistir; mantém pendente.
  if (!scr.query_id) {
    return stayPending();
  }
  const queryId = scr.query_id;

  const userId = await currentUserId();
  if (!userId) return { status: "pending", message: "Sessão expirada." };

  // Persistência atômica: payload bruto + adapter versionado + resultado
  // canônico/status numa única transação. 200 sem os blocos essenciais
  // (identidade) → payload_incompatible, não "concluída" em branco.
  const outcome = await executeConsultation({
    identity: { userId, role: "consultant" },
    consultationId: queryId,
    entityKind: scr.type,
    consult: async () => result,
  });
  if (outcome.status === "payload_incompatible") {
    await supabase
      .from("queries")
      .update({ status: "payload_incompatible" })
      .eq("id", queryId);
    return {
      status: "pending",
      message:
        "A consulta retornou sem os dados essenciais. Verifique a autorização e tente novamente.",
    };
  }

  // Sucesso → autorização confirmada.
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SCR_VALIDITY_DAYS * 86400000).toISOString();
  await supabase
    .from("scr_authorizations")
    .update({
      status: "authorized",
      authorized_at: now,
      expires_at: expiresAt,
      last_checked_at: now,
    })
    .eq("id", scrId);

  if (scr.crm_client_id) {
    await supabase.from("timeline_events").insert({
      entity_type: "crm_client",
      entity_id: scr.crm_client_id,
      event_type: "scr.authorized",
      title: "Autorização SCR confirmada",
      description: `Documento ${doc}`,
    });
  }

  await recordAudit({
    action: "bureau.consult",
    tableName: "queries",
    recordId: queryId,
    data: { document: doc, type: scr.type, product, via: "scr_verify" },
  });

  // Se a consulta pertence a um processo de empresa, recalcula o batch.
  const { data: qb } = await supabase
    .from("queries")
    .select("batch_id")
    .eq("id", queryId)
    .maybeSingle();
  const batchId = (qb as { batch_id: string | null } | null)?.batch_id ?? null;
  if (batchId) {
    await refreshBatchCounters(batchId);
    revalidatePath(`/batch/${batchId}`);
    revalidatePath("/batch");
  }

  revalidatePath("/scr");
  revalidatePath("/consultations");
  if (scr.crm_client_id) revalidatePath(`/clients/${scr.crm_client_id}`);
  return {
    status: "authorized",
    queryId: scr.query_id,
    message: "Autorização confirmada — consulta concluída.",
  };
}

// "Tentar novamente" na tela da consulta: localiza a autorização SCR vinculada
// à query e roda a mesma verificação (tenta a consulta; 200 = conclui, 400 =
// reenvia e-mail). Retorna o mesmo resultado de verifyScr.
export async function retryScrByQuery(queryId: string): Promise<VerifyScrResult> {
  const { data } = await db()
    .from("scr_authorizations")
    .select("id, document")
    .eq("query_id", queryId)
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) {
    return {
      status: "not_authorized",
      message: "Nenhuma autorização SCR vinculada a esta consulta.",
    };
  }
  const row = data as { id: string; document: string };
  return verifyScr(row.id, row.document);
}

// Reenvia o e-mail de autorização SCR pela deps.
export async function resendScr(
  scrId: string,
  document: string,
  type: EntityKind,
  name: string | null,
  email: string | null
): Promise<{ ok: boolean }> {
  const deps = getDepsClient();
  await deps.requestScrAuthorization({
    document,
    type,
    name: name ?? undefined,
    email: email ?? undefined,
  });
  await db()
    .from("scr_authorizations")
    .update({
      status: "pending",
      requested_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
    })
    .eq("id", scrId);
  revalidatePath("/scr");
  return { ok: true };
}
