// Valor a repassar ao Bureau (M3b). Só leitura. Os acréscimos nascem de duas formas: no pedido reservado antes da 077, em
// capture_order (order_ref); depois dela, na confirmação do pagamento, pelo split da entrada de dinheiro (pix_charge_id, sem
// order_ref; record_cash_in_commission, 074). Estorno e cupom seguem como antes.
// Os valores têm sinal: acréscimo (+), estorno (−) e repasse pago (−). O saldo é a soma. Sem view: soma direta.
// A RLS deixa o operator ler a tabela; quem barra o operator é a permissão payout:read na Server Action.
import type { PoolClient } from "pg";

import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export type PayableEntry = {
	id: string;
	kind: "accrual" | "reversal" | "payout" | "coupon_cost" | "coupon_refund";
	amount: string;
	// Acréscimo antigo: o pedido. Acréscimo da entrada de dinheiro: nulo (veja pixChargeId).
	orderRef: string | null;
	pixChargeId: string | null;
	createdAt: Date;
};

export type PayablePage = { rows: PayableEntry[]; nextCursor: string | null };

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
// created_at com microssegundos em UTC + "_" + id. O Date do driver perderia os microssegundos.
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export async function getPayableBalance(client: PoolClient, bureauId: string): Promise<string> {
	const { rows } = await client.query<{ balance: string }>(
		"select coalesce(sum(amount), 0.00)::text as balance from bureau_payable_entries where bureau_id = $1",
		[bureauId],
	);
	return rows[0].balance;
}

// Saldo de todos os Bureaus visíveis numa consulta só. Bureau sem lançamento não aparece no mapa (saldo 0.00).
export async function getPayableBalances(client: PoolClient): Promise<Map<string, string>> {
	const { rows } = await client.query<{ bureau_id: string; balance: string }>(
		"select bureau_id, coalesce(sum(amount), 0.00)::text as balance from bureau_payable_entries group by bureau_id",
	);
	return new Map(rows.map((r) => [r.bureau_id, r.balance]));
}

export type PayableBuckets = {
	released: string;
	retained: string;
	debt: string;
	inPayout: string;
	nextReleaseAt: Date | null;
	paid: string;
};

// payable_buckets devolve zero linhas para quem não pode ver o Bureau. Isso não é "zero reais": é recusa.
export class PayableBucketsRefusedError extends Error {
	constructor() {
		super("Sem acesso ao valor a receber deste Bureau.");
		this.name = "PayableBucketsRefusedError";
	}
}

// released: líquido que o create_payout pagaria agora (estorno conta na hora, acréscimo após a retenção; nunca negativo).
// debt: estorno a compensar quando o líquido liberado é negativo. retained: só acréscimos ainda em liberação.
// inPayout: valor em repasse aberto (entre create_payout e mark_payout_paid).
// paid: soma dos lançamentos de repasse pago, em valor positivo.
export async function getPayableBuckets(client: PoolClient, bureauId: string): Promise<PayableBuckets> {
	const { rows } = await client.query<{
		released: string;
		retained: string;
		debt: string;
		in_payout: string;
		next_release_at: Date | null;
		paid: string;
	}>(
		`select b.released::text, b.retained::text, b.debt::text, b.in_payout::text, b.next_release_at,
		        (select coalesce(-sum(e.amount), 0.00)::text
		           from bureau_payable_entries e where e.bureau_id = $1 and e.kind = 'payout') as paid
		   from payable_buckets($1) b`,
		[bureauId],
	);
	const row = rows[0];
	if (!row) throw new PayableBucketsRefusedError();
	return {
		released: row.released,
		retained: row.retained,
		debt: row.debt,
		inPayout: row.in_payout,
		nextReleaseAt: row.next_release_at,
		paid: row.paid,
	};
}

// Prazo de retenção em dias (settings.payable_retention_days; 30 se ausente ou inválido), lido pela função SQL.
export function getPayableRetentionDays(identity: DbIdentity): Promise<number> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{ days: number }>("select payable_retention_days() as days");
		return rows[0].days;
	});
}

type EntryRow = {
	id: string;
	kind: PayableEntry["kind"];
	amount: string;
	order_ref: string | null;
	pix_charge_id: string | null;
	created_at: Date;
	created_at_utc: string;
};

// Keyset por (created_at, id), o mesmo par do índice. cursor = última linha da página.
export async function listPayableEntries(
	client: PoolClient,
	bureauId: string,
	options: { limit?: number; cursor?: string | null } = {},
): Promise<PayablePage> {
	const cursor = options.cursor ?? null;
	const match = cursor === null ? null : CURSOR.exec(cursor);
	if (cursor !== null && !match) throw new RangeError("Cursor inválido.");
	// NaN e Infinity (limit vindo de um parse malfeito) voltam ao padrão em vez de virar "limit NaN" no SQL.
	const requested = options.limit !== undefined && Number.isFinite(options.limit) ? options.limit : DEFAULT_LIMIT;
	const limit = Math.min(Math.max(Math.trunc(requested), 1), MAX_LIMIT);

	const { rows } = await client.query<EntryRow>(
		`select id, kind, amount, order_ref, pix_charge_id, created_at,
		        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at_utc
		   from bureau_payable_entries
		  where bureau_id = $1
		    and ($2::timestamptz is null or (created_at, id) < ($2::timestamptz, $3::uuid))
		  order by created_at desc, id desc
		  limit $4`,
		[bureauId, match?.[1] ?? null, match?.[2] ?? null, limit + 1],
	);
	const page = rows.slice(0, limit);
	const last = page[page.length - 1];
	return {
		rows: page.map((r) => ({
			id: r.id,
			kind: r.kind,
			amount: r.amount,
			orderRef: r.order_ref,
			pixChargeId: r.pix_charge_id,
			createdAt: r.created_at,
		})),
		nextCursor: rows.length > limit ? `${last.created_at_utc}_${last.id}` : null,
	};
}
