"use server";

import { revalidatePath } from "next/cache";

import { getDepsClient } from "@/lib/deps/client";
import { DepsScrPendingError } from "@/lib/deps/errors";
import { executeConsultation } from "@/lib/consultations/service";
import { getConsultation } from "@/lib/consultations/queries";
import { createDossier, refreshDossierStatus } from "@/lib/dossiers/queries";
import { depsProductName } from "@/lib/deps/products";
import { listHolders, recordHolderEvent } from "@/lib/holders/queries";
import { hasValidInternalScr, upsertScrAuthorization } from "@/lib/scr/queries";
import { getRequiredSession } from "@/lib/auth/session";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { hasPermission } from "@/lib/db/permissions";
import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";
import type { EntityKind } from "@/types/app";

const currentIdentity = async () => { try { return await getRequiredSession(); } catch { return null; } };

const PICK_LIMIT = 10;
export interface HolderPick { id: string; type: EntityKind; name: string; document: string; }
export async function searchHolders(term: string): Promise<HolderPick[]> {
  const identity = await currentIdentity(); if (!identity) return [];
  if (!hasPermission(identity, "holders:read")) return [];
  const rows = await listHolders(identity, { q: term });
  return rows.slice(0, PICK_LIMIT).map(({ id, type, name, document }) => ({ id, type, name, document }));
}
export interface RecentConsultationResult { exists: boolean; queryId?: string; consultedAt?: string; }
export async function findRecentConsultation(document: string): Promise<RecentConsultationResult> {
  const identity = await currentIdentity(); if (!identity) return { exists: false };
  const { rows } = await withUserTransaction(identity, (client) => client.query<{ id: string; consulted_at: string }>(`select id,consulted_at::text from consultations where document=$1 and status='completed' and consulted_at>=now()-interval '30 days' order by consulted_at desc limit 1`, [onlyDigits(document)]));
  return rows[0] ? { exists: true, queryId: rows[0].id, consultedAt: rows[0].consulted_at } : { exists: false };
}

export type ScrMode = "internal" | "deps";
export interface RunConsultationInput { type: EntityKind; document: string; documentName: string; observations?: string; email?: string | null; reuseExisting?: boolean; scrMode?: ScrMode; }
export interface RunConsultationResult { error: string | null; status?: "completed" | "pending_scr"; queryId?: string; dossierId?: string; message?: string; }

async function setConsultationStatus(identity: DbIdentity, id: string, status: "processing" | "pending_authorization" | "error", error?: string | null) {
  await withUserTransaction(identity, async (client) => {
    const { rows } = await client.query<{ dossier_id: string }>(`update consultations set status=$2,error_message=$3 where id=$1 returning dossier_id`, [id,status,error ?? null]);
    if (rows[0]) await refreshDossierStatus(client, rows[0].dossier_id);
  });
}

