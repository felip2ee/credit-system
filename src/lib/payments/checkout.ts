// Checkout das duas recargas (Pix e cartão): reserva a linha, resolve o cliente Asaas do pagador e cria a cobrança.
// Spec: docs/superpowers/specs/2026-11-06-pagamento-por-pagador-design.md. Nenhuma chamada HTTP roda dentro de transação.
// Nada aqui grava em log, erro, auditoria ou retorno: número do cartão, CVV, validade, CPF/CNPJ ou CEP completos.
import { revalidatePath } from "next/cache";
import type { PoolClient } from "pg";

import { getClientAccountStatus } from "@/lib/account/queries";
import { AsaasOutcomeUnknownError, CardDeclinedError, getAsaasClient } from "@/lib/asaas";
import { toCents } from "@/lib/catalog/money";
import { readCardFeeConfig, readPiiKeyring, type PiiKeyring } from "@/lib/config";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { maskPayerDocument } from "@/lib/mask-document";
import { isNfseConfigured } from "@/lib/nfse/invoice";
import { PiiDecryptError } from "@/lib/pii/crypto";
import { claimAsaasCustomer, markPayerSynced } from "@/lib/payers/queries";
import { asaasPhone, resolveAsaasCustomer } from "@/lib/payers/resolve";
import { BlockedError, otherPayer, ownerPayer, type PayerSource } from "./payer-source";
import type { CheckoutInput } from "@/lib/validators/checkout";
import { getClientWallet } from "@/lib/wallet/client-queries";
import { CardFeeError, computeCardCharge } from "@/lib/wallet/card-fees";
import {
	bindAsaasCharge,
	cancelUnboundPixCharge,
	countPendingClientPixCharges,
	countPendingPixCharges,
	countRecentCardAttempts,
	lockChargeScope,
	MAX_CARD_ATTEMPTS_PER_HOUR,
	MAX_PENDING_PIX_CHARGES,
	reserveCharge,
	setChargeCustomer,
	type BillingType,
	type ChargeScope,
} from "@/lib/wallet/pix-charges";
import { getWallet } from "@/lib/wallet/queries";

export type CheckoutResult =
	| { error: null; id: string; method: "PIX"; pixPayload: string; qrImageBase64: string; expiresAt: string }
	// Cartão enviado: o crédito só vem pelo webhook. A tela consulta o status.
	| { error: null; id: string; method: "CREDIT_CARD" }
	// Mesma chave de idempotência já usada: o pedido original segue; a tela consulta o status.
	| { error: null; id: string; method: BillingType; reused: true }
	| { error: string };

// Contrato das actions de recarga: o mesmo formato achatado do Pix de antes, com os campos novos opcionais.
export interface CheckoutActionResult {
	error: string | null;
	id?: string;
	method?: BillingType;
	pixPayload?: string;
	qrImageBase64?: string;
	expiresAt?: string;
	// true = a mesma chave de idempotência já tinha pedido: a tela consulta o status em vez de mostrar o QR.
	reused?: boolean;
}

type CheckoutMeta = { remoteIp: string; description: string };

const UNAVAILABLE = "Pagamento indisponível. Contate o suporte.";
const FAILED_PIX = "Não foi possível gerar o PIX. Tente novamente.";
const FAILED_CARD = "Não foi possível processar o cartão. Tente novamente.";
const CARD_OFF = "Pagamento no cartão indisponível no momento.";
const EMAIL_NOT_VERIFIED = "Confirme seu e-mail antes de comprar créditos.";
const NO_WALLET = "Carteira não encontrada. Contate o suporte.";
const TOO_MANY_PENDING = "Há PIX pendentes demais. Pague ou aguarde expirar antes de gerar outro.";
const TOO_MANY_CARD_ATTEMPTS = "Muitas tentativas de cartão. Aguarde um pouco antes de tentar de novo.";
const BAD_AMOUNT = "Valor inválido.";
const REFERENCE_TAKEN = "Pedido já usado. Tente novamente.";

const MISSING_FIELDS = "Preencha os dados de pagamento que faltam.";

