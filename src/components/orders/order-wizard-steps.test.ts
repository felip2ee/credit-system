import { describe, expect, it } from "vitest";

import { canLeaveStep, hasTypedData, wizardSteps, type WizardFormState } from "@/components/orders/order-wizard-steps";

const VALID_CPF = "529.982.247-25";
const VALID_CNPJ = "11.222.333/0001-81";

const base: WizardFormState = {
	productCode: "dossie_empresarial",
	self: false,
	subject: { name: "", document: "" },
	contactEmail: "",
	contactPhone: "",
	partners: [],
	declarationAccepted: false,
};
const state = (patch: Partial<WizardFormState>): WizardFormState => ({ ...base, ...patch });
const ids = (steps: { id: string }[]) => steps.map((s) => s.id);

describe("wizardSteps", () => {
	it("PF sobre o próprio titular: escolha, dados (só aviso) e revisão", () => {
		expect(ids(wizardSteps("dossie_pf", "PF"))).toEqual(["product", "data", "review"]);
		expect(ids(wizardSteps("dossie_pf", null))).toEqual(["product", "data", "review"]);
	});

	it("PF em conta PJ: mesmas três etapas, com campos do responsável", () => {
		expect(ids(wizardSteps("dossie_pf", "PJ"))).toEqual(["product", "data", "review"]);
	});

	it("empresarial: quatro etapas, com sócios antes da revisão", () => {
		expect(ids(wizardSteps("dossie_empresarial", "PJ"))).toEqual(["product", "data", "partners", "review"]);
	});

	it("sem produto escolhido: só a escolha", () => {
		expect(ids(wizardSteps(null, "PF"))).toEqual(["product"]);
	});

	it("pessoas: avisa que o PIX vem na tela seguinte se faltar crédito", () => {
		expect(wizardSteps("dossie_empresarial", "PJ")[2].after).toBe(
			"Você revisa o pedido e confirma. Se faltar crédito, o pagamento por PIX vem na tela seguinte.",
		);
	});

	it.each([
		["dossie_pf", "PF"],
		["dossie_empresarial", "PJ"],
	] as const)("revisão (%s): e-mail só para quem não tem autorização válida nem pedido em aberto", (code, holder) => {
		expect(wizardSteps(code, holder).at(-1)?.after).toMatch(/^Quem ainda não tem autorização válida nem um pedido em aberto recebe um pedido por e-mail\. /);
	});

	it("cada etapa diz o que acontece depois", () => {
		for (const step of wizardSteps("dossie_empresarial", "PJ")) expect(step.after.length).toBeGreaterThan(0);
	});

	it("a etapa da lista é 'Pessoas da empresa'", () => {
		const step = wizardSteps("dossie_empresarial", "PJ").find((s) => s.id === "partners");
		expect(step).toMatchObject({ label: "Pessoas", title: "Pessoas da empresa" });
	});

	it("nenhuma etapa promete débito de saldo", () => {
		for (const step of wizardSteps("dossie_empresarial", "PJ")) expect(step.after).not.toMatch(/saldo/i);
	});
});

