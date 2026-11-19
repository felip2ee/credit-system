// Orçamento de um pedido de balcão: preço da plataforma, comissão do Bureau e parte da plataforma (o que a
// reserva debita da carteira do Bureau). Total = valor base + valor por sócio × número de sócios.
import type { DbIdentity } from "@/lib/db/transaction";

import { buildQuote, type QuoteLine } from "./build-quote";
import { toCents } from "./money";
import { getEffectiveCommission, listCatalog, pctToHundredths } from "./queries";

export { buildQuote, commissionCents, type QuoteLine } from "./build-quote";

export type Quote =
	| {
			ok: true;
			lines: QuoteLine[];
			totalPriceCents: number;
			bureauCommissionCents: number;
			platformShareCents: number;
	  }
	| { ok: false; reason: "product_not_for_sale" | "commission_not_configured" };

export async function quoteOrder(
	identity: DbIdentity,
	productCode: "dossie_pf" | "dossie_empresarial",
	options: { partnerCount: number },
): Promise<Quote> {
	const product = (await listCatalog(identity)).find((e) => e.code === productCode);
	if (!product) return { ok: false, reason: "product_not_for_sale" };
	const commission = await getEffectiveCommission(identity, identity.bureauId);
	if (commission.pct === null) return { ok: false, reason: "commission_not_configured" };

	return {
		ok: true,
		...buildQuote(
			{
				productVersionId: product.productVersionId,
				code: product.code,
				salePriceCents: toCents(product.salePrice),
				salePricePerPartnerCents: toCents(product.salePricePerPartner),
			},
			options.partnerCount,
			pctToHundredths(commission.pct),
		),
	};
}
