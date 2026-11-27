// Lógica pura do assistente "Pedido de balcão": quais etapas existem, quando dá para sair de uma etapa e quando sair pede confirmação.
import { z } from "zod";

import type { OrderProductCode } from "@/lib/orders/types";
import { counterOrderSchema, MAX_PARTNERS, partnerSchema } from "@/lib/validators/order";

export type DossierStepId = "product" | "holder" | "partners" | "review";

export interface DossierStep {
	id: DossierStepId;
	// Rótulo curto do cabeçalho ("Passo 2 de 4: Titular").
	label: string;
	// Título da etapa (h2).
	title: string;
	// "O que acontece depois", em linguagem simples.
	after: string;
}

// Valores como a equipe digita (o schema zod transforma só na saída).
export interface DossierFormState {
	// Vazio enquanto nada foi escolhido.
	productCode: OrderProductCode | "";
	// O documento digitado é o do comprador escolhido: o servidor usa o contato da conta do cliente.
	ownResearch: boolean;
	hasBuyer: boolean;
	subject: { name: string; document: string };
	contactEmail: string;
	contactPhone: string;
	partners: { name: string; document: string; email: string }[];
}

const REVIEW_AFTER =
	"O pedido fica aguardando pagamento. O pagamento é registrado em separado. O titular e os sócios recebem o pedido de autorização, e a consulta só roda depois do pagamento e da autorização de todos.";

export function dossierSteps(productCode: OrderProductCode): DossierStep[] {
	const empresarial = productCode === "dossie_empresarial";
	const steps: DossierStep[] = [
		{ id: "product", label: "Produto", title: "Produto e comprador", after: "Você informa os dados do titular." },
		{
			id: "holder",
			label: "Titular",
			title: "Titular",
			after: empresarial ? "Você pode adicionar os sócios da empresa." : "Você revisa o pedido e o abre.",
		},
	];
	if (empresarial) {
		steps.push({
			id: "partners",
			label: "Sócios",
			title: "Sócios",
			after: "Você revisa o pedido e o abre. Esta etapa é opcional.",
		});
	}
	steps.push({ id: "review", label: "Revisão", title: "Revisar e abrir pedido", after: REVIEW_AFTER });
	return steps;
}

const partnersSchema = z.array(partnerSchema).max(MAX_PARTNERS);

// Titular: as mesmas regras do schema da action (uma só fonte). Terceiro ainda precisa de e-mail; o schema o aceita vazio.
function holderIsValid(state: DossierFormState): boolean {
	if (state.productCode === "") return false;
	if (!state.ownResearch && state.contactEmail.trim() === "") return false;
	return counterOrderSchema.safeParse({
		productCode: state.productCode,
		buyerProfileId: null,
		subject: state.subject,
		contactEmail: state.ownResearch ? "" : state.contactEmail,
		contactPhone: state.ownResearch ? "" : state.contactPhone,
		partners: [],
	}).success;
}

// Sócio sem linha nenhuma é permitido; linha pela metade não.
export function canLeaveStep(step: DossierStepId, state: DossierFormState): boolean {
	switch (step) {
		case "product":
			return state.productCode !== "";
		case "holder":
			return holderIsValid(state);
		case "partners":
			return partnersSchema.safeParse(state.partners).success;
		case "review":
			return true;
	}
}

const isFilled = (value: string): boolean => value.trim() !== "";

// Sair da tela perde o que foi digitado: só pede confirmação se há algo a perder.
export function hasTypedData(state: DossierFormState): boolean {
	return (
		state.hasBuyer ||
		isFilled(state.subject.name) ||
		isFilled(state.subject.document) ||
		isFilled(state.contactEmail) ||
		isFilled(state.contactPhone) ||
		state.partners.length > 0
	);
}

export { STEP_CLICK_GUARD_MS, isStepSettled } from "@/lib/ui/step-guard";
