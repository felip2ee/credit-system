// Lógica pura do assistente "Nova pesquisa": quais etapas existem, quando dá para sair de uma etapa e quando a saída pede confirmação.
import { isSelfOrder, type HolderType } from "@/components/orders/order-rules";
import type { OrderProductCode } from "@/lib/orders/types";
import { isValidCNPJ, isValidCPF } from "@/lib/utils";
import { emailSchema, MAX_PARTNERS, partnerSchema, subjectSchema } from "@/lib/validators/order";
import { z } from "zod";

export type WizardStepId = "product" | "data" | "partners" | "review";

export interface WizardStep {
	id: WizardStepId;
	// Rótulo curto do cabeçalho ("Passo 2 de 4: Dados").
	label: string;
	// Título da etapa (h2).
	title: string;
	// "O que acontece depois": o passo seguinte, em linguagem simples.
	after: string;
}

// Valores como o usuário digita no formulário (o schema zod transforma só na saída).
export interface OrderFormValues {
	productCode: OrderProductCode;
	self: boolean;
	subject: { name: string; document: string };
	contactEmail: string;
	contactPhone: string;
	partners: { name: string; document: string; email: string }[];
	declarationAccepted: boolean;
}

export type WizardFormState = Omit<OrderFormValues, "productCode"> & { productCode: OrderProductCode | null };

const PRODUCT_STEP = { id: "product", label: "Para quem", title: "Para quem é a pesquisa?" } as const;

export function wizardSteps(productCode: OrderProductCode | null, holderType: HolderType): WizardStep[] {
	if (!productCode) return [{ ...PRODUCT_STEP, after: "Você informa os dados da pesquisa." }];
	const self = isSelfOrder(productCode, holderType);
	const empresarial = productCode === "dossie_empresarial";
	const reviewAfter = self
		? "Você recebe um pedido de autorização por e-mail. A consulta roda quando você autoriza."
		: "Cada pessoa informada recebe um pedido de autorização por e-mail. A consulta só roda depois da autorização de todas.";

	const steps: WizardStep[] = [
		{
			...PRODUCT_STEP,
			after: self ? "Você confere os seus dados." : "Você informa os dados de quem será pesquisado.",
		},
		{
			id: "data",
			label: "Dados",
			title: "Dados",
			after: empresarial
				? "Você pode adicionar os sócios da empresa."
				: "Você revisa o pedido e confirma.",
		},
	];
	if (empresarial) {
		steps.push({
			id: "partners",
			label: "Sócios",
			title: "Sócios",
			after: "Você revisa o pedido e confirma. O valor só sai do saldo quando a consulta roda.",
		});
	}
	steps.push({ id: "review", label: "Revisão", title: "Revisar e confirmar", after: reviewAfter });
	return steps;
}

const isFilled = (value: string): boolean => value.trim() !== "";
const partnersSchema = z.array(partnerSchema).max(MAX_PARTNERS);

function subjectIsValid(state: WizardFormState): boolean {
	if (state.self) return true;
	const documentIsValid = state.productCode === "dossie_pf" ? isValidCPF(state.subject.document) : isValidCNPJ(state.subject.document);
	// As mesmas regras do schema da action: uma só fonte da verdade.
	return documentIsValid && subjectSchema.safeParse(state.subject).success && emailSchema.safeParse(state.contactEmail).success;
}

// Mesmas regras do schema zod, só dos campos da etapa. Sócio sem linha nenhuma é permitido; linha pela metade não.
export function canLeaveStep(step: WizardStepId, state: WizardFormState): boolean {
	switch (step) {
		case "product":
			return state.productCode !== null;
		case "data":
			return subjectIsValid(state);
		case "partners":
			return partnersSchema.safeParse(state.partners).success;
		case "review":
			return true;
	}
}

// Um duplo clique em "Continuar" não pode atravessar a etapa seguinte, nem confirmar o pedido (cobra créditos).
export const STEP_CLICK_GUARD_MS = 600;

export function isStepSettled(changedAtMs: number, nowMs: number): boolean {
	return nowMs - changedAtMs >= STEP_CLICK_GUARD_MS;
}

// Sair da tela perde o que foi digitado: só pede confirmação se há algo a perder.
export function hasTypedData(state: WizardFormState): boolean {
	return (
		isFilled(state.subject.name) ||
		isFilled(state.subject.document) ||
		isFilled(state.contactEmail) ||
		isFilled(state.contactPhone) ||
		state.partners.length > 0 ||
		state.declarationAccepted
	);
}
