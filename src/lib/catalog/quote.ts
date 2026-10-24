// Orçamento de um pedido: custo do Bureau e preço de venda, com as versões vigentes.
// Total = valor base + valor por sócio × número de sócios. O M3 cobra o custo com este resultado.
import type { DbIdentity } from "@/lib/db/transaction";

import { toCents } from "./money";
import { listCatalog } from "./queries";

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

export type Quote =
	| { ok: true; lines: QuoteLine[]; totalCostCents: number; totalPriceCents: number }
	| { ok: false; reason: "product_not_for_sale" };

type QuoteTerms = {
	productVersionId: string;
	code: string;
	salePriceCents: number;
	salePricePerPartnerCents: number;
	costCents: number;
	costPerPartnerCents: number;
};

// Função pura: o balcão (quoteOrder) e o portal (catálogo público) montam as mesmas linhas.
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

export async function quoteOrder(
	identity: DbIdentity,
	productCode: "dossie_pf" | "dossie_empresarial",
	options: { partnerCount: number },
): Promise<Quote> {
	const catalog = await listCatalog(identity);
	const product = catalog.find((e) => e.code === productCode && e.onSale);
	if (!product?.item) return { ok: false, reason: "product_not_for_sale" };

	return {
		ok: true,
		...buildQuote(
			{
				productVersionId: product.productVersionId,
				code: product.code,
				salePriceCents: toCents(product.item.salePrice),
				salePricePerPartnerCents: toCents(product.item.salePricePerPartner),
				costCents: toCents(product.effectiveCost),
				costPerPartnerCents: toCents(product.effectiveCostPerPartner),
			},
			options.partnerCount,
		),
	};
}
