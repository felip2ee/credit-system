import type { StatementFilter } from "./statement-total";

export const STATEMENT_SOURCES: { key: StatementFilter; label: string }[] = [
	{ key: "all", label: "Tudo" },
	{ key: "prepaid", label: "Saldo pré-pago" },
	{ key: "payable", label: "A receber" },
];

// Sem payout:read não há filtro "A receber": ?fonte=payable vale como "all", igual a qualquer valor desconhecido.
export function visibleStatementSources(includePayable: boolean) {
	return STATEMENT_SOURCES.filter((s) => includePayable || s.key !== "payable");
}

export function parseStatementSource(raw: string | undefined, includePayable: boolean): StatementFilter {
	return visibleStatementSources(includePayable).find((s) => s.key === raw)?.key ?? "all";
}
