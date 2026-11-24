// Cobranças de recarga da carteira (Pix e cartão). A linha nasce antes do Asaas (reserveCharge) e recebe o id do
// pagamento depois (bindAsaasCharge).
// O crédito e o estorno não passam por aqui: apply_asaas_payment (014_wallet_refund_and_webhook_role.sql) decide, sem sessão.
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import type { DbIdentity } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { topupAmountSchema } from "@/lib/validators/wallet";

export const PIX_CHARGE_TTL_MINUTES = 30;
export const MAX_PENDING_PIX_CHARGES = 10;

export type PixChargeStatus = "pending" | "paid" | "expired" | "cancelled" | "refunded";

// Sem asaas_payment_id: ele não sai do servidor.
export type PixCharge = {
	id: string;
	// Recarga: o que sobe no saldo.
	amount: string;
	// Taxa repassada ao pagador e total que ele paga (amount + feeAmount). totalCharged nulo = sem taxa (total = amount).
	feeAmount: string;
	totalCharged: string | null;
	status: PixChargeStatus;
	pixPayload: string;
	expiresAt: Date;
	createdAt: Date;
};

export type BillingType = "PIX" | "CREDIT_CARD";

// Dono da carteira que recebe a recarga: o cliente (portal) ou o Bureau (empresa).
export type ChargeScope = { kind: "client"; clientProfileId: string } | { kind: "bureau"; bureauId: string };

export const MAX_CARD_ATTEMPTS_PER_HOUR = 5;
export const MAX_CARD_ATTEMPTS_PER_IP_PER_HOUR = 10;
export const MAX_CARD_ATTEMPTS_PER_BUREAU_PER_HOUR = 40;

export type ReserveChargeInput = {
	scope: ChargeScope;
	externalReference: string;
	amount: string;
	billingType: BillingType;
	installments: number;
	feeAmount: string;
	totalCharged: string | null;
	payerKind: "owner" | "other";
	payerDocumentMasked: string;
	// IP de origem do pedido (só o cartão o usa, para o teto por IP).
	requestIp?: string | null;
};

export type ReserveChargeResult =
	| { ok: true; id: string; expiresAt: Date; reused: boolean }
	| { ok: false; reason: "invalid_amount" | "reference_taken" };

// Serializa as cobranças do mesmo dono até o fim da transação: contagem de pendentes, contagem de tentativas de cartão
// e insert deixam de correr em paralelo. Chame antes das contagens, na mesma transação da reserva.
export async function lockChargeScope(client: PoolClient, scope: ChargeScope): Promise<void> {
	const key = scope.kind === "client" ? `client-pix-charges:${scope.clientProfileId}` : `bureau-pix-charges:${scope.bureauId}`;
	await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

// Reserva a linha antes de chamar o Asaas (Pix ou cartão). A referência externa é a chave de idempotência: o reenvio
// do mesmo autor devolve a mesma linha (reused) e não audita de novo; outro autor recebe reference_taken.
export async function reserveCharge(
	client: PoolClient,
	identity: DbIdentity,
	input: ReserveChargeInput,
): Promise<ReserveChargeResult> {
	if (!topupAmountSchema.safeParse(input.amount).success) return { ok: false, reason: "invalid_amount" };

	const clientProfileId = input.scope.kind === "client" ? input.scope.clientProfileId : null;
	const { rows } = await client.query<{ id: string; expires_at: Date }>(
		`insert into pix_charges (bureau_id, external_reference, amount, expires_at, requested_by, client_profile_id,
		   billing_type, installments, fee_amount, total_charged, payer_kind, payer_document_masked, request_ip)
		 values ($1, $2, $3, now() + make_interval(mins => $4), $5, $6, $7, $8, $9, $10, $11, $12, $13)
		 on conflict (external_reference) do nothing
		 returning id, expires_at`,
		[
			identity.bureauId,
			input.externalReference,
			input.amount,
			PIX_CHARGE_TTL_MINUTES,
			identity.userId,
			clientProfileId,
			input.billingType,
			input.installments,
			input.feeAmount,
			input.totalCharged,
			input.payerKind,
			input.payerDocumentMasked,
			input.requestIp ?? null,
		],
	);
	if (rows[0]) {
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "wallet.topup.request",
			targetTable: "pix_charges",
			targetId: rows[0].id,
			metadata: {
				amount: input.amount,
				billingType: input.billingType,
				installments: input.installments,
				feeAmount: input.feeAmount,
				// Sem taxa o total é a própria recarga.
				totalCharged: input.totalCharged ?? input.amount,
				payerKind: input.payerKind,
				// Não chama "documentMasked": redact() apagaria a máscara de toda chave com "document".
				payerMask: input.payerDocumentMasked,
			},
		});
		return { ok: true, id: rows[0].id, expiresAt: rows[0].expires_at, reused: false };
	}

	// Linha de outro tenant fica invisível pela RLS: também é reference_taken.
	const existing = await client.query<{ id: string; expires_at: Date; requested_by: string }>(
		"select id, expires_at, requested_by from pix_charges where external_reference = $1",
		[input.externalReference],
	);
	const row = existing.rows[0];
	if (!row || row.requested_by !== identity.userId) return { ok: false, reason: "reference_taken" };
	return { ok: true, id: row.id, expiresAt: row.expires_at, reused: true };
}

