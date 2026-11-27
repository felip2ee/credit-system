"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { setBureauWalletId } from "@/lib/partners/queries";
import { bureauWalletSchema } from "@/lib/validators/partners";

export interface BureauWalletResult {
	error: string | null;
}

const NOT_ALLOWED = "Você não tem permissão para alterar o walletId do Bureau.";
const SUPPORT_BLOCKED = "Encerre a sessão de suporte para alterar o walletId do Bureau.";

// Só nome e código do erro: sem walletId.
function logFailure(error: unknown): void {
	const meta = error instanceof Error ? { name: error.name, code: "code" in error ? error.code : undefined } : { name: typeof error };
	console.error("[bureau-wallet] setBureauWalletIdAction falhou", meta);
}

export async function setBureauWalletIdAction(values: unknown): Promise<BureauWalletResult> {
	const parsed = bureauWalletSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };
	let session;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure(error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (!hasPermission(session, "bureau_wallet:manage")) return { error: NOT_ALLOWED };
	if (session.supportSessionId) return { error: SUPPORT_BLOCKED };

	try {
		const result = await setBureauWalletId(session, parsed.data);
		if (result.error) return result;
		revalidatePath(`/superadmin/bureaus/${parsed.data.bureauId}`);
		return result;
	} catch (error) {
		logFailure(error);
		return { error: "Não foi possível salvar o walletId." };
	}
}
