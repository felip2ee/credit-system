"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { walletAdjustSchema } from "@/lib/validators/wallet";
import { adjustWalletWithAudit, type WalletFailure } from "@/lib/wallet/queries";

export interface WalletActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para ajustar a carteira.";
const SUPPORT_ACTIVE = "Encerre a sessão de suporte para ajustar a carteira.";

const FAILURE_MESSAGES: Record<WalletFailure, string> = {
	insufficient_balance: "O ajuste deixaria o saldo disponível negativo.",
	idempotency_conflict: "Este envio já foi usado com outros dados. Recarregue a página e tente de novo.",
	not_found: "Bureau não encontrado.",
	invalid_amount: "Valor inválido.",
	invalid_key: "Envio inválido. Recarregue a página e tente de novo.",
	reason_required: "Informe o motivo do ajuste.",
	reservation_exceeded: "Valor inválido.",
	not_allowed: NOT_ALLOWED,
};

// Só nome e código do erro: sem valores nem dados pessoais.
function logFailure(error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error("[wallet] adjustWalletAction falhou", meta);
}

// Ajuste manual: só o superadmin, fora de suporte (a auditoria é de plataforma, como o custo por Bureau).
export async function adjustWalletAction(values: unknown): Promise<WalletActionResult> {
	const parsed = walletAdjustSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	let session;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure(error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (session.role !== "superadmin" || !hasPermission(session, "wallet:adjust")) return { error: NOT_ALLOWED };
	if (session.supportSessionId || session.support) return { error: SUPPORT_ACTIVE };

	try {
		const result = await adjustWalletWithAudit(session, parsed.data);
		if (!result.ok) return { error: FAILURE_MESSAGES[result.reason] };
		revalidatePath(`/superadmin/bureaus/${parsed.data.bureauId}`);
		return { error: null, id: result.entryId };
	} catch (error) {
		logFailure(error);
		return { error: "Falha ao ajustar a carteira." };
	}
}