// Liga o cliente Asaas à cobrança reservada. Lança se a cobrança não é do autor, já fechou ou tem outro cliente Asaas.
export async function setChargeCustomer(client: PoolClient, chargeId: string, asaasCustomerId: string): Promise<void> {
	const { rows } = await client.query<{ ok: boolean }>("select public.set_pix_charge_customer($1, $2) as ok", [
		chargeId,
		asaasCustomerId,
	]);
	if (!rows[0].ok) throw new Error("set_pix_charge_customer: cobrança não aceita o cliente Asaas");
}

// Como bindPixCharge, com os campos do cartão e do parcelamento. false = não ligou (veja bind_pix_charge, 040).
export async function bindAsaasCharge(
	client: PoolClient,
	chargeId: string,
	input: {
		asaasPaymentId: string;
		pixPayload?: string;
		asaasInstallmentId?: string | null;
		cardBrand?: string;
		cardLast4?: string;
	},
): Promise<boolean> {
	const { rows } = await client.query<{ bound: boolean }>(
		"select public.bind_pix_charge($1, $2, $3, $4, $5, $6) as bound",
		[
			chargeId,
			input.asaasPaymentId,
			input.pixPayload ?? null,
			input.asaasInstallmentId ?? null,
			input.cardBrand ?? null,
			input.cardLast4 ?? null,
		],
	);
	return rows[0].bound;
}

// Tentativas de cartão do solicitante na última hora (qualquer estado). O teto é MAX_CARD_ATTEMPTS_PER_HOUR.
export async function countRecentCardAttempts(client: PoolClient, requestedBy: string): Promise<number> {
	const { rows } = await client.query<{ total: number }>(
		`select count(*)::int as total from pix_charges
		  where requested_by = $1 and billing_type = 'CREDIT_CARD' and created_at > now() - interval '1 hour'`,
		[requestedBy],
	);
	return rows[0].total;
}

// Tentativas de cartão de um IP desde `since`, de todos os usuários e Bureaus (count_recent_card_attempts_by_ip, 043:
// definer, só um inteiro). O teto é MAX_CARD_ATTEMPTS_PER_IP_PER_HOUR.
export async function countRecentCardAttemptsByIp(client: PoolClient, ip: string, since: Date): Promise<number> {
	const { rows } = await client.query<{ total: number }>(
		"select public.count_recent_card_attempts_by_ip($1, $2) as total",
		[ip, since],
	);
	return rows[0].total;
}

