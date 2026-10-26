// Vendas da Carteira: uma linha por pedido, separadas em online e balcão. Recebe o PoolClient da transação do chamador
// (withUserTransaction); o RLS limita à equipe do Bureau. O custo vem só de order_settlement_cost (018): a coluna
// order_settlements.cost não é legível pelo app_runtime. Mostra o nome do titular do pedido, nunca o CPF/CNPJ.
import type { PoolClient } from "pg";

import { derivePaymentState, type PaymentState } from "@/lib/counter-payments/overview";

import { assertCursor, UUID_PATTERN } from "./cursor";

export type SaleMode = "online" | "counter";

export type SaleRow = {
	orderRef: string;
	holderName: string;
	productName: string;
	createdAt: Date;
	mode: SaleMode;
	paid: string;
	cost: string;
	bureauShare: string;
	status: PaymentState;
};

export type SaleTotals = { paid: string; cost: string; bureauShare: string };

export type SalesPage = { rows: SaleRow[]; totals: SaleTotals; nextCursor: string | null };

export type SalesArgs = {
	mode: SaleMode;
	range: { start: string; end: string };
	cursor?: string | null;
	limit?: number;
};

type SettlementStatus = "reserved" | "captured" | "released";

export type RawSale = {
	order_ref: string;
	subject_name: string;
	product_name: string;
	created_at: Date;
	cursor_at: string;
	mode: SaleMode;
	state: string;
	settlement_status: SettlementStatus | null;
	has_settlement: boolean;
	fully_paid: boolean;
	paid: string;
	price: string | null;
	cost: string | null;
};

