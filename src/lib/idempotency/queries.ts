// Chave de idempotência (063): um envio do formulário vira no máximo um registro e uma cobrança. A chave é gravada na
// transação do chamador, junto do registro: se a transação desfaz, a chave some e o reenvio com a mesma chave vale.
import { createHash } from "node:crypto";

import type { PoolClient } from "pg";

export type IdempotencyScope = "order" | "counter_payment";

export type IdempotencyClaim =
	| { status: "new" }
	// sameRequest false: a mesma chave chegou com outro corpo. O chamador recusa em vez de devolver o registro de outro envio.
	| { status: "duplicate"; recordId: string; sameRequest: boolean };

// Chaves em ordem fixa: o mesmo corpo sempre dá o mesmo hash. Date vira ISO, como no JSON.
function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object" && !(value instanceof Date)) {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([k, v]) => [k, canonical(v)]),
		);
	}
	return value;
}

export const hashRequest = (payload: unknown): string =>
	createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");

// Chamar antes de gravar o registro. O INSERT espera a transação que já tem a mesma chave: se ela confirma, este
// envio vê o conflito; se ela desfaz, este segue como novo. Só vale sob withUserTransaction (app_user_id e RLS).
export async function claimIdempotencyKey(
	client: PoolClient,
	input: { scope: IdempotencyScope; key: string; payload: unknown },
): Promise<IdempotencyClaim> {
	const requestHash = hashRequest(input.payload);
	const inserted = await client.query(
		`insert into idempotency_keys (user_id, scope, key, bureau_id, request_hash)
		 values (app_user_id(), $1, $2, app_bureau_id(), $3)
		 on conflict do nothing`,
		[input.scope, input.key, requestHash],
	);
	if (inserted.rowCount === 1) return { status: "new" };
	const { rows } = await client.query<{ record_id: string | null; request_hash: string }>(
		"select record_id, request_hash from idempotency_keys where user_id = app_user_id() and scope = $1 and key = $2",
		[input.scope, input.key],
	);
	const existing = rows[0];
	// record_id é ligado na mesma transação que grava a chave: linha confirmada sem ele é defeito, não é duplicata.
	if (!existing?.record_id) throw new Error("idempotency key without record");
	return { status: "duplicate", recordId: existing.record_id, sameRequest: existing.request_hash === requestHash };
}

// Liga a chave ao registro criado. Mesma transação do claim.
export async function bindIdempotencyKey(
	client: PoolClient,
	input: { scope: IdempotencyScope; key: string; recordId: string },
): Promise<void> {
	const { rowCount } = await client.query(
		"update idempotency_keys set record_id = $3 where user_id = app_user_id() and scope = $1 and key = $2 and record_id is null",
		[input.scope, input.key, input.recordId],
	);
	if (rowCount !== 1) throw new Error("idempotency key not claimed");
}
