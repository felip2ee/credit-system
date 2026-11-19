// D26: o cliente não lê a tabela do catálogo. Preço de venda vem do catálogo público do Bureau; a comissão e a parte da plataforma são do
// banco (reserve_order recalcula tudo pelo pedido e só confere o preço total do cliente). Fora de "use server": não é endpoint.
import type { RequiredSession } from "@/lib/auth/session";
import { getPublicCatalog } from "@/lib/bureaus/public";
import { toCents } from "@/lib/catalog/money";
import { buildQuote } from "@/lib/catalog/quote";
import { withUserTransaction } from "@/lib/db/transaction";
import type { OrderQuote } from "@/lib/settlement/types";

export async function quoteFromPublicCatalog(
	session: RequiredSession,
	productCode: string,
	partnerCount: number,
): Promise<OrderQuote | { ok: false; reason: "product_not_for_sale" }> {
	const { rows } = await withUserTransaction(session, (client) =>
		client.query<{ slug: string }>("select slug from bureaus where id = app_bureau_id()"),
	);
	if (!rows[0]) throw new Error("bureau slug not found");
	const catalog = await getPublicCatalog(rows[0].slug);
	const product = catalog.find((item) => item.code === productCode);
	if (!product) return { ok: false, reason: "product_not_for_sale" };
	return {
		ok: true,
		...buildQuote(
			{
				productVersionId: "",
				code: product.code,
				salePriceCents: toCents(product.salePrice),
				salePricePerPartnerCents: toCents(product.salePricePerPartner),
			},
			partnerCount,
		),
	};
}
