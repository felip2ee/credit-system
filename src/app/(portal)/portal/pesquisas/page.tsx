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
		<div className="space-y-6">
			<PageHeader title="Pesquisas" description="Seus pedidos e entregas">
				<Button asChild glow>
					<Link href="/portal/pesquisas/nova">Nova pesquisa</Link>
				</Button>
			</PageHeader>
			{orders.length === 0 ? (
				<Card>
					<EmptyState icon={FolderOpen} title="Você ainda não fez nenhuma pesquisa" description="Faça sua primeira pesquisa em poucos passos." />
				</Card>
			) : (
				<ClientOrderList orders={orders} />
			)}
		</div>
	);
}
