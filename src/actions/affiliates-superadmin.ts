"use server";

import { revalidatePath } from "next/cache";

import { setBureauDefaultPct } from "@/lib/affiliates/rates";
import { getRequiredSession, SessionAccessError, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { bureauAffiliatePctSchema } from "@/lib/validators/affiliates";

export interface AffiliatesSuperadminResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para gerenciar afiliados.";
const SESSION_CHECK_FAILED = "Não foi possível verificar sua sessão. Tente novamente.";
const SUPPORT_BLOCKED = "Encerre a sessão de suporte para alterar a porcentagem de afiliados.";

// Só nome e código do erro: sem valores nem dados pessoais.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[affiliates] ${step} falhou`, meta);
}

async function requireAffiliateManager(): Promise<{ session: RequiredSession } | { error: string }> {
	let session: RequiredSession;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure("requireAffiliateManager", error);
		return { error: SESSION_CHECK_FAILED };
	}
	if (!hasPermission(session, "affiliates:manage")) return { error: NOT_ALLOWED };
	return { session };
}

// Única escrita da % de afiliados: uma por Bureau, só o superadmin (fora de suporte).
export async function setBureauAffiliatePctAction(values: unknown): Promise<AffiliatesSuperadminResult> {
	const parsed = bureauAffiliatePctSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	const gate = await requireAffiliateManager();
	if ("error" in gate) return { error: gate.error };
	if (gate.session.supportSessionId) return { error: SUPPORT_BLOCKED };

	const { bureauId, pct } = parsed.data;
	try {
		const result = await setBureauDefaultPct(gate.session, bureauId, pct);
		if (!result.ok) {
			return {
				error:
					result.reason === "not_found"
						? "Bureau não encontrado."
						: "A % do Bureau mais a % de afiliados passam de 100%. Reduza uma delas.",
			};
		}
	} catch (error) {
		logFailure("setBureauAffiliatePctAction", error);
		return { error: "Não foi possível salvar a porcentagem." };
	}
	revalidatePath(`/superadmin/bureaus/${bureauId}`);
	revalidatePath("/afiliados");
	return { error: null, id: bureauId };
}
