// Leitura do pedido pela equipe (M6), sob a RLS da equipe.
import type { PoolClient } from "pg";

import type { AiStatus, OrderMode, OrderProductCode, OrderState, OrderStateReason } from "./types";

export type StaffOrderView = {
	dossierId: string;
	mode: OrderMode;
	state: OrderState;
	reason: OrderStateReason | null;
	productCode: OrderProductCode;
	aiStatus: AiStatus;
	buyerName: string | null;
	price: string;
	paidTotal: string | null;
	releasedAt: Date | null;
	revokedAt: Date | null;
	revokeReason: string | null;
	createdAt: Date;
};

export async function getStaffOrder(client: PoolClient, dossierId: string): Promise<StaffOrderView | null> {
	const { rows } = await client.query<{
		dossier_id: string;
		mode: OrderMode;
		state: OrderState;
		state_reason: OrderStateReason | null;
		product_code: OrderProductCode;
		ai_status: AiStatus;
		buyer_name: string | null;
		price: string | null;
		paid_total: string | null;
		released_at: Date | null;
		revoked_at: Date | null;
		revoke_reason: string | null;
		created_at: Date;
	}>(
		`select o.dossier_id, o.mode, o.state, o.state_reason, o.product_code, o.ai_status,
		        p.full_name as buyer_name, s.price::text as price,
		        case when o.mode = 'counter' then
		          (select coalesce(sum(cp.amount), 0)::text from counter_payments cp
		            where cp.dossier_id = o.dossier_id and cp.voided_at is null) end as paid_total,
		        o.released_at, o.revoked_at, o.revoke_reason, o.created_at
		   from dossier_orders o
		   left join profiles p on p.id = o.client_profile_id
		   left join order_settlements s on s.order_ref = o.dossier_id
		  where o.dossier_id = $1`,
		[dossierId],
	);
	const r = rows[0];
	if (!r) return null;
	return {
		dossierId: r.dossier_id,
		mode: r.mode,
		state: r.state,
		reason: r.state_reason,
		productCode: r.product_code,
		aiStatus: r.ai_status,
		buyerName: r.buyer_name,
		price: r.price ?? "0.00",
		paidTotal: r.paid_total,
		releasedAt: r.released_at,
		revokedAt: r.revoked_at,
		revokeReason: r.revoke_reason,
		createdAt: r.created_at,
	};
}