describe("canLeaveStep", () => {
	it("escolha: bloqueia sem produto", () => {
		expect(canLeaveStep("product", state({ productCode: null }))).toBe(false);
		expect(canLeaveStep("product", state({}))).toBe(true);
	});

	it("dados: no pedido próprio não há campos", () => {
		expect(canLeaveStep("data", state({ productCode: "dossie_pf", self: true }))).toBe(true);
	});

	it("dados: CNPJ inválido bloqueia", () => {
		const s = state({ subject: { name: "Empresa X", document: "11.222.333/0001-80" }, contactEmail: "a@b.co" });
		expect(canLeaveStep("data", s)).toBe(false);
	});

	it("dados: CPF inválido bloqueia o responsável do PF em conta PJ", () => {
		const s = state({ productCode: "dossie_pf", subject: { name: "Maria", document: "111.111.111-11" }, contactEmail: "a@b.co" });
		expect(canLeaveStep("data", s)).toBe(false);
	});

	it("dados: e-mail vazio bloqueia", () => {
		expect(canLeaveStep("data", state({ subject: { name: "Empresa X", document: VALID_CNPJ } }))).toBe(false);
	});

	it("dados: nome curto bloqueia", () => {
		const s = state({ subject: { name: "E", document: VALID_CNPJ }, contactEmail: "a@b.co" });
		expect(canLeaveStep("data", s)).toBe(false);
	});

	it("dados: e-mail que o zod recusa (a@b.c, 255 caracteres) bloqueia", () => {
		const s = (email: string) => state({ subject: { name: "Empresa X", document: VALID_CNPJ }, contactEmail: email });
		expect(canLeaveStep("data", s("a@b.c"))).toBe(false);
		expect(canLeaveStep("data", s(`${"a".repeat(250)}@b.co`))).toBe(false);
	});

	it("dados: nome com 121 caracteres bloqueia", () => {
		const s = state({ subject: { name: "N".repeat(121), document: VALID_CNPJ }, contactEmail: "a@b.co" });
		expect(canLeaveStep("data", s)).toBe(false);
	});

	it("dados: tudo válido libera", () => {
		const s = state({ subject: { name: "Empresa X", document: VALID_CNPJ }, contactEmail: "a@b.co" });
		expect(canLeaveStep("data", s)).toBe(true);
	});

	it("sócios: etapa vazia é permitida", () => {
		expect(canLeaveStep("partners", state({ partners: [] }))).toBe(true);
	});

	it("sócios: linha incompleta bloqueia", () => {
		const row = { name: "Ana Sócia", document: VALID_CPF, email: "" };
		expect(canLeaveStep("partners", state({ partners: [row] }))).toBe(false);
		expect(canLeaveStep("partners", state({ partners: [{ ...row, document: "529.982" , email: "a@b.co" }] }))).toBe(false);
	});

	it("sócios: e-mail a@b.c e nome de 121 caracteres bloqueiam", () => {
		const row = { name: "Ana Sócia", document: VALID_CPF, email: "ana@b.co" };
		expect(canLeaveStep("partners", state({ partners: [{ ...row, email: "a@b.c" }] }))).toBe(false);
		expect(canLeaveStep("partners", state({ partners: [{ ...row, name: "N".repeat(121) }] }))).toBe(false);
	});

	it("sócios: dois e-mails iguais bloqueiam, mesmo com caixa diferente", () => {
		const row = { name: "Ana Sócia", document: VALID_CPF, email: "ana@b.co" };
		const other = { name: "Beto Sócio", document: "111.444.777-35", email: " ANA@b.co" };
		expect(canLeaveStep("partners", state({ partners: [row, other] }))).toBe(false);
		expect(canLeaveStep("partners", state({ partners: [row, { ...other, email: "beto@b.co" }] }))).toBe(true);
	});

	it("sócios: linhas completas liberam", () => {
		const row = { name: "Ana Sócia", document: VALID_CPF, email: "ana@b.co" };
		expect(canLeaveStep("partners", state({ partners: [row] }))).toBe(true);
	});

	it("revisão: sempre pode seguir (a confirmação valida o resto)", () => {
		expect(canLeaveStep("review", state({}))).toBe(true);
	});
});

describe("hasTypedData", () => {
	it("falso com o formulário recém-aberto", () => {
		expect(hasTypedData(state({}))).toBe(false);
	});

	it("verdadeiro com qualquer campo digitado", () => {
		expect(hasTypedData(state({ subject: { name: "A", document: "" } }))).toBe(true);
		expect(hasTypedData(state({ subject: { name: "", document: "1" } }))).toBe(true);
		expect(hasTypedData(state({ contactEmail: "a" }))).toBe(true);
		expect(hasTypedData(state({ contactPhone: "1" }))).toBe(true);
		expect(hasTypedData(state({ partners: [{ name: "", document: "", email: "" }] }))).toBe(true);
		expect(hasTypedData(state({ declarationAccepted: true }))).toBe(true);
	});

	it("espaços em branco não contam", () => {
		expect(hasTypedData(state({ contactEmail: "   " }))).toBe(false);
	});
});
