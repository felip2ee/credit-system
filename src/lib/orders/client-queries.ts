// Leitura do pedido pelo cliente (M6), sob RLS: só pedido próprio, sem tocar em holders. O custo nunca sai daqui.
// A entrega só existe com o pedido em 'released' (políticas *_client_released da 022).
import type { PoolClient } from "pg";

import type { Parecer } from "@/types/ai";
import type { CanonicalBureauResult } from "@/types/bureau";

import type { OrderKind, OrderMode, OrderProductCode, OrderState, OrderStateReason } from "./types";

const DEFAULT_LIMIT = 50;

export type ClientOrderListItem = {
	dossierId: string;
	mode: OrderMode;
	productCode: OrderProductCode;
	withAi: boolean;
	selfResearch: boolean;
	subjectName: string;
	subjectDocumentMasked: string;
	state: OrderState;
	reason: OrderStateReason | null;
	// Nulo quando o cliente não lê a liquidação (pedido de balcão): o preço não é dele para ver.
	price: string | null;
	createdAt: Date;
	releasedAt: Date | null;
};

type OrderRow = {
	dossier_id: string;
	mode: OrderMode;
	product_code: OrderProductCode;
	with_ai: boolean;
	self_research: boolean;
	subject_name: string;
	subject_document_masked: string;
	state: OrderState;
	state_reason: OrderStateReason | null;
	price: string | null;
	created_at: Date;
	released_at: Date | null;
};

const ORDER_COLUMNS = `o.dossier_id, o.mode, o.product_code, o.with_ai, o.self_research, o.subject_name, o.subject_document_masked, o.state,
	o.state_reason, s.price::text as price, o.created_at, o.released_at`;

const toItem = (r: OrderRow): ClientOrderListItem => ({
	dossierId: r.dossier_id,
	mode: r.mode,
	productCode: r.product_code,
	withAi: r.with_ai,
	selfResearch: r.self_research,
	subjectName: r.subject_name,
	subjectDocumentMasked: r.subject_document_masked,
	state: r.state,
	reason: r.state_reason,
	price: r.price,
	createdAt: r.created_at,
	releasedAt: r.released_at,
});

export async function listMyOrders(client: PoolClient, limit: number = DEFAULT_LIMIT): Promise<ClientOrderListItem[]> {
	const { rows } = await client.query<OrderRow>(
		`select ${ORDER_COLUMNS}
		   from dossier_orders o left join order_settlements s on s.order_ref = o.dossier_id
		  where o.client_profile_id = app_user_id()
		  order by o.created_at desc, o.dossier_id
		  limit $1`,
		[limit],
	);
	return rows.map(toItem);
}

// Um pedido próprio pelo id; nulo se não existe ou é de outro cliente (a RLS esconde o resto).
export async function getMyOrder(client: PoolClient, dossierId: string): Promise<ClientOrderListItem | null> {
	const { rows } = await client.query<OrderRow>(
		`select ${ORDER_COLUMNS}
		   from dossier_orders o left join order_settlements s on s.order_ref = o.dossier_id
		  where o.dossier_id = $1 and o.client_profile_id = app_user_id()`,
		[dossierId],
	);
	return rows[0] ? toItem(rows[0]) : null;
}

export type ClientDelivery = {
	order: ClientOrderListItem;
	kind: OrderKind;
	members: {
		consultationId: string;
		type: "PF" | "PJ";
		name: string | null;
		product: string | null;
		status: string;
		canonical: CanonicalBureauResult | null;
		payload: unknown; // null quando não há linha em bureau_payloads
		opinion: Parecer | null;
	}[];
	dossierOpinion: Parecer | null;
};

// O parecer só sai com o adicional comprado (with_ai): a política RLS libera a linha, a regra de venda é daqui.
// Nulo fora de 'released': pedido em andamento, revogado, de outro cliente ou inexistente.
export async function getMyDelivery(client: PoolClient, dossierId: string): Promise<ClientDelivery | null> {
	const order = await client.query<OrderRow & { kind: OrderKind; dossier_opinion: Parecer | null }>(
		`select ${ORDER_COLUMNS}, d.kind::text as kind, d.full_report as dossier_opinion
		   from dossier_orders o
		   join dossiers d on d.id = o.dossier_id
		   left join order_settlements s on s.order_ref = o.dossier_id
		  where o.dossier_id = $1 and o.client_profile_id = app_user_id() and o.state = 'released'`,
		[dossierId],
	);
	const head = order.rows[0];
	if (!head) return null;
	const members = await client.query<{
		id: string;
		type: "PF" | "PJ";
		document_name: string | null;
		product: string | null;
		status: string;
		canonical_result: CanonicalBureauResult | null;
		payload: unknown;
		full_report: Parecer | null;
	}>(
		`select c.id, c.type::text as type, c.document_name, c.product, c.status::text as status,
		        r.canonical_result, p.payload, a.full_report
		   from consultations c
		   join dossiers d on d.id = c.dossier_id
		   left join bureau_results r on r.consultation_id = c.id
		   left join lateral (
		     select bp.payload from bureau_payloads bp
		      where bp.consultation_id = c.id
		      order by (bp.id is not distinct from r.payload_id) desc, bp.received_at desc limit 1
		   ) p on true
		   left join ai_reports a on a.consultation_id = c.id
		  where c.dossier_id = $1
		  order by (c.holder_id = d.holder_id) desc, c.created_at, c.id`,
		[dossierId],
	);
	return {
		order: toItem(head),
		kind: head.kind,
		members: members.rows.map((m) => ({
			consultationId: m.id,
			type: m.type,
			name: m.document_name,
			product: m.product,
			status: m.status,
			canonical: m.canonical_result,
			payload: m.payload ?? null,
			opinion: head.with_ai ? m.full_report : null,
		})),
		dossierOpinion: head.with_ai ? head.dossier_opinion : null,
	};
}
