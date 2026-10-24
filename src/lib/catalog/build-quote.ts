// Cálculo puro do orçamento (sem banco): o formulário do cliente e o servidor montam as mesmas linhas.
export type QuoteLine = {
	productVersionId: string;
	code: string;
	part: "base" | "partner";
	quantity: number;
	unitPriceCents: number;
	unitCostCents: number;
	priceCents: number;
	costCents: number;
};

export type QuoteTerms = {
	productVersionId: string;
	code: string;
	salePriceCents: number;
	salePricePerPartnerCents: number;
	costCents: number;
	costPerPartnerCents: number;
};

export function buildQuote(
	terms: QuoteTerms,
	partnerCount: number,
): { lines: QuoteLine[]; totalPriceCents: number; totalCostCents: number } {
	const line = (part: QuoteLine["part"], quantity: number, unitPriceCents: number, unitCostCents: number) => ({
		productVersionId: terms.productVersionId,
		code: terms.code,
		part,
		quantity,
		unitPriceCents,
		unitCostCents,
		priceCents: unitPriceCents * quantity,
		costCents: unitCostCents * quantity,
	});
	const lines = [line("base", 1, terms.salePriceCents, terms.costCents)];
	if (partnerCount > 0) {
		lines.push(line("partner", partnerCount, terms.salePricePerPartnerCents, terms.costPerPartnerCents));
	}
	return {
		lines,
		totalPriceCents: lines.reduce((sum, l) => sum + l.priceCents, 0),
		totalCostCents: lines.reduce((sum, l) => sum + l.costCents, 0),
	};
}
