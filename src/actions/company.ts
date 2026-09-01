"use server";

import { revalidatePath } from "next/cache";

import { getDepsClient } from "@/lib/deps/client";
import { DepsScrPendingError } from "@/lib/deps/errors";
import { executeConsultation } from "@/lib/consultations/service";
import { DEPS_PRODUCT_PJ, depsProductName } from "@/lib/deps/products";
import { generateCompanyParecer } from "@/lib/ai/opinion";
import { COMPANY_PROMPT_VERSION } from "@/lib/ai/prompt";
import { getAiPrompt } from "@/actions/settings";
import { getRequiredSession } from "@/lib/auth/session";
import { withUserTransaction } from "@/lib/db/transaction";
import { hasPermission } from "@/lib/db/permissions";
import { createCompanyBatch, companyCanonicalResults, getCompanyMember, refreshCompanyBatchCounters } from "@/lib/company/queries";
import { hasValidInternalScr, upsertScrAuthorization } from "@/lib/scr/queries";
import { toAptitudeStatus } from "@/types/ai";
import { isValidCNPJ, isValidCPF, onlyDigits } from "@/lib/utils";
import type { EntityKind } from "@/types/app";
import type { ScrMode } from "@/actions/consultations";

const identity = async () => { try { const s = await getRequiredSession(); return { userId: s.userId, role: s.role } as const; } catch { return null; } };
export async function refreshBatchCounters(batchId: string): Promise<void> { const i = await identity(); if (i) await refreshCompanyBatchCounters(i, batchId); }
type MemberOutcome = "completed" | "pending" | "error";
export interface CompanyProcessSocioInput { cpf: string; name?: string; email?: string | null; }
export interface CreateCompanyProcessInput { cnpj: string; name?: string; email?: string | null; socios: CompanyProcessSocioInput[]; reuseExisting?: boolean; scrMode?: ScrMode; }
export interface CreateCompanyProcessResult { error: string | null; batchId?: string; memberQueryIds?: string[]; }

export async function createCompanyProcess(input: CreateCompanyProcessInput): Promise<CreateCompanyProcessResult> {
  const cnpj = onlyDigits(input.cnpj); if (!isValidCNPJ(cnpj)) return { error: "CNPJ inv\u00e1lido." };
  const socios = input.socios.map((s) => ({ ...s, cpf: onlyDigits(s.cpf) })).filter((s) => s.cpf);
  if (socios.some((s) => !isValidCPF(s.cpf))) return { error: "CPF de s\u00f3cio inv\u00e1lido." };
  const i = await identity(); if (!i) return { error: "Sess\u00e3o expirada." };
  if (!hasPermission(i.role, "consultations:write")) return { error: "N\u00e3o autorizado." };
  try {
    const email = input.email?.trim() || null;
    const created = await createCompanyBatch(i, { cnpj, name: input.name ?? null, product: DEPS_PRODUCT_PJ, scrMode: input.scrMode ?? "internal", members: [{ type: "PJ", document: cnpj, documentName: input.name ?? cnpj, email }, ...socios.map((s) => ({ type: "PF" as EntityKind, document: s.cpf, documentName: s.name ?? s.cpf, email: s.email?.trim() || email }))] });
    revalidatePath("/batch"); revalidatePath("/clients"); return { error: null, ...created };
  } catch { return { error: "Falha ao criar o processo." }; }
}

