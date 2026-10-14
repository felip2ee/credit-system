"use server";

import { revalidatePath } from "next/cache";

import { getRequiredSession, SessionAccessError, type RequiredSession } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { isNfseConfigured, rescheduleInvoice } from "@/lib/nfse/invoice";
import { requestNfseRetry, type NfseFailure } from "@/lib/nfse/queries";
import { retryNfseSchema } from "@/lib/validators/nfse";

export interface NfseActionResult {
	error: string | null;
	id?: string;
}

const NOT_ALLOWED = "Você não tem permissão para reenviar notas fiscais.";
const SUPPORT_ACTIVE = "Encerre a sessão de suporte para reenviar notas fiscais.";

const FAILURE_MESSAGES: Record<NfseFailure, string> = {
	not_allowed: NOT_ALLOWED,
	not_found: "Cobrança não encontrada.",
	invalid_state: "Só uma nota com falha pode ser reenviada.",
	invalid_status: "Status de nota inválido.",
	invalid_number: "Número de nota inválido.",
	invalid_url: "Endereço da nota inválido.",
};

// Só nome e código do erro: sem dados da cobrança nem do Asaas.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[nfse] ${step} falhou`, meta);
}

// Nova tentativa de nota: só o superadmin fora de suporte. A nota nunca toca a carteira.
export async function retryNfseAction(values: unknown): Promise<NfseActionResult> {
	const parsed = retryNfseSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	let session: RequiredSession;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure("retryNfseAction.session", error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (session.role !== "superadmin" || !hasPermission(session, "nfse:manage")) return { error: NOT_ALLOWED };
	if (session.supportSessionId || session.support) return { error: SUPPORT_ACTIVE };
	// Sem configuração a nota voltaria a pending sem ninguém para agendá-la.
	if (!isNfseConfigured()) return { error: "A NFS-e não está configurada neste ambiente." };

	const { chargeId } = parsed.data;
	try {
		const retry = await requestNfseRetry(session, chargeId);
		if (!retry.ok) return { error: FAILURE_MESSAGES[retry.reason] };

		const outcome = await rescheduleInvoice(session, chargeId);
		revalidatePath("/superadmin/nfse");
		if (outcome === "pending") return { error: null, id: chargeId };
		return { error: "A nova tentativa falhou; a nota continua com falha." };
	} catch (error) {
		logFailure("retryNfseAction", error);
		return { error: "Falha ao pedir a nova tentativa da nota." };
	}
}
