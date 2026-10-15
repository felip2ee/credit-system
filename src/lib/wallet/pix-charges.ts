// Cobranças PIX de recarga da carteira (M3a). A linha só nasce depois que o Asaas respondeu.
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
	amount: string;
	status: PixChargeStatus;
	pixPayload: string;
	expiresAt: Date;
	createdAt: Date;
};

export type CreatePixChargeInput = { asaasPaymentId: string; pixPayload: string; amount: string };

export type CreatePixChargeResult =
	| { ok: true; id: string; expiresAt: Date }
	| { ok: false; reason: "invalid_amount" };

export async function createPixCharge(
	client: PoolClient,
	identity: DbIdentity,
	input: CreatePixChargeInput,
): Promise<CreatePixChargeResult> {
	if (!topupAmountSchema.safeParse(input.amount).success) return { ok: false, reason: "invalid_amount" };

	const { rows } = await client.query<{ id: string; expires_at: Date }>(
		`insert into pix_charges (bureau_id, asaas_payment_id, amount, pix_payload, expires_at, requested_by)
		 values ($1, $2, $3, $4, now() + make_interval(mins => $5), $6)
		 returning id, expires_at`,
		[identity.bureauId, input.asaasPaymentId, input.amount, input.pixPayload, PIX_CHARGE_TTL_MINUTES, identity.userId],
	);
	const { id, expires_at: expiresAt } = rows[0];
	await writeAuditEvent(client, {
		actorId: identity.userId,
		action: "wallet.topup.request",
		targetTable: "pix_charges",
		targetId: id,
		metadata: { amount: input.amount },
	});
	return { ok: true, id, expiresAt };
}

// Cobranças ainda válidas do Bureau: limita o spam de PIX antes de chamar o Asaas.
export async function countPendingPixCharges(client: PoolClient, bureauId: string): Promise<number> {
	const { rows } = await client.query<{ total: number }>(
		"select count(*)::int as total from pix_charges where bureau_id = $1 and status = 'pending' and expires_at > now()",
		[bureauId],
	);
	return rows[0].total;
}

type ChargeRow = {
	id: string;
	amount: string;
	status: PixChargeStatus;
	pix_payload: string;
	expires_at: Date;
	created_at: Date;
};

// Estado efetivo: pending vencida é expired (a coluna só muda no pagamento).
const SELECT_CHARGE = `select id, amount,
	case when status = 'pending' and expires_at < now() then 'expired' else status end as status,
	pix_payload, expires_at, created_at
	from pix_charges`;

const toCharge = (r: ChargeRow): PixCharge => ({
	id: r.id,
	amount: r.amount,
	status: r.status,
	pixPayload: r.pix_payload,
	expiresAt: r.expires_at,
	createdAt: r.created_at,
});

export async function getPixCharge(client: PoolClient, id: string): Promise<PixCharge | null> {
	const { rows } = await client.query<ChargeRow>(`${SELECT_CHARGE} where id = $1`, [id]);
	return rows[0] ? toCharge(rows[0]) : null;
}

const LIST_LIMIT = 50;

export async function listPixCharges(client: PoolClient, bureauId: string): Promise<PixCharge[]> {
	const { rows } = await client.query<ChargeRow>(
		`${SELECT_CHARGE} where bureau_id = $1 order by created_at desc limit $2`,
		[bureauId, LIST_LIMIT],
	);
	return rows.map(toCharge);
}

export type AsaasPaymentResult = "credited" | "refunded" | "duplicate" | "ignored" | "unknown_charge";

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

// Webhook sem sessão, na role app_webhook: a função SECURITY DEFINER é a única porta de escrita e usa pix_charges.amount.
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
