"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getDepsClient } from "@/lib/deps/client";
import { DepsScrPendingError } from "@/lib/deps/errors";
import { mapPfResult, mapPjResult, resultDisplayName } from "@/lib/deps/map";
import { depsProductName } from "@/lib/deps/products";
import { upsertScrAuthorization } from "@/lib/deps/scr-auth";
import { recordAudit } from "@/lib/audit";
import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";
import type { Database } from "@/types/supabase";
import type { DepsConsultResultPF, DepsConsultResultPJ } from "@/types/deps";
import type { EntityKind } from "@/types/app";

// Alias curto para o client server-side (ver clients.ts / server.ts).
function db(): SupabaseClient<Database> {
  return createClient();
}

async function currentUserId(): Promise<string | null> {
  const {
    data: { user },
  } = await createClient().auth.getUser();
  return user?.id ?? null;
}

export interface ClientPick {
  id: string;
  type: EntityKind;
  name: string;
  document: string | null;
  email: string | null;
}

export async function searchClients(term: string): Promise<ClientPick[]> {
  const supabase = db();
  const t = term.trim();
  let query = supabase
    .from("crm_clients")
    .select("id, type, name, document, email")
    .order("updated_at", { ascending: false })
    .limit(10);

  if (t.length > 0) {
    const docTerm = onlyDigits(t);
    const clauses = [`name.ilike.%${t}%`];
    if (docTerm.length > 0) clauses.push(`document.ilike.%${docTerm}%`);
    query = query.or(clauses.join(","));
  }

  const { data } = await query;
  return (data ?? []) as ClientPick[];
}

export interface RecentConsultationResult {
  exists: boolean;
  queryId?: string;
  consultedAt?: string;
}

