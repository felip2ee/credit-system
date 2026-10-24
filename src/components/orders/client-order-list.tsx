import Link from "next/link";

import { StatusBadge } from "@/components/ui/status-badge";
import { ORDER_REASON_LABEL } from "@/lib/orders/labels";
import type { ClientOrderListItem } from "@/lib/orders/client-queries";
import type { OrderState } from "@/lib/orders/types";
import { statusInfo } from "@/lib/ui/status";
import { formatCurrency, formatDateTime } from "@/lib/utils";

const PRODUCT_LABEL: Record<ClientOrderListItem["productCode"], string> = {
	dossie_pf: "Dossiê Pessoa Física",
	dossie_empresarial: "Dossiê Empresarial Estruturado",
};

export function OrderStateBadge({ state, reason }: { state: OrderState; reason: ClientOrderListItem["reason"] }) {
	const { tone, label } = statusInfo("order", state, "client");
	return (
		<span className="flex flex-col items-start gap-1 sm:items-end">
			<StatusBadge tone={tone} label={label} />
			{reason && (state === "failed" || state === "cancelled") && (
				<span className="text-base text-muted-foreground">{ORDER_REASON_LABEL[reason]}</span>
			)}
		</span>
	);
}

export function ClientOrderList({ orders }: { orders: ClientOrderListItem[] }) {
	return (
		<ul className="divide-y rounded-md border-2 bg-background">
			{orders.map((o) => (
				<li key={o.dossierId}>
					<Link
						href={`/portal/pesquisas/${o.dossierId}`}
						className="flex min-h-12 flex-wrap items-start justify-between gap-3 p-4 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					>
						<span className="min-w-0 space-y-0.5">
							<span className="block font-bold">
								{PRODUCT_LABEL[o.productCode]}
							</span>
							<span className="block break-words">{o.subjectName}</span>
							<span className="block text-base text-muted-foreground">
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
