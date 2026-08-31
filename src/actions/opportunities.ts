"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession } from "@/lib/auth/session";
import { readScenario, type FinancingScenario } from "@/lib/checklists/real-estate";
import { hasPermission } from "@/lib/db/permissions";
import type { DbIdentity } from "@/lib/db/transaction";
import { DocumentRejectedError, storeDocument } from "@/lib/documents/service";
import {
  addOpportunityNoteRecord,
  createOpportunityForClient as createOpportunityForClientRecord,
  createOpportunityFromConsultation,
  recordOpportunityDocumentUpload,
  recordScannedDocumentUpload,
  setOpportunityDocumentStatusRecord,
  updateFinancingScenarioRecord,
  updateOpportunityDetailsRecord,
  updateOpportunityStatusRecord,
  updateRealEstateOrderRecord,
} from "@/lib/opportunities/queries";
import { REAL_ESTATE_ORDER_KEYS } from "@/lib/orders/real-estate-order";
import { opportunityDetailsSchema, type OpportunityDetailsFormValues } from "@/lib/validators/opportunity";
import type { OpportunityDocStatus, OpportunityStatus } from "@/types/app";

export interface ActionResult { error: string | null; id?: string; }

async function opportunityWriter(): Promise<DbIdentity | null> {
  try {
    const session = await getRequiredSession();
    return hasPermission(session.role, "opportunities:write") ? { userId: session.userId, role: session.role } : null;
  } catch {
    return null;
  }
}

function revalidateOpportunity(id: string, clientId?: string) {
  revalidatePath(`/opportunities/${id}`);
  revalidatePath("/opportunities");
  if (clientId) revalidatePath(`/clients/${clientId}`);
}

export async function createOpportunityFromQuery(queryId: string): Promise<ActionResult> {
  const identity = await opportunityWriter();
  if (!identity) return { error: "Sessão expirada." };
  try {
    const result = await createOpportunityFromConsultation(identity, queryId);
    if (!result.ok) return { error: result.reason === "consultation_not_found" ? "Consulta não encontrada." : result.reason === "consultation_not_completed" ? "A consulta precisa estar concluída." : "Cliente não encontrado." };
    revalidatePath("/opportunities");
    if (result.crmClientId) revalidatePath(`/clients/${result.crmClientId}`);
    revalidatePath(`/consultations/${queryId}`);
    return { error: null, id: result.id };
  } catch {
    return { error: "Falha ao criar a oportunidade." };
  }
}

export async function createOpportunityForClient(clientId: string): Promise<ActionResult> {
  const identity = await opportunityWriter();
  if (!identity) return { error: "Sessão expirada." };
  try {
    const result = await createOpportunityForClientRecord(identity, clientId);
    if (!result.ok) return { error: "Cliente não encontrado." };
    revalidatePath("/opportunities");
    revalidatePath(`/clients/${clientId}`);
    if (result.consultationId) revalidatePath(`/consultations/${result.consultationId}`);
    return { error: null, id: result.id };
  } catch {
    return { error: "Falha ao criar a oportunidade." };
  }
}

export async function updateOpportunityDetails(id: string, values: OpportunityDetailsFormValues): Promise<ActionResult> {
  const parsed = opportunityDetailsSchema.safeParse(values);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const identity = await opportunityWriter();
  if (!identity) return { error: "Sessão expirada." };
  try {
    const result = await updateOpportunityDetailsRecord(identity, id, parsed.data);
    if (!result.ok) return { error: "Oportunidade não encontrada." };
    revalidateOpportunity(id, result.crmClientId);
    return { error: null, id };
  } catch {
    return { error: "Falha ao salvar a oportunidade." };
  }
}

export async function updateFinancingScenario(opportunityId: string, scenario: FinancingScenario): Promise<ActionResult> {
  const identity = await opportunityWriter();
  if (!identity) return { error: "Sessão expirada." };
  try {
    const result = await updateFinancingScenarioRecord(identity, opportunityId, readScenario({ financing_scenario: scenario }) as unknown as Record<string, unknown>);
    if (!result.ok) return { error: "Oportunidade não encontrada." };
    revalidateOpportunity(opportunityId, result.crmClientId);
    return { error: null, id: opportunityId };
  } catch {
    return { error: "Falha ao salvar o cenário." };
  }
}

