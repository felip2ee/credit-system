"use server";

import { revalidatePath } from "next/cache";

import { generateParecer } from "@/lib/ai/opinion";
import { PROMPT_VERSION } from "@/lib/ai/prompt";
import { getAiPrompt } from "@/actions/settings";
import { loadCanonicalResult } from "@/lib/consultations/canonical-store";
import { getRequiredSession } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";
import { hasPermission } from "@/lib/db/permissions";
import { toAptitudeStatus } from "@/types/ai";
import type { EntityKind } from "@/types/app";

export interface GenerateOpinionResult { error: string | null; }

export async function generateOpinion(queryId: string, force = false): Promise<GenerateOpinionResult> {
  let session;
  try { session = await getRequiredSession(); } catch { return { error: "Sess\u00e3o expirada." }; }
  const identity = { userId: session.userId, role: session.role } as const;
  if (!hasPermission(identity.role, "reports:write")) return { error: "N\u00e3o autorizado." };
  const query = await withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ id: string; type: EntityKind; status: string; crm_client_id: string | null; document_name: string | null; report_status: string | null }>(
      `select c.id,c.type,c.status::text,c.crm_client_id,c.document_name,r.status report_status
       from consultations c left join ai_reports r on r.consultation_id=c.id where c.id=$1`, [queryId]);
    return rows[0] ?? null;
  });
  if (!query) return { error: "Consulta n\u00e3o encontrada." };
  if (query.status !== "completed") return { error: "A consulta ainda n\u00e3o foi conclu\u00edda." };
  if (!force && query.report_status === "completed") return { error: null };
  const canonical = await loadCanonicalResult(identity, queryId);
  if (!canonical) return { error: "Resultado can\u00f4nico da consulta n\u00e3o encontrado." };
  try {
    const prompt = await getAiPrompt(query.type === "PJ" ? "pj" : "pf");
    const { parecer, model } = await generateParecer({ type: query.type, dataAnalise: new Date().toISOString().slice(0, 10), canonical }, prompt);
    await withUserTransaction(identity, async (client) => {
      await client.query(
        `insert into ai_reports (consultation_id,crm_client_id,aptitude_status,executive_summary,positive_points,risk_points,action_plan,suggested_products,suggested_limit,suggested_limit_notes,report_markdown,full_report,model_used,prompt_version,generated_at,generation_error,status)
         values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14,now(),null,'completed')
         on conflict (consultation_id) do update set aptitude_status=excluded.aptitude_status,executive_summary=excluded.executive_summary,positive_points=excluded.positive_points,risk_points=excluded.risk_points,action_plan=excluded.action_plan,suggested_products=excluded.suggested_products,suggested_limit=excluded.suggested_limit,suggested_limit_notes=excluded.suggested_limit_notes,report_markdown=excluded.report_markdown,full_report=excluded.full_report,model_used=excluded.model_used,prompt_version=excluded.prompt_version,generated_at=excluded.generated_at,generation_error=null,status='completed'`,
        [queryId, query.crm_client_id, toAptitudeStatus(parecer.apto), parecer.resumo_executivo, JSON.stringify(parecer.pontos_fortes), JSON.stringify(parecer.pontos_atencao), JSON.stringify(parecer.plano_acao), JSON.stringify(parecer.produtos_sugeridos), parecer.limite_sugerido, parecer.limite_sugerido_notas, parecer.relatorio_markdown, JSON.stringify(parecer), model, PROMPT_VERSION]);
      if (query.crm_client_id) await client.query(`insert into timeline_events (entity_type,entity_id,event_type,title,description,metadata,created_by) values ('crm_client',$1,'ai_report.generated','Parecer de IA gerado',$2,$3::jsonb,$4)`, [query.crm_client_id, `${query.document_name ?? ""} \u00b7 ${parecer.classificacao_perfil}`.trim(), JSON.stringify({ consultation_id: queryId, apto: parecer.apto }), identity.userId]);
    });
  } catch (error) {
    await withUserTransaction(identity, (client) => client.query(`insert into ai_reports (consultation_id,crm_client_id,status,generation_error) values ($1,$2,'error',$3) on conflict (consultation_id) do update set status='error',generation_error=excluded.generation_error`, [queryId, query.crm_client_id, error instanceof Error ? error.message : "Erro ao gerar o parecer."]));
    return { error: error instanceof Error ? error.message : "Erro ao gerar o parecer." };
  }
  revalidatePath(`/consultations/${queryId}`);
  if (query.crm_client_id) revalidatePath(`/clients/${query.crm_client_id}`);
  return { error: null };
}
