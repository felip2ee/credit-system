// Ajuste de saldo do cliente pelo Bureau. Nenhuma regra de saldo vive aqui: adjust_client_balance
// (029_client_balance_adjustments.sql) decide, e estas funções só traduzem o resultado.
import type { PoolClient } from "pg";

import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

export type ClientAdjustmentDirection = "credit" | "debit";

export type ClientAdjustmentFailure =
	| "not_allowed"
	| "invalid_direction"
	| "invalid_amount"
	| "invalid_reason"
	| "invalid_request"
	| "request_conflict"
	| "not_found"
	| "insufficient_bureau_funds"
	| "insufficient_client_funds";

// O cliente vem do titular (holders.client_profile_id): o Bureau enxerga o cliente pela página do titular.
// requestId é gerado uma vez por diálogo: repetir o mesmo id devolve o mesmo ajuste sem lançar de novo.
export type ClientAdjustmentInput = {
	holderId: string;
	requestId: string;
	direction: ClientAdjustmentDirection;
	amount: string;
	reason: string;
};

export type ClientAdjustmentResult =
	| { ok: true; adjustmentId: string; clientProfileId: string }
	| { ok: false; reason: ClientAdjustmentFailure };

export type ClientAdjustment = {
	id: string;
	direction: ClientAdjustmentDirection;
	amount: string;
	reason: string;
	createdAt: Date;
	authorName: string;
};

type AdjustRow = { ok: boolean; reason: ClientAdjustmentFailure | null; adjustment_id: string | null };

// Ajuste, lançamentos nos dois livros e auditoria: uma transação dentro da função.
export async function adjustClientBalance(
	identity: DbIdentity,
	input: ClientAdjustmentInput,
): Promise<ClientAdjustmentResult> {
	return withUserTransaction(identity, async (client) => {
		// RLS limita o titular ao Bureau da sessão; o banco confere de novo que o cliente é do Bureau.
		const holder = await client.query<{ client_profile_id: string | null }>(
			"select client_profile_id from holders where id = $1",
			[input.holderId],
		);
		const clientProfileId = holder.rows[0]?.client_profile_id;
		if (!clientProfileId) return { ok: false, reason: "not_found" };
		const { rows } = await client.query<AdjustRow>(
			"select ok, reason, adjustment_id from adjust_client_balance($1, $2, $3, $4, $5)",
			[clientProfileId, input.direction, input.amount, input.reason, input.requestId],
		);
		const row = rows[0];
		if (!row.ok) return { ok: false, reason: row.reason as ClientAdjustmentFailure };
		return { ok: true, adjustmentId: row.adjustment_id as string, clientProfileId };
	});
}

type HistoryRow = {
	id: string;
	direction: ClientAdjustmentDirection;
	amount: string;
	reason: string;
	created_at: Date;
	author_name: string;
};

// Só a equipe do Bureau dono recebe linhas (com o nome de quem ajustou); para qualquer outro papel a lista vem vazia.
export async function listClientAdjustments(
	client: PoolClient,
	clientProfileId: string,
	options: { limit?: number } = {},
): Promise<ClientAdjustment[]> {
	const { rows } = await client.query<HistoryRow>(
		"select id, direction, amount, reason, created_at, author_name from list_client_balance_adjustments($1, $2)",
		[clientProfileId, options.limit ?? 50],
	);
	return rows.map((r) => ({
		id: r.id,
		direction: r.direction,
		amount: r.amount,
		reason: r.reason,
		createdAt: r.created_at,
		authorName: r.author_name,
	}));
}
