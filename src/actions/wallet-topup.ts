"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";

import { getAsaasClient } from "@/lib/asaas";
import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { walletTopupSchema } from "@/lib/validators/wallet";
import { countPendingPixCharges, createPixCharge, MAX_PENDING_PIX_CHARGES } from "@/lib/wallet/pix-charges";
import { getWallet } from "@/lib/wallet/queries";

// Nada do Asaas além do que o QR precisa: o id do pagamento fica no servidor.
export interface TopupActionResult {
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
const DESCRIPTION = "Recarga de carteira";

// Só nome e código do erro: sem valores, chaves nem corpo da resposta do Asaas.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[wallet] requestTopupAction falhou em ${step}`, meta);
}

export async function requestTopupAction(values: unknown): Promise<TopupActionResult> {
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
	if (!hasPermission(session, "wallet:topup")) return { error: NOT_ALLOWED };

	const { amount } = parsed.data;

	// Antes do Asaas: cobrança externa sem carteira ou acima do limite ficaria sem destino.
	const { bureauId } = session;
	let blocked: string | null;
	try {
		blocked = await withUserTransaction(session, async (client) => {
			if (!bureauId || !(await getWallet(client, bureauId))) return NO_WALLET;
			if ((await countPendingPixCharges(client, bureauId)) >= MAX_PENDING_PIX_CHARGES) return TOO_MANY_PENDING;
			return null;
		});
	} catch (error) {
		logFailure("precheck", error);
		return { error: FAILED };
	}
	if (blocked) return { error: blocked };

	let charge;
	try {
		charge = await getAsaasClient().createPixCharge({
			amount,
			externalReference: randomUUID(),
			description: DESCRIPTION,
		});
	} catch (error) {
		logFailure("asaas", error);
		return { error: FAILED };
	}

	// A linha só nasce depois que o Asaas respondeu: uma falha acima não deixa cobrança pendente órfã.
	try {
		const saved = await withUserTransaction(session, (client) =>
			createPixCharge(client, session, {
				asaasPaymentId: charge.asaasPaymentId,
				pixPayload: charge.pixPayload,
				amount,
			}),
		);
		if (!saved.ok) return { error: "Valor inválido." };
		revalidatePath("/settings/wallet");
		return {
			error: null,
			id: saved.id,
			pixPayload: charge.pixPayload,
			qrImageBase64: charge.qrImageBase64,
			expiresAt: saved.expiresAt.toISOString(),
		};
	} catch (error) {
		logFailure("save", error);
		return { error: FAILED };
	}
}
