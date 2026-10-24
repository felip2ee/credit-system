import { Badge, type BadgeProps } from "@/components/ui/badge";
import { blockedOrderMessage, MEMBER_STATUS_LABEL, orderIsBlocked } from "@/components/orders/order-rules";
import type { OrderMember, OrderMemberRole, OrderMemberScrStatus } from "@/lib/orders/client-ops";
import type { OrderMode } from "@/lib/orders/types";

const ROLE_LABEL: Record<OrderMemberRole, string> = {
	company: "Empresa",
	partner: "Sócio",
	subject: "Titular",
};

const STATUS_VARIANT: Record<OrderMemberScrStatus, BadgeProps["variant"]> = {
	pending: "muted",
	authorized: "success",
	refused: "destructive",
	expired: "destructive",
};

// Estado do aceite SCR de cada pessoa do pedido. Só o documento mascarado chega aqui.
export function OrderMembers({ members, mode }: { members: OrderMember[]; mode: OrderMode }) {
	if (members.length === 0) return null;
	return (
		<section aria-labelledby="order-members-title" className="space-y-3">
			<h2 id="order-members-title" className="text-lg font-semibold">
				Autorizações
			</h2>
			<ul className="divide-y rounded-md border bg-background">
				{members.map((m) => (
					<li key={`${m.role}-${m.documentMasked}`} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
						<span className="min-w-0 space-y-0.5">
							<span className="block font-medium">{m.name ?? ROLE_LABEL[m.role]}</span>
							<span className="block text-xs text-muted-foreground">
								{ROLE_LABEL[m.role]} · {m.documentMasked}
							</span>
						</span>
						<Badge variant={STATUS_VARIANT[m.scrStatus]}>{MEMBER_STATUS_LABEL[m.scrStatus]}</Badge>
					</li>
				))}
			</ul>
			{orderIsBlocked(members.map((m) => m.scrStatus)) && (
				<p role="alert" className="text-sm text-destructive">
					{blockedOrderMessage(mode)}
				</p>
			)}
		</section>
	);
}
