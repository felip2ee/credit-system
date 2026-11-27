import { describe, expect, it } from "vitest";

import { buildSaleRow, buildTotals, type RawSale, type RawTotalsGroup } from "./sales";

const online: RawSale = {
	order_ref: "00000000-0000-4000-8000-000000000001",
	subject_name: "Maria",
	product_name: "Dossiê PF",
	created_at: new Date("2026-10-10T12:00:00Z"),
	cursor_at: "2026-10-10 12:00:00+00",
	mode: "online",
	state: "completed",
	settlement_status: "captured",
	has_settlement: true,
	fully_paid: false,
	paid: "100.00",
	price: "100.00",
	cost: "70.00",
};

describe("buildSaleRow", () => {
	it("online captured: paid is the price and the Bureau keeps price minus cost", () => {
		const row = buildSaleRow(online);
		expect(row).toMatchObject({ status: "paid", paid: "100.00", cost: "70.00", bureauShare: "30.00", holderName: "Maria" });
	});

	it("online order of the cash-in commission flow shows no per-order share", () => {
		expect(buildSaleRow({ ...online, cash_in: true, cost: "0.00" })).toMatchObject({ status: "paid", cost: "0.00", bureauShare: "0.00" });
	});

	it("counter partial payment is awaiting and has no share", () => {
		const row = buildSaleRow({ ...online, mode: "counter", settlement_status: "reserved", fully_paid: false, paid: "40.00" });
		expect(row).toMatchObject({ status: "awaiting", paid: "40.00", bureauShare: "0.00" });
	});

	it("counter fully paid is paid", () => {
		const row = buildSaleRow({ ...online, mode: "counter", fully_paid: true, paid: "100.00" });
		expect(row).toMatchObject({ status: "paid", bureauShare: "30.00" });
	});

	it("refunded online and cancelled counter keep their status and have no share", () => {
		expect(buildSaleRow({ ...online, settlement_status: "released", paid: "0.00" })).toMatchObject({
			status: "refunded",
			bureauShare: "0.00",
		});
		expect(buildSaleRow({ ...online, mode: "counter", settlement_status: "released", paid: "0.00" })).toMatchObject({
			status: "cancelled",
		});
	});

	it("order without settlement has zero cost", () => {
		const row = buildSaleRow({ ...online, mode: "counter", settlement_status: null, has_settlement: false, cost: null, paid: "0.00" });
		expect(row).toMatchObject({ status: "awaiting", cost: "0.00" });
	});

	it("counter overpayment: the share is capped at the price, the paid value stays real", () => {
		const row = buildSaleRow({ ...online, mode: "counter", fully_paid: true, paid: "120.00", price: "100.00", cost: "40.00" });
		expect(row).toMatchObject({ status: "paid", paid: "120.00", cost: "40.00", bureauShare: "60.00" });
	});

	it("throws a clear error when a settlement exists but the cost is not readable", () => {
		expect(() => buildSaleRow({ ...online, cost: null })).toThrow("Custo do pedido indisponível");
	});
});

describe("buildTotals", () => {
	const group = (over: Partial<RawTotalsGroup>): RawTotalsGroup => ({
		mode: "online",
		state: "completed",
		settlement_status: "captured",
		has_settlement: true,
		fully_paid: false,
		paid_sum: "0.00",
		capped_paid_sum: "0.00",
		cost_sum: "0.00",
		missing_cost: 0,
		...over,
	});

	it("leaves cancelled and refunded orders out of the totals", () => {
		const totals = buildTotals([
			group({ paid_sum: "100.00", capped_paid_sum: "100.00", cost_sum: "70.00" }),
			group({ settlement_status: "released", paid_sum: "0.00", cost_sum: "50.00" }),
			group({ state: "cancelled", has_settlement: false, settlement_status: null, paid_sum: "0.00", cost_sum: "0.00" }),
		]);
		expect(totals).toEqual({ paid: "100.00", cost: "70.00", bureauShare: "30.00" });
	});

	it("totals cap an overpaid order at its price for the share", () => {
		const totals = buildTotals([
			group({ mode: "counter", fully_paid: true, paid_sum: "120.00", capped_paid_sum: "100.00", cost_sum: "40.00" }),
		]);
		expect(totals).toEqual({ paid: "120.00", cost: "40.00", bureauShare: "60.00" });
	});

	it("an unreadable cost on a cancelled or refunded order does not break the totals", () => {
		const totals = buildTotals([
			group({ paid_sum: "100.00", capped_paid_sum: "100.00", cost_sum: "70.00" }),
			group({ settlement_status: "released", missing_cost: 2 }),
			group({ mode: "counter", state: "cancelled", missing_cost: 1 }),
		]);
		expect(totals).toEqual({ paid: "100.00", cost: "70.00", bureauShare: "30.00" });
	});

	it("counts the money received on awaiting counter orders but gives no share", () => {
		const totals = buildTotals([
			group({ mode: "counter", settlement_status: "reserved", paid_sum: "40.00", cost_sum: "70.00" }),
			group({ mode: "counter", fully_paid: true, paid_sum: "100.00", capped_paid_sum: "100.00", cost_sum: "70.00" }),
		]);
		expect(totals).toEqual({ paid: "140.00", cost: "140.00", bureauShare: "30.00" });
	});

	it("a cash-in commission order has no per-order share; the cash-in share is added to the total", () => {
		const totals = buildTotals([group({ cash_in: true, paid_sum: "100.00", capped_paid_sum: "100.00", cost_sum: "0.00" })], 1234);
		expect(totals).toEqual({ paid: "100.00", cost: "0.00", bureauShare: "12.34" });
	});

	it("is zero for an empty period", () => {
		expect(buildTotals([])).toEqual({ paid: "0.00", cost: "0.00", bureauShare: "0.00" });
	});

	it("throws when a settled order has no readable cost", () => {
		expect(() => buildTotals([group({ missing_cost: 1 })])).toThrow("Custo do pedido indisponível");
	});
});
