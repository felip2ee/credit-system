"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getDepsClient } from "@/lib/deps/client";
import { DepsScrPendingError } from "@/lib/deps/errors";
import { mapPfResult, mapPjResult, resultDisplayName } from "@/lib/deps/map";
import { DEPS_PRODUCT_PJ, depsProductName } from "@/lib/deps/products";
import { upsertScrAuthorization } from "@/lib/deps/scr-auth";
import { generateCompanyParecer } from "@/lib/ai/opinion";
import { recordAudit } from "@/lib/audit";
import { COMPANY_PROMPT_VERSION } from "@/lib/ai/prompt";
import { getAiPrompt } from "@/actions/settings";
import { toAptitudeStatus } from "@/types/ai";
import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";
import type { Database, Json } from "@/types/supabase";
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

const json = (v: unknown): Json => v as Json;

type Deps = ReturnType<typeof getDepsClient>;
type MemberOutcome = "completed" | "pending" | "error";

// Recalcula os contadores/status do processo a partir das consultas-membro.
// Fonte da verdade: a tabela `queries` (que muda quando um SCR pendente é
// resolvido depois, via verifyScr). Mantém o batch sempre coerente.
export async function refreshBatchCounters(batchId: string): Promise<void> {
  const supabase = db();
  const { data: b } = await supabase
    .from("batches")
    .select("total_items")
    .eq("id", batchId)
    .maybeSingle();
  if (!b) return;
  const totalItems = (b as { total_items: number }).total_items;

  const { data } = await supabase
    .from("queries")
    .select("status")
    .eq("batch_id", batchId);
  const rows = (data ?? []) as { status: string }[];
  const success = rows.filter((r) => r.status === "completed").length;
  const errors = rows.filter((r) => r.status === "error").length;
  const total = Math.max(totalItems, rows.length);
  const resolved = success + errors;
  const done = resolved >= total;
  const status = errors > 0 ? "completed_with_errors" : done ? "completed" : "processing";

  await supabase
    .from("batches")
    .update({
      success_items: success,
      error_items: errors,
      processed_items: resolved,
      status,
      completed_at: done ? new Date().toISOString() : null,
    })
    .eq("id", batchId);
}

// ─────────────────────────────────────────────────────────────────────────
// Roda a consulta de uma query JÁ existente (status 'processing') e grava o
// resultado. Espelha o fluxo unificado de `runConsultation`, vinculado ao batch
// e sem crm_client. 200 → conclui; DepsScrPendingError (400) → pendente; erro → erro.
// ─────────────────────────────────────────────────────────────────────────
async function consultExistingMember(args: {
  supabase: SupabaseClient<Database>;
  admin: SupabaseClient<Database>;
  deps: Deps;
  userId: string;
  queryId: string;
  type: EntityKind;
  document: string;
  documentName: string;
  email: string | null;
  reuseExisting?: boolean;
}): Promise<MemberOutcome> {
  const { supabase, admin, deps, userId, queryId, type, document, documentName, email } = args;
  const product = depsProductName(type);

  const consultOptions = {
    product,
    reuseExisting: args.reuseExisting,
    authorization: { name: documentName, email: email ?? undefined },
  };

  let result: DepsConsultResultPF | DepsConsultResultPJ;
  try {
    result =
      type === "PJ"
        ? await deps.consultPJ(document, consultOptions)
        : await deps.consultPF(document, consultOptions);
  } catch (err) {
    if (err instanceof DepsScrPendingError) {
      await supabase
        .from("queries")
        .update({ status: "pending_authorization" })
        .eq("id", queryId);

      // Registro de pendência SCR (atualiza o mais recente do documento ou cria).
      await upsertScrAuthorization(supabase, {
        document,
        type,
        status: "pending",
        name: documentName,
        email,
        queryId,
        requestedBy: userId,
      });
      return "pending";
    }

    await supabase
      .from("queries")
      .update({
        status: "error",
        error_message: err instanceof Error ? err.message : "Erro na consulta.",
      })
      .eq("id", queryId);
    return "error";
  }

  // Sucesso (200) → grava resultado (service-role) e conclui.
  if (type === "PJ") {
    await admin
      .from("query_results_pj")
      .insert(mapPjResult(queryId, result as DepsConsultResultPJ));
  } else {
    await admin
      .from("query_results_pf")
      .insert(mapPfResult(queryId, result as DepsConsultResultPF));
  }
  // Nome real do bureau (PF: nome completo; PJ: razão social) vira o nome de exibição.
  const displayName = resultDisplayName(type, result) ?? documentName;
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

  await upsertScrAuthorization(supabase, {
    document,
    type,
    status: "authorized",
    name: displayName,
    queryId,
    requestedBy: userId,
  });

  await recordAudit({
    action: "bureau.consult",
    tableName: "queries",
    recordId: queryId,
    data: { document, type, product, via: "company_process" },
  });

  return "completed";
}

