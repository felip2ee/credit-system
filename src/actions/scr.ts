"use server";

import { revalidatePath } from "next/cache";

import { getDepsClient } from "@/lib/deps/client";
import { executeConsultation } from "@/lib/consultations/service";
import { depsProductName } from "@/lib/deps/products";
import { getRequiredSession } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";
import { authorizeScr, getScrAuthorization, getScrByConsultation, markScrPending } from "@/lib/scr/queries";
import { onlyDigits } from "@/lib/utils";
import type { EntityKind, ScrStatus } from "@/types/app";
import { refreshBatchCounters } from "@/actions/company";

const SCR_VALIDITY_DAYS = 90;
export interface VerifyScrResult { status: ScrStatus; queryId?: string; message: string; }

export async function verifyScr(scrId: string, document: string): Promise<VerifyScrResult> {
  let session; try { session = await getRequiredSession(); } catch { return { status: "pending", message: "Sess\u00e3o expirada." }; }
  const identity = { userId: session.userId, role: session.role } as const;
  const scr = await getScrAuthorization(identity, scrId);
  if (!scr) return { status: "not_authorized", message: "Registro SCR n\u00e3o encontrado." };
  const query = scr.consultation_id ? await withUserTransaction(identity, async (client) => (await client.query<{ scr_mode: string; batch_id: string | null }>(`select scr_mode,batch_id from consultations where id=$1`, [scr.consultation_id])).rows[0]) : null;
  const doc = onlyDigits(document); const product = depsProductName(scr.type);
  const pending = async () => { await markScrPending(identity, scrId, scr.email); revalidatePath("/scr"); return { status: "pending" as ScrStatus, message: "Autoriza\u00e7\u00e3o SCR ainda pendente. Conceda a autoriza\u00e7\u00e3o no portal da deps e clique em Tentar novamente." }; };
  let raw;
  try { raw = scr.type === "PJ" ? await getDepsClient().consultPJ(doc, { product, reuseExisting: true, authorization: { name: scr.name ?? undefined, email: scr.email ?? undefined }, autorizacaoScr: query?.scr_mode !== "deps" }) : await getDepsClient().consultPF(doc, { product, reuseExisting: true, authorization: { name: scr.name ?? undefined, email: scr.email ?? undefined }, autorizacaoScr: query?.scr_mode !== "deps" }); }
  catch { return pending(); }
  if (!scr.consultation_id) return pending();
  const outcome = await executeConsultation({ identity, consultationId: scr.consultation_id, entityKind: scr.type, consult: async () => raw });
  if (outcome.status === "no_data") return pending();
  if (outcome.status === "payload_incompatible") return { status: "not_authorized", message: "A consulta retornou dados incompat\u00edveis com o formato esperado do bureau." };
  await authorizeScr(identity, { id: scrId, validityDays: SCR_VALIDITY_DAYS, crmClientId: scr.crm_client_id, document: doc });
  if (query?.batch_id) { await refreshBatchCounters(query.batch_id); revalidatePath(`/batch/${query.batch_id}`); revalidatePath("/batch"); }
  revalidatePath("/scr"); revalidatePath("/consultations"); if (scr.crm_client_id) revalidatePath(`/clients/${scr.crm_client_id}`);
  return { status: "authorized", queryId: scr.consultation_id, message: "Autoriza\u00e7\u00e3o confirmada \u2014 consulta conclu\u00edda." };
}

export async function retryScrByQuery(queryId: string): Promise<VerifyScrResult> {
  let session; try { session = await getRequiredSession(); } catch { return { status: "pending", message: "Sess\u00e3o expirada." }; }
  const row = await getScrByConsultation({ userId: session.userId, role: session.role }, queryId);
  return row ? verifyScr(row.id, row.document) : { status: "not_authorized", message: "Nenhuma autoriza\u00e7\u00e3o SCR vinculada a esta consulta." };
}

export async function resendScr(scrId: string, _document: string, _type: EntityKind, _name: string | null, email: string | null): Promise<{ ok: boolean }> {
  let session; try { session = await getRequiredSession(); } catch { return { ok: false }; }
  await markScrPending({ userId: session.userId, role: session.role }, scrId, email);
  revalidatePath("/scr"); return { ok: true };
}
