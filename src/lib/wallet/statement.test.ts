import { describe, expect, it } from "vitest";

import type { ClientLedgerEntry } from "./client-queries";
import type { ClientPixCharge } from "./pix-charges";
import { buildStatement, clipChargesToLedgerWindow } from "./statement";

const NOW = new Date("2026-10-26T15:00:00Z");

const entry = (o: Partial<ClientLedgerEntry> & { id: string }): ClientLedgerEntry => ({
	seq: "1",
	kind: "capture",
	amount: "10.00",
	availableAfter: "0",
	reservedAfter: "0",
	reference: null,
	reason: null,
	createdBy: "u",
	createdAt: new Date("2026-10-26T14:00:00Z"),
	...o,
});

const charge = (o: Partial<ClientPixCharge> & { id: string }): ClientPixCharge => ({
	amount: "50.00",
	status: "paid",
	pixPayload: null,
	expiresAt: new Date("2026-10-26T15:00:00Z"),
	createdAt: new Date("2026-10-26T14:00:00Z"),
	...o,
});

describe("buildStatement", () => {
	it("vazio", () => {
		expect(buildStatement({ ledger: [], topups: [], now: NOW })).toEqual([]);
	});

	it("recarga paga: recibo, tom in, sinal +", () => {
		const [g] = buildStatement({ ledger: [], topups: [charge({ id: "c1" })], now: NOW });
		expect(g.rows[0]).toMatchObject({
			title: "Recarga por PIX",
			detail: "Pago · 11:00",
			tone: "in",
			receiptHref: "/portal/credits/receipts/c1",
		});
		expect(g.rows[0].amount).toMatch(/^\+ R\$/);
	});

	it("recarga pendente, expirada e cancelada: neutral sem sinal", () => {
		const rows = buildStatement({
			ledger: [],
			topups: [
				charge({ id: "p", status: "pending" }),
				charge({ id: "e", status: "expired" }),
				charge({ id: "x", status: "cancelled" }),
			],
			now: NOW,
		})[0].rows;
		expect(rows.map((r) => r.detail)).toEqual(["Aguardando pagamento · 11:00", "Expirado · 11:00", "Cancelado · 11:00"]);
		for (const r of rows) {
			expect(r.tone).toBe("neutral");
			expect(r.amount).not.toMatch(/^[+−]/);
			expect(r.receiptHref).toBeUndefined();
		}
	});

	it("mapeia kinds do ledger", () => {
		const kinds: [ClientLedgerEntry["kind"], string, string, string][] = [
			["capture", "Pesquisa", "out", "−"],
			["reversal", "Estorno", "in", "+"],
			["commission_credit", "Comissão convertida", "in", "+"],
			["adjustment_credit", "Ajuste", "in", "+"],
			["adjustment_debit", "Ajuste", "out", "−"],
		];
		for (const [kind, title, tone, sign] of kinds) {
			const [g] = buildStatement({ ledger: [entry({ id: kind, kind })], topups: [], now: NOW });
			expect(g.rows[0]).toMatchObject({ title, tone });
			expect(g.rows[0].amount?.startsWith(sign)).toBe(true);
		}
	});

	it("omite reserve, release e kind desconhecido", () => {
		const ledger = [
			entry({ id: "a", kind: "reserve" }),
			entry({ id: "b", kind: "release" }),
			entry({ id: "c", kind: "foo" as ClientLedgerEntry["kind"] }),
		];
		expect(buildStatement({ ledger, topups: [], now: NOW })).toEqual([]);
	});

	it("valor 0: neutral sem sinal", () => {
		const [g] = buildStatement({ ledger: [entry({ id: "z", amount: "0.00" })], topups: [], now: NOW });
		expect(g.rows[0].tone).toBe("neutral");
		expect(g.rows[0].amount).not.toMatch(/^[+−]/);
	});

	it("virada de dia no fuso de São Paulo, mais recente primeiro, hora decrescente", () => {
		const ledger = [
			entry({ id: "late", createdAt: new Date("2026-10-26T02:30:00Z") }), // 25 out 23:30
			entry({ id: "early", createdAt: new Date("2026-10-26T03:30:00Z") }), // 26 out 00:30
			entry({ id: "noon", createdAt: new Date("2026-10-26T15:00:00Z") }), // 26 out 12:00
		];
		const groups = buildStatement({ ledger, topups: [], now: NOW });
		expect(groups.map((g) => g.dateLabel)).toEqual(["26 out", "25 out"]);
		expect(groups[0].rows.map((r) => r.id)).toEqual(["ledger:noon", "ledger:early"]);
	});

	it("recarga paga + ledger topup da mesma referência: 1 linha", () => {
		const rows = buildStatement({
			ledger: [entry({ id: "l", kind: "topup", reference: "pix:c1" })],
			topups: [charge({ id: "c1" })],
			now: NOW,
		})[0].rows;
		expect(rows).toHaveLength(1);
		expect(rows[0].receiptHref).toBe("/portal/credits/receipts/c1");
	});

	it("ledger topup sem recarga paga correspondente aparece", () => {
		const rows = buildStatement({ ledger: [entry({ id: "l", kind: "topup", reference: "pix:zz" })], topups: [], now: NOW })[0].rows;
		expect(rows[0]).toMatchObject({ title: "Recarga por PIX", tone: "in" });
	});
});

describe("clipChargesToLedgerWindow", () => {
	const old = charge({ id: "old", createdAt: new Date("2026-10-01T10:00:00Z") });
	const recent = charge({ id: "new", createdAt: new Date("2026-10-26T10:00:00Z") });
	const ledger = [entry({ id: "a", createdAt: new Date("2026-10-20T10:00:00Z") }), entry({ id: "b", createdAt: new Date("2026-10-10T10:00:00Z") })];

	it("há mais páginas: descarta cobrança anterior ao lançamento mais antigo", () => {
		expect(clipChargesToLedgerWindow([recent, old], ledger, true).map((c) => c.id)).toEqual(["new"]);
	});

	it("sem mais páginas: mantém tudo", () => {
		expect(clipChargesToLedgerWindow([recent, old], ledger, false)).toHaveLength(2);
	});

	it("sem lançamentos: mantém tudo", () => {
		expect(clipChargesToLedgerWindow([recent, old], [], true)).toHaveLength(2);
	});
});
