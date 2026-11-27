// PIX do pedido online (063): preço pago e cupom guardados quando o saldo não cobre o pedido, e a leitura do que a
// tela de pagamento precisa. O dinheiro em si (crédito e reserva) vive em apply_order_pix_charge (webhook).
import type { PoolClient } from "pg";

import { fromCents, toCents } from "@/lib/catalog/money";
import type { PixChargeStatus } from "@/lib/wallet/pix-charges";

import type { OrderState } from "./types";

export async function insertOrderPixQuote(
	client: PoolClient,
	input: { dossierId: string; priceCents: number; couponCode: string | null },
): Promise<void> {
	await client.query(
		`insert into order_pix_quotes (dossier_id, bureau_id, client_profile_id, price, coupon_code)
		 values ($1, app_bureau_id(), app_user_id(), $2, $3)`,
		[input.dossierId, fromCents(input.priceCents), input.couponCode],
	);
}

// Preço da cotação do PIX do pedido (null: pedido sem cotação, pago pela carteira). Reenvio idempotente (088).
export async function readOrderPixQuoteCents(client: PoolClient, dossierId: string): Promise<number | null> {
	const { rows } = await client.query<{ price: string }>("select price from order_pix_quotes where dossier_id = $1", [dossierId]);
	return rows[0] ? toCents(rows[0].price) : null;
}

export type OrderPixCharge = {
	id: string;
	// Efetivo: pending vencida é expired.
	status: PixChargeStatus;
	// Só enquanto pending e no prazo.
	pixPayload: string | null;
	expiresAt: Date;
	createdAt: Date;
	amountCents: number;
	feeCents: number;
	// total_charged ou amount (sem taxa).
	totalCents: number;
};

export type OrderPayment = {
	state: OrderState;
	priceCents: number;
	couponCode: string | null;
	charge: OrderPixCharge | null;
};

type PaymentRow = {
	state: OrderState;
	price: string;
	coupon_code: string | null;
	charge_id: string | null;
	status: PixChargeStatus | null;
	pix_payload: string | null;
	expires_at: Date | null;
	created_at: Date | null;
	amount: string | null;
	fee_amount: string | null;
	total_charged: string | null;
};

// Pedido, cotação e a cobrança mais recente. A RLS limita ao dono (e à equipe). Sem cotação: null.
export async function getOrderPayment(client: PoolClient, dossierId: string): Promise<OrderPayment | null> {
	const { rows } = await client.query<PaymentRow>(
		`select o.state, q.price, q.coupon_code,
		        c.id as charge_id,
		        case when c.status = 'pending' and c.expires_at < now() then 'expired' else c.status end as status,
		        case when c.status = 'pending' and c.expires_at >= now() then c.pix_payload end as pix_payload,
		        c.expires_at, c.created_at, c.amount, c.fee_amount, c.total_charged
		   from order_pix_quotes q
		   join dossier_orders o on o.dossier_id = q.dossier_id
		   left join lateral (
		     select * from pix_charges p where p.order_id = q.dossier_id order by p.created_at desc limit 1
		   ) c on true
		  where q.dossier_id = $1`,
		[dossierId],
	);
	const r = rows[0];
	if (!r) return null;
	const charge: OrderPixCharge | null =
		r.charge_id && r.status && r.expires_at && r.created_at && r.amount && r.fee_amount
			? {
					id: r.charge_id,
					status: r.status,
					pixPayload: r.pix_payload,
					expiresAt: r.expires_at,
					createdAt: r.created_at,
					amountCents: toCents(r.amount),
					feeCents: toCents(r.fee_amount),
					totalCents: toCents(r.total_charged ?? r.amount),
				}
			: null;
	return { state: r.state, priceCents: toCents(r.price), couponCode: r.coupon_code, charge };
}
