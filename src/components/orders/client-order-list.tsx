import Link from "next/link";
import { FileText } from "lucide-react";

import { Card } from "@/components/ui/card";

import { StatusBadge } from "@/components/ui/status-badge";
import { ORDER_REASON_LABEL } from "@/lib/orders/labels";
import type { ClientOrderListItem } from "@/lib/orders/client-queries";
import type { OrderState } from "@/lib/orders/types";
import { statusInfo } from "@/lib/ui/status";
import { formatCurrency, formatDateTime } from "@/lib/utils";

const PRODUCT_LABEL: Record<ClientOrderListItem["productCode"], string> = {
	dossie_pf: "Dossiê Pessoa Física",
	dossie_empresarial: "Dossiê Empresarial",
};

export function OrderStateBadge({ state, reason }: { state: OrderState; reason: ClientOrderListItem["reason"] }) {
	const { tone, label } = statusInfo("order", state, "client");
	return (
		<span className="flex shrink-0 flex-col items-start gap-1">
			<StatusBadge tone={tone} label={label} />
			{reason && (state === "failed" || state === "cancelled") && (
				<span className="text-base text-muted-foreground">{ORDER_REASON_LABEL[reason]}</span>
			)}
		</span>
	);
}

export function ClientOrderList({ orders }: { orders: ClientOrderListItem[] }) {
	return (
		<Card>
			<ul className="divide-y divide-border">
				{orders.map((o) => (
					<li key={o.dossierId}>
						<Link
							href={`/portal/pesquisas/${o.dossierId}`}
							className="flex min-h-14 items-start gap-3 rounded-card px-4 py-3 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span aria-hidden className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
								<FileText className="size-5" />
							</span>
							<span className="min-w-0 flex-1 space-y-1">
								<span className="block font-bold">{PRODUCT_LABEL[o.productCode]}</span>
								<span className="block truncate">{o.subjectName}</span>
								<span className="block truncate text-base text-muted-foreground">
									{o.subjectDocumentMasked} · {formatDateTime(o.createdAt)} ·{" "}
									<span className="tabular-nums">{o.price === null ? "—" : formatCurrency(Number(o.price))}</span>
								</span>
								<OrderStateBadge state={o.state} reason={o.reason} />
							</span>
						</Link>
					</li>
				))}
			</ul>
		</Card>
	);
}