export interface ProcessMemberResult { outcome: MemberOutcome | "skipped"; }
export async function processCompanyMember(queryId: string, reuseExisting = true): Promise<ProcessMemberResult> {
  const i = await identity(); if (!i) return { outcome: "error" };
  if (!hasPermission(i.role, "consultations:write")) return { outcome: "error" };
  const member = await getCompanyMember(i, queryId); if (!member) return { outcome: "error" };
  if (member.status !== "processing") return { outcome: member.status === "completed" ? "completed" : member.status === "pending_authorization" ? "pending" : member.status === "error" || member.status === "payload_incompatible" ? "error" : "skipped" };
  const pending = async () => { await withUserTransaction(i, (client) => client.query(`update consultations set status='pending_authorization' where id=$1`, [queryId])); await upsertScrAuthorization(i, { document: member.document, type: member.type, status: "pending", name: member.document_name ?? member.document, email: member.scr_email, queryId, crmClientId: member.crm_client_id, requestedBy: i.userId }); return "pending" as const; };
  let outcome: MemberOutcome;
  if (member.scr_mode === "internal" && !(await hasValidInternalScr(i, member.document))) outcome = await pending();
  else try {
    const product = depsProductName(member.type); const raw = member.type === "PJ" ? await getDepsClient().consultPJ(member.document, { product, reuseExisting, authorization: { name: member.document_name ?? member.document, email: member.scr_email ?? undefined }, autorizacaoScr: member.scr_mode === "internal" }) : await getDepsClient().consultPF(member.document, { product, reuseExisting, authorization: { name: member.document_name ?? member.document, email: member.scr_email ?? undefined }, autorizacaoScr: member.scr_mode === "internal" });
    const saved = await executeConsultation({ identity: i, consultationId: queryId, entityKind: member.type, consult: async () => raw });
    if (saved.status === "no_data") outcome = await pending();
    else if (saved.status === "payload_incompatible") outcome = "error";
    else { await upsertScrAuthorization(i, { document: member.document, type: member.type, status: "authorized", name: saved.canonical.subject.name || member.document_name, queryId, crmClientId: member.crm_client_id, requestedBy: i.userId }); outcome = "completed"; }
  } catch (error) { if (error instanceof DepsScrPendingError) outcome = await pending(); else { await withUserTransaction(i, (client) => client.query(`update consultations set status='error',error_message=$2 where id=$1`, [queryId,error instanceof Error ? error.message : "Erro na consulta."])); outcome = "error"; } }
  if (member.batch_id) { await refreshCompanyBatchCounters(i, member.batch_id); revalidatePath(`/batch/${member.batch_id}`); revalidatePath("/batch"); }
  revalidatePath("/consultations"); revalidatePath("/clients"); return { outcome };
}

export interface GenerateCompanyReportResult { error: string | null; }
export async function generateCompanyReport(batchId: string, force = false): Promise<GenerateCompanyReportResult> {
  const i = await identity(); if (!i) return { error: "Sess\u00e3o expirada." };
  if (!hasPermission(i.role, "reports:write")) return { error: "N\u00e3o autorizado." };
  const existing = await withUserTransaction(i, async (client) => (await client.query<{ status: string }>(`select status from company_reports where batch_id=$1`, [batchId])).rows[0]);
  if (!force && existing?.status === "completed") return { error: null };
  const rows = await companyCanonicalResults(i, batchId); const company = rows.find((row) => row.type === "PJ");
  if (!company) return { error: "A consulta da empresa (CNPJ) ainda n\u00e3o foi conclu\u00edda." };
  try {
    const { parecer, model } = await generateCompanyParecer({ dataAnalise: new Date().toISOString().slice(0, 10), empresaRow: JSON.parse(JSON.stringify(company.canonical_result)), socios: rows.filter((row) => row.type === "PF").map((row) => ({ type: "PF" as const, resultRow: JSON.parse(JSON.stringify(row.canonical_result)) })) }, await getAiPrompt("empresa"));
    await withUserTransaction(i, (client) => client.query(`insert into company_reports (batch_id,aptitude_status,executive_summary,positive_points,risk_points,action_plan,suggested_products,suggested_limit,suggested_limit_notes,report_markdown,full_report,model_used,prompt_version,generated_at,generation_error,status,created_by) values ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9,$10,$11::jsonb,$12,$13,now(),null,'completed',$14) on conflict (batch_id) do update set aptitude_status=excluded.aptitude_status,executive_summary=excluded.executive_summary,positive_points=excluded.positive_points,risk_points=excluded.risk_points,action_plan=excluded.action_plan,suggested_products=excluded.suggested_products,suggested_limit=excluded.suggested_limit,suggested_limit_notes=excluded.suggested_limit_notes,report_markdown=excluded.report_markdown,full_report=excluded.full_report,model_used=excluded.model_used,prompt_version=excluded.prompt_version,generated_at=excluded.generated_at,generation_error=null,status='completed'`, [batchId,toAptitudeStatus(parecer.apto),parecer.resumo_executivo,JSON.stringify(parecer.pontos_fortes),JSON.stringify(parecer.pontos_atencao),JSON.stringify(parecer.plano_acao),JSON.stringify(parecer.produtos_sugeridos),parecer.limite_sugerido,parecer.limite_sugerido_notas,parecer.relatorio_markdown,JSON.stringify(parecer),model,COMPANY_PROMPT_VERSION,i.userId]));
  } catch (error) { await withUserTransaction(i, (client) => client.query(`insert into company_reports (batch_id,status,generation_error) values ($1,'error',$2) on conflict (batch_id) do update set status='error',generation_error=excluded.generation_error`, [batchId,error instanceof Error ? error.message : "Erro ao gerar o parecer."])); return { error: error instanceof Error ? error.message : "Erro ao gerar o parecer." }; }
  revalidatePath(`/batch/${batchId}`); return { error: null };
}
