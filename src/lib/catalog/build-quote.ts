// Cálculo puro do orçamento (sem banco): o formulário do cliente e o servidor montam as mesmas linhas.
export type QuoteLine = {
	productVersionId: string;
	code: string;
	part: "base" | "partner";
	quantity: number;
	unitPriceCents: number;
	priceCents: number;
};

export type QuoteTerms = {
	productVersionId: string;
	code: string;
	salePriceCents: number;
	salePricePerPartnerCents: number;
};

const BASIS_POINTS = 10_000;

// Mesma conta do SQL (round(price * pct / 100, 2), meio para cima), em centavos inteiros. pct em centésimos de %.
export function commissionCents(priceCents: number, pctHundredths: number): number {
	return Math.floor((priceCents * pctHundredths + BASIS_POINTS / 2) / BASIS_POINTS);
}

export function buildQuote(
	terms: QuoteTerms,
	partnerCount: number,
	pctHundredths = 0,
): { lines: QuoteLine[]; totalPriceCents: number; bureauCommissionCents: number; platformShareCents: number } {
	const line = (part: QuoteLine["part"], quantity: number, unitPriceCents: number): QuoteLine => ({
		productVersionId: terms.productVersionId,
		code: terms.code,
		part,
		quantity,
		unitPriceCents,
		priceCents: unitPriceCents * quantity,
	});
	const lines = [line("base", 1, terms.salePriceCents)];
	if (partnerCount > 0) lines.push(line("partner", partnerCount, terms.salePricePerPartnerCents));
	const totalPriceCents = lines.reduce((sum, l) => sum + l.priceCents, 0);
	const bureauCommissionCents = commissionCents(totalPriceCents, pctHundredths);
	return {
		lines,
		totalPriceCents,
		bureauCommissionCents,
		platformShareCents: totalPriceCents - bureauCommissionCents,
	};
}
