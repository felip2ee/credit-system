import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { portalNavItems } from "./nav-items";
import { PortalHeader } from "./portal-header";
import { PublicShell } from "./public-shell";

describe("PortalHeader", () => {
	const items = portalNavItems({ credits: false, affiliates: false });

	it("sem saldo (sem credits:read ou sem carteira): não mostra saldo nem quebra", () => {
		const html = renderToStaticMarkup(createElement(PortalHeader, { items, balance: null }));
		expect(html).not.toContain("Saldo");
		expect(html).toContain("Rainha Cred");
	});

	it("com saldo: mostra o valor", () => {
		const html = renderToStaticMarkup(createElement(PortalHeader, { items, balance: "R$ 10,50" }));
		expect(html).toContain("Saldo");
		expect(html).toContain("R$ 10,50");
	});
});

describe("PublicShell", () => {
	it("nome de Bureau com 60 caracteres aparece inteiro e quebra de linha", () => {
		const name = "Consultoria de Crédito e Soluções Financeiras Eliane Moreira";
		expect(name).toHaveLength(60);
		const html = renderToStaticMarkup(createElement(PublicShell, { bureauName: name }, "conteúdo"));
		expect(html).toContain(name);
		expect(html).toMatch(/class="[^"]*break-words[^"]*"[^>]*>Consultoria/);
		expect(html).not.toContain("line-clamp");
	});
});
