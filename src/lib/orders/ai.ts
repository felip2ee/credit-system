// Parecer de IA do pedido (M6). Sem sessão: usa a identidade do Bureau e os prompts do próprio Bureau.
// Falha devolve "failed" sem log do conteúdo; o tick conta a tentativa em dossier_orders.ai_attempts.
import { generateCompanyParecer, generateParecer } from "@/lib/ai/opinion";
import { saveConsultationOpinion } from "@/lib/ai/persist";
import { COMPANY_PROMPT_VERSION } from "@/lib/ai/prompt";
import { loadCanonicalResult, loadLatestPayload } from "@/lib/consultations/canonical-store";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { dossierCanonicalResults, saveDossierReport } from "@/lib/dossiers/queries";
import { readAiPrompt } from "@/lib/settings/readers";

import { getExecutionPlan } from "./queries";
import type { OrderKind } from "./types";

const today = () => new Date().toISOString().slice(0, 10);

async function generateConsultationOpinion(identity: DbIdentity, dossierId: string): Promise<void> {
	const plan = await withUserTransaction(identity, (client) => getExecutionPlan(client, dossierId));
	const main = plan?.members.find((m) => m.isMain && m.status === "completed");
	if (!main) throw new Error("generateOrderAi: main consultation not completed");
	const canonical = await loadCanonicalResult(identity, main.consultationId);
	if (!canonical) throw new Error("generateOrderAi: canonical result not found");
	const { parecer, model } = await generateParecer(
		{ type: main.type, dataAnalise: today(), canonical, payload: await loadLatestPayload(identity, main.consultationId) },
		await readAiPrompt(identity, main.type === "PJ" ? "pj" : "pf"),
	);
	await withUserTransaction(identity, (client) =>
		saveConsultationOpinion(client, identity, main.consultationId, main.holderId, {
			status: "completed",
			parecer,
			model,
			documentName: main.name,
		}),
	);
}

async function generateGroupReport(identity: DbIdentity, dossierId: string): Promise<void> {
	const rows = await dossierCanonicalResults(identity, dossierId);
	const company = rows.find((row) => row.type === "PJ");
	if (!company) throw new Error("generateOrderAi: company consultation not completed");
	const { parecer, model } = await generateCompanyParecer(
		{
			dataAnalise: today(),
			empresaRow: JSON.parse(JSON.stringify(company.canonical_result)),
			empresaPayload: company.payload,
			socios: rows
				.filter((row) => row.type === "PF")
				.map((row) => ({ type: "PF" as const, resultRow: JSON.parse(JSON.stringify(row.canonical_result)), payload: row.payload })),
		},
		await readAiPrompt(identity, "empresa"),
	);
	await saveDossierReport(identity, dossierId, { status: "completed", parecer, model, promptVersion: COMPANY_PROMPT_VERSION });
}

export async function generateOrderAi(identity: DbIdentity, dossierId: string, kind: OrderKind): Promise<"done" | "failed"> {
	try {
		if (kind === "PJ_FULL") await generateGroupReport(identity, dossierId);
		else await generateConsultationOpinion(identity, dossierId);
		return "done";
	} catch (error) {
		// Só o nome: a mensagem pode trazer trecho do documento ou da resposta do modelo.
		console.warn("[orders-ai] falha ao gerar o parecer", { name: error instanceof Error ? error.name : typeof error });
		return "failed";
	}
}
