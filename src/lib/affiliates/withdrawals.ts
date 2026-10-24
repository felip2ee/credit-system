// Saque e conversão da comissão do afiliado (028). Nenhuma regra vive aqui: as funções SQL decidem (taxa, saldo, trava,
// papel) e auditam na mesma transação, sem a chave PIX. Estas funções só traduzem o resultado. Nenhum PoolClient sai daqui.
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { ReceiptMime } from "@/lib/payouts/receipt";

export type PixKeyType = "document" | "email" | "phone" | "random";
export type WithdrawalStatus = "open" | "paid" | "cancelled";

export type WithdrawalFailure =
	| "not_allowed"
	| "not_found"
	| "invalid_amount"
	| "invalid_pix_key"
	| "invalid_request"
	| "invalid_reason"
	| "invalid_receipt"
	| "invalid_state"
	| "already_paid"
	| "net_not_positive"
	| "withdrawal_open"
	| "insufficient_funds"
	| "idempotency_conflict";

type Failure = { ok: false; reason: WithdrawalFailure };
type FailureRow = { ok: boolean; reason: WithdrawalFailure | null };

// Motivo que a função não conhece vira o mais genérico: a action o mapeia para a mensagem padrão.
const failure = (row: FailureRow): Failure => ({ ok: false, reason: row.reason ?? "invalid_state" });

export type MyWithdrawal = {
	id: string;
	amount: string;
	fee: string;
	net: string;
	pixKeyType: PixKeyType;
	pixKeyMasked: string;
	status: WithdrawalStatus;
	cancelReason: string | null;
	createdAt: Date;
	paidAt: Date | null;
};

export type QueueWithdrawal = {
	id: string;
	bureauId: string;
	profileId: string;
	amount: string;
	fee: string;
	net: string;
	pixKeyType: PixKeyType;
	pixKeyMasked: string;
	holderName: string;
	status: WithdrawalStatus;
	createdAt: Date;
	paidAt: Date | null;
};

// Só o superadmin fora de suporte recebe a chave completa; cada leitura grava withdrawal.view.
export type WithdrawalDetail = {
	id: string;
	bureauId: string;
	profileId: string;
	amount: string;
	fee: string;
	net: string;
	pixKeyType: PixKeyType;
	pixKey: string;
	holderName: string;
	status: WithdrawalStatus;
	cancelReason: string | null;
	receiptObjectKey: string | null;
	receiptMime: ReceiptMime | null;
	paidAt: Date | null;
	createdAt: Date;
};

export async function requestWithdrawal(
	identity: DbIdentity,
	input: { amount: string; pixKeyType: PixKeyType; pixKey: string },
): Promise<{ ok: true; withdrawalId: string } | Failure> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<FailureRow & { withdrawal_id: string | null }>(
			"select ok, reason, withdrawal_id from request_affiliate_withdrawal($1, $2, $3)",
			[input.amount, input.pixKeyType, input.pixKey],
		);
		const row = rows[0];
		if (!row.ok || !row.withdrawal_id) return failure(row);
		return { ok: true, withdrawalId: row.withdrawal_id };
	});
}

// requestId faz a conversão idempotente: repetir o mesmo pedido não converte duas vezes.
export async function convertCommission(
	identity: DbIdentity,
	input: { amount: string; requestId: string },
): Promise<{ ok: true } | Failure> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<FailureRow>("select ok, reason from convert_affiliate_commission($1, $2)", [
			input.amount,
			input.requestId,
		]);
		return rows[0].ok ? { ok: true } : failure(rows[0]);
	});
}

type MyRow = {
	id: string;
	amount: string;
	fee: string;
	net: string;
	pix_key_type: PixKeyType;
	pix_key_masked: string;
	status: WithdrawalStatus;
	cancel_reason: string | null;
	created_at: Date;
	paid_at: Date | null;
};

export async function listMyWithdrawals(identity: DbIdentity): Promise<MyWithdrawal[]> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<MyRow>(
			`select id, amount, fee, net, pix_key_type, pix_key_masked, status, cancel_reason, created_at, paid_at
			   from list_my_affiliate_withdrawals()`,
		);
		return rows.map((r) => ({
			id: r.id,
			amount: r.amount,
			fee: r.fee,
			net: r.net,
			pixKeyType: r.pix_key_type,
			pixKeyMasked: r.pix_key_masked,
			status: r.status,
			cancelReason: r.cancel_reason,
			createdAt: r.created_at,
			paidAt: r.paid_at,
		}));
	});
}

