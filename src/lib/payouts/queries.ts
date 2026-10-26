// Repasse ao Bureau (M3b). Nenhuma regra de repasse vive aqui: create_payout, mark_payout_paid e cancel_payout
// (016_payouts_nfse.sql) decidem, e estas funções traduzem o resultado e gravam a auditoria na mesma transação.
//
// Auditoria: payout.* grava o Bureau alvo em bureau_id (política audit_logs_insert, 017): o Bureau e o superadmin leem.
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { ReceiptMime } from "./receipt";

export type PayoutStatus = "open" | "paid" | "cancelled";

export type PayoutFailure =
	| "not_allowed"
	| "invalid_cutoff"
	| "not_found"
	| "nothing_to_pay"
	| "cutoff_within_retention"
	| "invalid_state"
	| "already_paid"
	| "invalid_receipt";

export type Payout = {
	id: string;
	bureauId: string;
	cutoffAt: Date;
	amount: string;
	status: PayoutStatus;
	createdAt: Date;
	paidAt: Date | null;
	hasReceipt: boolean;
};

export type PayoutReceiptRef = {
	bureauId: string;
	objectKey: string;
	mime: ReceiptMime;
};

export type CreatePayoutResult =
	| { ok: true; payoutId: string; amount: string }
	| { ok: false; reason: PayoutFailure };
// replayed: o repasse já estava pago com o mesmo comprovante; o objeto novo é redundante e o chamador o remove.
export type MarkPayoutPaidResult =
	| { ok: true; bureauId: string; replayed: boolean }
	| { ok: false; reason: PayoutFailure };
export type CancelPayoutResult =
	| { ok: true; bureauId: string }
	| { ok: false; reason: PayoutFailure };

type StatusRow = {
	ok: boolean;
	reason: PayoutFailure | null;
	status: string | null;
};

export async function createPayout(
	identity: DbIdentity,
	input: { bureauId: string; cutoffAt: Date },
): Promise<CreatePayoutResult> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{
			ok: boolean;
			reason: PayoutFailure | null;
			payout_id: string | null;
			amount: string | null;
		}>("select ok, reason, payout_id, amount from create_payout($1, $2)", [
			input.bureauId,
			input.cutoffAt,
		]);
		const row = rows[0];
		if (!row.ok) return { ok: false, reason: row.reason ?? "invalid_state" };
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "payout.create",
			targetTable: "payouts",
			targetId: row.payout_id,
			bureauId: input.bureauId,
			metadata: {
				amount: row.amount,
				cutoffAt: input.cutoffAt.toISOString(),
			},
		});
		return {
			ok: true,
			payoutId: row.payout_id as string,
			amount: row.amount as string,
		};
	});
}

// written_here: a linha foi escrita por esta transação (mesmo sinal da política de auditoria, 017). Repetição de
// um cancelamento já feito devolve ok sem escrever; a política recusaria o evento sem a linha escrita aqui.
async function cancelledHere(
	client: PoolClient,
	payoutId: string,
): Promise<{ bureauId: string; writtenHere: boolean } | null> {
	const { rows } = await client.query<{ bureau_id: string; written_here: boolean }>(
		"select bureau_id, xmin = pg_current_xact_id()::xid as written_here from payouts where id = $1",
		[payoutId],
	);
	return rows[0] ? { bureauId: rows[0].bureau_id, writtenHere: rows[0].written_here } : null;
}

