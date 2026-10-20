"use server";

import { revalidatePath } from "next/cache";

import { generateParecer } from "@/lib/ai/opinion";
import { saveConsultationOpinion } from "@/lib/ai/persist";
import { getAiPrompt } from "@/actions/settings";
import { loadCanonicalResult, loadLatestPayload } from "@/lib/consultations/canonical-store";
import { getRequiredSession } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";
import { hasPermission } from "@/lib/db/permissions";
import type { EntityKind } from "@/types/app";

export interface GenerateOpinionResult { error: string | null; }

export async function generateOpinion(queryId: string, force = false): Promise<GenerateOpinionResult> {
  let session;
  try { session = await getRequiredSession(); } catch { return { error: "Sess\u00e3o expirada." }; }
  const identity = session;
  if (!hasPermission(identity, "reports:write")) return { error: "N\u00e3o autorizado." };
  const query = await withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ id: string; type: EntityKind; status: string; holder_id: string; document_name: string | null; report_status: string | null }>(
      `select c.id,c.type,c.status::text,c.holder_id,c.document_name,r.status report_status
       from consultations c left join ai_reports r on r.consultation_id=c.id where c.id=$1`, [queryId]);
    return rows[0] ?? null;
  });
  if (!query) return { error: "Consulta n\u00e3o encontrada." };
  if (query.status !== "completed") return { error: "A consulta ainda n\u00e3o foi conclu\u00edda." };
  if (!force && query.report_status === "completed") return { error: null };
  const canonical = await loadCanonicalResult(identity, queryId);
  if (!canonical) return { error: "Resultado can\u00f4nico da consulta n\u00e3o encontrado." };
  try {
    const payload = await loadLatestPayload(identity, queryId);
    const prompt = await getAiPrompt(query.type === "PJ" ? "pj" : "pf");
    const { parecer, model } = await generateParecer({ type: query.type, dataAnalise: new Date().toISOString().slice(0, 10), canonical, payload }, prompt);
    await withUserTransaction(identity, (client) =>
      saveConsultationOpinion(client, identity, queryId, query.holder_id, { status: "completed", parecer, model, documentName: query.document_name }));
  } catch (error) {
    await withUserTransaction(identity, (client) =>
      saveConsultationOpinion(client, identity, queryId, query.holder_id, { status: "error", error: error instanceof Error ? error.message : "Erro ao gerar o parecer." }));
    return { error: error instanceof Error ? error.message : "Erro ao gerar o parecer." };
  }
  revalidatePath(`/consultations/${queryId}`);
  revalidatePath(`/holders/${query.holder_id}`);
  return { error: null };
}
