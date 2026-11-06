"use server";

import { headers } from "next/headers";

import { requestMeta } from "@/lib/account/request-meta";
import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { runCheckout, type CheckoutActionResult } from "@/lib/payments/checkout";
import { checkoutSchema } from "@/lib/validators/checkout";

// Recarga da carteira do Bureau (Pix ou cartão). Nada do Asaas além do que a tela precisa: o id do pagamento fica no servidor.
export type TopupActionResult = CheckoutActionResult;

const NOT_ALLOWED = "Você não tem permissão para recarregar a carteira.";
const NO_IP = "Não foi possível validar sua conexão. Tente novamente.";
const DESCRIPTION = "Recarga de carteira";

export async function requestTopupAction(values: unknown): Promise<TopupActionResult> {
	const parsed = checkoutSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	let session;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		console.error("[wallet] requestTopupAction falhou em session", { name: error instanceof Error ? error.name : typeof error });
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (!hasPermission(session, "wallet:topup") || !session.bureauId) return { error: NOT_ALLOWED };

	const { ip } = requestMeta(await headers());
	// O Asaas exige o IP de quem paga no cartão: sem ele a cobrança não sai (nunca o IP do servidor).
	if (parsed.data.method === "CREDIT_CARD" && !ip) return { error: NO_IP };

	return runCheckout(session, { kind: "bureau", bureauId: session.bureauId }, parsed.data, {
		remoteIp: ip ?? "",
		description: DESCRIPTION,
	});
}
