"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import { getDepsClient } from "@/lib/deps/client";
import { DepsScrPendingError } from "@/lib/deps/errors";
import { executeConsultation } from "@/lib/consultations/service";
import { depsProductName } from "@/lib/deps/products";
import { hasValidInternalScr, upsertScrAuthorization } from "@/lib/deps/scr-auth";
import { getRequiredSession } from "@/lib/auth/session";
import { recordAudit } from "@/lib/audit";
import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";
import type { Database } from "@/types/supabase";
import type { DepsRawConsult } from "@/types/deps";
import type { DbIdentity } from "@/lib/db/transaction";
import type { EntityKind } from "@/types/app";

// Alias curto para o client server-side (ver clients.ts / server.ts).
function db(): SupabaseClient<Database> {
  return createClient();
}

// Identidade (userId + role) para as transações user-scoped do Postgres.
async function currentIdentity(): Promise<DbIdentity | null> {
  try {
    const s = await getRequiredSession();
    return { userId: s.userId, role: s.role };
  } catch {
    return null;
  }
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

// Modo de autorização SCR da consulta:
//   internal → NÓS gerimos a autorização (termo + código por e-mail). A consulta
//              só é disparada se houver autorização vigente no nosso BD; envia
//              `autorizacaoScr=true` (a deps cadastra no momento da consulta).
//   deps     → ignora nosso BD e tenta a consulta com `autorizacaoScr=false`; a
//              deps só devolve dados se já houver autorização registrada nela.
export type ScrMode = "internal" | "deps";

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
  // Como a autorização SCR é gerida nesta consulta. Default "internal".
  scrMode?: ScrMode;
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
  const identity = await currentIdentity();
  if (!identity) return { error: "Sessão expirada." };
  const userId = identity.userId;
  const deps = getDepsClient();

  const product = depsProductName(input.type);
  const email = input.email?.trim() || null;
  const scrMode: ScrMode = input.scrMode ?? "internal";

  // ── Opção A (internal): só consulta se HÁ autorização vigente no nosso BD ──
  // Sem autorização própria, não dispara a deps: registra/renova a pendência em
  // scr_authorizations e orienta o operador a enviar o termo (aba Autorizações SCR).
  if (scrMode === "internal" && !(await hasValidInternalScr(supabase, document))) {
    await upsertScrAuthorization(supabase, {
      document,
      type: input.type,
      status: "pending",
      name: input.documentName,
      email,
      crmClientId: input.crmClientId,
      requestedBy: userId,
    });
    if (email) {
      await supabase
        .from("crm_clients")
        .update({ email })
        .eq("id", input.crmClientId)
        .is("email", null);
    }
    revalidatePath("/scr");
    return {
      error: null,
      status: "pending_scr",
      message:
        "Sem autorização SCR própria vigente para este documento. Envie o termo de autorização (e-mail + código) ao titular em Autorizações SCR; quando ele confirmar, repita a consulta.",
    };
  }

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
      scr_mode: scrMode,
    })
    .select("id")
    .single();
  if (insErr || !inserted) {
    return { error: insErr?.message ?? "Falha ao criar a consulta." };
  }
  const queryId = (inserted as { id: string }).id;

  // Deixa a consulta aguardando autorização SCR: marca a query pendente, registra
  // a pendência SCR, persiste o e-mail e loga na timeline. Reutilizado no 400 da
  // deps e quando a deps devolve 200 sem dados mapeáveis (mix vazio).
  const markPending = async (): Promise<RunConsultationResult> => {
    await supabase
      .from("queries")
      .update({ status: "pending_authorization" })
      .eq("id", queryId);

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
        scrMode === "deps"
          ? "A deps não possui autorização SCR registrada para este documento. Solicite a autorização pela deps (o titular receberá o e-mail) em Autorizações SCR e reprocesse a consulta."
          : "Consulta sem dados/SCR pendente. Envie a autorização SCR (termo + código) ao titular em Autorizações SCR e reprocesse a consulta.",
    };
  };

  const consultOptions = {
    product,
    reuseExisting: input.reuseExisting,
    authorization: { name: input.documentName, email: email ?? undefined },
    // internal → true (autogestão, deps cadastra na hora); deps → false (deps
    // verifica a própria autorização e devolve 400 se não houver).
    autorizacaoScr: scrMode === "internal",
  };

  let result: DepsRawConsult;
  try {
    result =
      input.type === "PJ"
        ? await deps.consultPJ(document, consultOptions)
        : await deps.consultPF(document, consultOptions);
  } catch (err) {
    // ── SCR pendente (400): a deps já (re)enviou o e-mail; deixa aguardando ──
    if (err instanceof DepsScrPendingError) {
      return markPending();
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

  // Persistência atômica: guarda o payload bruto (evidência imutável), roda o
  // adapter versionado e grava o resultado canônico + status numa única
  // transação user-scoped.
  const outcome = await executeConsultation({
    identity,
    consultationId: queryId,
    entityKind: input.type,
    consult: async () => result,
  });

  // 200 sem bloco de identidade = documento sem dados / SCR ainda não aceito.
  // Recuperável: mesmo caminho do 400 (payload já foi guardado como evidência).
  if (outcome.status === "no_data") {
    return markPending();
  }

  if (outcome.status === "payload_incompatible") {
    // Resposta com dados reais que não bateram com o formato canônico.
    await supabase
      .from("queries")
      .update({ status: "payload_incompatible" })
      .eq("id", queryId);
    return {
      error:
        "A consulta retornou dados incompatíveis com o formato esperado do bureau.",
    };
  }

  // Nome real do bureau (canônico) vira o nome de exibição.
  const displayName = outcome.canonical.subject.name || input.documentName;

  // Dual-write para a tabela legada `queries` (a UI ainda lê dela; some no
  // Task 9/11). O resultado canônico já foi persistido em `consultations`.
  await supabase
    .from("queries")
    .update({
      status: "completed",
      document_name: displayName,
      consulted_at: outcome.canonical.provider.consultedAt,
      historico_consulta_id: outcome.canonical.provider.consultationId,
      api_version: outcome.canonical.provider.apiVersion,
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
    .select("id, type, document, scr_mode")
    .eq("id", queryId)
    .maybeSingle();
  if (!q) return { error: "Consulta não encontrada." };
  const query = q as {
    id: string;
    type: EntityKind;
    document: string;
    scr_mode: string | null;
  };
  const product = depsProductName(query.type);
  // Honra o modo escolhido na consulta original (default internal).
  const autorizacaoScr = query.scr_mode !== "deps";
  const deps = getDepsClient();

  const identity = await currentIdentity();
  if (!identity) return { error: "Sessão expirada." };

  await supabase
    .from("queries")
    .update({ status: "processing", error_message: null })
    .eq("id", queryId);

  try {
    const raw =
      query.type === "PJ"
        ? await deps.consultPJ(query.document, { product, autorizacaoScr })
        : await deps.consultPF(query.document, { product, autorizacaoScr });

    const outcome = await executeConsultation({
      identity,
      consultationId: queryId,
      entityKind: query.type,
      consult: async () => raw,
    });

    if (outcome.status === "no_data") {
      await supabase
        .from("queries")
        .update({ status: "pending_authorization" })
        .eq("id", queryId);
      return {
        error: null,
        status: "pending_scr",
        queryId,
        message:
          "Consulta sem dados/SCR pendente. Verifique a autorização e tente novamente.",
      };
    }

    if (outcome.status === "payload_incompatible") {
      await supabase
        .from("queries")
        .update({ status: "payload_incompatible" })
        .eq("id", queryId);
      return {
        error:
          "A consulta retornou dados incompatíveis com o formato esperado do bureau.",
      };
    }

    // Dual-write para a tabela legada `queries` (some no Task 9/11).
    await supabase
      .from("queries")
      .update({
        status: "completed",
        document_name: outcome.canonical.subject.name || undefined,
        consulted_at: outcome.canonical.provider.consultedAt,
        historico_consulta_id: outcome.canonical.provider.consultationId,
        api_version: outcome.canonical.provider.apiVersion,
      })
      .eq("id", queryId);
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
