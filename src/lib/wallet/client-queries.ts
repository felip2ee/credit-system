// Carteira do cliente (M3b). Só leitura: reserve, capture e release passam por reserve_order,
// capture_order e release_order (015_client_wallet_settlement.sql). Recebem o PoolClient da transação do chamador.
import type { PoolClient } from "pg";

export type ClientWalletBalance = { available: string; reserved: string };

export type ClientLedgerEntry = {
	id: string;
	seq: string;
	kind: "topup" | "reserve" | "capture" | "release" | "reversal" | "commission_credit";
	amount: string;
	availableAfter: string;
	reservedAfter: string;
	reference: string | null;
	reason: string | null;
	createdBy: string;
	createdAt: Date;
};

export type ClientLedgerPage = { rows: ClientLedgerEntry[]; nextCursor: string | null };

const MAX_LEDGER_LIMIT = 100;
const DEFAULT_LEDGER_LIMIT = 20;

export async function getClientWallet(
	client: PoolClient,
	clientProfileId: string,
): Promise<ClientWalletBalance | null> {
	const { rows } = await client.query<ClientWalletBalance>(
		"select available, reserved from client_wallets where client_profile_id = $1",
		[clientProfileId],
	);
	return rows[0] ?? null;
}

type LedgerRow = {
	id: string;
	seq: string;
	kind: ClientLedgerEntry["kind"];
	amount: string;
	available_after: string;
	reserved_after: string;
	reference: string | null;
	reason: string | null;
	created_by: string;
	created_at: Date;
};

// order by qualificado: "seq" sozinho ordenaria pela coluna de saída (texto): 9 viria depois de 10.
// Keyset por seq. cursor = seq da última linha da página.
export async function listClientLedger(
	client: PoolClient,
	clientProfileId: string,
	options: { limit?: number; cursor?: string | null } = {},
): Promise<ClientLedgerPage> {
	const cursor = options.cursor ?? null;
	if (cursor !== null && !/^\d{1,18}$/.test(cursor)) throw new RangeError("Cursor inválido.");
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LEDGER_LIMIT), 1), MAX_LEDGER_LIMIT);

	const { rows } = await client.query<LedgerRow>(
		`select id, seq::text as seq, kind, amount, available_after, reserved_after, reference, reason, created_by, created_at
		   from client_ledger_entries
		  where client_profile_id = $1 and ($2::bigint is null or seq < $2::bigint)
		  order by client_ledger_entries.seq desc
		  limit $3`,
		[clientProfileId, cursor, limit + 1],
	);
	const page = rows.slice(0, limit);
	return {
		rows: page.map((r) => ({
			id: r.id,
			seq: r.seq,
			kind: r.kind,
			amount: r.amount,
			availableAfter: r.available_after,
			reservedAfter: r.reserved_after,
			reference: r.reference,
			reason: r.reason,
			createdBy: r.created_by,
			createdAt: r.created_at,
		})),
		nextCursor: rows.length > limit ? page[page.length - 1].seq : null,
	};
}
