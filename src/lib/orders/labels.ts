import type { OrderState, OrderStateReason } from "./types";

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
