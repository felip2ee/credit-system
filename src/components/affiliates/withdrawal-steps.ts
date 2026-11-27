// Lógica pura das etapas do saque: o que cada etapa exige antes de seguir.
import { withdrawalPreview, type WithdrawalFee } from "./affiliate-rules";

export type WithdrawalStepId = "amount" | "key";

export const WITHDRAWAL_STEPS: { id: WithdrawalStepId; label: string; title: string; after: string }[] = [
	{ id: "amount", label: "Valor", title: "Quanto você quer sacar?", after: "Depois você informa a chave PIX e confirma." },
	{
		id: "key",
		label: "Chave PIX",
		title: "Para onde vai o dinheiro?",
		after: "Ao confirmar, o pedido entra na fila. Você é avisado quando o pagamento sair.",
	},
];

// Mesma regra de antes: o valor precisa ser maior que a taxa de saque.
export function amountStepError(amount: string, fee: WithdrawalFee): string | null {
	if (amount.trim() === "") return "Informe o valor do saque.";
	return withdrawalPreview(amount, fee).valid ? null : "Informe um valor maior que a taxa de saque.";
}

export interface KeyStepErrors {
	pixKey?: string;
	ownKey?: string;
}

export function keyStepErrors(pixKey: string, ownKey: boolean): KeyStepErrors {
	const errors: KeyStepErrors = {};
	if (pixKey.trim() === "") errors.pixKey = "Informe a chave PIX.";
	if (!ownKey) errors.ownKey = "Confirme que a chave PIX está no seu nome.";
	return errors;
}
