"use server";

import { z } from "zod";

import { getRequiredSession, SessionAccessError } from "@/lib/auth/session";
import { toCents } from "@/lib/catalog/money";
import { readCardFeeConfig, readPixFeeConfig, type CardFeeConfig, type PixFeeConfig } from "@/lib/config";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { isNfseConfigured } from "@/lib/nfse/invoice";
import { getOwnerPayerView, type OwnerPayerView, type PayerField } from "@/lib/payers/queries";
import { missingPayerFields } from "@/lib/payers/resolve";
import { checkoutContextSchema } from "@/lib/validators/checkout";
import { topupAmountSchema } from "@/lib/validators/wallet";
import { listInstallmentOptions } from "@/lib/wallet/card-fees";
import { getChargeStatus, type ChargeScope } from "@/lib/wallet/pix-charges";
import { computePixCharge, type ChargeSummary } from "@/lib/wallet/pix-fees";

// Dados que a tela do checkout precisa antes de enviar: só máscaras e o que falta. Nada em claro sai daqui.
export type CheckoutContextResult = {
	error: string | null;
	owner?: OwnerPayerView;
	missing?: { PIX: PayerField[]; CREDIT_CARD: PayerField[] };
	cardEnabled?: boolean;
	installmentOptions?: Array<{ installments: number; totalCents: number; installmentCents: number }>;
	// Pix: false = taxa mal configurada (a recarga por Pix falha fechada). pixCharge = recarga + taxa = total para o valor
	// digitado (nulo se o valor é inválido). A tela mostra "Recarga + taxa Pix = total".
	pixEnabled?: boolean;
	pixCharge?: ChargeSummary | null;
};

const NOT_ALLOWED = "Você não tem permissão para recarregar a carteira.";
const FAILED = "Não foi possível carregar os dados de pagamento. Tente novamente.";

type Session = Awaited<ReturnType<typeof getRequiredSession>>;

// Escopo do próprio solicitante: o cliente paga a carteira dele, o Bureau a do Bureau. Nunca vem do navegador.
function ownScope(session: Session, kind: "bureau" | "client"): ChargeScope | null {
	if (kind === "client") {
		return session.role === "client" && hasPermission(session, "credits:topup")
			? { kind: "client", clientProfileId: session.userId }
			: null;
	}
	return session.role !== "client" && session.bureauId && hasPermission(session, "wallet:topup")
		? { kind: "bureau", bureauId: session.bureauId }
		: null;
}

async function sessionOrNull(step: string): Promise<Session | null> {
	try {
		return await getRequiredSession();
	} catch (error) {
		if (!(error instanceof SessionAccessError)) {
			console.error(`[checkout] ${step} falhou em session`, { name: error instanceof Error ? error.name : typeof error });
		}
		return null;
	}
}

function cardConfig(): CardFeeConfig | null {
	try {
		return readCardFeeConfig(process.env);
	} catch (error) {
		console.error("[checkout] tabela de taxas inválida", { name: error instanceof Error ? error.name : typeof error });
		return null;
	}
}

function pixConfig(): PixFeeConfig | null {
	try {
		return readPixFeeConfig(process.env);
	} catch (error) {
		console.error("[checkout] taxa do Pix inválida", { name: error instanceof Error ? error.name : typeof error });
		return null;
	}
}

export async function getCheckoutContextAction(values: unknown): Promise<CheckoutContextResult> {
	const parsed = checkoutContextSchema.safeParse(values);
	if (!parsed.success) return { error: "Dados inválidos." };

	const session = await sessionOrNull("getCheckoutContextAction");
	const scope = session ? ownScope(session, parsed.data.scope) : null;
	if (!session || !scope) return { error: NOT_ALLOWED };

	try {
		const owner = await withUserTransaction(session, (client) => getOwnerPayerView(client, session, scope));
		const nfseOn = isNfseConfigured();
		const feeConfig = cardConfig();
		const amountOk = topupAmountSchema.safeParse(parsed.data.amount).success;
		const pixFee = pixConfig();
		return {
			error: null,
			owner,
			missing: {
				PIX: missingPayerFields(owner, "PIX", nfseOn),
				CREDIT_CARD: missingPayerFields(owner, "CREDIT_CARD", nfseOn),
			},
			cardEnabled: feeConfig !== null,
			installmentOptions: feeConfig && amountOk ? listInstallmentOptions(feeConfig, toCents(parsed.data.amount)) : [],
			pixEnabled: pixFee !== null,
			pixCharge: pixFee && amountOk ? computePixCharge(pixFee, toCents(parsed.data.amount)) : null,
		};
	} catch (error) {
		console.error("[checkout] getCheckoutContextAction falhou", { name: error instanceof Error ? error.name : typeof error });
		return { error: FAILED };
	}
}

// Consulta de status da tela (cartão em processamento). Só a cobrança do próprio solicitante.
export async function getChargeStatusAction(id: unknown): Promise<{ error: string | null; status?: string }> {
	const parsed = z.string().uuid().safeParse(id);
	if (!parsed.success) return { error: "Cobrança não encontrada." };

	const session = await sessionOrNull("getChargeStatusAction");
	const scope = session ? ownScope(session, session.role === "client" ? "client" : "bureau") : null;
	if (!session || !scope) return { error: NOT_ALLOWED };

	try {
		const charge = await withUserTransaction(session, (client) => getChargeStatus(client, parsed.data, scope));
		return charge ? { error: null, status: charge.status } : { error: "Cobrança não encontrada." };
	} catch (error) {
		console.error("[checkout] getChargeStatusAction falhou", { name: error instanceof Error ? error.name : typeof error });
		return { error: FAILED };
	}
}