// consultation.belongs-to-dossier: a consulta avulsa nasce em um Dossiê PF ou PJ.
export async function runConsultation(input: RunConsultationInput): Promise<RunConsultationResult> {
  const document = onlyDigits(input.document); const valid = input.type === "PF" ? isValidCPF(document) : isValidCNPJ(document);
  if (!valid) return { error: "Documento inválido." };
  const identity = await currentIdentity(); if (!identity) return { error: "Sessão expirada." };
  if (!hasPermission(identity, "consultations:write")) return { error: "Não autorizado." };
  const email = input.email?.trim() || null; const scrMode = input.scrMode ?? "internal";
  const created = await createDossier(identity, { kind: input.type, holder: { type: input.type, name: input.documentName, document }, scrMode, email, observations: input.observations ?? null });
  if (!created.ok) return { error: "Falha ao criar a consulta." };
  const queryId = created.consultationIds[0]; const dossierId = created.id;
  const inserted = await getConsultation(identity, queryId);
  if (!inserted) return { error: "Falha ao criar a consulta." };
  const holderId = inserted.holder_id;
  const pending = async (message: string): Promise<RunConsultationResult> => {
    await setConsultationStatus(identity, queryId, "pending_authorization");
    await upsertScrAuthorization(identity, { document, type: input.type, status: "pending", name: input.documentName, email, queryId, holderId, requestedBy: identity.userId });
    revalidatePath("/dossiers"); revalidatePath("/scr");
    return { error: null, status: "pending_scr", queryId, dossierId, message };
  };
  if (scrMode === "internal" && !(await hasValidInternalScr(identity, document))) {
    return pending("Sem autorização SCR própria vigente para este documento. Envie o termo de autorização.");
  }
  const deps = getDepsClient(); let raw;
  try { raw = input.type === "PJ" ? await deps.consultPJ(document, { product: depsProductName(input.type), reuseExisting: input.reuseExisting, authorization: { name: input.documentName, email: email ?? undefined }, autorizacaoScr: scrMode === "internal" }) : await deps.consultPF(document, { product: depsProductName(input.type), reuseExisting: input.reuseExisting, authorization: { name: input.documentName, email: email ?? undefined }, autorizacaoScr: scrMode === "internal" }); }
  catch (error) { if (error instanceof DepsScrPendingError) return pending("Consulta sem dados/SCR pendente. Envie a autorização SCR e reprocesse a consulta."); await setConsultationStatus(identity, queryId, "error", error instanceof Error ? error.message : "Erro na consulta."); return { error: "Falha ao executar a consulta no bureau." }; }
  const outcome = await executeConsultation({ identity, consultationId: queryId, entityKind: input.type, consult: async () => raw });
  if (outcome.status === "no_data") return pending("Consulta sem dados/SCR pendente. Envie a autorização SCR e reprocesse a consulta.");
  if (outcome.status === "payload_incompatible") return { error: "A consulta retornou dados incompatíveis com o formato esperado do bureau." };
  await upsertScrAuthorization(identity, { document, type: input.type, status: "authorized", name: outcome.canonical.subject.name || input.documentName, queryId, holderId, requestedBy: identity.userId });
  await withUserTransaction(identity, (client) => recordHolderEvent(client, identity.userId, holderId, { eventType: "query.executed", title: "Consulta realizada", description: `${depsProductName(input.type)} · ${document}` }));
  revalidatePath("/dossiers"); revalidatePath(`/holders/${holderId}`);
  return { error: null, status: "completed", queryId, dossierId };
}

export async function reprocessQuery(queryId: string): Promise<RunConsultationResult> {
  const identity = await currentIdentity(); if (!identity) return { error: "Sessão expirada." };
  if (!hasPermission(identity, "consultations:write")) return { error: "Não autorizado." };
  const query = await withUserTransaction(identity, async (client) => (await client.query<{ type: EntityKind; document: string; scr_mode: ScrMode | null }>(`select type,document,scr_mode from consultations where id=$1`, [queryId])).rows[0]);
  if (!query) return { error: "Consulta não encontrada." };
  // Same consent gate as runConsultation: autorizacaoScr: true registers consent at DEPS.
  if (query.scr_mode !== "deps" && !(await hasValidInternalScr(identity, query.document))) return { error: "Sem autorização SCR própria vigente para este documento. Envie o termo de autorização." };
  await setConsultationStatus(identity, queryId, "processing");
  try {
    const product = depsProductName(query.type); const deps = getDepsClient();
    const raw = query.type === "PJ" ? await deps.consultPJ(query.document, { product, autorizacaoScr: query.scr_mode !== "deps" }) : await deps.consultPF(query.document, { product, autorizacaoScr: query.scr_mode !== "deps" });
    const outcome = await executeConsultation({ identity, consultationId: queryId, entityKind: query.type, consult: async () => raw });
    if (outcome.status === "no_data") { await setConsultationStatus(identity, queryId, "pending_authorization"); return { error: null, status: "pending_scr", queryId, message: "Consulta sem dados/SCR pendente. Verifique a autorização e tente novamente." }; }
    if (outcome.status === "payload_incompatible") return { error: "A consulta retornou dados incompatíveis com o formato esperado do bureau." };
  } catch (error) { await setConsultationStatus(identity, queryId, "error", error instanceof Error ? error.message : "Erro na consulta."); return { error: "Falha ao reprocessar a consulta." }; }
  revalidatePath("/dossiers"); revalidatePath(`/consultations/${queryId}`); return { error: null, status: "completed", queryId };
}