const CARD_FEE_MESSAGES: Record<CardFeeError["code"], string> = {
	invalid_amount: BAD_AMOUNT,
	installments_out_of_range: "Número de parcelas inválido.",
	installment_below_minimum: "Parcela abaixo do mínimo. Escolha menos parcelas.",
};

// Só nome e código do erro: sem valores, chaves nem corpo da resposta do Asaas.
function logFailure(step: string, error: unknown): void {
	const meta =
		error instanceof Error
			? { name: error.name, code: "code" in error ? error.code : undefined }
			: { name: typeof error };
	console.error(`[checkout] falhou em ${step}`, meta);
}

type CardPlan = { totalCents: number; feeCents: number; installmentCents: number[] };

// O total vem do servidor: o que o navegador mandar além de amount e installments não conta.
function planCard(input: CheckoutInput): CardPlan | null {
	if (input.method === "PIX") return null;
	let feeConfig;
	try {
		feeConfig = readCardFeeConfig(process.env);
	} catch (error) {
		logFailure("tabela de taxas", error);
		throw new BlockedError(CARD_OFF);
	}
	if (!feeConfig) throw new BlockedError(CARD_OFF);
	try {
		return computeCardCharge(feeConfig, { rechargeCents: toCents(input.amount), installments: input.installments ?? 1 });
	} catch (error) {
		if (error instanceof CardFeeError) throw new BlockedError(CARD_FEE_MESSAGES[error.code]);
		throw error;
	}
}

async function assertWalletReady(
	client: PoolClient,
	session: DbIdentity,
	scope: ChargeScope,
): Promise<void> {
	if (scope.kind === "client") {
		// Primeiro de tudo: sem e-mail confirmado nenhuma linha é reservada nem o Asaas é chamado.
		if (!(await getClientAccountStatus(client, session.userId)).emailVerified) throw new BlockedError(EMAIL_NOT_VERIFIED);
		if (!(await getClientWallet(client, scope.clientProfileId))) throw new BlockedError(NO_WALLET);
		return;
	}
	if (!(await getWallet(client, scope.bureauId))) throw new BlockedError(NO_WALLET);
}

// Depois da reserva e sob o lock do dono: a contagem já inclui a linha nova, então o teto é "maior que". Estourou =
// BlockedError e a transação desfaz a linha (e a gravação do pagador).
async function enforceLimits(
	client: PoolClient,
	session: DbIdentity,
	scope: ChargeScope,
	method: BillingType,
): Promise<void> {
	if (method === "CREDIT_CARD") {
		if ((await countRecentCardAttempts(client, session.userId)) > MAX_CARD_ATTEMPTS_PER_HOUR) {
			throw new BlockedError(TOO_MANY_CARD_ATTEMPTS);
		}
		return;
	}
	const pending =
		scope.kind === "client"
			? await countPendingClientPixCharges(client, scope.clientProfileId)
			: await countPendingPixCharges(client, scope.bureauId);
	if (pending > MAX_PENDING_PIX_CHARGES) throw new BlockedError(TOO_MANY_PENDING);
}

type Reserved = { chargeId: string; expiresAt: Date; reused: boolean; source: PayerSource };

async function reserve(
	session: DbIdentity,
	scope: ChargeScope,
	input: CheckoutInput,
	plan: CardPlan | null,
	keyring: PiiKeyring,
): Promise<Reserved> {
	const nfseOn = isNfseConfigured();
	return withUserTransaction(session, async (client) => {
		await lockChargeScope(client, scope);
		await assertWalletReady(client, session, scope);
		const source =
			input.payerKind === "owner"
				? await ownerPayer(client, session, scope, input, keyring, nfseOn)
				: otherPayer(input, nfseOn);

		const reserved = await reserveCharge(client, session, {
			scope,
			externalReference: input.idempotencyKey,
			amount: input.amount,
			billingType: input.method,
			installments: plan ? (input.installments ?? 1) : 1,
			feeAmount: plan ? centsToReais(plan.feeCents) : "0.00",
			totalCharged: plan ? centsToReais(plan.totalCents) : null,
			payerKind: input.payerKind,
			payerDocumentMasked: maskPayerDocument(source.payer.cpfCnpj),
		});
		if (!reserved.ok) throw new BlockedError(reserved.reason === "invalid_amount" ? BAD_AMOUNT : REFERENCE_TAKEN);
		if (!reserved.reused) await enforceLimits(client, session, scope, input.method);
		return { chargeId: reserved.id, expiresAt: reserved.expiresAt, reused: reserved.reused, source };
	});
}

