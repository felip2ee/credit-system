import { FileText } from "lucide-react";

import { Card } from "@/components/ui/card";
import { ListRow } from "@/components/ui/list-row";
import { StatusBadge } from "@/components/ui/status-badge";
import { ORDER_REASON_LABEL } from "@/lib/orders/labels";
import type { ClientOrderListItem } from "@/lib/orders/client-queries";
import type { OrderState } from "@/lib/orders/types";
import { statusInfo } from "@/lib/ui/status";
import { formatCurrency, formatDate } from "@/lib/utils";

const PRODUCT_LABEL: Record<ClientOrderListItem["productCode"], string> = {
	dossie_pf: "Pessoa física",
	dossie_empresarial: "Empresa",
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

// Linha compacta: nome, tipo, data e valor; o estado fica à direita. O motivo de falha aparece no andamento do pedido.
export function ClientOrderList({ orders }: { orders: ClientOrderListItem[] }) {
	return (
		<Card>
			<ul className="divide-y divide-border">
				{orders.map((o) => {
					const { tone, label } = statusInfo("order", o.state, "client");
					const price = o.price === null ? "—" : formatCurrency(Number(o.price));
					return (
						<li key={o.dossierId}>
							<ListRow
								icon={FileText}
								title={o.subjectName}
								subtitle={`${PRODUCT_LABEL[o.productCode]} · ${formatDate(o.createdAt)} · ${price}`}
								value={<StatusBadge tone={tone} label={label} />}
								href={`/portal/pesquisas/${o.dossierId}`}
								className="rounded-card duration-fast ease-out hover:bg-accent motion-safe:transition-colors"
							/>
						</li>
					);
				})}
			</ul>
		</Card>
	);
}