// Tentativas de cartão do Bureau da sessão desde `since`, de todos os usuários dele (count_recent_card_attempts_by_bureau,
// 043: definer, recusa outro Bureau). O teto é MAX_CARD_ATTEMPTS_PER_BUREAU_PER_HOUR.
export async function countRecentCardAttemptsByBureau(client: PoolClient, bureauId: string, since: Date): Promise<number> {
	const { rows } = await client.query<{ total: number }>(
		"select public.count_recent_card_attempts_by_bureau($1, $2) as total",
		[bureauId, since],
	);
	return rows[0].total;
}

// Estado efetivo da cobrança (pending vencida é expired), para a consulta de status da tela. Só do próprio dono: o
// cliente vê a cobrança da própria carteira; o Bureau, a da dele (nunca a de um cliente).
export async function getChargeStatus(
	client: PoolClient,
	chargeId: string,
	scope: ChargeScope,
): Promise<{ status: PixChargeStatus; billingType: BillingType } | null> {
	const owner =
		scope.kind === "client"
			? { clause: "client_profile_id = $2", value: scope.clientProfileId }
			: { clause: "client_profile_id is null and payment_link_id is null and bureau_id = $2", value: scope.bureauId };
	const { rows } = await client.query<{ status: PixChargeStatus; billing_type: BillingType }>(
		`select case when status = 'pending' and expires_at < now() then 'expired' else status end as status, billing_type
		   from pix_charges where id = $1 and ${owner.clause}`,
		[chargeId, owner.value],
	);
	return rows[0] ? { status: rows[0].status, billingType: rows[0].billing_type } : null;
}

// O Asaas não criou a cobrança: fecha a linha reservada para ela sair do teto de pendentes.
export async function cancelUnboundPixCharge(client: PoolClient, chargeId: string): Promise<void> {
	await client.query("select public.cancel_unbound_pix_charge($1)", [chargeId]);
}

// Cobranças Pix ainda válidas do Bureau (sem as dos clientes e sem o cartão): limita o spam de PIX antes de chamar o Asaas.
export async function countPendingPixCharges(client: PoolClient, bureauId: string): Promise<number> {
	const { rows } = await client.query<{ total: number }>(
		`select count(*)::int as total from pix_charges
		  where bureau_id = $1 and client_profile_id is null and payment_link_id is null and billing_type = 'PIX'
		    and status = 'pending' and expires_at > now()`,
		[bureauId],
	);
	return rows[0].total;
}

// Teto próprio de cada cliente. Usa pix_charges_client_created_idx (client_profile_id, ...): não é o índice
// parcial de pendentes, mas um cliente tem poucas linhas e o plano filtra status/expiração sobre elas.
export async function countPendingClientPixCharges(client: PoolClient, clientProfileId: string): Promise<number> {
	const { rows } = await client.query<{ total: number }>(
		`select count(*)::int as total from pix_charges
		  where client_profile_id = $1 and billing_type = 'PIX' and status = 'pending' and expires_at > now()`,
		[clientProfileId],
	);
	return rows[0].total;
}

type ChargeRow = {
	id: string;
	amount: string;
	fee_amount: string;
	total_charged: string | null;
	status: PixChargeStatus;
	pix_payload: string;
	expires_at: Date;
	created_at: Date;
};

// Estado efetivo: pending vencida é expired (a coluna só muda no pagamento).
const SELECT_CHARGE = `select id, amount, fee_amount, total_charged,
	case when status = 'pending' and expires_at < now() then 'expired' else status end as status,
	pix_payload, expires_at, created_at
	from pix_charges`;

// Telas do Bureau nunca leem cobrança de cliente (nem o pix_payload dela) nem a de link de pagamento (não é recarga).
const BUREAU_ONLY = "client_profile_id is null and payment_link_id is null";

const toCharge = (r: ChargeRow): PixCharge => ({
	id: r.id,
	amount: r.amount,
	feeAmount: r.fee_amount,
	totalCharged: r.total_charged,
	status: r.status,
	pixPayload: r.pix_payload,
	expiresAt: r.expires_at,
	createdAt: r.created_at,
});

