"use server";

import { revalidatePath } from "next/cache";

import { getDepsClient } from "@/lib/deps/client";
import { DepsScrPendingError } from "@/lib/deps/errors";
import { executeConsultation } from "@/lib/consultations/service";
import { depsProductName } from "@/lib/deps/products";
import { hasValidInternalScr, upsertScrAuthorization } from "@/lib/scr/queries";
import { getRequiredSession } from "@/lib/auth/session";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { hasPermission } from "@/lib/db/permissions";
import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";
import type { EntityKind } from "@/types/app";

const currentIdentity = async (): Promise<DbIdentity | null> => { try { const s = await getRequiredSession(); return { userId: s.userId, role: s.role }; } catch { return null; } };

export interface ClientPick { id: string; type: EntityKind; name: string; document: string | null; email: string | null; }
export async function searchClients(term: string): Promise<ClientPick[]> {
  const identity = await currentIdentity(); if (!identity) return [];
  const text = term.trim(); const doc = onlyDigits(text);
  return withUserTransaction(identity, async (client) => (await client.query<ClientPick>(
    `select id,type,name,document,email from crm_clients where ($1='' or name ilike '%'||$1||'%' or ($2<>'' and document ilike '%'||$2||'%')) order by updated_at desc limit 10`, [text, doc])).rows);
}
export interface RecentConsultationResult { exists: boolean; queryId?: string; consultedAt?: string; }
export async function findRecentConsultation(document: string): Promise<RecentConsultationResult> {
  const identity = await currentIdentity(); if (!identity) return { exists: false };
  const { rows } = await withUserTransaction(identity, (client) => client.query<{ id: string; consulted_at: string }>(`select id,consulted_at::text from consultations where document=$1 and status='completed' and consulted_at>=now()-interval '30 days' order by consulted_at desc limit 1`, [onlyDigits(document)]));
  return rows[0] ? { exists: true, queryId: rows[0].id, consultedAt: rows[0].consulted_at } : { exists: false };
}

export type ScrMode = "internal" | "deps";
export interface RunConsultationInput { crmClientId: string; type: EntityKind; document: string; documentName: string; observations?: string; email?: string | null; reuseExisting?: boolean; scrMode?: ScrMode; }
export interface RunConsultationResult { error: string | null; status?: "completed" | "pending_scr"; queryId?: string; message?: string; }

async function setConsultationStatus(identity: DbIdentity, id: string, status: "processing" | "pending_authorization" | "error", error?: string | null) {
  await withUserTransaction(identity, (client) => client.query(`update consultations set status=$2,error_message=$3 where id=$1`, [id,status,error ?? null]));
}

