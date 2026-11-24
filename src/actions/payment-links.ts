"use server";

import { z } from "zod";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { config } from "@/lib/config";
import { hasPermission } from "@/lib/db/permissions";
import { createPaymentLink } from "@/lib/payment-links/queries";
import { uuidSchema } from "@/lib/validators/id";

export interface PaymentLinkActionResult {
	error: string | null;
	id?: string;
	url?: string;
}

const inputSchema = z.object({ orderId: uuidSchema });

const NOT_ALLOWED = "Você não tem permissão para gerar links de pagamento.";
const SUPPORT_ACTIVE = "Encerre a sessão de suporte para gerar links de pagamento.";
const FAILURE_MESSAGES = {
	not_found: "Consulta não encontrada.",
	not_payable: "Esta consulta não aceita link de pagamento.",
	already_paid: "Esta consulta já foi paga.",
} as const;

// Só nome e código do erro: nunca token, hash nem documento.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error ? { name: error.name, code: "code" in error ? error.code : undefined } : { name: typeof error };
	console.error(`[payment-links] ${step} falhou`, meta);
}

// Permissão "consultations:write": é a que abre o pedido de balcão (orders:create não existe no catálogo).
// Cada chamada emite um link novo e cancela o ativo (o token em claro só existe na criação): veja createPaymentLink.
export async function createPaymentLinkAction(input: { orderId: string }): Promise<PaymentLinkActionResult> {
	const parsed = inputSchema.safeParse(input);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	let session;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure("createPaymentLinkAction/session", error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (!hasPermission(session, "consultations:write")) return { error: NOT_ALLOWED };
	// O superadmin em suporte não passa pela RLS do Bureau.
	if (session.supportSessionId) return { error: SUPPORT_ACTIVE };

	try {
		const result = await createPaymentLink(session, parsed.data.orderId);
		if (!result.ok) return { error: FAILURE_MESSAGES[result.reason] };
		return { error: null, id: result.id, url: new URL(`/pagar/${result.token}`, config.betterAuthUrl).toString() };
	} catch (error) {
		logFailure("createPaymentLinkAction", error);
		return { error: "Não foi possível gerar o link." };
	}
}