export async function getPixCharge(client: PoolClient, id: string): Promise<PixCharge | null> {
	const { rows } = await client.query<ChargeRow>(`${SELECT_CHARGE} where id = $1 and ${BUREAU_ONLY}`, [id]);
	return rows[0] ? toCharge(rows[0]) : null;
}

const LIST_LIMIT = 50;

export async function listPixCharges(client: PoolClient, bureauId: string): Promise<PixCharge[]> {
	const { rows } = await client.query<ChargeRow>(
		`${SELECT_CHARGE} where bureau_id = $1 and ${BUREAU_ONLY} order by created_at desc limit $2`,
		[bureauId, LIST_LIMIT],
	);
	return rows.map(toCharge);
}

// Cobrança do cliente na tela dele: o código PIX só vem enquanto a cobrança está pendente.
export type ClientPixCharge = Omit<PixCharge, "pixPayload"> & { pixPayload: string | null };

export async function listClientPixCharges(client: PoolClient, clientProfileId: string): Promise<ClientPixCharge[]> {
	const { rows } = await client.query<Omit<ChargeRow, "pix_payload"> & { pix_payload: string | null }>(
		`select id, amount, fee_amount, total_charged,
		   case when status = 'pending' and expires_at < now() then 'expired' else status end as status,
		   case when status = 'pending' and expires_at >= now() then pix_payload end as pix_payload,
		   expires_at, created_at
		 from pix_charges where client_profile_id = $1 order by created_at desc limit $2`,
		[clientProfileId, LIST_LIMIT],
	);
	return rows.map((r) => ({
		id: r.id,
		amount: r.amount,
		feeAmount: r.fee_amount,
		totalCharged: r.total_charged,
		status: r.status,
		pixPayload: r.pix_payload,
		expiresAt: r.expires_at,
		createdAt: r.created_at,
	}));
}

export type AsaasPaymentResult =
	| "credited"
	| "refunded"
	| "duplicate"
	| "ignored"
	| "unknown_charge"
	| "partial_refund_ignored"
	| "chargeback_ignored"
	| "amount_mismatch"
	// Cobrança de link de pagamento (058): baixa o link e o pedido de balcão; nunca a carteira.
	| "link_paid"
	| "link_duplicate"
	| "link_ignored"
	| "link_order_not_payable";

// Estorno de PIX que o saldo disponível não cobriu (pix_charges.refund_shortfall > 0), para o superadmin.
export type RefundShortfall = { chargeId: string; amount: string; shortfall: string; createdAt: Date };

export async function listRefundShortfalls(client: PoolClient, bureauId: string): Promise<RefundShortfall[]> {
	const { rows } = await client.query<{ id: string; amount: string; refund_shortfall: string; created_at: Date }>(
		`select id, amount, refund_shortfall, created_at from pix_charges
		  where bureau_id = $1 and refund_shortfall > 0
		  order by created_at desc limit $2`,
		[bureauId, LIST_LIMIT],
	);
	return rows.map((r) => ({ chargeId: r.id, amount: r.amount, shortfall: r.refund_shortfall, createdAt: r.created_at }));
}

// Webhook sem sessão, na role app_webhook: a função SECURITY DEFINER é a única porta de escrita: credita pix_charges.amount (a recarga) e confere o valor pago contra total_charged (Pix, 045).
export async function applyAsaasPayment(event: {
	eventId: string;
	eventType: string;
	asaasPaymentId: string;
	payload: unknown;
}): Promise<AsaasPaymentResult> {
	const { rows } = await getWebhookPool().query<{ result: AsaasPaymentResult }>(
		"select public.apply_asaas_payment($1, $2, $3, $4::jsonb) as result",
		[event.eventId, event.eventType, event.asaasPaymentId, JSON.stringify(event.payload)],
	);
	return rows[0].result;
}
