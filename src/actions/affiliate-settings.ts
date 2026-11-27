"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { setAffiliateEnabled } from "@/lib/affiliates/enabled";
import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";

export interface AffiliateSettingsResult {
	error: string | null;
}

const NOT_ALLOWED = "Você não tem permissão para alterar a seção de afiliado.";
const enabledSchema = z.object({ enabled: z.boolean({ errorMap: () => ({ message: "Dados inválidos." }) }) });

// Liga ou desliga a seção de afiliado do Bureau da sessão (o Bureau nunca vem do formulário).
export async function setAffiliateEnabledAction(values: unknown): Promise<AffiliateSettingsResult> {
	const checked = enabledSchema.safeParse(values);
	if (!checked.success) return { error: checked.error.issues[0]?.message ?? "Dados inválidos." };

	let session;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		console.error("[affiliates] setAffiliateEnabledAction: sessão falhou", { name: error instanceof Error ? error.name : typeof error });
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (!hasPermission(session, "affiliate_settings:manage")) return { error: NOT_ALLOWED };

	try {
		const result = await setAffiliateEnabled(session, { enabled: checked.data.enabled });
		if (result.error) return result;
	} catch (error) {
		console.error("[affiliates] setAffiliateEnabledAction falhou", {
			name: error instanceof Error ? error.name : typeof error,
			code: error instanceof Error && "code" in error ? error.code : undefined,
		});
		return { error: "Não foi possível salvar. Tente novamente." };
	}
	revalidatePath("/afiliados");
	revalidatePath("/portal", "layout");
	return { error: null };
}