export type RawTotalsGroup = {
	mode: SaleMode;
	state: string;
	settlement_status: SettlementStatus | null;
	has_settlement: boolean;
	fully_paid: boolean;
	paid_sum: string;
	// Soma do pago de cada pedido limitado ao preço: base da parte do Bureau (pagamento a mais não é lucro).
	capped_paid_sum: string;
	cost_sum: string;
	missing_cost: number;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const COST_UNAVAILABLE = "Custo do pedido indisponível.";

// Centavos inteiros para não errar a soma de decimais.
const toCents = (v: string) => Math.round(Number(v) * 100);
const fromCents = (c: number) => (c / 100).toFixed(2);

// derivePaymentState compara preço e total pago: aqui só importa se o pedido tem liquidação e se está quitado.
function statusOf(i: {
	mode: SaleMode;
	state: string;
	settlement_status: SettlementStatus | null;
	has_settlement: boolean;
	fully_paid: boolean;
}): PaymentState {
	return derivePaymentState({
		mode: i.mode,
		orderState: i.state,
		settlementStatus: i.settlement_status,
		price: i.has_settlement ? "1" : null,
		paidTotal: i.fully_paid ? "1" : "0",
	});
}

export function buildSaleRow(r: RawSale): SaleRow {
	if (r.has_settlement && r.cost === null) throw new Error(COST_UNAVAILABLE);
	const status = statusOf(r);
	const cost = r.cost ?? "0.00";
	const shareBase = r.price !== null ? Math.min(toCents(r.paid), toCents(r.price)) : toCents(r.paid);
	return {
		orderRef: r.order_ref,
		holderName: r.subject_name,
		productName: r.product_name,
		createdAt: r.created_at,
		mode: r.mode,
		paid: r.paid,
		cost,
		bureauShare: status === "paid" ? fromCents(shareBase - toCents(cost)) : "0.00",
		status,
	};
}

// Cancelado e devolvido ficam fora; pedido ainda aguardando soma o que já entrou, mas não tem parte do Bureau.
export function buildTotals(groups: RawTotalsGroup[]): SaleTotals {
	let paid = 0;
	let cost = 0;
	let share = 0;
	for (const g of groups) {
		const status = statusOf(g);
		if (status === "cancelled" || status === "refunded") continue;
		if (g.missing_cost > 0) throw new Error(COST_UNAVAILABLE);
		paid += toCents(g.paid_sum);
		cost += toCents(g.cost_sum);
		if (status === "paid") share += toCents(g.capped_paid_sum) - toCents(g.cost_sum);
	}
	return { paid: fromCents(paid), cost: fromCents(cost), bureauShare: fromCents(share) };
}

// Cursor "<created_at em texto do Postgres>|<order_ref>": o texto guarda os microssegundos que um Date perde.
const CURSOR = new RegExp(`^(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,6})?[+-]\\d{2}(?::\\d{2})?)\\|(${UUID_PATTERN})$`, "i");

// Sem cursor: null. Cursor adulterado: RangeError (a página volta ao início).
export function parseSalesCursor(raw: string | null | undefined): { at: string; orderRef: string } | null {
	if (!raw) return null;
	const m = CURSOR.exec(raw);
	if (!m) throw new RangeError("Cursor inválido.");
	assertCursor(m[1], m[2]);
	return { at: m[1], orderRef: m[2] };
}

// Online: o saldo do cliente já cobriu o preço (reservado ou cobrado). Balcão: soma dos pagamentos não anulados.
const PAID_SQL = `case when o.mode = 'online'
		then case when s.status in ('captured', 'reserved') then s.price else 0 end
		else coalesce(pp.paid, 0) end`;

const FROM_SQL = `from dossier_orders o
	left join order_settlements s on s.order_ref = o.dossier_id
	left join lateral (select sum(cp.amount) as paid from counter_payments cp
	                    where cp.dossier_id = o.dossier_id and cp.voided_at is null) pp on true
	left join lateral order_settlement_cost(o.dossier_id) c on true
	left join products p on p.code = o.product_code
	where o.bureau_id = app_bureau_id() and o.mode = $1 and o.created_at >= $2 and o.created_at < $3`;

export async function listSales(client: PoolClient, args: SalesArgs): Promise<SalesPage> {
	const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
	const cursor = parseSalesCursor(args.cursor);
	const base = [args.mode, args.range.start, args.range.end];

	const page = await client.query<RawSale>(
		`select o.dossier_id as order_ref, o.subject_name, coalesce(p.name, o.product_code) as product_name,
		        o.created_at, o.created_at::text as cursor_at, o.mode, o.state, s.status as settlement_status,
		        s.id is not null as has_settlement,
		        (s.id is not null and coalesce(pp.paid, 0) >= s.price) as fully_paid,
		        (${PAID_SQL})::text as paid, s.price::text as price, c.cost::text as cost
		 ${FROM_SQL}
		   and ($4::timestamptz is null or (o.created_at, o.dossier_id) < ($4::timestamptz, $5::uuid))
		 order by o.created_at desc, o.dossier_id desc
		 limit ${limit + 1}`,
		[...base, cursor?.at ?? null, cursor?.orderRef ?? null],
	);

	const groups = await client.query<RawTotalsGroup>(
		`select o.mode, o.state, s.status as settlement_status, s.id is not null as has_settlement,
		        (s.id is not null and coalesce(pp.paid, 0) >= s.price) as fully_paid,
		        coalesce(sum(${PAID_SQL}), 0)::text as paid_sum,
		        coalesce(sum(least(${PAID_SQL}, s.price)), 0)::text as capped_paid_sum, coalesce(sum(c.cost), 0)::text as cost_sum,
		        (count(*) filter (where s.id is not null and c.cost is null))::int as missing_cost
		 ${FROM_SQL}
		 group by 1, 2, 3, 4, 5`,
		base,
	);

	const hasMore = page.rows.length > limit;
	const rows = page.rows.slice(0, limit);
	const last = rows[rows.length - 1];
	return {
		rows: rows.map(buildSaleRow),
		totals: buildTotals(groups.rows),
		nextCursor: hasMore && last ? `${last.cursor_at}|${last.order_ref}` : null,
	};
}
