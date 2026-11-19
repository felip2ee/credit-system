// Conta um erro de código de cupom numa transação própria e já confirmada (migração 053). O pedido dá rollback
// quando o cupom é inválido, e isso desfaria o erro gravado por coupon_preview. Nunca lança: a resposta ao
// usuário continua "Cupom inválido ou indisponível". Sem código de cupom no log.
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

// Motivos de recusa que são problema do código. coupon_funds_insufficient é do Bureau: não conta.
const CODE_FAILURES: ReadonlySet<string> = new Set([
	"coupon_invalid",
	"coupon_expired",
	"coupon_exhausted",
	"coupon_client_limit",
	"coupon_product_not_allowed",
]);

export const isCouponCodeFailure = (reason: string): boolean => CODE_FAILURES.has(reason);

export async function recordCouponMiss(identity: DbIdentity): Promise<void> {
	if (identity.role !== "client") return;
	try {
		await withUserTransaction(identity, async (client) => {
			await client.query("select coupon_record_miss()");
		});
	} catch (error) {
		console.error("recordCouponMiss failed", error instanceof Error ? error.message : "unknown error");
	}
}
