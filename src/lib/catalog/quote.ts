// Orçamento de um pedido: custo do Bureau e preço de venda, com as versões vigentes.
// O M3 cobra o custo com este resultado; o M6 liga a função ao pedido.
import type { DbIdentity } from "@/lib/db/transaction";

import { toCents } from "./money";
import { listCatalog } from "./queries";

// Único adicional do M2.
export const AI_ADDON_CODE = "parecer_ia";

export type QuoteLine = {
	productVersionId: string;
	code: string;
	costCents: number;
	priceCents: number;
};

export type Quote =
	| { ok: true; lines: QuoteLine[]; totalCostCents: number; totalPriceCents: number }
	| { ok: false; reason: "product_not_for_sale" | "addon_not_for_sale" };

export async function quoteOrder(
	identity: DbIdentity,
	productCode: string,
	options: { withAi: boolean },
): Promise<Quote> {
	const catalog = await listCatalog(identity);
	const main = catalog.find((e) => e.code === productCode && e.kind === "main" && e.onSale);
	if (!main) return { ok: false, reason: "product_not_for_sale" };

	const entries = [main];
	if (options.withAi) {
		const addon = catalog.find(
			(e) => e.code === AI_ADDON_CODE && e.onSale && e.addonFor?.includes(main.code),
		);
		if (!addon) return { ok: false, reason: "addon_not_for_sale" };
		entries.push(addon);
	}

	const lines = entries.map((e) => ({
		productVersionId: e.productVersionId,
		code: e.code,
		costCents: toCents(e.effectiveCost),
		// onSale garante o item.
		priceCents: toCents(e.item?.salePrice ?? "0"),
	}));
	return {
		ok: true,
		lines,
		totalCostCents: lines.reduce((sum, l) => sum + l.costCents, 0),
		totalPriceCents: lines.reduce((sum, l) => sum + l.priceCents, 0),
	};
}
