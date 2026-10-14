// Carteira pré-paga do Bureau (M3a). Nenhuma regra de saldo vive aqui: wallet_apply (012_wallet.sql)
// decide, e estas funções só traduzem o resultado. Todas recebem o PoolClient da transação do chamador.
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { platformIdentity, withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export type WalletFailure =
	| "insufficient_balance"
	| "reservation_exceeded"
	| "idempotency_conflict"
	| "reason_required"
	| "not_allowed"
	| "invalid_amount"
	| "invalid_key"
	| "not_found";

export type WalletResult =
	| { ok: true; entryId: string; available: string; reserved: string; replayed: boolean }
	| { ok: false; reason: WalletFailure };

export type MovementInput = {
	bureauId: string;
	amount: string;
	idempotencyKey: string;
	reference: string | null;
};

export type AdjustInput = {
	bureauId: string;
	amount: string;
	reason: string;
	idempotencyKey: string;
};

export type WalletBalance = { available: string; reserved: string };

export type LedgerEntry = {
	id: string;
	seq: string;
	kind: "topup" | "reserve" | "capture" | "release" | "adjustment";
	amount: string;
	availableAfter: string;
	reservedAfter: string;
	reference: string | null;
	reason: string | null;
	createdBy: string;
	createdAt: Date;
};

export type LedgerPage = { rows: LedgerEntry[]; nextCursor: string | null };

const MAX_LEDGER_LIMIT = 100;
const DEFAULT_LEDGER_LIMIT = 20;

type ApplyRow = {
	ok: boolean;
	reason: WalletFailure | null;
	entry_id: string | null;
	available: string | null;
	reserved: string | null;
	replayed: boolean;
};

async function walletApply(
	client: PoolClient,
	kind: "reserve" | "capture" | "release" | "adjustment",
	input: { bureauId: string; amount: string; idempotencyKey: string; reference?: string | null; reason?: string | null },
): Promise<WalletResult> {
	const { rows } = await client.query<ApplyRow>(
		"select ok, reason, entry_id, available, reserved, replayed from wallet_apply($1, $2, $3, $4, $5, $6)",
		[input.bureauId, kind, input.amount, input.idempotencyKey, input.reference ?? null, input.reason ?? null],
	);
	const row = rows[0];
	if (!row.ok) return { ok: false, reason: row.reason as WalletFailure };
	return {
		ok: true,
		entryId: row.entry_id as string,
		available: row.available as string,
		reserved: row.reserved as string,
		replayed: row.replayed,
	};
}

export const reserve = (client: PoolClient, input: MovementInput) => walletApply(client, "reserve", input);
export const capture = (client: PoolClient, input: MovementInput) => walletApply(client, "capture", input);
export const release = (client: PoolClient, input: MovementInput) => walletApply(client, "release", input);

// amount é decimal com sinal em reais; só o superadmin passa em wallet_apply.
export const adjust = (client: PoolClient, input: AdjustInput) => walletApply(client, "adjustment", input);

// Ajuste e auditoria na mesma transação. Um replay não audita de novo: o ajuste original já tem o evento.
export async function adjustWalletWithAudit(identity: DbIdentity, input: AdjustInput): Promise<WalletResult> {
	return withUserTransaction(platformIdentity(identity), async (client) => {
		const result = await adjust(client, input);
		if (!result.ok || result.replayed) return result;
		await writeAuditEvent(client, {
			actorId: identity.userId,
			bureauId: input.bureauId,
			action: "wallet.adjust",
			targetTable: "ledger_entries",
			targetId: result.entryId,
			metadata: {
				amount: input.amount,
				reason: input.reason,
				available_after: result.available,
				reserved_after: result.reserved,
			},
		});
		return result;
	});
}

export async function getWallet(client: PoolClient, bureauId: string): Promise<WalletBalance | null> {
	const { rows } = await client.query<WalletBalance>(
		"select available, reserved from wallets where bureau_id = $1",
		[bureauId],
	);
	return rows[0] ?? null;
}

type LedgerRow = {
	id: string;
	seq: string;
	kind: LedgerEntry["kind"];
	amount: string;
	available_after: string;
	reserved_after: string;
	reference: string | null;
	reason: string | null;
	created_by: string;
	created_at: Date;
};

// Keyset por seq (created_at repete entre lançamentos da mesma transação). cursor = seq da última linha da página.
export async function listLedger(
	client: PoolClient,
	bureauId: string,
	options: { limit?: number; cursor?: string | null } = {},
): Promise<LedgerPage> {
	const cursor = options.cursor ?? null;
	if (cursor !== null && !/^\d{1,18}$/.test(cursor)) throw new RangeError("Cursor inválido.");
	const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LEDGER_LIMIT), 1), MAX_LEDGER_LIMIT);

	const { rows } = await client.query<LedgerRow>(
		`select id, seq::text as seq, kind, amount, available_after, reserved_after, reference, reason, created_by, created_at
		   from ledger_entries
		  where bureau_id = $1 and ($2::bigint is null or seq < $2::bigint)
		  order by seq desc
		  limit $3`,
		[bureauId, cursor, limit + 1],
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
