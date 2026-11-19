import type { LedgerEntry } from "./queries";

export type LedgerTone = "in" | "out" | "neutral";
export type LedgerView = { title: string; detail: string | null; sign: "+" | "−" | ""; tone: LedgerTone };

type Kind = LedgerEntry["kind"];
const MAP: Record<Exclude<Kind, "adjustment">, { title: string; sign: "+" | "−"; tone: LedgerTone }> = {
	topup: { title: "Recarga via Pix", sign: "+", tone: "in" },
	reserve: { title: "Valor separado para um pedido", sign: "−", tone: "out" },
	capture: { title: "Pedido concluído", sign: "−", tone: "out" },
	release: { title: "Valor devolvido (pedido cancelado)", sign: "+", tone: "in" },
	reversal: { title: "Recarga estornada", sign: "−", tone: "out" },
	client_adjustment_out: { title: "Crédito dado a um cliente", sign: "−", tone: "out" },
	client_adjustment_in: { title: "Crédito tirado de um cliente", sign: "+", tone: "in" },
};

// Ajuste tem valor com sinal (positivo soma, negativo tira); os outros tipos guardam valor positivo.
export function ledgerView(e: Pick<LedgerEntry, "kind" | "amount" | "reason">): LedgerView {
	if (e.kind === "adjustment") {
		const n = Number(e.amount);
		const sign = n > 0 ? "+" : n < 0 ? "−" : "";
		return { title: "Ajuste", detail: e.reason, sign, tone: n > 0 ? "in" : n < 0 ? "out" : "neutral" };
	}
	const m = MAP[e.kind];
	return { ...m, detail: e.reason };
}

// Textos do Extrato total: um por tipo de lançamento, em português simples. `signed` é o valor com sinal
// (positivo entra, negativo sai); `neutral` é o lançamento que só informa e não muda o saldo disponível.
export type StatementText = { title: string; detail: string; signed: "in" | "out" | "neutral" | "by-amount" };

export const PREPAID_STATEMENT_TEXT: Record<Kind, StatementText> = {
	topup: { title: "Recarga no saldo pré-pago", detail: "Entrou dinheiro no saldo pré-pago por Pix.", signed: "in" },
	reserve: { title: "Custo saiu do saldo pré-pago", detail: "Valor separado para um pedido de balcão.", signed: "out" },
	capture: {
		title: "Pedido de balcão concluído",
		detail: "O custo já estava separado. O saldo disponível não mudou.",
		signed: "neutral",
	},
	release: { title: "Valor devolvido ao saldo pré-pago", detail: "O pedido foi cancelado e o custo voltou para o saldo.", signed: "in" },
	reversal: { title: "Recarga estornada", detail: "Uma recarga por Pix foi devolvida e saiu do saldo pré-pago.", signed: "out" },
	adjustment: { title: "Ajuste feito pela Rainha Cred", detail: "A Rainha Cred corrigiu o saldo pré-pago.", signed: "by-amount" },
	client_adjustment_out: {
		title: "Crédito dado a cliente",
		detail: "Saiu do saldo do Bureau e entrou no saldo do cliente (ajuste de conta).",
		signed: "out",
	},
	client_adjustment_in: {
		title: "Crédito tirado de cliente",
		detail: "Saiu do saldo do cliente e voltou para o saldo do Bureau (ajuste de conta).",
		signed: "in",
	},
};

// Reserva, captura e liberação gravadas com motivo 'cupom' cobrem o desconto de um cupom, não um pedido de balcão.
export const COUPON_PREPAID_TEXT: Partial<Record<Kind, StatementText>> = {
	reserve: { title: "Reserva de cobertura de cupom", detail: "Valor separado do saldo pré-pago para cobrir o desconto de um cupom.", signed: "out" },
	capture: {
		title: "Captura de cobertura de cupom",
		detail: "A cobertura do cupom já estava separada. O saldo disponível não mudou.",
		signed: "neutral",
	},
	release: { title: "Liberação de cobertura de cupom", detail: "O pedido foi cancelado e a cobertura do cupom voltou para o saldo.", signed: "in" },
};

export const PAYABLE_STATEMENT_TEXT: Record<"accrual" | "reversal" | "payout" | "coupon_cost" | "coupon_refund", StatementText> = {
	accrual: {
		title: "Sua parte entrou em A receber",
		detail: "Venda online concluída. A Rainha Cred repassa essa parte a você.",
		signed: "in",
	},
	reversal: { title: "Parte estornada em A receber", detail: "Um pedido online foi estornado e sua parte foi retirada.", signed: "out" },
	payout: { title: "Repasse recebido", detail: "A Rainha Cred pagou este valor. Ele saiu de A receber.", signed: "out" },
	coupon_cost: {
		title: "Cobertura de cupom",
		detail: "O desconto de um cupom foi coberto com o valor de A receber.",
		signed: "out",
	},
	coupon_refund: {
		title: "Devolução de cobertura de cupom",
		detail: "O pedido com cupom foi cancelado e a cobertura voltou para A receber.",
		signed: "in",
	},
};

// Lançamento do saldo do cliente sem o par no Bureau: não deveria existir, mas nada que movimentou fica de fora.
export const CLIENT_STATEMENT_TEXT: Record<"adjustment_credit" | "adjustment_debit", StatementText> = {
	adjustment_credit: { title: "Crédito dado a cliente", detail: "Entrou no saldo do cliente (ajuste de conta).", signed: "in" },
	adjustment_debit: { title: "Crédito tirado de cliente", detail: "Saiu do saldo do cliente (ajuste de conta).", signed: "out" },
};
