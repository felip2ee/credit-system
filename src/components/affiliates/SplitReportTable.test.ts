import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SplitReportRow } from "@/lib/affiliates/split-report";

import { SplitReportTable } from "./SplitReportTable";

const row = (o: Partial<SplitReportRow>): SplitReportRow => ({
	id: "1",
	pixChargeId: "abcdef12-0000-4000-8000-000000000000",
	bureauId: "b",
	bureauName: "Bureau",
	createdAt: new Date("2026-11-26T12:00:00Z"),
	beneficiaryKind: "bureau",
	beneficiaryName: "Nome",
	payoutMethod: "asaas",
	walletMasked: null,
	pct: "40.00",
	amountCents: 4000,
	status: "done",
	chargeRefunded: false,
	...o,
});

const render = (o: Partial<SplitReportRow>) => renderToStaticMarkup(createElement(SplitReportTable, { rows: [row(o)] }));

describe("SplitReportTable", () => {
	it("formats the percentage in pt-BR with 2 decimals", () => {
		expect(render({})).toContain("40,00%");
	});

	it("a done asaas split reads Repassado", () => {
		expect(render({})).toContain("Repassado");
	});

	it("a done accrual split was not paid out: it reads A repassar, never Repassado", () => {
		const html = render({ payoutMethod: "accrual" });
		expect(html).not.toContain("Repassado");
		expect(html.match(/A repassar/g)).toHaveLength(2);
	});

	it("a done asaas split on a refunded charge waits for the Asaas reversal", () => {
		const html = render({ chargeRefunded: true });
		expect(html).toContain("Reversão pendente");
		expect(html).not.toContain("Repassado");
	});
});