export interface CompanyProcessSocioInput {
  cpf: string;
  name?: string;
  email?: string | null;
}

export interface CreateCompanyProcessInput {
  cnpj: string;
  name?: string;
  email?: string | null;
  socios: CompanyProcessSocioInput[];
  reuseExisting?: boolean;
}

export interface CreateCompanyProcessResult {
  error: string | null;
  batchId?: string;
  // Ids das consultas enfileiradas (status 'processing'); o cliente dispara uma
  // a uma. O e-mail do titular já fica gravado em queries.scr_email.
  memberQueryIds?: string[];
}

// Cria o processo e ENFILEIRA as consultas (CNPJ + sócios) como queries
// 'processing', SEM consultar a deps aqui. O processamento real acontece em
// `processCompanyMember` (uma consulta por requisição), dirigido pelo cliente —
// assim nenhuma requisição roda N chamadas à deps em série (evita timeout).
export async function createCompanyProcess(
  input: CreateCompanyProcessInput
): Promise<CreateCompanyProcessResult> {
  const cnpj = onlyDigits(input.cnpj);
  if (!isValidCNPJ(cnpj)) return { error: "CNPJ inválido." };

  const socios = (input.socios ?? [])
    .map((s) => ({ ...s, cpf: onlyDigits(s.cpf) }))
    .filter((s) => s.cpf.length > 0);
  for (const s of socios) {
    if (!isValidCPF(s.cpf)) return { error: `CPF de sócio inválido: ${s.cpf}` };
  }

  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { error: "Sessão expirada." };

  const total = 1 + socios.length;
  const { data: batchRow, error: batchErr } = await supabase
    .from("batches")
    .insert({
      type: "PJ",
      document: cnpj,
      name: input.name ?? null,
      product: DEPS_PRODUCT_PJ,
      created_by: userId,
      status: "processing",
      total_items: total,
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (batchErr || !batchRow) {
    return { error: batchErr?.message ?? "Falha ao criar o processo." };
  }
  const batchId = (batchRow as { id: string }).id;

  // E-mail da empresa serve de fallback para os sócios que não informarem o seu.
  const companyEmail = input.email?.trim() || null;

  // Lista a enfileirar: empresa (PJ) + sócios (PF). O e-mail do titular (sócio
  // herda o da empresa quando ausente) é gravado em queries.scr_email já aqui,
  // para não depender do cliente no reprocessamento/retomada.
  const toQueue: {
    type: EntityKind;
    document: string;
    documentName: string;
    email: string | null;
  }[] = [
    {
      type: "PJ",
      document: cnpj,
      documentName: input.name ?? cnpj,
      email: companyEmail,
    },
    ...socios.map((s) => ({
      type: "PF" as EntityKind,
      document: s.cpf,
      documentName: s.name ?? s.cpf,
      email: (s.email?.trim() || null) ?? companyEmail,
    })),
  ];

  const memberQueryIds: string[] = [];
  for (const m of toQueue) {
    const { data: inserted, error } = await supabase
      .from("queries")
      .insert({
        type: m.type,
        document: m.document,
        document_name: m.documentName,
        product: depsProductName(m.type),
        batch_id: batchId,
        crm_client_id: null,
        created_by: userId,
        status: "processing",
        requires_auth: true,
        scr_email: m.email,
      })
      .select("id")
      .single();
    if (error || !inserted) {
      return { error: error?.message ?? "Falha ao criar as consultas do processo." };
    }
    memberQueryIds.push((inserted as { id: string }).id);
  }

  await refreshBatchCounters(batchId);
  revalidatePath("/batch");
  return { error: null, batchId, memberQueryIds };
}

export interface ProcessMemberResult {
  outcome: MemberOutcome | "skipped";
}

// Processa UMA consulta enfileirada (uma chamada à deps). Idempotente: só roda
// se a query ainda estiver 'processing' (na fila). O e-mail do titular vem de
// queries.scr_email (gravado na criação) — não depende do cliente. Atualiza os
// contadores do batch.
export async function processCompanyMember(
  queryId: string,
  reuseExisting = true
): Promise<ProcessMemberResult> {
  const supabase = db();
  const userId = await currentUserId();
  if (!userId) return { outcome: "error" };

  const { data: q } = await supabase
    .from("queries")
    .select("id, type, document, document_name, status, batch_id, scr_email")
    .eq("id", queryId)
    .maybeSingle();
  if (!q) return { outcome: "error" };
  const query = q as {
    id: string;
    type: EntityKind;
    document: string;
    document_name: string | null;
    status: string;
    batch_id: string | null;
    scr_email: string | null;
  };

  // Já saiu da fila (concluída/pendente/erro) → não refaz.
  if (query.status !== "processing") {
    const map: Record<string, MemberOutcome> = {
      completed: "completed",
      pending_authorization: "pending",
      error: "error",
    };
    return { outcome: map[query.status] ?? "skipped" };
  }

  const deps = getDepsClient();
  const admin = createServiceClient();
  const outcome = await consultExistingMember({
    supabase,
    admin,
    deps,
    userId,
    queryId: query.id,
    type: query.type,
    document: query.document,
    documentName: query.document_name ?? query.document,
    email: query.scr_email,
    reuseExisting,
  });

  if (query.batch_id) {
    await refreshBatchCounters(query.batch_id);
    revalidatePath(`/batch/${query.batch_id}`);
    revalidatePath("/batch");
  }
  revalidatePath("/consultations");
  return { outcome };
}

// ─────────────────────────────────────────────────────────────────────────
// Parecer técnico consolidado do processo (empresa + sócios concluídos).
// ─────────────────────────────────────────────────────────────────────────
export interface GenerateCompanyReportResult {
  error: string | null;
}

export async function generateCompanyReport(
  batchId: string,
  force = false
): Promise<GenerateCompanyReportResult> {
  const supabase = db();

  const { data: batch } = await supabase
    .from("batches")
    .select("id, document")
    .eq("id", batchId)
    .maybeSingle();
  if (!batch) return { error: "Processo não encontrado." };

  if (!force) {
    const { data: existing } = await supabase
      .from("company_reports")
      .select("status")
      .eq("batch_id", batchId)
      .maybeSingle();
    const row = existing as { status: string } | null;
    if (row && row.status === "completed") return { error: null };
  }

  // Membros concluídos do processo.
  const { data: members } = await supabase
    .from("queries")
    .select("id, type")
    .eq("batch_id", batchId)
    .eq("status", "completed");
  const rows = (members ?? []) as { id: string; type: EntityKind }[];
  const empresaQuery = rows.find((r) => r.type === "PJ");
  if (!empresaQuery) {
    return { error: "A consulta da empresa (CNPJ) ainda não foi concluída." };
  }

  // Carrega os resultados brutos.
  const { data: empresaRow } = await supabase
    .from("query_results_pj")
    .select("*")
    .eq("query_id", empresaQuery.id)
    .maybeSingle();
  if (!empresaRow) return { error: "Resultado da empresa não encontrado." };

  const socioQueryIds = rows.filter((r) => r.type === "PF").map((r) => r.id);
  const socios: { type: "PF" | "PJ"; resultRow: Record<string, unknown> }[] = [];
  if (socioQueryIds.length > 0) {
    const { data: pfRows } = await supabase
      .from("query_results_pf")
      .select("*")
      .in("query_id", socioQueryIds);
    for (const pf of (pfRows ?? []) as Record<string, unknown>[]) {
      socios.push({ type: "PF", resultRow: pf });
    }
  }

  try {
    const systemPrompt = await getAiPrompt("empresa");
    const { parecer, model } = await generateCompanyParecer(
      {
        dataAnalise: new Date().toISOString().slice(0, 10),
        empresaRow: empresaRow as Record<string, unknown>,
        socios,
      },
      systemPrompt
    );

    const admin = createServiceClient();
    const { error: upsertErr } = await admin.from("company_reports").upsert(
      {
        batch_id: batchId,
        aptitude_status: toAptitudeStatus(parecer.apto),
        executive_summary: parecer.resumo_executivo,
        positive_points: json(parecer.pontos_fortes),
        risk_points: json(parecer.pontos_atencao),
        action_plan: json(parecer.plano_acao),
        suggested_products: json(parecer.produtos_sugeridos),
        suggested_limit: parecer.limite_sugerido,
        suggested_limit_notes: parecer.limite_sugerido_notas,
        report_markdown: parecer.relatorio_markdown,
        full_report: json(parecer),
        model_used: model,
        prompt_version: COMPANY_PROMPT_VERSION,
        generated_at: new Date().toISOString(),
        generation_error: null,
        status: "completed",
        created_by: await currentUserId(),
      },
      { onConflict: "batch_id" }
    );
    if (upsertErr) return { error: upsertErr.message };
  } catch (err) {
    await createServiceClient().from("company_reports").upsert(
      {
        batch_id: batchId,
        status: "error",
        generation_error:
          err instanceof Error ? err.message : "Erro ao gerar o parecer.",
      },
      { onConflict: "batch_id" }
    );
    return {
      error: err instanceof Error ? err.message : "Erro ao gerar o parecer.",
    };
  }

  revalidatePath(`/batch/${batchId}`);
  return { error: null };
}
