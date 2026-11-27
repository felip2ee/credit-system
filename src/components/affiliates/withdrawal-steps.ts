// Lógica pura das etapas do saque: o que cada etapa exige antes de seguir.
import type { MoneyOutcome } from "@/lib/ui/failure-message";

import { withdrawalPreview, type WithdrawalFee } from "./affiliate-rules";

export type WithdrawalStepId = "amount" | "key";

export const WITHDRAWAL_STEPS: { id: WithdrawalStepId; label: string; title: string; after: string }[] = [
	{ id: "amount", label: "Valor", title: "Quanto você quer sacar?", after: "Depois você informa a chave PIX e confirma." },
	{
		id: "key",
		label: "Chave PIX",
		title: "Para onde vai o dinheiro?",
		after: 'O pedido entra na fila. Acompanhe o status em "Seus saques".',
	},
];

// Mesma regra de antes: o valor precisa ser maior que a taxa de saque.
export function amountStepError(amount: string, fee: WithdrawalFee): string | null {
	if (amount.trim() === "") return "Informe o valor do saque.";
	return withdrawalPreview(amount, fee).valid ? null : "Informe um valor maior que a taxa de saque.";
}

// A action devolve só o texto. Estas são as recusas por valor (invalid_amount, net_not_positive, insufficient_funds): voltam à etapa do valor.
// shortcut: compara o começo do texto da action; trocar por um código de motivo se a action passar a devolvê-lo.
const AMOUNT_FAILURE_PREFIXES = ["Informe um valor maior que zero", "O valor é menor ou igual à taxa", "Valor maior que o saldo"];

export function isAmountFailure(message: string): boolean {
	return AMOUNT_FAILURE_PREFIXES.some((prefix) => message.startsWith(prefix));
}

const OPEN_WITHDRAWAL_REFUSAL = "Você já tem um saque em aberto. Espere o pagamento ou o cancelamento.";

// Recusas da action em que este pedido com certeza não criou saque. Qualquer outro texto (falha no banco ou na conexão) pode ter criado.
// shortcut: compara o texto da action (texto novo cai no caso neutro); trocar por um código de motivo se a action passar a devolvê-lo.
const CLEAN_REFUSALS = new Set([
	OPEN_WITHDRAWAL_REFUSAL,
	"O saque ainda não está disponível.",
	"Dados inválidos.",
	"Escolha o tipo da chave PIX.",
	"Chave PIX muito longa.",
	"Declare que a chave PIX está no seu nome.",
	"Informe um CPF ou CNPJ válido.",
	"Informe um e-mail válido.",
	"Informe o celular com DDD (ex.: +5563912345678).",
	"Informe a chave aleatória (formato UUID).",
	"Você não tem permissão para usar a comissão de afiliado.",
	"Não foi possível verificar sua sessão. Tente novamente.",
	"Você não tem permissão para esta operação.",
	"Saque ou conta não encontrado.",
	"Chave PIX inválida.",
	"A chave CPF/CNPJ precisa ser o documento da sua conta.",
	"Pedido inválido. Recarregue a página e tente de novo.",
]);

// O que o aviso de falha diz sobre o dinheiro e o próximo passo ("" = sem próximo passo).
export function withdrawalFailure(message: string): { money: MoneyOutcome; next: string } {
	if (!CLEAN_REFUSALS.has(message)) return { money: "none", next: 'Atualize a página e confira "Seus saques" antes de tentar de novo.' };
	return { money: "not_charged", next: message === OPEN_WITHDRAWAL_REFUSAL ? "" : "Confira os dados e tente de novo." };
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