// O comprovante (chave, mime, sha256) vem de storePayoutReceipt; a auditoria não leva nada do arquivo.
export async function markPayoutPaid(
	identity: DbIdentity,
	input: {
		payoutId: string;
		receipt: { objectKey: string; mime: ReceiptMime; sha256: string };
	},
): Promise<MarkPayoutPaidResult> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<StatusRow>(
			"select ok, reason, status from mark_payout_paid($1, $2, $3, $4)",
			[
				input.payoutId,
				input.receipt.objectKey,
				input.receipt.mime,
				input.receipt.sha256,
			],
		);
		const row = rows[0];
		if (!row.ok) return { ok: false, reason: row.reason ?? "invalid_state" };

		const stored = await client.query<{
			bureau_id: string;
			receipt_object_key: string;
		}>("select bureau_id, receipt_object_key from payouts where id = $1", [
			input.payoutId,
		]);
		const { bureau_id: bureauId, receipt_object_key: storedKey } =
			stored.rows[0];
		const replayed = storedKey !== input.receipt.objectKey;
		// Repetição com o mesmo comprovante não grava outro evento: o primeiro pagamento já tem o dele.
		if (!replayed) {
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "payout.pay",
				targetTable: "payouts",
				targetId: input.payoutId,
				bureauId,
			});
		}
		return { ok: true, bureauId, replayed };
	});
}

export async function cancelPayout(
	identity: DbIdentity,
	payoutId: string,
): Promise<CancelPayoutResult> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<StatusRow>(
			"select ok, reason, status from cancel_payout($1)",
			[payoutId],
		);
		const row = rows[0];
		if (!row.ok) return { ok: false, reason: row.reason ?? "invalid_state" };
		const payout = await cancelledHere(client, payoutId);
		if (!payout) return { ok: false, reason: "not_found" };
		if (payout.writtenHere) {
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "payout.cancel",
				targetTable: "payouts",
				targetId: payoutId,
				bureauId: payout.bureauId,
			});
		}
		return { ok: true, bureauId: payout.bureauId };
	});
}

type PayoutRow = {
	id: string;
	bureau_id: string;
	cutoff_at: Date;
	amount: string;
	status: PayoutStatus;
	created_at: Date;
	paid_at: Date | null;
	has_receipt: boolean;
};

const SELECT_PAYOUT = `select id, bureau_id, cutoff_at, amount, status, created_at, paid_at,
	receipt_object_key is not null as has_receipt
	from payouts`;

const LIST_LIMIT = 100;

const toPayout = (r: PayoutRow): Payout => ({
	id: r.id,
	bureauId: r.bureau_id,
	cutoffAt: r.cutoff_at,
	amount: r.amount,
	status: r.status,
	createdAt: r.created_at,
	paidAt: r.paid_at,
	hasReceipt: r.has_receipt,
});

// A RLS decide o escopo: o bureau_admin vê só o próprio Bureau; o superadmin (sem suporte) vê todos.
export async function listPayouts(
	client: PoolClient,
	filter: { bureauId?: string; status?: PayoutStatus } = {},
): Promise<Payout[]> {
	const { rows } = await client.query<PayoutRow>(
		`${SELECT_PAYOUT}
		 where ($1::uuid is null or bureau_id = $1) and ($2::text is null or status = $2)
		 order by created_at desc, id limit $3`,
		[filter.bureauId ?? null, filter.status ?? null, LIST_LIMIT],
	);
	return rows.map(toPayout);
}

export async function getPayout(
	client: PoolClient,
	id: string,
): Promise<Payout | null> {
	const { rows } = await client.query<PayoutRow>(
		`${SELECT_PAYOUT} where id = $1`,
		[id],
	);
	return rows[0] ? toPayout(rows[0]) : null;
}

// Só para a rota de download: a chave nunca vai à UI. null = sem repasse visível ou sem comprovante.
export async function getPayoutReceiptRef(
	client: PoolClient,
	id: string,
): Promise<PayoutReceiptRef | null> {
	const { rows } = await client.query<{
		bureau_id: string;
		receipt_object_key: string;
		receipt_mime: ReceiptMime;
	}>(
		"select bureau_id, receipt_object_key, receipt_mime from payouts where id = $1 and receipt_object_key is not null",
		[id],
	);
	const row = rows[0];
	return row
		? {
				bureauId: row.bureau_id,
				objectKey: row.receipt_object_key,
				mime: row.receipt_mime,
			}
		: null;
}
