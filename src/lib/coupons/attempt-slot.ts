// Vagas de tentativa de código de cupom (migração 054). A vaga é gravada ANTES de avaliar o código, numa transação
// própria e confirmada, e serializada por cliente no banco. Só o sucesso do pedido a apaga: vaga que sobra conta como
// erro (fecha fechado). Sem código de cupom no log.
import type { PoolClient } from "pg";

import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

// Id da vaga, ou null quando o cliente está no limite ou a vaga não pôde ser aberta (recusa o cupom).
export async function beginCouponAttempt(identity: DbIdentity): Promise<string | null> {
	try {
		return await withUserTransaction(identity, async (client) => {
			const { rows } = await client.query<{ id: string | null }>("select coupon_attempt_begin() as id");
			return rows[0]?.id ?? null;
		});
	} catch (error) {
		console.error("beginCouponAttempt failed", error instanceof Error ? error.message : "unknown error");
		return null;
	}
}

// Dentro da transação do pedido: com a vaga em mãos o banco não confere o limite de novo (a vaga contaria contra ele).
export async function holdCouponSlot(client: PoolClient, slotId: string): Promise<void> {
	await client.query("select set_config('app.coupon_slot', $1, true)", [slotId]);
}

// Nunca lança. Se falhar, a vaga fica e conta como erro (fecha fechado).
export async function clearCouponAttempt(identity: DbIdentity, slotId: string): Promise<void> {
	try {
		await withUserTransaction(identity, async (client) => {
			await client.query("select coupon_attempt_clear($1)", [slotId]);
		});
	} catch (error) {
		console.error("clearCouponAttempt failed", error instanceof Error ? error.message : "unknown error");
	}
}
