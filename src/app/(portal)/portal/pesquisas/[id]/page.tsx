import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { PageHeader } from "@/components/layout/page-header";
import { OrderStateBadge } from "@/components/orders/client-order-list";
import { DeliveryView } from "@/components/orders/delivery-view";
import { Card, CardContent } from "@/components/ui/card";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { getMyDelivery, listMyOrders } from "@/lib/orders/client-queries";
import { ORDER_REASON_LABEL } from "@/lib/orders/labels";
import type { OrderState, OrderStateReason } from "@/lib/orders/types";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";

export const metadata = { title: "Pesquisa" };

const LIST_LIMIT = 500;
const REFUNDED = "A reserva foi devolvida ao seu saldo.";

const NEXT_STEP: Partial<Record<OrderState, string>> = {
	awaiting_payment: "Aguardando o pagamento.",
	awaiting_authorization: "Aguardando a autorização do titular. O pedido expira em 7 dias sem resposta.",
	ready: "Consulta em andamento.",
	executing: "Consulta em andamento.",
	completed: "Concluída. Aguardando liberação do Bureau.",
};

function nextStep(state: OrderState, reason: OrderStateReason | null): string[] {
	if (state === "failed" || state === "cancelled") return [reason ? ORDER_REASON_LABEL[reason] : "Pedido encerrado.", REFUNDED];
	return NEXT_STEP[state] ? [NEXT_STEP[state]] : [];
}

export default async function ClientOrderPage({ params }: { params: { id: string } }) {
	const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
	if (!hasPermission(session, "portal:read")) redirect("/portal");
	if (!isUuid(params.id)) notFound();

	const found = await withUserTransaction(session, async (client) => {
		const order = (await listMyOrders(client, LIST_LIMIT)).find((o) => o.dossierId === params.id);
		if (!order) return null;
		return { order, delivery: order.state === "released" ? await getMyDelivery(client, params.id) : null };
	});
	if (!found) notFound();
	const { order, delivery } = found;

	return (
		<div className="space-y-6">
			<Link href="/portal/pesquisas" className="text-sm underline">
				Voltar às pesquisas
			</Link>
			<PageHeader title={order.subjectName} description={`${order.subjectDocumentMasked} · ${formatDateTime(order.createdAt)}`} />
			<Card>
				<CardContent className="flex flex-wrap items-start justify-between gap-4 p-6">
					<div className="space-y-1 text-sm">
						{nextStep(order.state, order.reason).map((line) => (
							<p key={line}>{line}</p>
						))}
						{order.price !== null && <p className="text-muted-foreground">Valor: {formatCurrency(Number(order.price))}</p>}
					</div>
					<OrderStateBadge state={order.state} reason={order.reason} />
				</CardContent>
			</Card>
			{order.state === "released" &&
				(delivery ? (
					<DeliveryView delivery={delivery} />
				) : (
					<p className="text-sm text-muted-foreground">A entrega não está disponível agora. Tente novamente em instantes.</p>
				))}
		</div>
	);
}
