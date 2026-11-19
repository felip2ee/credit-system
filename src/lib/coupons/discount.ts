// Desconto de cupom em centavos. Gêmeo do cálculo de reserve_order (049): o SQL decide, esta função só prevê o preço
// pago para o formulário e para o p_price. Arredonda uma vez, sobre o total aceito (meio centavo sobe, como o round do numeric).
export type CouponDiscountInput = {
	kind: "percent" | "fixed";
	// Percentual: 0,01 a 100 (ex.: 33.33). Fixo: reais (ex.: 12.5). Mesma unidade da coluna coupons.value.
	value: number;
	eligibleTotalCents: number;
};

export type CouponDiscount = { discountCents: number; paidCents: number };

const HUNDREDTHS = 100;

export function computeCouponDiscount(input: CouponDiscountInput): CouponDiscount {
	const base = Math.max(0, Math.round(input.eligibleTotalCents));
	// Valor com até 2 casas vira inteiro (centésimos): evita erro de ponto flutuante na multiplicação.
	const hundredths = Math.round(input.value * HUNDREDTHS);
	const discountCents =
		input.kind === "percent"
			? // round(base * pct / 100) com pct = hundredths / 100, em inteiros: floor(x + 1/2).
				Math.floor((2 * base * hundredths + HUNDREDTHS * HUNDREDTHS) / (2 * HUNDREDTHS * HUNDREDTHS))
			: Math.min(hundredths, base);
	const capped = Math.min(Math.max(discountCents, 0), base);
	return { discountCents: capped, paidCents: base - capped };
}

// Soma só as linhas dos produtos que o cupom aceita.
export function eligibleTotalCents(
	lines: readonly { code: string; priceCents: number }[],
	eligibleProductCodes: readonly string[],
): number {
	return lines.filter((l) => eligibleProductCodes.includes(l.code)).reduce((sum, l) => sum + l.priceCents, 0);
}
