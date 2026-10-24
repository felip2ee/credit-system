"use server";

import { revalidatePath } from "next/cache";

import { getAiPrompt } from "@/actions/settings";
import { generateCompanyParecer } from "@/lib/ai/opinion";
import { COMPANY_PROMPT_VERSION } from "@/lib/ai/prompt";
import { getRequiredSession, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { dossierCanonicalResults, getDossierDetail, saveDossierReport } from "@/lib/dossiers/queries";
import { isUuid } from "@/lib/validators/id";

const identity = async (): Promise<RequiredSession | null> => {
  try {
    return await getRequiredSession();
  } catch {
    return null;
  }
};

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
        empresaPayload: company.payload,
        socios: rows
          .filter((row) => row.type === "PF")
          .map((row) => ({ type: "PF" as const, resultRow: JSON.parse(JSON.stringify(row.canonical_result)), payload: row.payload })),
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
