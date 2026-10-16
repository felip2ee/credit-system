import { describe, expect, it } from "vitest";

import { orderStepLines } from "./labels";

const REFUNDED = "A reserva foi devolvida ao seu saldo.";

describe("orderStepLines", () => {
	it("says the reservation went back only for an online order that was not clawed back", () => {
		expect(orderStepLines({ state: "cancelled", reason: "scr_expired", mode: "online" })).toEqual(["Autorização expirada", REFUNDED]);
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