type QueueRow = {
	id: string;
	bureau_id: string;
	profile_id: string;
	amount: string;
	fee: string;
	net: string;
	pix_key_type: PixKeyType;
	pix_key_masked: string;
	holder_name: string;
	status: WithdrawalStatus;
	created_at: Date;
	paid_at: Date | null;
};

// Chave mascarada: a completa só sai por getWithdrawalDetail. status null traz todos.
export async function listWithdrawalQueue(
	identity: DbIdentity,
	status: WithdrawalStatus | null = "open",
): Promise<QueueWithdrawal[]> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<QueueRow>(
			`select id, bureau_id, profile_id, amount, fee, net, pix_key_type, pix_key_masked, holder_name, status,
			        created_at, paid_at
			   from list_affiliate_withdrawal_queue($1)`,
			[status],
		);
		return rows.map((r) => ({
			id: r.id,
			bureauId: r.bureau_id,
			profileId: r.profile_id,
			amount: r.amount,
			fee: r.fee,
			net: r.net,
			pixKeyType: r.pix_key_type,
			pixKeyMasked: r.pix_key_masked,
			holderName: r.holder_name,
			status: r.status,
			createdAt: r.created_at,
			paidAt: r.paid_at,
		}));
	});
}

type DetailRow = {
	id: string;
	bureau_id: string;
	profile_id: string;
	amount: string;
	fee: string;
	net: string;
	pix_key_type: PixKeyType;
	pix_key: string;
	holder_name: string;
	status: WithdrawalStatus;
	cancel_reason: string | null;
	receipt_object_key: string | null;
	receipt_mime: ReceiptMime | null;
	paid_at: Date | null;
	created_at: Date;
};

// null: não existe ou o papel não pode ver. A função grava withdrawal.view na mesma transação.
export async function getWithdrawalDetail(identity: DbIdentity, id: string): Promise<WithdrawalDetail | null> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<DetailRow>(
			`select id, bureau_id, profile_id, amount, fee, net, pix_key_type, pix_key, holder_name, status, cancel_reason,
			        receipt_object_key, receipt_mime, paid_at, created_at
			   from get_affiliate_withdrawal_detail($1)`,
			[id],
		);
		const r = rows[0];
		if (!r) return null;
		return {
			id: r.id,
			bureauId: r.bureau_id,
			profileId: r.profile_id,
			amount: r.amount,
			fee: r.fee,
			net: r.net,
			pixKeyType: r.pix_key_type,
			pixKey: r.pix_key,
			holderName: r.holder_name,
			status: r.status,
			cancelReason: r.cancel_reason,
			receiptObjectKey: r.receipt_object_key,
			receiptMime: r.receipt_mime,
			paidAt: r.paid_at,
			createdAt: r.created_at,
		};
	});
}

// replayed: o saque já estava pago com o mesmo comprovante; o objeto novo é redundante e o chamador o remove.
export async function markWithdrawalPaid(
	identity: DbIdentity,
	input: { id: string; receipt: { objectKey: string; mime: ReceiptMime; sha256: string } },
): Promise<{ ok: true; replayed: boolean } | Failure> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<FailureRow & { replayed: boolean }>(
			"select ok, reason, replayed from mark_affiliate_withdrawal_paid($1, $2, $3, $4)",
			[input.id, input.receipt.objectKey, input.receipt.mime, input.receipt.sha256],
		);
		return rows[0].ok ? { ok: true, replayed: rows[0].replayed } : failure(rows[0]);
	});
}

export async function cancelWithdrawal(
	identity: DbIdentity,
	input: { id: string; reason: string },
): Promise<{ ok: true } | Failure> {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<FailureRow>("select ok, reason from cancel_affiliate_withdrawal($1, $2)", [
			input.id,
			input.reason,
		]);
		return rows[0].ok ? { ok: true } : failure(rows[0]);
	});
}
