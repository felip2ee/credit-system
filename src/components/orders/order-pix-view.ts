import type { OrderPayment } from "@/lib/orders/order-pix";
import type { PollOutcome } from "@/components/payments/useChargePolling";

// Decisões da tela de pagamento do pedido (sem React, testável).
export type OrderPixView = "show_qr" | "generate" | "in_progress" | "expired" | "paid_not_reserved" | "leave";

// leave: estado diferente de awaiting_payment. paid_not_reserved: cobrança paga e pedido ainda em awaiting_payment.
export function orderPixView(payment: OrderPayment, now: Date): OrderPixView {
	if (payment.state !== "awaiting_payment") return "leave";
	const { charge } = payment;
	// Sem cobrança, ou a que o Asaas recusou (cancelled): o PIX pode ser feito de novo.
	if (!charge || charge.status === "cancelled") return "generate";
	if (charge.status === "paid") return "paid_not_reserved";
	// Estorno e vencimento: não há PIX vivo; o tick cancela o pedido.
	if (charge.status !== "pending" || charge.expiresAt.getTime() <= now.getTime()) return "expired";
	return charge.pixPayload ? "show_qr" : "in_progress";
}

export function afterPoll(outcome: PollOutcome, expiresAt: Date, now: Date): "go_to_order" | "expired" | "poll_again" | "failed" {
	if (outcome === "paid") return "go_to_order";
	if (outcome === "expired") return "expired";
	if (outcome === "timeout") return now.getTime() < expiresAt.getTime() ? "poll_again" : "expired";
	return "failed";
}
