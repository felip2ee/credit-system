// Valor mostrado no cartão de saldo: oculto vira pontos, sem revelar o tamanho do número.
export const HIDDEN_BALANCE = "R$ ••••";

export function displayBalance(value: string, hidden: boolean): string {
	return hidden ? HIDDEN_BALANCE : value;
}

// Preferência de ocultar o saldo no portal: o chip do cabeçalho e o cartão de Créditos usam a mesma chave.
export const PORTAL_BALANCE_HIDDEN_KEY = "portal:balance-hidden";
