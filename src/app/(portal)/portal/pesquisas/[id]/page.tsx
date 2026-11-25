import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { PageHeader } from "@/components/layout/page-header";
import { OrderStateBadge } from "@/components/orders/client-order-list";
import { CancelOrderButton } from "@/components/orders/cancel-order-button";
import { DeliveryView } from "@/components/orders/delivery-view";
import { OrderAutoRefresh } from "@/components/orders/order-auto-refresh";
import { OrderMembers } from "@/components/orders/order-members";
import { canCancelOrder } from "@/components/orders/order-rules";
import { orderSteps } from "@/components/orders/order-steps";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Stepper } from "@/components/ui/stepper";
import { StatusBanner } from "@/components/ui/status-banner";
import { getRequiredSession, sessionErrorPath } from "@/lib/auth/session";
import { hasPermission } from "@/lib/db/permissions";
import { withUserTransaction } from "@/lib/db/transaction";
import { listMyOrderMembers } from "@/lib/orders/client-ops";
import { getMyDelivery, getMyOrder } from "@/lib/orders/client-queries";
import { ORDER_REASON_LABEL, orderStepLines } from "@/lib/orders/labels";
import { failureMessage, type MoneyOutcome } from "@/lib/ui/failure-message";
import { formatCurrency, formatDateTime } from "@/lib/utils";
import { isUuid } from "@/lib/validators/id";

export const metadata = { title: "Pesquisa" };

export default async function ClientOrderPage({ params }: { params: { id: string } }) {
	const session = await getRequiredSession().catch((err) => redirect(sessionErrorPath(err)));
	if (!hasPermission(session, "portal:read")) redirect("/portal");
	if (!isUuid(params.id)) notFound();

	const found = await withUserTransaction(session, async (client) => {
		const order = await getMyOrder(client, params.id);
		if (!order) return null;
		return {
			order,
			members: await listMyOrderMembers(client, params.id),
			delivery: order.state === "released" ? await getMyDelivery(client, params.id) : null,
		};
	});
	if (!found) notFound();
	const { order, members, delivery } = found;

	const steps = orderSteps(order.state, order.reason);
	const ended = order.state === "failed" || order.state === "cancelled";
	const money: MoneyOutcome = order.mode !== "online" || order.reason === "reservation_clawed_back" ? "none" : "refunded";
	const failure = ended
		? failureMessage({
				what: order.reason ? ORDER_REASON_LABEL[order.reason] : "Este pedido foi encerrado.",
				money,
				next: "Veja suas pesquisas ou faça um novo pedido.",
			})
		: null;

	return (
		<div className="space-y-6">
			<OrderAutoRefresh orderId={order.dossierId} initialState={order.state} />
			<Link href="/portal/pesquisas" className="inline-flex min-h-12 items-center gap-1 font-bold text-primary hover:underline">
				<ArrowLeft aria-hidden className="size-5" />
				Voltar às pesquisas
			</Link>
			<PageHeader title={order.subjectName} description={`${order.subjectDocumentMasked} · ${formatDateTime(order.createdAt)}`} />
			<Card>
				<CardContent className="space-y-4 p-6">
					{steps && <Stepper steps={steps} />}
					<div className="flex flex-wrap items-center justify-between gap-3">
						<OrderStateBadge state={order.state} reason={null} />
						{order.price !== null && <p className="text-muted-foreground">
							Valor: <span className="font-bold tabular-nums">{formatCurrency(Number(order.price))}</span>
						</p>}
					</div>
					{!ended && orderStepLines(order).map((line) => <p key={line}>{line}</p>)}
				</CardContent>
			</Card>
			{failure && (
				<StatusBanner
					tone={order.state === "failed" ? "attention" : "neutral"}
					title={failure.title}
					description={
						<>
							{failure.money && <p>{failure.money}</p>}
							<p>{failure.next}</p>
						</>
					}
					action={
						<Button asChild>
							<Link href="/portal/pesquisas">Voltar para minhas pesquisas</Link>
						</Button>
					}
				/>
			)}
			<OrderMembers members={members} mode={order.mode} />
			{canCancelOrder(order.state, order.mode) && <CancelOrderButton dossierId={order.dossierId} />}
			{order.state === "released" &&
				(delivery ? (
					<DeliveryView delivery={delivery} />
				) : (
					<StatusBanner tone="attention" title="A entrega não está disponível agora." description="Tente novamente em instantes." />
				))}
		</div>
	);
}
