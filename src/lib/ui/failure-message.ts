export type MoneyOutcome = "refunded" | "not_charged" | "reserved" | "none";

const MONEY_TEXT: Record<MoneyOutcome, string | null> = {
	refunded: "O valor voltou para o seu saldo.",
	not_charged: "Nada foi cobrado.",
	reserved: "O valor continua reservado.",
	none: null,
};

// Mensagem de falha ao cliente em 3 partes: o que houve, o que houve com o dinheiro, o que fazer.
export function failureMessage(input: { what: string; money: MoneyOutcome; next: string }): {
	title: string;
	money: string | null;
	next: string;
} {
	return { title: input.what, money: MONEY_TEXT[input.money], next: input.next };
}
