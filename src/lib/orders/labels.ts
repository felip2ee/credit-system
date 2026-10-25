import { statusInfo } from "@/lib/ui/status";

import type { OrderMode, OrderState, OrderStateReason } from "./types";

const ORDER_REASONS: OrderStateReason[] = [
	"scr_refused",
	"scr_expired",
	"payment_timeout",
	"cancelled_by_staff",
	"cancelled_by_client",
	"deps_no_data",
	"deps_incompatible",
	"deps_unavailable",
	"reservation_clawed_back",
];

// Rótulos vêm do vocabulário único (`@/lib/ui/status`). O motivo mostra a explicação, que diz o que houve.
export const ORDER_REASON_LABEL = Object.fromEntries(
	ORDER_REASONS.map((r) => [r, statusInfo("orderReason", r, "client").explanation]),
) as Record<OrderStateReason, string>;

const REFUNDED = "A reserva foi devolvida ao seu saldo.";

const SELF_AUTHORIZATION_STEP =
	"Confirme a autorização SCR pelo e-mail que enviamos para você. O pedido expira em 7 dias sem resposta.";

const NEXT_STEP: Partial<Record<OrderState, string>> = {
	awaiting_payment: "Aguardando o pagamento.",
	awaiting_authorization: "Aguardando a autorização do titular. O pedido expira em 7 dias sem resposta.",
	ready: "Consulta em andamento.",
	executing: "Consulta em andamento.",
	completed: "Concluída. Aguardando liberação do Bureau.",
};

// Texto do estado para o cliente. A reserva só volta ao saldo no pedido online. No balcão não houve reserva do cliente;
// no estorno de PIX o dinheiro já saiu do saldo e nada volta.
export function orderStepLines(order: {
	state: OrderState;
	reason: OrderStateReason | null;
	mode: OrderMode;
	selfResearch?: boolean;
}): string[] {
	if (order.state === "awaiting_authorization" && order.selfResearch) return [SELF_AUTHORIZATION_STEP];
	if (order.state === "failed" || order.state === "cancelled") {
		const lines = [order.reason ? ORDER_REASON_LABEL[order.reason] : "Pedido encerrado."];
		if (order.mode === "online" && order.reason !== "reservation_clawed_back") lines.push(REFUNDED);
		return lines;
	}
	return NEXT_STEP[order.state] ? [NEXT_STEP[order.state] as string] : [];
}