export async function runConsultation(input: RunConsultationInput): Promise<RunConsultationResult> {
  const document = onlyDigits(input.document); const valid = input.type === "PF" ? isValidCPF(document) : isValidCNPJ(document);
  if (!valid) return { error: "Documento inv\u00e1lido." };
  const identity = await currentIdentity(); if (!identity) return { error: "Sess\u00e3o expirada." };
  if (!hasPermission(identity.role, "consultations:write")) return { error: "N\u00e3o autorizado." };
  const email = input.email?.trim() || null; const scrMode = input.scrMode ?? "internal";
  if (scrMode === "internal" && !(await hasValidInternalScr(identity, document))) {
    await upsertScrAuthorization(identity, { document, type: input.type, status: "pending", name: input.documentName, email, crmClientId: input.crmClientId, requestedBy: identity.userId });
    return { error: null, status: "pending_scr", message: "Sem autoriza\u00e7\u00e3o SCR pr\u00f3pria vigente para este documento. Envie o termo de autoriza\u00e7\u00e3o." };
  }
  const inserted = await withUserTransaction(identity, async (client) => (await client.query<{ id: string }>(`insert into consultations (type,document,document_name,product,crm_client_id,created_by,status,requires_auth,observations,scr_mode) values ($1,$2,$3,$4,$5,$6,'processing',true,$7,$8) returning id`, [input.type,document,input.documentName,depsProductName(input.type),input.crmClientId,identity.userId,input.observations ?? null,scrMode])).rows[0]);
  if (!inserted) return { error: "Falha ao criar a consulta." };
  const pending = async (): Promise<RunConsultationResult> => {
    await setConsultationStatus(identity, inserted.id, "pending_authorization");
    await upsertScrAuthorization(identity, { document, type: input.type, status: "pending", name: input.documentName, email, queryId: inserted.id, crmClientId: input.crmClientId, requestedBy: identity.userId });
    revalidatePath("/consultations"); revalidatePath("/scr");
    return { error: null, status: "pending_scr", queryId: inserted.id, message: "Consulta sem dados/SCR pendente. Envie a autoriza\u00e7\u00e3o SCR e reprocesse a consulta." };
  };
  const deps = getDepsClient(); let raw;
  try { raw = input.type === "PJ" ? await deps.consultPJ(document, { product: depsProductName(input.type), reuseExisting: input.reuseExisting, authorization: { name: input.documentName, email: email ?? undefined }, autorizacaoScr: scrMode === "internal" }) : await deps.consultPF(document, { product: depsProductName(input.type), reuseExisting: input.reuseExisting, authorization: { name: input.documentName, email: email ?? undefined }, autorizacaoScr: scrMode === "internal" }); }
  catch (error) { if (error instanceof DepsScrPendingError) return pending(); await setConsultationStatus(identity, inserted.id, "error", error instanceof Error ? error.message : "Erro na consulta."); return { error: "Falha ao executar a consulta no bureau." }; }
  const outcome = await executeConsultation({ identity, consultationId: inserted.id, entityKind: input.type, consult: async () => raw });
  if (outcome.status === "no_data") return pending();
  if (outcome.status === "payload_incompatible") return { error: "A consulta retornou dados incompat\u00edveis com o formato esperado do bureau." };
  await upsertScrAuthorization(identity, { document, type: input.type, status: "authorized", name: outcome.canonical.subject.name || input.documentName, queryId: inserted.id, crmClientId: input.crmClientId, requestedBy: identity.userId });
  await withUserTransaction(identity, (client) => client.query(`insert into timeline_events (entity_type,entity_id,event_type,title,description,created_by) values ('crm_client',$1,'query.executed','Consulta realizada',$2,$3)`, [input.crmClientId,`${depsProductName(input.type)} \u00b7 ${document}`,identity.userId]));
  revalidatePath("/consultations"); revalidatePath(`/clients/${input.crmClientId}`);
  return { error: null, status: "completed", queryId: inserted.id };
}

export async function reprocessQuery(queryId: string): Promise<RunConsultationResult> {
  const identity = await currentIdentity(); if (!identity) return { error: "Sess\u00e3o expirada." };
  if (!hasPermission(identity.role, "consultations:write")) return { error: "N\u00e3o autorizado." };
  const query = await withUserTransaction(identity, async (client) => (await client.query<{ type: EntityKind; document: string; scr_mode: ScrMode | null }>(`select type,document,scr_mode from consultations where id=$1`, [queryId])).rows[0]);
  if (!query) return { error: "Consulta n\u00e3o encontrada." };
  await setConsultationStatus(identity, queryId, "processing");
  try {
    const product = depsProductName(query.type); const deps = getDepsClient();
    const raw = query.type === "PJ" ? await deps.consultPJ(query.document, { product, autorizacaoScr: query.scr_mode !== "deps" }) : await deps.consultPF(query.document, { product, autorizacaoScr: query.scr_mode !== "deps" });
    const outcome = await executeConsultation({ identity, consultationId: queryId, entityKind: query.type, consult: async () => raw });
    if (outcome.status === "no_data") { await setConsultationStatus(identity, queryId, "pending_authorization"); return { error: null, status: "pending_scr", queryId, message: "Consulta sem dados/SCR pendente. Verifique a autoriza\u00e7\u00e3o e tente novamente." }; }
    if (outcome.status === "payload_incompatible") return { error: "A consulta retornou dados incompat\u00edveis com o formato esperado do bureau." };
  } catch (error) { await setConsultationStatus(identity, queryId, "error", error instanceof Error ? error.message : "Erro na consulta."); return { error: "Falha ao reprocessar a consulta." }; }
  revalidatePath("/consultations"); revalidatePath(`/consultations/${queryId}`); return { error: null, status: "completed", queryId };
}
