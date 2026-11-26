import { PAYER_FIELDS, type CheckoutErrors, type Method } from "./checkout-model";

// Etapas do assistente de recarga (lógica pura, sem DOM).
export type Step = "amount" | "method" | "payer" | "card";

/** Ordem das etapas. Sem cartão habilitado não há escolha de forma; só o cartão tem a etapa final de dados do meio. */
export function stepsFor(cardEnabled: boolean, method: Method): Step[] {
	if (!cardEnabled) return ["amount", "payer"];
	return method === "CREDIT_CARD" ? ["amount", "method", "payer", "card"] : ["amount", "method", "payer"];
}

export const STEP_TITLE: Record<Step, string> = {
	amount: "Valor da recarga",
	method: "Forma de pagamento",
	payer: "Dados do pagador",
	card: "Dados do cartão",
};

const STEP_ERROR_KEYS: Record<Step, readonly string[]> = {
	amount: ["amount"],
	method: [],
	payer: [...PAYER_FIELDS, "declaration"],
	card: ["number", "holderName", "expiry", "cvv", "installments"],
};

/** Só os erros que pertencem à etapa. */
export function errorsForStep(step: Step, errors: CheckoutErrors): CheckoutErrors {
	return Object.fromEntries(Object.entries(errors).filter(([key]) => STEP_ERROR_KEYS[step].includes(key)));
}

/** Pode avançar quando nenhum erro da etapa está aberto. */
export const canContinue = (step: Step, errors: CheckoutErrors): boolean => Object.keys(errorsForStep(step, errors)).length === 0;

/** Primeira etapa com erro, para devolver o foco ao envio rejeitado. */
export const firstStepWithErrors = (steps: Step[], errors: CheckoutErrors): Step | null => steps.find((s) => !canContinue(s, errors)) ?? null;
