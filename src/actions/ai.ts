"use server";

import { revalidatePath } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient, createServiceClient } from "@/lib/supabase/server";
import { generateParecer } from "@/lib/ai/opinion";
import { PROMPT_VERSION } from "@/lib/ai/prompt";
import { getAiPrompt } from "@/actions/settings";
import { toAptitudeStatus } from "@/types/ai";
import type { Database, Json } from "@/types/supabase";
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

export interface GenerateOpinionResult {
  error: string | null;
}

// Gera (ou regenera) o parecer de IA para uma consulta concluída.
// Idempotente: se já houver parecer concluído e `force` for false, não refaz.
export async function generateOpinion(
  queryId: string,
  force = false
): Promise<GenerateOpinionResult> {
  const supabase = db();

  const { data: q } = await supabase
    .from("queries")
    .select("id, type, status, crm_client_id, document_name")
    .eq("id", queryId)
    .maybeSingle();
  if (!q) return { error: "Consulta não encontrada." };
  const query = q as {
    id: string;
    type: EntityKind;
    status: string;
    crm_client_id: string | null;
    document_name: string | null;
  };
  if (query.status !== "completed") {
    return { error: "A consulta ainda não foi concluída." };
  }

  // Já existe parecer concluído? Não refaz salvo regeneração explícita.
  if (!force) {
    const { data: existing } = await supabase
      .from("ai_reports")
      .select("id, status")
      .eq("query_id", queryId)
      .maybeSingle();
    const row = existing as { id: string; status: string } | null;
    if (row && row.status === "completed") return { error: null };
  }

  // Carrega o resultado bruto da consulta.
  const table = query.type === "PJ" ? "query_results_pj" : "query_results_pf";
  const { data: resultRow } = await supabase
    .from(table)
    .select("*")
    .eq("query_id", queryId)
    .maybeSingle();
  if (!resultRow) {
    return { error: "Resultado da consulta não encontrado." };
  }

  try {
    const systemPrompt = await getAiPrompt(query.type === "PJ" ? "pj" : "pf");
    const { parecer, model } = await generateParecer(
      {
        type: query.type,
        dataAnalise: new Date().toISOString().slice(0, 10),
        resultRow: resultRow as Record<string, unknown>,
      },
      systemPrompt
    );

    // ai_reports não tem política de escrita RLS → grava via service-role.
    const admin = createServiceClient();
    const { error: upsertErr } = await admin.from("ai_reports").upsert(
      {
        query_id: queryId,
        crm_client_id: query.crm_client_id,
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
        prompt_version: PROMPT_VERSION,
        generated_at: new Date().toISOString(),
        generation_error: null,
        status: "completed",
      },
      { onConflict: "query_id" }
    );
    if (upsertErr) return { error: upsertErr.message };

    if (query.crm_client_id) {
      const userId = await currentUserId();
      await supabase.from("timeline_events").insert({
        entity_type: "crm_client",
        entity_id: query.crm_client_id,
        event_type: "ai_report.generated",
        title: "Parecer de IA gerado",
        description: `${query.document_name ?? ""} · ${parecer.classificacao_perfil}`.trim(),
        metadata: json({ query_id: queryId, apto: parecer.apto }),
        created_by: userId,
      });
    }
  } catch (err) {
    // Registra o erro no próprio parecer para exibição/retry (service-role).
    await createServiceClient().from("ai_reports").upsert(
      {
        query_id: queryId,
        crm_client_id: query.crm_client_id,
        status: "error",
        generation_error:
          err instanceof Error ? err.message : "Erro ao gerar o parecer.",
      },
      { onConflict: "query_id" }
    );
    return {
      error: err instanceof Error ? err.message : "Erro ao gerar o parecer.",
    };
  }

  revalidatePath(`/consultations/${queryId}`);
  if (query.crm_client_id) revalidatePath(`/clients/${query.crm_client_id}`);
  return { error: null };
}
