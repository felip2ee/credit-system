import { describe, expect, it } from "vitest";

import {
	billablePartners,
	blockedOrderMessage,
	canAddSelf,
	canCancelOrder,
	choiceTitle,
	countBillablePartners,
	canConfirmOrder,
	hasBuyerRow,
	isSelfOrder,
	orderHasMembers,
	orderIsBlocked,
	orderPriceBreakdown,
	orderTotalCents,
	productLabel,
	reviewActionLabel,
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
	it("pedido de balcão bloqueado manda falar com o Bureau, sem falar de cancelar", () => {
		expect(blockedOrderMessage("online")).toBe("Este pedido não vai rodar. Cancele para receber o valor de volta.");
		expect(blockedOrderMessage("counter")).toBe("Este pedido não vai rodar. Fale com o Bureau.");
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

describe("orderPriceBreakdown", () => {
	const company = "11222333000181";
	const cpf = (n: number) => String(n).padStart(11, "0");
	const run = (partners: { document?: string }[]) => {
		const b = orderPriceBreakdown(empresarial, partners, company);
		expect(b.totalCents).toBe(orderTotalCents(empresarial, b.partnerCount));
		return b;
	};

	it("sem sócios: só o valor base", () => {
		expect(run([])).toEqual({ baseCents: 10000, partnerCount: 0, partnersCents: 0, ignoredRows: 0, totalCents: 10000 });
	});

	it("dois sócios válidos", () => {
		expect(run([{ document: cpf(1) }, { document: cpf(2) }])).toMatchObject({
			partnerCount: 2,
			partnersCents: 6000,
			ignoredRows: 0,
			totalCents: 16000,
		});
	});

	it("linha vazia não entra", () => {
		expect(run([{ document: cpf(1) }, { document: "" }])).toMatchObject({ partnerCount: 1, ignoredRows: 1, totalCents: 13000 });
	});

	it("CPF repetido conta uma vez", () => {
		expect(run([{ document: cpf(1) }, { document: cpf(1) }])).toMatchObject({ partnerCount: 1, ignoredRows: 1 });
	});

	it("CPF igual ao documento da empresa não entra", () => {
		const b = orderPriceBreakdown(empresarial, [{ document: "11122233344" }], "111.222.333-44");
		expect(b).toMatchObject({ partnerCount: 0, ignoredRows: 1, totalCents: 10000 });
	});
});

describe("billablePartners", () => {
	it("descarta linha incompleta, CPF repetido e CPF igual ao da empresa, e mantém a ordem", () => {
		const rows = [
			{ document: "529.982.247-25", n: 1 },
			{ document: "123", n: 2 },
			{ document: "52998224725", n: 3 },
			{ document: "111.444.777-35", n: 4 },
			{ document: "390.533.447-05", n: 5 },
			{ n: 6 },
		];
		expect(billablePartners(rows, "390.533.447-05").map((r) => r.n)).toEqual([1, 4]);
	});
});

describe("canAddSelf", () => {
	it("só para conta PF", () => {
		expect(canAddSelf("PF")).toBe(true);
		expect(canAddSelf("PJ")).toBe(false);
		expect(canAddSelf(null)).toBe(false);
	});
});

describe("hasBuyerRow", () => {
	it("ignora caixa e espaço e nunca casa e-mail vazio", () => {
		expect(hasBuyerRow([{ email: "  Ana@Ex.com " }], "ana@ex.com")).toBe(true);
		expect(hasBuyerRow([{ email: "b@ex.com" }], "ana@ex.com")).toBe(false);
		expect(hasBuyerRow([{ email: "" }, {}], "")).toBe(false);
	});
});

describe("choiceTitle", () => {
	it("nomeia a escolha por produto e tipo de conta", () => {
		expect(choiceTitle("dossie_pf", "PF")).toBe("Só para você");
		expect(choiceTitle("dossie_pf", null)).toBe("Só para você");
		expect(choiceTitle("dossie_pf", "PJ")).toBe("Para o responsável da empresa");
		expect(choiceTitle("dossie_empresarial", "PF")).toBe("Para uma empresa");
	});
});

describe("reviewActionLabel", () => {
	it("muda com valor zero", () => {
		expect(reviewActionLabel(0)).toBe("Confirmar pedido");
		expect(reviewActionLabel(1)).toBe("Ir para o pagamento");
	});
});
