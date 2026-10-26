import { describe, expect, it } from "vitest";

import { ledgerView } from "./ledger-view";

const e = (kind: Parameters<typeof ledgerView>[0]["kind"], amount: string, reason: string | null = null) => ({ kind, amount, reason });

describe("ledgerView", () => {
	it("recarga e devolução entram com +", () => {
		expect(ledgerView(e("topup", "50.00"))).toMatchObject({ title: "Recarga via Pix", sign: "+", tone: "in" });
		expect(ledgerView(e("release", "5.00"))).toMatchObject({ sign: "+", tone: "in" });
	});
	it("separar e concluir pedido saem com −", () => {
		expect(ledgerView(e("reserve", "5.00"))).toMatchObject({ sign: "−", tone: "out" });
		expect(ledgerView(e("capture", "5.00"))).toMatchObject({ title: "Pedido concluído", sign: "−" });
	});
	it("ajuste segue o sinal do valor e mostra o motivo", () => {
		expect(ledgerView(e("adjustment", "-3.00", "erro"))).toMatchObject({ sign: "−", tone: "out", detail: "erro" });
		expect(ledgerView(e("adjustment", "3.00"))).toMatchObject({ sign: "+", tone: "in" });
	});
});
