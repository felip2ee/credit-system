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
	bindPixCharge,
	cancelUnboundPixCharge,
	countPendingClientPixCharges,
	lockClientPixCharges,
	MAX_PENDING_PIX_CHARGES,
	reserveClientPixCharge,
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

type ReserveOutcome = { id: string; expiresAt: Date } | { blocked: string };

// Só nome e código do erro: sem valores, chaves nem corpo da resposta do Asaas.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[credits] requestClientTopupAction falhou em ${step}`, meta);
}

// Cobrança criada no Asaas e não ligada à linha reservada: a linha segue pendente, com a referência externa, e o webhook a
// credita por payment.externalReference. Alto e claro para a conciliação.
function logUnbound(chargeId: string, asaasPaymentId: string, externalReference: string): void {
	console.error("[credits] COBRANÇA sem ligação no banco: o webhook a acha pela referência externa", {
		chargeId,
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

	// Antes do Asaas, sob lock por cliente: a linha reservada conta no teto, então o clique duplo ou o limite estourado
	// nunca chega a criar cobrança externa. A linha leva a referência externa, que o webhook usa se o bind falhar.
	const externalReference = randomUUID();
	let reserved: ReserveOutcome;
	try {
		reserved = await withUserTransaction(session, async (client) => {
			if (!(await getClientWallet(client, session.userId))) return { blocked: NO_WALLET };
			await lockClientPixCharges(client, session.userId);
			if ((await countPendingClientPixCharges(client, session.userId)) >= MAX_PENDING_PIX_CHARGES)
				return { blocked: TOO_MANY_PENDING };
			const row = await reserveClientPixCharge(client, session, { externalReference, amount });
			return row.ok ? { id: row.id, expiresAt: row.expiresAt } : { blocked: "Valor inválido." };
		});
	} catch (error) {
		logFailure("reserve", error);
		return { error: FAILED };
	}
	if ("blocked" in reserved) return { error: reserved.blocked };

	let charge;
	try {
		charge = await getAsaasClient().createPixCharge({ amount, externalReference, description: DESCRIPTION });
	} catch (error) {
		logFailure("asaas", error);
		// Fecha a linha para ela sair do teto; se isto falhar, ela expira sozinha em PIX_CHARGE_TTL_MINUTES.
		await withUserTransaction(session, (client) => cancelUnboundPixCharge(client, reserved.id)).catch((cancelError) =>
			logFailure("cancel", cancelError),
		);
		return { error: FAILED };
	}

	try {
		const bound = await withUserTransaction(session, (client) =>
			bindPixCharge(client, reserved.id, { asaasPaymentId: charge.asaasPaymentId, pixPayload: charge.pixPayload }),
		);
		if (!bound) {
			logUnbound(reserved.id, charge.asaasPaymentId, externalReference);
			return { error: FAILED };
		}
	} catch (error) {
		logFailure("bind", error);
		logUnbound(reserved.id, charge.asaasPaymentId, externalReference);
		return { error: FAILED };
	}
	revalidatePath("/portal/credits");
	return {
		error: null,
		id: reserved.id,
		pixPayload: charge.pixPayload,
		qrImageBase64: charge.qrImageBase64,
		expiresAt: reserved.expiresAt.toISOString(),
	};
}
