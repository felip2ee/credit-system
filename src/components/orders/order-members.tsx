import { Building2, UserRound } from "lucide-react";

import { MemberEmailActions } from "@/components/orders/member-email-actions";
import { blockedOrderMessage, memberActionHint, orderIsBlocked } from "@/components/orders/order-rules";
import { Card } from "@/components/ui/card";
import { StatusBadge } from "@/components/ui/status-badge";
import { StatusBanner } from "@/components/ui/status-banner";
import type { OrderMember, OrderMemberRole } from "@/lib/orders/client-ops";
import type { OrderMode, OrderState } from "@/lib/orders/types";
import { statusInfo } from "@/lib/ui/status";

const ROLE_LABEL: Record<OrderMemberRole, string> = {
	company: "Empresa",
	partner: "Sócio",
	subject: "Titular",
};

// Estado do aceite SCR de cada pessoa do pedido. Só o documento mascarado chega aqui.
export function OrderMembers({
	members,
	mode,
	dossierId,
	orderState,
}: {
	members: OrderMember[];
	mode: OrderMode;
	dossierId: string;
	orderState: OrderState;
}) {
	if (members.length === 0) return null;
	return (
		<section aria-labelledby="order-members-title" className="space-y-2">
			<h2 id="order-members-title" className="text-lg font-bold">
				Autorizações
			</h2>
			<Card>
			<ul className="divide-y divide-border">
				{members.map((m) => {
					const { tone, label } = statusInfo("member", m.scrStatus, "client");
					const hint = memberActionHint(m);
					return (
						<li key={m.consultationId} className="flex flex-wrap items-start gap-3 px-4 py-3">
							<span aria-hidden className="mt-0.5 flex size-11 shrink-0 items-center justify-center rounded-full bg-accent text-primary">
								{m.role === "company" ? <Building2 className="size-5" /> : <UserRound className="size-5" />}
							</span>
							<span className="min-w-0 flex-[1_1_8rem] space-y-1">
								<span className="block break-words font-bold">{m.name ?? ROLE_LABEL[m.role]}</span>
								<span className="block text-muted-foreground">
									{ROLE_LABEL[m.role]} · {m.documentMasked}
								</span>
								<span className="block break-words text-muted-foreground">{m.emailMasked ?? "Sem e-mail"}</span>
								<StatusBadge tone={tone} label={label} />
								{hint && <span className="block text-sm text-muted-foreground">{hint}</span>}
								<MemberEmailActions dossierId={dossierId} member={m} orderState={orderState} />
							</span>
						</li>
					);
				})}
			</ul>
			</Card>
			{orderIsBlocked(members.map((m) => m.scrStatus)) && (
				<StatusBanner tone="attention" title={blockedOrderMessage(mode)} />
			)}
		</section>
	);
}
