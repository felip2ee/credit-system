import { redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { ClientOrderForm } from "@/components/orders/client-order-form";
import { StatusBanner } from "@/components/ui/status-banner";
import { getClientAccountStatus } from "@/lib/account/queries";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { getPublicCatalog } from "@/lib/bureaus/public";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getCurrentDeclaration } from "@/lib/orders/client-ops";
import { getMyHolderType } from "@/lib/orders/client-queries";
import type { OrderProductCode } from "@/lib/orders/types";

export const metadata = { title: "Nova pesquisa" };

export default async function NewClientOrderPage() {
	const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
	if (!hasPermission(session, "portal:read")) redirect("/portal");

	const data = await withUserTransaction(session, async (client) => {
		const bureau = await client.query<{ slug: string }>("select slug from bureaus where id = app_bureau_id()");
		return {
			slug: bureau.rows[0]?.slug ?? null,
			status: await getClientAccountStatus(client, session.userId),
			holderType: await getMyHolderType(client, session.userId),
			declaration: await getCurrentDeclaration(client),
		};
	});
	const catalog = data.slug ? await getPublicCatalog(data.slug) : [];
	const products = catalog
		.filter((item): item is typeof item & { code: OrderProductCode } => item.code === "dossie_pf" || item.code === "dossie_empresarial")
		.map((item) => ({ code: item.code, name: item.name, price: item.salePrice, pricePerPartner: item.salePricePerPartner }));

	return (
		<div className="space-y-6">
			<PageHeader title="Nova pesquisa" description="Escolha o dossiê e informe os dados do pedido" />
			{products.length === 0 ? (
				<StatusBanner tone="neutral" title="Nenhum produto à venda no momento." description="Tente novamente mais tarde." />
			) : (
				<ClientOrderForm
					products={products}
					holderType={data.holderType}
					declaration={data.declaration}
					selfDocumentMasked={data.status.documentMasked}
				/>
			)}
		</div>
	);
}
