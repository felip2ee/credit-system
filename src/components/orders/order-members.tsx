import { blockedOrderMessage, orderIsBlocked } from "@/components/orders/order-rules";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusBanner } from "@/components/ui/status-banner";
import type { OrderMember, OrderMemberRole } from "@/lib/orders/client-ops";
import type { OrderMode } from "@/lib/orders/types";
import { statusInfo } from "@/lib/ui/status";

const ROLE_LABEL: Record<OrderMemberRole, string> = {
	company: "Empresa",
	partner: "Sócio",
	subject: "Titular",
};

// Estado do aceite SCR de cada pessoa do pedido. Só o documento mascarado chega aqui.
export function OrderMembers({ members, mode }: { members: OrderMember[]; mode: OrderMode }) {
	if (members.length === 0) return null;
	return (
		<section aria-labelledby="order-members-title" className="space-y-3">
			<h2 id="order-members-title" className="text-xl font-bold">
				Autorizações
			</h2>
			<ul className="divide-y rounded-md border-2 bg-background">
				{members.map((m) => {
					const { tone, label } = statusInfo("member", m.scrStatus, "client");
					return (
						<li key={`${m.role}-${m.documentMasked}`} className="flex flex-wrap items-center justify-between gap-3 p-4">
							<span className="min-w-0 space-y-0.5">
								<span className="block break-words font-bold">{m.name ?? ROLE_LABEL[m.role]}</span>
								<span className="block text-muted-foreground">
									{ROLE_LABEL[m.role]} · {m.documentMasked}
								</span>
							</span>
							<StatusBadge tone={tone} label={label} />
						</li>
					);
				})}
			</ul>
			{orderIsBlocked(members.map((m) => m.scrStatus)) && (
				<StatusBanner tone="attention" title={blockedOrderMessage(mode)} />
			)}
		</section>
	);
}
