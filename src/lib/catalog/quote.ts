// Orçamento de um pedido: custo do Bureau e preço de venda, com as versões vigentes.
// Total = valor base + valor por sócio × número de sócios. O M3 cobra o custo com este resultado.
import type { DbIdentity } from "@/lib/db/transaction";

import { buildQuote, type QuoteLine } from "./build-quote";
import { toCents } from "./money";
import { listCatalog } from "./queries";

export { buildQuote, type QuoteLine } from "./build-quote";

export type Quote =
	| { ok: true; lines: QuoteLine[]; totalCostCents: number; totalPriceCents: number }
	| { ok: false; reason: "product_not_for_sale" };

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
