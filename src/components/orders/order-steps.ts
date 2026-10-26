import type { StepItem, StepState } from "@/components/ui/state-tone";
import type { OrderState, OrderStateReason } from "@/lib/orders/types";

const LABELS = ["Pedido feito", "Autorizações", "Consultando", "Pronto"] as const;

// Passo atual (0 a 3) por estado do pedido. `released` termina todos.
const CURRENT_INDEX: Partial<Record<OrderState, number>> = {
	awaiting_payment: 0,
	awaiting_authorization: 1,
	ready: 2,
	executing: 2,
	completed: 3,
};

function build(markAt: number, mark: StepState): StepItem[] {
	return LABELS.map((label, i) => ({ label, state: i < markAt ? "done" : i === markAt ? mark : "todo" }));
}

// Passos do pedido para o cliente. Cancelado por escolha ou prazo de pagamento não tem passos.
export function orderSteps(state: OrderState, reason: OrderStateReason | null): StepItem[] | null {
	if (state === "released") return LABELS.map((label) => ({ label, state: "done" }));
	if (state === "failed" || state === "cancelled") {
		if (reason === "scr_refused" || reason === "scr_expired") return build(1, "failed");
		return state === "failed" ? build(2, "failed") : null;
	}
	const current = CURRENT_INDEX[state];
	return current === undefined ? null : build(current, "current");
}
