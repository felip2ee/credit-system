import { describe, expect, it } from "vitest";

import { headerBalance, portalNavItems } from "./nav-items";

const labels = (p: { credits: boolean; affiliates: boolean }) => portalNavItems(p).map((i) => i.label);

describe("portalNavItems", () => {
	it("sem permissões: Início, Pesquisas e Conta", () => {
		expect(labels({ credits: false, affiliates: false })).toEqual(["Início", "Pesquisas", "Conta"]);
	});

	it("com créditos: Créditos fica na 3ª posição", () => {
		const items = portalNavItems({ credits: true, affiliates: false });
		expect(items.map((i) => i.label)).toEqual(["Início", "Pesquisas", "Créditos", "Conta"]);
		expect(items[2].href).toBe("/portal/credits");
	});

	it("afiliação não adiciona item à barra", () => {
		expect(labels({ credits: false, affiliates: true })).toEqual(["Início", "Pesquisas", "Conta"]);
		expect(labels({ credits: true, affiliates: true })).toHaveLength(4);
	});
});

describe("headerBalance", () => {
	it("sem credits:read ou sem carteira: não mostra saldo", () => {
		expect(headerBalance(false, { available: "10.00" })).toBeNull();
		expect(headerBalance(true, null)).toBeNull();
	});

	it("com permissão e carteira: texto em reais", () => {
		expect(headerBalance(true, { available: "10.5" })).toMatch(/10,50/);
		expect(headerBalance(true, { available: "0" })).toMatch(/0,00/);
	});
});
