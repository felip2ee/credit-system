// Total a receber: soma com sinal de tudo que ainda não foi pago ao Bureau. Igual a getPayableBalance (payables/queries).
// released já é líquido (nunca negativo) e debt é o estorno que ele não cobriu; por isso debt entra subtraindo.
import type { PayableBuckets } from "@/lib/payables/queries";

type OwedParts = Pick<PayableBuckets, "released" | "retained" | "inPayout" | "debt">;

const toCents = (v: string) => Math.round(Number(v) * 100);

export function payableOwed(b: OwedParts): string {
	const cents = toCents(b.released) + toCents(b.retained) + toCents(b.inPayout) - toCents(b.debt);
	return (cents / 100).toFixed(2);
}

export const hasDebt = (b: Pick<PayableBuckets, "debt">): boolean => toCents(b.debt) > 0;
