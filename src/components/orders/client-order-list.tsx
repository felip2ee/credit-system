import Link from "next/link";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import { ORDER_REASON_LABEL, ORDER_STATE_LABEL } from "@/lib/orders/labels";
import type { ClientOrderListItem } from "@/lib/orders/client-queries";
import type { OrderState } from "@/lib/orders/types";
import { formatCurrency, formatDateTime } from "@/lib/utils";

const STATE_VARIANT: Record<OrderState, BadgeProps["variant"]> = {
	awaiting_payment: "muted",
	awaiting_authorization: "secondary",
	ready: "secondary",
	executing: "secondary",
	completed: "secondary",
	released: "success",
	failed: "destructive",
	cancelled: "destructive",
};

const PRODUCT_LABEL: Record<ClientOrderListItem["productCode"], string> = {
	consulta_pf: "Consulta PF",
	consulta_pj: "Consulta PJ",
	dossie_pj_completo: "Dossiê PJ completo",
};

export function OrderStateBadge({ state, reason }: { state: OrderState; reason: ClientOrderListItem["reason"] }) {
	return (
		<span className="flex flex-col items-end gap-1">
			<Badge variant={STATE_VARIANT[state]}>{ORDER_STATE_LABEL[state]}</Badge>
			{reason && (state === "failed" || state === "cancelled") && (
				<span className="text-xs text-muted-foreground">{ORDER_REASON_LABEL[reason]}</span>
			)}
		</span>
	);
}

export function ClientOrderList({ orders }: { orders: ClientOrderListItem[] }) {
	return (
		<ul className="divide-y rounded-md border bg-background">
			{orders.map((o) => (
				<li key={o.dossierId}>
					<Link
						href={`/portal/pesquisas/${o.dossierId}`}
						className="flex flex-wrap items-start justify-between gap-3 p-4 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span className="min-w-0 space-y-0.5">
							<span className="block text-sm font-medium">
								{PRODUCT_LABEL[o.productCode]}
								{o.withAi && " + parecer IA"}
							</span>
							<span className="block truncate text-sm">{o.subjectName}</span>
							<span className="block text-xs text-muted-foreground">
								{o.subjectDocumentMasked} · {formatDateTime(o.createdAt)} · {o.price === null ? "—" : formatCurrency(Number(o.price))}
							</span>
						</span>
						<OrderStateBadge state={o.state} reason={o.reason} />
					</Link>
				</li>
			))}
		</ul>
	);
}
