import { describe, expect, it } from "vitest";

import { canLeaveStep, dossierSteps, hasTypedData, ownResearchContacts, stepForErrors, type DossierFormState } from "@/components/dossiers/dossier-wizard-steps";

const VALID_CPF = "529.982.247-25";
const VALID_CNPJ = "11.222.333/0001-81";

const base: DossierFormState = {
	productCode: "dossie_empresarial",
	ownResearch: false,
	hasBuyer: false,
	subject: { name: "", document: "" },
	contactEmail: "",
	contactPhone: "",
	partners: [],
};
const state = (patch: Partial<DossierFormState>): DossierFormState => ({ ...base, ...patch });
const ids = (steps: { id: string }[]) => steps.map((s) => s.id);
const partner = { name: "Maria Souza", document: VALID_CPF, email: "maria@exemplo.com" };

describe("dossierSteps", () => {
	it("PF: produto, titular e revisão", () => {
		expect(ids(dossierSteps("dossie_pf"))).toEqual(["product", "holder", "review"]);
	});

	it("empresarial: sócios antes da revisão", () => {
		expect(ids(dossierSteps("dossie_empresarial"))).toEqual(["product", "holder", "partners", "review"]);
	});

	it("cada etapa diz o que acontece depois", () => {
		for (const step of dossierSteps("dossie_empresarial")) expect(step.after.length).toBeGreaterThan(0);
	});

	it("a revisão explica pagamento, autorização e consulta", () => {
		const review = dossierSteps("dossie_pf").find((s) => s.id === "review");
		expect(review?.after).toMatch(/pagamento/);
		expect(review?.after).toMatch(/autoriza/);
	});
});

describe("canLeaveStep", () => {
	it("produto: exige um produto escolhido", () => {
		expect(canLeaveStep("product", state({ productCode: "" }))).toBe(false);
		expect(canLeaveStep("product", state({}))).toBe(true);
	});

	it("titular PJ: CNPJ válido, razão social e e-mail", () => {
		const ok = state({ subject: { name: "Empresa Ltda", document: VALID_CNPJ }, contactEmail: "a@b.co" });
		expect(canLeaveStep("holder", ok)).toBe(true);
		expect(canLeaveStep("holder", { ...ok, subject: { name: "Empresa Ltda", document: "11.222.333/0001-80" } })).toBe(false);
		expect(canLeaveStep("holder", { ...ok, subject: { name: "", document: VALID_CNPJ } })).toBe(false);
	});

	it("titular PF pede CPF, não CNPJ", () => {
		const pf = state({ productCode: "dossie_pf", subject: { name: "João Lima", document: VALID_CPF }, contactEmail: "a@b.co" });
		expect(canLeaveStep("holder", pf)).toBe(true);
		expect(canLeaveStep("holder", { ...pf, subject: { name: "João Lima", document: VALID_CNPJ } })).toBe(false);
	});

	it("terceiro precisa de e-mail válido; celular longo demais não passa", () => {
		const third = state({ subject: { name: "Empresa Ltda", document: VALID_CNPJ } });
		expect(canLeaveStep("holder", third)).toBe(false);
		expect(canLeaveStep("holder", { ...third, contactEmail: "sem-arroba" })).toBe(false);
		expect(canLeaveStep("holder", { ...third, contactEmail: "a@b.co", contactPhone: "9".repeat(31) })).toBe(false);
	});

	it("pesquisa própria dispensa e-mail e celular", () => {
		expect(canLeaveStep("holder", state({ ownResearch: true, subject: { name: "Empresa Ltda", document: VALID_CNPJ } }))).toBe(true);
	});

	it("sócios: zero é permitido; linha pela metade não; mais de 20 não", () => {
		expect(canLeaveStep("partners", state({}))).toBe(true);
		expect(canLeaveStep("partners", state({ partners: [partner] }))).toBe(true);
		expect(canLeaveStep("partners", state({ partners: [{ ...partner, email: "" }] }))).toBe(false);
		expect(canLeaveStep("partners", state({ partners: Array.from({ length: 21 }, () => partner) }))).toBe(false);
	});

	it("revisão sempre pode seguir", () => {
		expect(canLeaveStep("review", state({}))).toBe(true);
	});
});

describe("hasTypedData", () => {
	it("pedido vazio não pede confirmação para sair", () => {
		expect(hasTypedData(state({}))).toBe(false);
		expect(hasTypedData(state({ subject: { name: "  ", document: " " } }))).toBe(false);
	});

	it("qualquer campo, comprador ou sócio conta como dado digitado", () => {
		expect(hasTypedData(state({ subject: { name: "A", document: "" } }))).toBe(true);
		expect(hasTypedData(state({ subject: { name: "", document: "1" } }))).toBe(true);
		expect(hasTypedData(state({ contactEmail: "a" }))).toBe(true);
		expect(hasTypedData(state({ contactPhone: "1" }))).toBe(true);
		expect(hasTypedData(state({ partners: [partner] }))).toBe(true);
		expect(hasTypedData(state({ hasBuyer: true }))).toBe(true);
	});
});

describe("ownResearchContacts", () => {
	const contact = { contactEmail: "abc", contactPhone: "11999999999" };

	it("pesquisa própria zera e-mail e celular, como o servidor espera", () => {
		expect(ownResearchContacts(true, contact)).toEqual({ contactEmail: "", contactPhone: "" });
	});

	it("terceiro mantém o contato digitado", () => {
		expect(ownResearchContacts(false, contact)).toEqual(contact);
	});
});

describe("stepForErrors", () => {
	it("leva ao primeiro passo que tem erro, na ordem do assistente", () => {
		expect(stepForErrors({ productCode: {}, subject: {} })).toBe("product");
		expect(stepForErrors({ subject: {} })).toBe("holder");
		expect(stepForErrors({ contactEmail: {} })).toBe("holder");
		expect(stepForErrors({ contactPhone: {} })).toBe("holder");
		expect(stepForErrors({ partners: {} })).toBe("partners");
		expect(stepForErrors({ subject: {}, partners: {} })).toBe("holder");
	});

	it("sem erro conhecido devolve null", () => {
		expect(stepForErrors({})).toBeNull();
	});
});