export async function updateRealEstateOrder(opportunityId: string, data: Record<string, string>): Promise<ActionResult> {
  const identity = await opportunityWriter();
  if (!identity) return { error: "Sessão expirada." };
  const clean = REAL_ESTATE_ORDER_KEYS.reduce((out, key) => {
    out[key] = (data[key] ?? "").trim();
    return out;
  }, {} as Record<string, string>);
  try {
    const result = await updateRealEstateOrderRecord(identity, opportunityId, clean);
    if (!result.ok) return { error: "Oportunidade não encontrada." };
    revalidateOpportunity(opportunityId, result.crmClientId);
    return { error: null, id: opportunityId };
  } catch {
    return { error: "Falha ao salvar os dados." };
  }
}

export interface StatusExtra { approvedAmount?: number | null; rejectionReason?: string | null; }

export async function updateOpportunityStatus(id: string, status: OpportunityStatus, extra?: StatusExtra): Promise<ActionResult> {
  const identity = await opportunityWriter();
  if (!identity) return { error: "Sessão expirada." };
  try {
    const result = await updateOpportunityStatusRecord(identity, id, status, extra);
    if (!result.ok) return { error: "Oportunidade não encontrada." };
    revalidateOpportunity(id, result.crmClientId);
    return { error: null, id };
  } catch {
    return { error: "Falha ao alterar o status." };
  }
}

export async function addOpportunityNote(id: string, content: string): Promise<ActionResult> {
  const text = content.trim();
  if (!text) return { error: "Anotação vazia." };
  const identity = await opportunityWriter();
  if (!identity) return { error: "Sessão expirada." };
  try {
    const result = await addOpportunityNoteRecord(identity, id, text);
    if (!result.ok) return { error: "Oportunidade não encontrada." };
    revalidateOpportunity(id, result.crmClientId);
    return { error: null, id };
  } catch {
    return { error: "Falha ao salvar a anotação." };
  }
}

export interface RecordUploadInput { docId: string; opportunityId: string; docLabel: string; fileName: string; filePath: string; fileSize: number; fileMime: string; }

// ponytail: legacy browser-storage callback remains callable until its client
// caller is removed; uploads in this slice use uploadOpportunityDocument.
export async function recordOpportunityDocUpload(input: RecordUploadInput): Promise<ActionResult> {
  const identity = await opportunityWriter();
  if (!identity) return { error: "Sessão expirada." };
  try {
    const result = await recordOpportunityDocumentUpload(identity, input);
    if (!result.ok) return { error: "Documento não encontrado." };
    revalidateOpportunity(input.opportunityId, result.crmClientId);
    return { error: null, id: input.docId };
  } catch {
    return { error: "Falha ao registrar o documento." };
  }
}

export async function setOpportunityDocStatus(docId: string, opportunityId: string, docLabel: string, status: Extract<OpportunityDocStatus, "approved" | "rejected">, rejectionReason?: string): Promise<ActionResult> {
  const identity = await opportunityWriter();
  if (!identity) return { error: "Sessão expirada." };
  try {
    const result = await setOpportunityDocumentStatusRecord(identity, { docId, opportunityId, docLabel, status, rejectionReason });
    if (!result.ok) return { error: "Documento não encontrado." };
    revalidateOpportunity(opportunityId, result.crmClientId);
    return { error: null, id: docId };
  } catch {
    return { error: "Falha ao revisar o documento." };
  }
}

export interface SignedUrlResult { error: string | null; url?: string; }
export async function getOpportunityDocUrl(docId: string): Promise<SignedUrlResult> { return { error: null, url: `/api/documents/${docId}` }; }

export async function uploadOpportunityDocument(formData: FormData): Promise<ActionResult> {
  const identity = await opportunityWriter();
  if (!identity) return { error: "Apenas a equipe pode enviar documentos." };
  const docId = String(formData.get("docId") ?? "");
  const opportunityId = String(formData.get("opportunityId") ?? "");
  const docLabel = String(formData.get("docLabel") ?? "");
  const file = formData.get("file");
  if (!docId || !opportunityId || !(file instanceof File) || file.size === 0) return { error: "Selecione um arquivo válido." };
  try {
    await storeDocument({ stream: file.stream() as unknown as AsyncIterable<Uint8Array>, declaredName: file.name, declaredMime: file.type || "application/octet-stream", uploaderId: identity.userId, identity, link: { opportunityId, docType: docLabel, docId, docLabel } });
    const result = await recordScannedDocumentUpload(identity, opportunityId, docLabel, file.name);
    if (!result.ok) return { error: "Oportunidade não encontrada." };
    revalidateOpportunity(opportunityId, result.crmClientId);
    return { error: null, id: docId };
  } catch (error) {
    return { error: error instanceof DocumentRejectedError ? error.message : "Falha ao processar o arquivo." };
  }
}
