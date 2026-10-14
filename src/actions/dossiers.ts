"use server";

import { revalidatePath } from "next/cache";

import { getAiPrompt } from "@/actions/settings";
import type { ScrMode } from "@/actions/consultations";
import { generateCompanyParecer } from "@/lib/ai/opinion";
import { COMPANY_PROMPT_VERSION } from "@/lib/ai/prompt";
import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { executeConsultation } from "@/lib/consultations/service";
import { getDepsClient } from "@/lib/deps/client";
import { DepsScrPendingError } from "@/lib/deps/errors";
import { depsProductName } from "@/lib/deps/products";
import {
  createDossier as createDossierQuery,
  dossierCanonicalResults,
  getDossierDetail,
  getDossierMember,
  refreshDossierStatus,
  saveDossierReport,
  type DossierKindFilter,
} from "@/lib/dossiers/queries";
import { hasValidInternalScr, upsertScrAuthorization } from "@/lib/scr/queries";
import { createDossierSchema } from "@/lib/validators/dossier";
import { isUuid } from "@/lib/validators/id";

const identity = async (): Promise<RequiredSession | null> => {
  try {
    return await getRequiredSession();
  } catch {
    return null;
  }
};

type MemberOutcome = "completed" | "pending" | "error";

export interface DossierPartnerFormInput {
  cpf: string;
  name?: string;
  email?: string | null;
  percentage?: number | null;
  role?: string | null;
}
export interface CreateDossierInput {
  kind: DossierKindFilter;
  document: string;
  name?: string;
  email?: string | null;
  partners?: DossierPartnerFormInput[];
  scrMode?: ScrMode;
}
export interface CreateDossierResult {
  error: string | null;
  dossierId?: string;
  consultationIds?: string[];
}

export async function createDossier(input: CreateDossierInput): Promise<CreateDossierResult> {
  const parsed = createDossierSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  const { kind, document, name, email, partners, scrMode } = parsed.data;
  const type = kind === "PF" ? "PF" : "PJ";

  const session = await identity();
  if (!session) return { error: "Sessão expirada." };
  if (!hasPermission(session, "consultations:write")) return { error: "Não autorizado." };

  try {
    const created = await createDossierQuery(session, {
      kind,
      holder: { type, name: name || document, document },
      partners: partners.map((p) => ({ ...p, document: p.cpf })),
      scrMode,
      email,
    });
    if (!created.ok) return { error: "O tipo do Titular não combina com o tipo do Dossiê." };
    revalidatePath("/dossiers");
    revalidatePath("/holders");
    return { error: null, dossierId: created.id, consultationIds: created.consultationIds };
  } catch {
    return { error: "Falha ao criar o Dossiê." };
  }
}

export interface ProcessMemberResult {
  outcome: MemberOutcome | "skipped";
}

export async function processDossierMember(
  consultationId: string,
  reuseExisting = true,
): Promise<ProcessMemberResult> {
  if (!isUuid(consultationId)) return { outcome: "error" };
  const i = await identity();
  if (!i) return { outcome: "error" };
  if (!hasPermission(i, "consultations:write")) return { outcome: "error" };
  const member = await getDossierMember(i, consultationId);
  if (!member) return { outcome: "error" };
  if (member.status !== "processing") {
    if (member.status === "completed") return { outcome: "completed" };
    if (member.status === "pending_authorization") return { outcome: "pending" };
    return { outcome: member.status === "error" || member.status === "payload_incompatible" ? "error" : "skipped" };
  }

  const scr = { document: member.document, type: member.type, queryId: consultationId, holderId: member.holder_id, requestedBy: i.userId };
  const pending = async (): Promise<MemberOutcome> => {
    await withUserTransaction(i, (client) =>
      client.query(`update consultations set status='pending_authorization' where id=$1`, [consultationId]),
    );
    await upsertScrAuthorization(i, { ...scr, status: "pending", name: member.document_name ?? member.document, email: member.scr_email });
    return "pending";
  };

  let outcome: MemberOutcome;
  if (member.scr_mode === "internal" && !(await hasValidInternalScr(i, member.document))) {
    outcome = await pending();
  } else {
    try {
      const options = {
        product: depsProductName(member.type),
        reuseExisting,
        authorization: { name: member.document_name ?? member.document, email: member.scr_email ?? undefined },
        autorizacaoScr: member.scr_mode === "internal",
      };
      const deps = getDepsClient();
      const raw = member.type === "PJ" ? await deps.consultPJ(member.document, options) : await deps.consultPF(member.document, options);
      const saved = await executeConsultation({ identity: i, consultationId, entityKind: member.type, consult: async () => raw });
      if (saved.status === "no_data") outcome = await pending();
      else if (saved.status === "payload_incompatible") outcome = "error";
      else {
        await upsertScrAuthorization(i, { ...scr, status: "authorized", name: saved.canonical.subject.name || member.document_name });
        outcome = "completed";
      }
    } catch (error) {
      if (error instanceof DepsScrPendingError) outcome = await pending();
      else {
        await withUserTransaction(i, (client) =>
          client.query(`update consultations set status='error',error_message=$2 where id=$1`, [
            consultationId,
            error instanceof Error ? error.message : "Erro na consulta.",
          ]),
        );
        outcome = "error";
      }
    }
  }

  await withUserTransaction(i, (client) => refreshDossierStatus(client, member.dossier_id));
  revalidatePath(`/dossiers/${member.dossier_id}`);
  revalidatePath("/dossiers");
  revalidatePath("/holders");
  revalidatePath(`/holders/${member.holder_id}`);
  return { outcome };
}

export interface GenerateDossierReportResult {
  error: string | null;
}

export async function generateDossierReport(dossierId: string, force = false): Promise<GenerateDossierReportResult> {
  if (!isUuid(dossierId)) return { error: "Dossiê não encontrado." };
  const i = await identity();
  if (!i) return { error: "Sessão expirada." };
  if (!hasPermission(i, "reports:write")) return { error: "Não autorizado." };

  const detail = await getDossierDetail(i, dossierId);
  if (!detail) return { error: "Dossiê não encontrado." };
  if (!force && detail.report?.status === "completed") return { error: null };

  const rows = await dossierCanonicalResults(i, dossierId);
  const company = rows.find((row) => row.type === "PJ");
  if (!company) return { error: "A consulta da empresa (CNPJ) ainda não foi concluída." };

  try {
    const { parecer, model } = await generateCompanyParecer(
      {
        dataAnalise: new Date().toISOString().slice(0, 10),
        empresaRow: JSON.parse(JSON.stringify(company.canonical_result)),
        socios: rows
          .filter((row) => row.type === "PF")
          .map((row) => ({ type: "PF" as const, resultRow: JSON.parse(JSON.stringify(row.canonical_result)) })),
      },
      await getAiPrompt("empresa"),
    );
    await saveDossierReport(i, dossierId, { status: "completed", parecer, model, promptVersion: COMPANY_PROMPT_VERSION });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro ao gerar o parecer.";
    await saveDossierReport(i, dossierId, { status: "error", error: message });
    return { error: message };
  }
  revalidatePath(`/dossiers/${dossierId}`);
  revalidatePath("/dossiers");
  revalidatePath(`/holders/${detail.dossier.holder_id}`);
  return { error: null };
}
