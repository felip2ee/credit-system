import { toCents } from "@/lib/catalog/money";

// Mesma regra e texto da action: só valor válido abre a confirmação.
export function convertAmountError(amount: string): string | null {
	try {
		if (toCents(amount) > 0) return null;
	} catch {
		// Formato ou faixa inválidos: cai na mensagem abaixo.
	}
	return "Informe um valor maior que zero, com até 2 casas decimais.";
}
