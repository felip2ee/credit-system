// Valor mostrado no cartão de saldo: oculto vira pontos, sem revelar o tamanho do número.
export const HIDDEN_BALANCE = "R$ ••••";

export function displayBalance(value: string, hidden: boolean): string {
	return hidden ? HIDDEN_BALANCE : value;
}
