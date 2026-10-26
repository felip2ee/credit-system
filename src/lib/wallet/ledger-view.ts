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
