"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { upsertPartner } from "@/lib/partners/queries";
import { partnerSchema } from "@/lib/validators/partners";

export interface PartnerActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para gerenciar sócios.";
const SUPPORT_BLOCKED = "Encerre a sessão de suporte para alterar os sócios.";

// Só nome e código do erro: sem walletId nem dados pessoais.
function logFailure(error: unknown): void {
	const meta = error instanceof Error ? { name: error.name, code: "code" in error ? error.code : undefined } : { name: typeof error };
	console.error("[partners] upsertPartnerAction falhou", meta);
}

export async function upsertPartnerAction(values: unknown): Promise<PartnerActionResult> {
	const parsed = partnerSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	let session;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure(error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (!hasPermission(session, "partner:manage")) return { error: NOT_ALLOWED };
	if (session.supportSessionId) return { error: SUPPORT_BLOCKED };

	try {
		const result = await upsertPartner(session, parsed.data);
		if (result.error) return result;
		revalidatePath("/superadmin/settings/socios");
		return result;
	} catch (error) {
		logFailure(error);
		return { error: "Não foi possível salvar o sócio." };
	}
}
