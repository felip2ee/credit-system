// Etapas da compra (lógica pura, sem DOM). Mesmo padrão de payments/checkout-steps.ts.
import { isSelfOrder, type HolderType } from "@/components/orders/order-rules";
import type { OrderProductCode } from "@/lib/orders/types";

export type OrderStep = "choice" | "subject" | "people" | "review";
export type OrderFormField = "subject" | "contactEmail" | "partners" | "declarationAccepted";

// Valores como o usuário digita.
export interface OrderFormValues {
	productCode: OrderProductCode;
	self: boolean;
	subject: { name: string; document: string };
	contactEmail: string;
	contactPhone: string;
	partners: { name: string; document: string; email: string }[];
	declarationAccepted: boolean;
}

/** Caminho do pedido: própria pula os dados; só a empresa pede a lista de pessoas. */
export function orderStepsFor(productCode: OrderProductCode, holderType: HolderType): OrderStep[] {
	if (productCode === "dossie_empresarial") return ["choice", "subject", "people", "review"];
	return isSelfOrder(productCode, holderType) ? ["choice", "review"] : ["choice", "subject", "review"];
}

export function orderStepTitle(step: OrderStep, productCode: OrderProductCode): string {
	switch (step) {
		case "choice":
			return "Para quem é a pesquisa?";
		case "subject":
			return productCode === "dossie_empresarial" ? "Dados da empresa" : "Dados do responsável";
		case "people":
			return "Pessoas da empresa";
		case "review":
			return "Revise o pedido";
	}
}

export const ORDER_STEP_FIELDS: Record<OrderStep, readonly OrderFormField[]> = {
	choice: [],
	subject: ["subject", "contactEmail"],
	people: ["partners"],
	review: [],
};

/** Primeira etapa do caminho com erro; campo fora do caminho não conta. */
export function stepWithErrors(steps: readonly OrderStep[], errorFields: readonly string[]): OrderStep | null {
	return steps.find((step) => ORDER_STEP_FIELDS[step].some((field) => errorFields.includes(field))) ?? null;
}