function centsToReais(cents: number): string {
	return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// Falha definitiva antes de existir cobrança no Asaas: fecha a linha para ela sair do teto de pendentes (se isto
// falhar, ela expira sozinha). A tentativa de cartão continua contada: a contagem olha qualquer estado.
async function cancelReserved(session: DbIdentity, chargeId: string): Promise<void> {
	await withUserTransaction(session, (client) => cancelUnboundPixCharge(client, chargeId)).catch((error) =>
		logFailure("cancel", error),
	);
}

async function resolveCustomer(session: DbIdentity, chargeId: string, source: PayerSource, kind: "owner" | "other") {
	const profileId = source.owner?.payerProfileId ?? null;
	const customerId = await resolveAsaasCustomer(
		{
			asaas: getAsaasClient(),
			claim: (asaasCustomerId, owned) => {
				if (!profileId) throw new Error("claim sem linha do pagador");
				return withUserTransaction(session, (client) => claimAsaasCustomer(client, profileId, asaasCustomerId, owned));
			},
			markSynced: async () => {
				if (profileId) await withUserTransaction(session, (client) => markPayerSynced(client, profileId));
			},
		},
		{
			payer: source.payer,
			kind,
			current: source.owner
				? { asaasCustomerId: source.owner.asaasCustomerId, owned: source.owner.owned, stale: source.owner.stale }
				: null,
			payerProfileId: profileId,
		},
	);
	await withUserTransaction(session, (client) => setChargeCustomer(client, chargeId, customerId));
	return customerId;
}

// Cobrança criada no Asaas e não ligada à linha: o webhook a acha pela referência externa. Só ids, para a conciliação.
function logUnbound(chargeId: string, asaasPaymentId: string, externalReference: string): void {
	console.error("[checkout] COBRANÇA sem ligação no banco: o webhook a acha pela referência externa", {
		chargeId,
		asaasPaymentId,
		externalReference,
	});
}

async function bind(
	session: DbIdentity,
	chargeId: string,
	externalReference: string,
	input: Parameters<typeof bindAsaasCharge>[2],
): Promise<boolean> {
	try {
		if (await withUserTransaction(session, (client) => bindAsaasCharge(client, chargeId, input))) return true;
	} catch (error) {
		logFailure("bind", error);
	}
	logUnbound(chargeId, input.asaasPaymentId, externalReference);
	return false;
}

const REVALIDATE: Record<ChargeScope["kind"], string> = { bureau: "/settings/wallet", client: "/portal/credits" };

async function createPix(
	session: DbIdentity,
	scope: ChargeScope,
	input: CheckoutInput,
	reserved: Reserved,
	customerId: string,
	meta: CheckoutMeta,
): Promise<CheckoutResult> {
	let charge;
	try {
		charge = await getAsaasClient().createPixCharge({
			customerId,
			amount: input.amount,
			externalReference: input.idempotencyKey,
			description: meta.description,
		});
	} catch (error) {
		logFailure("asaas", error);
		// Resultado desconhecido: a cobrança pode existir; a linha fica pendente e expira.
		if (!(error instanceof AsaasOutcomeUnknownError)) await cancelReserved(session, reserved.chargeId);
		return { error: FAILED_PIX };
	}
	const bound = await bind(session, reserved.chargeId, input.idempotencyKey, {
		asaasPaymentId: charge.asaasPaymentId,
		pixPayload: charge.pixPayload,
	});
	if (!bound) return { error: FAILED_PIX };
	revalidatePath(REVALIDATE[scope.kind]);
	return {
		error: null,
		id: reserved.chargeId,
		method: "PIX",
		pixPayload: charge.pixPayload,
		qrImageBase64: charge.qrImageBase64,
		expiresAt: reserved.expiresAt.toISOString(),
	};
}

async function createCard(
	session: DbIdentity,
	scope: ChargeScope,
	input: CheckoutInput,
	reserved: Reserved,
	plan: CardPlan,
	customerId: string,
	meta: CheckoutMeta,
): Promise<CheckoutResult> {
	const { payer } = reserved.source;
	const { card } = input;
	const phone = asaasPhone(payer.phone);
	if (!card || !phone || !payer.postalCode || !payer.addressNumber) throw new BlockedError(MISSING_FIELDS);

	let charge;
	try {
		charge = await getAsaasClient().createCardCharge({
			customerId,
			externalReference: input.idempotencyKey,
			description: meta.description,
			totalCents: plan.totalCents,
			installments: input.installments ?? 1,
			installmentCents: plan.installmentCents[0],
			card: {
				holderName: card.holderName,
				number: card.number,
				expiryMonth: card.expiryMonth,
				expiryYear: card.expiryYear,
				ccv: card.cvv,
			},
			holder: {
				name: payer.name,
				email: payer.email,
				cpfCnpj: payer.cpfCnpj,
				postalCode: payer.postalCode,
				addressNumber: payer.addressNumber,
				phone,
			},
			remoteIp: meta.remoteIp,
		});
	} catch (error) {
		logFailure("asaas", error);
		// Resultado desconhecido: a cobrança pode existir. Sem segunda chamada; a linha fica pendente e o webhook decide.
		if (error instanceof AsaasOutcomeUnknownError) return { error: null, id: reserved.chargeId, method: "CREDIT_CARD" };
		await cancelReserved(session, reserved.chargeId);
		return { error: error instanceof CardDeclinedError ? error.message : FAILED_CARD };
	}
	// Cobrança criada: se o bind falhar, o webhook ainda a acha pela referência externa. O crédito é só do webhook.
	await bind(session, reserved.chargeId, input.idempotencyKey, {
		asaasPaymentId: charge.asaasPaymentId,
		asaasInstallmentId: charge.asaasInstallmentId,
		cardBrand: charge.brand,
		cardLast4: charge.last4,
	});
	revalidatePath(REVALIDATE[scope.kind]);
	return { error: null, id: reserved.chargeId, method: "CREDIT_CARD" };
}

// A action já validou o corpo (checkoutSchema), a sessão e a permissão (`wallet:topup` ou `credits:topup`).
export async function runCheckout(
	session: DbIdentity,
	scope: ChargeScope,
	input: CheckoutInput,
	meta: CheckoutMeta,
): Promise<CheckoutResult> {
	const failed = input.method === "PIX" ? FAILED_PIX : FAILED_CARD;
	try {
		const plan = planCard(input);
		// Sem chave PII válida a recarga falha fechada (Pix e cartão).
		let keyring: PiiKeyring;
		try {
			keyring = readPiiKeyring(process.env);
		} catch (error) {
			logFailure("chave PII", error);
			return { error: UNAVAILABLE };
		}

		const reserved = await reserve(session, scope, input, plan, keyring);
		if (reserved.reused) return { error: null, id: reserved.chargeId, method: input.method, reused: true };

		let customerId: string;
		try {
			customerId = await resolveCustomer(session, reserved.chargeId, reserved.source, input.payerKind);
		} catch (error) {
			logFailure("cliente Asaas", error);
			// Nenhuma cobrança existe ainda: fechar a linha é seguro, mesmo se o resultado do cliente era desconhecido
			// (a próxima tentativa busca o cliente por CPF/CNPJ antes de criar).
			await cancelReserved(session, reserved.chargeId);
			return { error: failed };
		}

		return plan
			? await createCard(session, scope, input, reserved, plan, customerId, meta)
			: await createPix(session, scope, input, reserved, customerId, meta);
	} catch (error) {
		if (error instanceof BlockedError) return { error: error.message };
		if (error instanceof PiiDecryptError) {
			logFailure("pii", error);
			return { error: UNAVAILABLE };
		}
		logFailure("checkout", error);
		return { error: failed };
	}
}
