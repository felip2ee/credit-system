// Valor a repassar ao Bureau (M3b). Só leitura: os lançamentos nascem em capture_order (015_client_wallet_settlement.sql).
// Os valores têm sinal: acréscimo (+), estorno (−) e repasse pago (−). O saldo é a soma. Sem view: soma direta.
// A RLS deixa o operator ler a tabela; quem barra o operator é a permissão payout:read na Server Action.
import type { PoolClient } from "pg";

export type PayableEntry = {
	id: string;
	kind: "accrual" | "reversal" | "payout";
	amount: string;
	orderRef: string | null;
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

type EntryRow = {
	id: string;
	kind: PayableEntry["kind"];
	amount: string;
	order_ref: string | null;
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
		`select id, kind, amount, order_ref, created_at,
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
		rows: page.map((r) => ({ id: r.id, kind: r.kind, amount: r.amount, orderRef: r.order_ref, createdAt: r.created_at })),
		nextCursor: rows.length > limit ? `${last.created_at_utc}_${last.id}` : null,
	};
}
