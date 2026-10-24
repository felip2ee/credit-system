import { describe, expect, it } from "vitest";

import { ORDER_REASON_LABEL, orderStepLines } from "./labels";

const REFUNDED = "A reserva foi devolvida ao seu saldo.";

describe("ORDER_REASON_LABEL", () => {
	it("names who cancelled in words that fit staff and client alike", () => {
		expect(ORDER_REASON_LABEL.cancelled_by_client).toBe("Cancelada pelo cliente");
		expect(ORDER_REASON_LABEL.cancelled_by_staff).toBe("Cancelada pela equipe");
	});
});

describe("orderStepLines", () => {
	it("tells the client to confirm the SCR e-mail on an own order awaiting authorization", () => {
		const own = orderStepLines({ state: "awaiting_authorization", reason: null, mode: "online", selfResearch: true });
		expect(own).toEqual(["Confirme a autorização SCR pelo e-mail que enviamos para você. O pedido expira em 7 dias sem resposta."]);
		expect(orderStepLines({ state: "awaiting_authorization", reason: null, mode: "online", selfResearch: false })[0]).toMatch(/titular/);
	});

	it("says the reservation went back only for an online order that was not clawed back", () => {
		expect(orderStepLines({ state: "cancelled", reason: "scr_expired", mode: "online" })).toEqual(["A autorização venceu.", REFUNDED]);
		expect(orderStepLines({ state: "failed", reason: "deps_no_data", mode: "online" })).toContain(REFUNDED);
	});

	it("never promises a refund for a counter order", () => {
		expect(orderStepLines({ state: "cancelled", reason: "payment_timeout", mode: "counter" })).toEqual(["Pagamento não recebido no prazo"]);
	});

	it("shows the reason label only when the reservation was clawed back", () => {
		expect(orderStepLines({ state: "failed", reason: "reservation_clawed_back", mode: "online" })).toEqual(["Pagamento estornado"]);
	});

	it("describes the waiting states and says nothing for released", () => {
		expect(orderStepLines({ state: "executing", reason: null, mode: "online" })).toEqual(["Consulta em andamento."]);
		expect(orderStepLines({ state: "released", reason: null, mode: "online" })).toEqual([]);
	});
});
