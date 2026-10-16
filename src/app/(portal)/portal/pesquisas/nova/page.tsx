import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { ClientOrderForm } from "@/components/orders/client-order-form";
import { getClientAccountStatus } from "@/lib/account/queries";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { getPublicCatalog } from "@/lib/bureaus/public";
import { AI_ADDON_CODE } from "@/lib/catalog/quote";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getClientWallet } from "@/lib/wallet/client-queries";

export const metadata = { title: "Nova pesquisa" };

export default async function NewClientOrderPage() {
	const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
	if (!hasPermission(session, "portal:read")) redirect("/portal");

	const data = await withUserTransaction(session, async (client) => {
		const bureau = await client.query<{ slug: string }>("select slug from bureaus where id = app_bureau_id()");
		return {
			slug: bureau.rows[0]?.slug ?? null,
			status: await getClientAccountStatus(client, session.userId),
			wallet: await getClientWallet(client, session.userId),
		};
	});
	const catalog = data.slug ? await getPublicCatalog(data.slug) : [];
	const products = catalog
		.filter((item) => item.kind === "main" && (item.code === "consulta_pf" || item.code === "consulta_pj"))
		.map((item) => ({ code: item.code as "consulta_pf" | "consulta_pj", name: item.name, price: item.salePrice }));
	const aiPrice = catalog.find((item) => item.kind === "addon" && item.code === AI_ADDON_CODE)?.salePrice ?? null;

	return (
		<div className="space-y-6">
			<PageHeader title="Nova pesquisa" description="Escolha o produto e quem será pesquisado" />
			{products.length === 0 ? (
				<p className="text-sm text-muted-foreground">Nenhum produto à venda no momento. Tente novamente mais tarde.</p>
			) : (
				<ClientOrderForm
					products={products}
					aiPrice={aiPrice}
					selfDocumentMasked={data.status.documentMasked}
					available={data.wallet?.available ?? "0"}
				/>
			)}
		</div>
	);
}
