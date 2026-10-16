import type { OrderMode, OrderState, OrderStateReason } from "./types";

export const ORDER_STATE_LABEL: Record<OrderState, string> = {
	awaiting_payment: "Aguardando pagamento",
	awaiting_authorization: "Aguardando autorização do titular",
	ready: "Na fila",
	executing: "Em consulta",
	completed: "Concluída",
	released: "Liberada",
	failed: "Não concluída",
	cancelled: "Cancelada",
};

export const ORDER_REASON_LABEL: Record<OrderStateReason, string> = {
	scr_refused: "Autorização recusada",
	scr_expired: "Autorização expirada",
	payment_timeout: "Pagamento não recebido no prazo",
	cancelled_by_staff: "Cancelada pela equipe",
	deps_no_data: "Sem dados na consulta",
	deps_incompatible: "Resposta incompatível",
	deps_unavailable: "Serviço indisponível",
	reservation_clawed_back: "Pagamento estornado",
};

const REFUNDED = "A reserva foi devolvida ao seu saldo.";

const NEXT_STEP: Partial<Record<OrderState, string>> = {
	awaiting_payment: "Aguardando o pagamento.",
	awaiting_authorization: "Aguardando a autorização do titular. O pedido expira em 7 dias sem resposta.",
	ready: "Consulta em andamento.",
	executing: "Consulta em andamento.",
	completed: "Concluída. Aguardando liberação do Bureau.",
};

// Texto do estado para o cliente. A reserva só volta ao saldo no pedido online. No balcão não houve reserva do cliente;
// no estorno de PIX o dinheiro já saiu do saldo e nada volta.
export function orderStepLines(order: { state: OrderState; reason: OrderStateReason | null; mode: OrderMode }): string[] {
	if (order.state === "failed" || order.state === "cancelled") {
		const lines = [order.reason ? ORDER_REASON_LABEL[order.reason] : "Pedido encerrado."];
		if (order.mode === "online" && order.reason !== "reservation_clawed_back") lines.push(REFUNDED);
		return lines;
	}
	return NEXT_STEP[order.state] ? [NEXT_STEP[order.state] as string] : [];
}