// Verifica se há consulta concluída para este documento nos últimos N dias.
const RECENT_DAYS = 30;
export async function findRecentConsultation(
  document: string
): Promise<RecentConsultationResult> {
  const doc = onlyDigits(document);
  const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
  const supabase = db();
  const { data } = await supabase
    .from("queries")
    .select("id, consulted_at")
    .eq("document", doc)
    .eq("status", "completed")
    .gte("consulted_at", since)
    .order("consulted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return { exists: false };
  const row = data as { id: string; consulted_at: string };
  return { exists: true, queryId: row.id, consultedAt: row.consulted_at };
}

export interface RunConsultationInput {
  crmClientId: string;
  type: EntityKind;
  document: string;
  documentName: string;
  observations?: string;
  // E-mail do titular para a solicitação de autorização SCR (opcional). Quando
  // presente, a deps (re)envia o e-mail de autorização caso o SCR ainda não esteja aceito.
  email?: string | null;
  // Reaproveita dados existentes na deps (sem nova cobrança). Default true.
  reuseExisting?: boolean;
}

export interface RunConsultationResult {
  error: string | null;
  status?: "completed" | "pending_scr";
  queryId?: string;
  message?: string;
}

export async function runConsultation(
  input: RunConsultationInput
): Promise<RunConsultationResult> {
  const document = onlyDigits(input.document);
  const valid = input.type === "PF" ? isValidCPF(document) : isValidCNPJ(document);
  if (!valid) return { error: "Documento inválido." };

  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };
  const deps = getDepsClient();

  const product = depsProductName(input.type);
  const email = input.email?.trim() || null;

  // Cria a consulta e tenta executar direto. A própria deps decide: 200 = SCR
  // aceito (retorna dados) → conclui; 400 = SCR pendente → (re)envia o e-mail de
  // autorização e marcamos a consulta aguardando o aceite do titular (doc §4.2).
  const { data: inserted, error: insErr } = await supabase
    .from("queries")
    .insert({
      type: input.type,
      document,
      document_name: input.documentName,
      product,
      crm_client_id: input.crmClientId,
      created_by: userId,
      status: "processing",
      requires_auth: true,
      observations: input.observations ?? null,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    return { error: insErr?.message ?? "Falha ao criar a consulta." };
  }
  const queryId = (inserted as { id: string }).id;

  const consultOptions = {
    product,
    reuseExisting: input.reuseExisting,
    authorization: { name: input.documentName, email: email ?? undefined },
  };

  let result: DepsConsultResultPF | DepsConsultResultPJ;
  try {
    result =
      input.type === "PJ"
        ? await deps.consultPJ(document, consultOptions)
        : await deps.consultPF(document, consultOptions);
  } catch (err) {
    // ── SCR pendente: a deps já (re)enviou o e-mail; deixa a consulta aguardando ──
    if (err instanceof DepsScrPendingError) {
      await supabase
        .from("queries")
        .update({ status: "pending_authorization" })
        .eq("id", queryId);

      // Atualiza o registro SCR mais recente do documento ou cria um novo pendente.
      await upsertScrAuthorization(supabase, {
        document,
        type: input.type,
        status: "pending",
        name: input.documentName,
        email,
        queryId,
        crmClientId: input.crmClientId,
        requestedBy: userId,
      });

      // Persiste o e-mail no cadastro do cliente quando ainda não havia.
      if (email) {
        await supabase
          .from("crm_clients")
          .update({ email })
          .eq("id", input.crmClientId)
          .is("email", null);
      }

      await supabase.from("timeline_events").insert({
        entity_type: "crm_client",
        entity_id: input.crmClientId,
        event_type: "scr.requested",
        title: "Autorização SCR solicitada",
        description: `Documento ${document}`,
        created_by: userId,
      });

      revalidatePath("/consultations");
      revalidatePath("/scr");
      return {
        error: null,
        status: "pending_scr",
        queryId,
        message:
          "Autorização SCR pendente. Conceda a autorização no portal da deps e depois clique em Tentar novamente.",
      };
    }

    await supabase
      .from("queries")
      .update({
        status: "error",
        error_message: err instanceof Error ? err.message : "Erro na consulta.",
      })
      .eq("id", queryId);
    return { error: "Falha ao executar a consulta no bureau." };
  }

  // ── Sucesso (200): grava o resultado e conclui a consulta ──
  // query_results_* não têm política de escrita RLS → grava via service-role.
  const admin = createServiceClient();
  if (input.type === "PJ") {
    await admin
      .from("query_results_pj")
      .insert(mapPjResult(queryId, result as DepsConsultResultPJ));
  } else {
    await admin
      .from("query_results_pf")
      .insert(mapPfResult(queryId, result as DepsConsultResultPF));
  }
  // Nome real do bureau (PF: nome completo; PJ: razão social) vira o nome de exibição.
  const displayName = resultDisplayName(input.type, result) ?? input.documentName;
  await supabase
    .from("queries")
    .update({
      status: "completed",
      document_name: displayName,
      consulted_at: result.consultedAt,
      historico_consulta_id: result.historicoConsultaId,
      api_version: result.apiVersion,
      product_version: result.productVersion,
      is_partial: result.isPartial,
      share_link: result.shareLink,
    })
    .eq("id", queryId);

  // Registra o SCR como concedido (a consulta só retorna 200 com autorização vigente).
  await upsertScrAuthorization(supabase, {
    document,
    type: input.type,
    status: "authorized",
    name: displayName,
    queryId,
    crmClientId: input.crmClientId,
    requestedBy: userId,
  });

  await supabase.from("timeline_events").insert({
    entity_type: "crm_client",
    entity_id: input.crmClientId,
    event_type: "query.executed",
    title: "Consulta realizada",
    description: `${product} · ${document}`,
    created_by: userId,
  });

  await recordAudit({
    action: "bureau.consult",
    tableName: "queries",
    recordId: queryId,
    data: { document, type: input.type, product, document_name: displayName },
  });

  revalidatePath("/consultations");
  revalidatePath(`/clients/${input.crmClientId}`);
  return { error: null, status: "completed", queryId };
}

// Reexecuta uma consulta que falhou (botão "reprocessar").
export async function reprocessQuery(
  queryId: string
): Promise<RunConsultationResult> {
  const supabase = db();
  const { data: q } = await supabase
    .from("queries")
    .select("id, type, document")
    .eq("id", queryId)
    .maybeSingle();
  if (!q) return { error: "Consulta não encontrada." };
  const query = q as { id: string; type: EntityKind; document: string };
  const product = depsProductName(query.type);
  const deps = getDepsClient();

  await supabase
    .from("queries")
    .update({ status: "processing", error_message: null })
    .eq("id", queryId);

  // query_results_* não têm política de escrita RLS → grava via service-role.
  const admin = createServiceClient();
  try {
    if (query.type === "PJ") {
      const r = await deps.consultPJ(query.document, { product });
      await admin.from("query_results_pj").delete().eq("query_id", queryId);
      await admin.from("query_results_pj").insert(mapPjResult(queryId, r));
      await supabase
        .from("queries")
        .update({
          status: "completed",
          document_name: resultDisplayName("PJ", r) ?? undefined,
          consulted_at: r.consultedAt,
          historico_consulta_id: r.historicoConsultaId,
          api_version: r.apiVersion,
          product_version: r.productVersion,
          is_partial: r.isPartial,
          share_link: r.shareLink,
        })
        .eq("id", queryId);
    } else {
      const r = await deps.consultPF(query.document, { product });
      await admin.from("query_results_pf").delete().eq("query_id", queryId);
      await admin.from("query_results_pf").insert(mapPfResult(queryId, r));
      await supabase
        .from("queries")
        .update({
          status: "completed",
          document_name: resultDisplayName("PF", r) ?? undefined,
          consulted_at: r.consultedAt,
          historico_consulta_id: r.historicoConsultaId,
          api_version: r.apiVersion,
          product_version: r.productVersion,
          is_partial: r.isPartial,
          share_link: r.shareLink,
        })
        .eq("id", queryId);
    }
  } catch (err) {
    await supabase
      .from("queries")
      .update({
        status: "error",
        error_message: err instanceof Error ? err.message : "Erro na consulta.",
      })
      .eq("id", queryId);
    return { error: "Falha ao reprocessar a consulta." };
  }

  await recordAudit({
    action: "bureau.consult",
    tableName: "queries",
    recordId: queryId,
    data: { document: query.document, type: query.type, product, reprocessed: true },
  });

  revalidatePath("/consultations");
  revalidatePath(`/consultations/${queryId}`);
  return { error: null, status: "completed", queryId };
}
