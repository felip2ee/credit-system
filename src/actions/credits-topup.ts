"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { getAsaasClient } from "@/lib/asaas";
import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { walletTopupSchema } from "@/lib/validators/wallet";
import { getClientWallet } from "@/lib/wallet/client-queries";
import {
	countPendingClientPixCharges,
	createClientPixCharge,
	lockClientPixCharges,
	MAX_PENDING_PIX_CHARGES,
} from "@/lib/wallet/pix-charges";

// Nada do Asaas além do que o QR precisa: o id do pagamento fica no servidor.
export interface ClientTopupActionResult {
	error: string | null;
	id?: string;
	pixPayload?: string;
	qrImageBase64?: string;
	expiresAt?: string;
}

const NOT_ALLOWED = "Você não tem permissão para recarregar a carteira.";
const FAILED = "Não foi possível gerar o PIX. Tente novamente.";
const NO_WALLET = "Carteira não encontrada. Contate o suporte.";
const TOO_MANY_PENDING = "Há PIX pendentes demais. Pague ou aguarde expirar antes de gerar outro.";
const DESCRIPTION = "Recarga de créditos";

// Só nome e código do erro: sem valores, chaves nem corpo da resposta do Asaas.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[credits] requestClientTopupAction falhou em ${step}`, meta);
}

// Cobrança criada no Asaas sem linha no banco: um pagamento nela não credita nada. Alto e claro para a conciliação.
function logOrphan(reason: string, asaasPaymentId: string, externalReference: string): void {
	console.error("[credits] COBRANÇA ÓRFÃ no Asaas: sem linha no banco, o webhook não a credita", {
		reason,
		asaasPaymentId,
		externalReference,
	});
}

export async function requestClientTopupAction(values: unknown): Promise<ClientTopupActionResult> {
	const parsed = walletTopupSchema.safeParse(values);
	if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dados inválidos." };

	let session;
	try {
		session = await getRequiredSession();
	} catch (error) {
		if (error instanceof SessionAccessError) return { error: NOT_ALLOWED };
		logFailure("session", error);
		return { error: "Não foi possível verificar sua sessão. Tente novamente." };
	}
	if (!hasPermission(session, "credits:topup")) return { error: NOT_ALLOWED };

	const { amount } = parsed.data;

	// Antes do Asaas: cobrança externa sem carteira ou acima do limite ficaria sem destino. É só uma triagem barata;
	// o teto de verdade é conferido de novo, sob lock, na mesma transação do insert.
	let blocked: string | null;
	try {
		blocked = await withUserTransaction(session, async (client) => {
			if (!(await getClientWallet(client, session.userId))) return NO_WALLET;
			if ((await countPendingClientPixCharges(client, session.userId)) >= MAX_PENDING_PIX_CHARGES)
				return TOO_MANY_PENDING;
			return null;
		});
	} catch (error) {
		logFailure("precheck", error);
		return { error: FAILED };
	}
	if (blocked) return { error: blocked };

	const externalReference = randomUUID();
	let charge;
	try {
		charge = await getAsaasClient().createPixCharge({ amount, externalReference, description: DESCRIPTION });
	} catch (error) {
		logFailure("asaas", error);
		return { error: FAILED };
	}

	// pix_charges não tem coluna para a referência e a linha precisa do id do pagamento: a linha só nasce depois do Asaas.
	// Se ela não for salva, o webhook não acha a cobrança: o log abaixo (id do pagamento e referência) permite conciliar.
	try {
		const saved = await withUserTransaction(session, async (client) => {
			await lockClientPixCharges(client, session.userId);
			if ((await countPendingClientPixCharges(client, session.userId)) >= MAX_PENDING_PIX_CHARGES) return null;
			return createClientPixCharge(client, session, {
				asaasPaymentId: charge.asaasPaymentId,
				pixPayload: charge.pixPayload,
				amount,
			});
		});
		if (saved === null) {
			logOrphan("limite", charge.asaasPaymentId, externalReference);
			return { error: TOO_MANY_PENDING };
		}
		if (!saved.ok) {
			logOrphan("valor", charge.asaasPaymentId, externalReference);
			return { error: "Valor inválido." };
		}
		revalidatePath("/portal/credits");
		return {
			error: null,
			id: saved.id,
			pixPayload: charge.pixPayload,
			qrImageBase64: charge.qrImageBase64,
			expiresAt: saved.expiresAt.toISOString(),
		};
	} catch (error) {
		logFailure("save", error);
		logOrphan("save", charge.asaasPaymentId, externalReference);
		return { error: FAILED };
	}
}
