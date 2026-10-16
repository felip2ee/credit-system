// Grava o parecer de uma consulta (ai_reports) com linha do tempo e auditoria, na transação do chamador.
// Sem "use server": o tick de pedidos chama este módulo com a identidade do Bureau.
import type { PoolClient } from "pg";

import { PROMPT_VERSION } from "@/lib/ai/prompt";
import { writeAuditEvent } from "@/lib/audit/write";
import type { DbIdentity } from "@/lib/db/transaction";
import { recordHolderEvent } from "@/lib/holders/queries";
import { toAptitudeStatus, type Parecer } from "@/types/ai";

export type ConsultationOpinion =
	| { status: "completed"; parecer: Parecer; model: string; documentName: string | null }
	| { status: "error"; error: string };

export async function saveConsultationOpinion(
	client: PoolClient,
	identity: DbIdentity,
	consultationId: string,
	holderId: string,
	result: ConsultationOpinion,
): Promise<void> {
	if (result.status === "error") {
		await client.query(
			`insert into ai_reports (bureau_id,consultation_id,holder_id,status,generation_error) values (app_bureau_id(),$1,$2,'error',$3) on conflict (consultation_id) do update set status='error',generation_error=excluded.generation_error`,
			[consultationId, holderId, result.error],
		);
		await writeAuditEvent(client, { actorId: identity.userId, action: "ai.opinion", targetTable: "consultations", targetId: consultationId, outcome: "failure" });
		return;
	}
	const { parecer, model, documentName } = result;
	await client.query(
		`insert into ai_reports (bureau_id,consultation_id,holder_id,aptitude_status,executive_summary,positive_points,risk_points,action_plan,suggested_products,suggested_limit,suggested_limit_notes,report_markdown,full_report,model_used,prompt_version,generated_at,generation_error,status)
         values (app_bureau_id(),$1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14,now(),null,'completed')
         on conflict (consultation_id) do update set aptitude_status=excluded.aptitude_status,executive_summary=excluded.executive_summary,positive_points=excluded.positive_points,risk_points=excluded.risk_points,action_plan=excluded.action_plan,suggested_products=excluded.suggested_products,suggested_limit=excluded.suggested_limit,suggested_limit_notes=excluded.suggested_limit_notes,report_markdown=excluded.report_markdown,full_report=excluded.full_report,model_used=excluded.model_used,prompt_version=excluded.prompt_version,generated_at=excluded.generated_at,generation_error=null,status='completed'`,
		[consultationId, holderId, toAptitudeStatus(parecer.apto), parecer.resumo_executivo, JSON.stringify(parecer.pontos_fortes), JSON.stringify(parecer.pontos_atencao), JSON.stringify(parecer.plano_acao), JSON.stringify(parecer.produtos_sugeridos), parecer.limite_sugerido, parecer.limite_sugerido_notas, parecer.relatorio_markdown, JSON.stringify(parecer), model, PROMPT_VERSION],
	);
	await recordHolderEvent(client, identity.userId, holderId, { eventType: "ai_report.generated", title: "Parecer de IA gerado", description: `${documentName ?? ""} · ${parecer.classificacao_perfil}`.trim(), metadata: { consultation_id: consultationId, apto: parecer.apto } });
	await writeAuditEvent(client, { actorId: identity.userId, action: "ai.opinion", targetTable: "consultations", targetId: consultationId, metadata: { model, promptVersion: PROMPT_VERSION } });
}
