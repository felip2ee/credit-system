import Link from "next/link";
import { redirect } from "next/navigation";
import { FolderOpen } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { ClientOrderList } from "@/components/orders/client-order-list";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listMyOrders } from "@/lib/orders/client-queries";

export const metadata = { title: "Pesquisas" };

export default async function ClientOrdersPage() {
	const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
	if (!hasPermission(session, "portal:read")) redirect("/portal");

	const orders = await withUserTransaction(session, (client) => listMyOrders(client));

	return (
		<div className="space-y-4">
			<PageHeader title="Pesquisas" description="Seus pedidos e entregas">
				{orders.length > 0 && (
					<Button asChild variant="cta" glow>
						<Link href="/portal/pesquisas/nova">Nova pesquisa</Link>
					</Button>
				)}
			</PageHeader>
			{orders.length === 0 ? (
				<Card>
					<EmptyState
						icon={FolderOpen}
						title="Você ainda não fez nenhuma pesquisa"
						description="Primeiro passo: escolha se a pesquisa é de uma pessoa ou de uma empresa. Depois é só preencher os dados e confirmar."
						action={
							<Button asChild variant="cta" glow>
								<Link href="/portal/pesquisas/nova">Fazer minha primeira pesquisa</Link>
							</Button>
						}
					/>
				</Card>
			) : (
				<ClientOrderList orders={orders} />
			)}
		</div>
	);
}
