import { formatCurrency } from "@/lib/utils";

import type { ClientLedgerEntry } from "./client-queries";
import type { ClientPixCharge, PixChargeStatus } from "./pix-charges";

export type StatementTone = "in" | "out" | "neutral";
export type StatementRow = {
	id: string;
	title: string;
	detail: string;
	amount: string | null;
	tone: StatementTone;
	receiptHref?: string;
};
export type StatementGroup = { dateLabel: string; rows: StatementRow[] };

const TZ = "America/Sao_Paulo";
const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];
const partsFormat = new Intl.DateTimeFormat("en-CA", {
	timeZone: TZ,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
});

function localParts(date: Date) {
	const p = Object.fromEntries(partsFormat.formatToParts(date).map((x) => [x.type, x.value]));
	return { year: p.year, month: Number(p.month), day: Number(p.day), time: `${p.hour}:${p.minute}` };
}

// Só o que o extrato usa: serve ao lançamento completo e à linha da ação "carregar mais".
export type StatementLedgerEntry = Pick<ClientLedgerEntry, "id" | "kind" | "amount" | "reference" | "createdAt">;

type Mapped = { title: string; tone: StatementTone; sign: "+" | "−" };
const LEDGER_MAP: Partial<Record<ClientLedgerEntry["kind"], Mapped>> = {
	topup: { title: "Recarga por PIX", tone: "in", sign: "+" },
	capture: { title: "Pesquisa", tone: "out", sign: "−" },
	reversal: { title: "Estorno", tone: "in", sign: "+" },
	commission_credit: { title: "Comissão convertida", tone: "in", sign: "+" },
	adjustment_credit: { title: "Ajuste", tone: "in", sign: "+" },
	adjustment_debit: { title: "Ajuste", tone: "out", sign: "−" },
};

const CHARGE_DETAIL: Record<PixChargeStatus, string> = {
	pending: "Aguardando pagamento",
	paid: "Pago",
	expired: "Expirado",
	cancelled: "Cancelado",
	refunded: "Estornado",
};

// Valor 0 não tem sinal nem cor.
function money(amount: string, tone: StatementTone, sign: "+" | "−"): { amount: string; tone: StatementTone } {
	const n = Number(amount);
	return n === 0 ? { amount: formatCurrency(0), tone: "neutral" } : { amount: `${sign} ${formatCurrency(n)}`, tone };
}

type Dated = { at: Date; row: StatementRow };

function ledgerItem(e: StatementLedgerEntry): Dated | null {
	const m = LEDGER_MAP[e.kind];
	if (!m) return null;
	const { time } = localParts(e.createdAt);
	const v = money(e.amount, m.tone, m.sign);
	return { at: e.createdAt, row: { id: `ledger:${e.id}`, title: m.title, detail: time, amount: v.amount, tone: v.tone } };
}

function chargeItem(c: ClientPixCharge): Dated {
	const { time } = localParts(c.createdAt);
	const paid = c.status === "paid";
	const v = paid ? money(c.amount, "in", "+") : { amount: formatCurrency(Number(c.amount)), tone: "neutral" as const };
	return {
		at: c.createdAt,
		row: {
			id: `charge:${c.id}`,
			title: "Recarga por PIX",
			detail: `${CHARGE_DETAIL[c.status]} · ${time}`,
			// Pendente/expirada/cancelada não mexeu no saldo: sem sinal.
			amount: v.amount,
			tone: v.tone,
			...(paid ? { receiptHref: `/portal/credits/receipts/${c.id}` } : {}),
		},
	};
}

export function buildStatement(input: { ledger: StatementLedgerEntry[]; topups: ClientPixCharge[]; now?: Date }): StatementGroup[] {
	const currentYear = localParts(input.now ?? new Date()).year;
	// A recarga paga tem recibo: ela vence o lançamento `topup` da mesma referência.
	const paidRefs = new Set(input.topups.filter((c) => c.status === "paid").map((c) => `pix:${c.id}`));
	const items = [
		...input.ledger.filter((e) => !(e.kind === "topup" && e.reference !== null && paidRefs.has(e.reference))).map(ledgerItem),
		...input.topups.map(chargeItem),
	]
		.filter((i): i is Dated => i !== null)
		.sort((a, b) => b.at.getTime() - a.at.getTime());

	const groups: StatementGroup[] = [];
	for (const { at, row } of items) {
		const p = localParts(at);
		const label = `${p.day} ${MONTHS[p.month - 1]}${p.year === currentYear ? "" : ` ${p.year}`}`;
		const last = groups[groups.length - 1];
		if (last?.dateLabel === label) last.rows.push(row);
		else groups.push({ dateLabel: label, rows: [row] });
	}
	return groups;
}

// Com mais páginas do livro-caixa por carregar, cobranças mais antigas que o lançamento mais antigo
// carregado ficariam num extrato sem os lançamentos do mesmo período: corta a janela.
export function clipChargesToLedgerWindow(
	charges: ClientPixCharge[],
	ledger: Pick<StatementLedgerEntry, "createdAt">[],
	hasMore: boolean,
): ClientPixCharge[] {
	if (!hasMore || ledger.length === 0) return charges;
	const oldest = Math.min(...ledger.map((e) => e.createdAt.getTime()));
	return charges.filter((c) => c.createdAt.getTime() >= oldest);
}
