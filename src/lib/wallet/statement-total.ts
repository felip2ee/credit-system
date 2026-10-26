// Extrato total da Carteira: os três dinheiros do Bureau em uma lista só, por data decrescente.
// Saldo pré-pago (ledger_entries), A receber (bureau_payable_entries) e ajustes de conta do cliente.
// Um ajuste de conta grava duas linhas (Bureau e cliente) com o mesmo `reference` = 'adjustment:<id>' (029):
// a linha do Bureau representa o ajuste inteiro e a do cliente só aparece se o par do Bureau não existir.
import type { PoolClient } from "pg";

import {
	CLIENT_STATEMENT_TEXT,
	PAYABLE_STATEMENT_TEXT,
	PREPAID_STATEMENT_TEXT,
	type StatementText,
} from "./ledger-view";

export type StatementSource = "prepaid" | "payable" | "client";
export type StatementTone = "in" | "out" | "neutral";
export type StatementLine = {
	id: string;
	at: Date;
	source: StatementSource;
	title: string;
	detail: string;
	// Valor com sinal em reais: positivo entra, negativo sai.
	amount: string;
	tone: StatementTone;
};
export type StatementFilter = "all" | "prepaid" | "payable";
export type StatementPage = { lines: StatementLine[]; nextCursor: string | null };

export type StatementRow = {
	id: string;
	source: StatementSource;
	kind: string;
	amount: string;
	reason: string | null;
	at: Date;
	cursorAt: string;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CURSOR_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z\|[0-9a-f-]{36}$/;

const TEXTS: Record<StatementSource, Record<string, StatementText>> = {
	prepaid: PREPAID_STATEMENT_TEXT,
	payable: PAYABLE_STATEMENT_TEXT,
	client: CLIENT_STATEMENT_TEXT,
};

function signedAmount(text: StatementText, amount: string): { amount: string; tone: StatementTone } {
	const abs = amount.replace(/^-/, "");
	if (text.signed === "in") return { amount: abs, tone: "in" };
	if (text.signed === "out") return { amount: `-${abs}`, tone: "out" };
	if (text.signed === "neutral") return { amount: abs, tone: "neutral" };
	const n = Number(amount);
	return { amount, tone: n > 0 ? "in" : n < 0 ? "out" : "neutral" };
}

export function toStatementLine(row: StatementRow): StatementLine {
	const text = TEXTS[row.source][row.kind];
	if (!text) throw new Error(`Tipo de lançamento sem texto no extrato: ${row.source}/${row.kind}`);
	const { amount, tone } = signedAmount(text, row.amount);
	const reason = row.reason?.trim();
	return {
		id: row.id,
		at: row.at,
		source: row.source,
		title: text.title,
		detail: reason ? `${text.detail} Motivo: ${reason}` : text.detail,
		amount,
		tone,
	};
}

type QueryRow = Omit<StatementRow, "cursorAt"> & { cursor_at: string };

export async function listWalletStatement(
	client: PoolClient,
	args: {
		bureauId: string;
		source: StatementFilter;
		range: { start: string; end: string };
		cursor?: string | null;
		limit?: number;
	},
): Promise<StatementPage> {
	const { start, end } = args.range;
	if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) throw new RangeError("Período inválido.");
	const cursor = args.cursor ?? null;
	if (cursor !== null && !CURSOR_FORMAT.test(cursor)) throw new RangeError("Cursor inválido.");
	const [cursorAt, cursorId] = cursor ? cursor.split("|") : [null, null];
	const limit = Math.min(Math.max(Math.trunc(args.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);

	const { rows } = await client.query<QueryRow>(
		`with lines as (
		   select id, 'prepaid'::text as source, kind, amount::text as amount, reason, created_at as at
		     from ledger_entries where bureau_id = $1
		   union all
		   select id, 'payable', kind, amount::text, null, created_at
		     from bureau_payable_entries where bureau_id = $1
		   union all
		   select c.id, 'client', c.kind, c.amount::text, c.reason, c.created_at
		     from client_ledger_entries c
		    where c.bureau_id = $1 and c.kind in ('adjustment_credit', 'adjustment_debit')
		      and not exists (
		        select 1 from ledger_entries l
		         where l.bureau_id = c.bureau_id and l.reference = c.reference
		           and l.kind in ('client_adjustment_out', 'client_adjustment_in'))
		 )
		 select id, source, kind, amount, reason, at,
		        to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_at
		   from lines
		  where at >= $2::timestamptz and at < $3::timestamptz
		    and ($4 = 'all' or source = $4)
		    and ($5::timestamptz is null or (at, id) < ($5::timestamptz, $6::uuid))
		  order by at desc, id desc
		  limit $7`,
		[args.bureauId, start, end, args.source, cursorAt, cursorId, limit + 1],
	);
	const page = rows.slice(0, limit);
	const last = page[page.length - 1];
	return {
		lines: page.map((r) => toStatementLine({ ...r, cursorAt: r.cursor_at })),
		nextCursor: rows.length > limit ? `${last.cursor_at}|${last.id}` : null,
	};
}
