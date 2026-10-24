import { describe, expect, it } from "vitest";

import {
	canCancelOrder,
	countBillablePartners,
	canConfirmOrder,
	isSelfOrder,
	MEMBER_STATUS_LABEL,
	orderHasMembers,
	orderIsBlocked,
	orderTotalCents,
	productLabel,
} from "./order-rules";

const empresarial = { code: "dossie_empresarial" as const, price: "100.00", pricePerPartner: "30.00" };

describe("orderTotalCents", () => {
	it("soma o valor base sem sócios", () => {
		expect(orderTotalCents(empresarial, 0)).toBe(10000);
	});
	it("vai de R$ 100,00 para R$ 160,00 com 2 sócios", () => {
		expect(orderTotalCents(empresarial, 2)).toBe(16000);
	});
});

describe("declaração do comprador", () => {
	it("sem o checkbox, o Dossiê Empresarial não confirma", () => {
		const hasMembers = orderHasMembers("dossie_empresarial", "PF");
		expect(canConfirmOrder({ hasMembers, declarationAccepted: false })).toBe(false);
		expect(canConfirmOrder({ hasMembers, declarationAccepted: true })).toBe(true);
	});
	it("Dossiê Pessoa Física da conta PF não tem membros nem declaração", () => {
		const hasMembers = orderHasMembers("dossie_pf", "PF");
		expect(hasMembers).toBe(false);
		expect(canConfirmOrder({ hasMembers, declarationAccepted: false })).toBe(true);
	});
	it("Dossiê Pessoa Física da conta PJ exige a declaração", () => {
		expect(orderHasMembers("dossie_pf", "PJ")).toBe(true);
	});
});

describe("campos do Dossiê Pessoa Física", () => {
	it("conta PF pesquisa a si mesma", () => {
		expect(isSelfOrder("dossie_pf", "PF")).toBe(true);
		expect(productLabel("Dossiê Pessoa Física", "dossie_pf", "PF")).toBe("Dossiê Pessoa Física (você)");
	});
	it("conta PJ vê os campos do responsável", () => {
		expect(isSelfOrder("dossie_pf", "PJ")).toBe(false);
		expect(productLabel("Dossiê Pessoa Física", "dossie_pf", "PJ")).toBe("Dossiê Pessoa Física");
	});
	it("Dossiê Empresarial nunca é próprio", () => {
		expect(isSelfOrder("dossie_empresarial", "PF")).toBe(false);
	});
});

describe("cancelamento", () => {
	it("só cancela pedido online em awaiting_authorization e ready", () => {
		expect(canCancelOrder("awaiting_authorization", "online")).toBe(true);
		expect(canCancelOrder("ready", "online")).toBe(true);
		expect(canCancelOrder("executing", "online")).toBe(false);
		expect(canCancelOrder("completed", "online")).toBe(false);
		expect(canCancelOrder("cancelled", "online")).toBe(false);
	});
	it("pedido de balcão nunca é cancelado pelo cliente", () => {
		expect(canCancelOrder("awaiting_authorization", "counter")).toBe(false);
		expect(canCancelOrder("ready", "counter")).toBe(false);
	});
	it("recusado ou vencido bloqueia o pedido", () => {
		expect(orderIsBlocked(["authorized", "refused"])).toBe(true);
		expect(orderIsBlocked(["pending", "expired"])).toBe(true);
		expect(orderIsBlocked(["pending", "authorized"])).toBe(false);
	});
	it("rotula os 4 estados", () => {
		expect(Object.values(MEMBER_STATUS_LABEL)).toEqual(["Pendente", "Autorizado", "Recusado", "Vencido"]);
	});
});

describe("countBillablePartners", () => {
	it("o mesmo CPF formatado e só com dígitos conta 1 sócio: total R$ 130,00", () => {
		const count = countBillablePartners([{ document: "123.456.789-09" }, { document: "12345678909" }]);
		expect(count).toBe(1);
		expect(orderTotalCents(empresarial, count)).toBe(13000);
	});
	it("linha vazia ou incompleta não conta", () => {
		expect(countBillablePartners([{ document: "" }, { document: "123.456" }, { document: undefined }])).toBe(0);
	});
	it("CPF igual ao documento da empresa não conta", () => {
		expect(countBillablePartners([{ document: "123.456.789-09" }], "12345678909")).toBe(0);
	});
});
