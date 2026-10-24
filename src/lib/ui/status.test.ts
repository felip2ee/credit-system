import { describe, expect, it } from "vitest";

import { STATE_COLORS } from "@/lib/brand/tokens";

import { statusInfo, type StatusDomain } from "./status";

// Valores reais: src/lib/orders/types.ts, src/types/app.ts, src/lib/orders/client-ops.ts,
// src/lib/affiliates/types.ts e os CHECKs das migrations 012, 015, 028, 029.
const VALUES: Record<StatusDomain, string[]> = {
	order: ["awaiting_payment", "awaiting_authorization", "ready", "executing", "completed", "released", "failed", "cancelled"],
	orderReason: [
		"scr_refused",
		"scr_expired",
		"payment_timeout",
		"cancelled_by_staff",
		"cancelled_by_client",
		"deps_no_data",
		"deps_incompatible",
		"deps_unavailable",
		"reservation_clawed_back",
	],
	consultation: ["pending_authorization", "authorized", "processing", "completed", "payload_incompatible", "error", "rejected"],
	scr: ["pending", "authorized", "not_authorized", "expired"],
	member: ["pending", "authorized", "refused", "expired"],
	withdrawal: ["open", "paid", "cancelled"],
	commission: ["pending", "released", "reversed"],
	walletEntry: [
		"topup",
		"reserve",
		"capture",
		"release",
		"adjustment",
		"reversal",
		"commission_credit",
		"adjustment_credit",
		"adjustment_debit",
		"client_adjustment_out",
		"client_adjustment_in",
	],
};
const TECHNICAL = /deps|payload|erro \d|500/i;

describe("statusInfo", () => {
	describe.each(Object.entries(VALUES) as [StatusDomain, string[]][])("%s", (domain, values) => {
		it.each(values)("%s has label, valid tone and no technical term", (value) => {
			for (const audience of ["client", "staff"] as const) {
				const info = statusInfo(domain, value, audience);
				expect(info.label).not.toBe("");
				expect(info.label).not.toBe("Situação desconhecida");
				expect(info.tone in STATE_COLORS).toBe(true);
				expect(`${info.label} ${info.explanation} ${info.nextStep ?? ""}`).not.toMatch(TECHNICAL);
			}
		});
	});

	it("uses the client vocabulary", () => {
		expect(statusInfo("order", "failed", "client").label).toBe("Não foi possível consultar");
		expect(statusInfo("order", "failed", "client").tone).toBe("attention");
		expect(statusInfo("order", "completed", "client")).toMatchObject({
			label: "Pronto, aguardando liberação do Bureau",
			tone: "waiting",
		});
		expect(statusInfo("order", "released", "client")).toMatchObject({ label: "Pronto para ver", tone: "success" });
		expect(statusInfo("scr", "authorized", "client").label).toBe("Autorizado");
		expect(statusInfo("consultation", "authorized", "client").label).toBe("Autorizado");
		expect(statusInfo("consultation", "error", "client").label).toBe("Não foi possível consultar");
	});

	it("explains a failed order by its reason", () => {
		expect(statusInfo("orderReason", "deps_no_data", "client").explanation).toBe("Não encontramos dados para este documento.");
		expect(statusInfo("orderReason", "deps_unavailable", "client").explanation).toBe("O serviço de consulta está fora do ar.");
		expect(statusInfo("orderReason", "scr_refused", "client").explanation).toBe("A autorização foi recusada.");
		expect(statusInfo("orderReason", "scr_expired", "client").explanation).toBe("A autorização venceu.");
	});

	it("maps third-party waits to waiting, internal work to progress, expired and cancelled to neutral", () => {
		for (const [d, v] of [["order", "awaiting_payment"], ["order", "awaiting_authorization"], ["member", "pending"]] as const)
			expect(statusInfo(d, v, "client").tone).toBe("waiting");
		for (const v of ["ready", "executing"]) expect(statusInfo("order", v, "client").tone).toBe("progress");
		expect(statusInfo("consultation", "processing", "client").tone).toBe("progress");
		expect(statusInfo("scr", "expired", "client").tone).toBe("neutral");
		expect(statusInfo("order", "cancelled", "client").tone).toBe("neutral");
	});

	it("shows an unknown status as danger without leaking the code", () => {
		const info = statusInfo("order", "inventado_xyz", "client");
		expect(info).toEqual({
			tone: "danger",
			label: "Situação desconhecida",
			explanation: "Não conseguimos mostrar esta situação.",
			nextStep: "Fale com o suporte.",
		});
		expect(statusInfo("nope" as StatusDomain, "x", "staff").tone).toBe("danger");
		expect(statusInfo("order", "toString", "client").label).toBe("Situação desconhecida");
	});
});
