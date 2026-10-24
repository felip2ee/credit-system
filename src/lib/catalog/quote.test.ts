import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DbIdentity } from "@/lib/db/transaction";

const state = vi.hoisted(() => ({ listCatalog: vi.fn() }));
vi.mock("./queries", () => ({ listCatalog: state.listCatalog }));

import { buildQuote, quoteOrder } from "./quote";

const identity: DbIdentity = { userId: "u", role: "bureau_admin", bureauId: "b" };

const terms = {
	productVersionId: "v-dossie_empresarial",
	code: "dossie_empresarial",
	salePriceCents: 10000,
	salePricePerPartnerCents: 3000,
	costCents: 6000,
	costPerPartnerCents: 2000,
};

describe("buildQuote", () => {
	it("charges only the base value without partners", () => {
		const quote = buildQuote(terms, 0);

		expect(quote).toMatchObject({ totalPriceCents: 10000, totalCostCents: 6000 });
		expect(quote.lines).toHaveLength(1);
		expect(quote.lines[0]).toMatchObject({ part: "base", quantity: 1, priceCents: 10000, costCents: 6000 });
	});

	it("adds one partner line with the quantity", () => {
		const one = buildQuote(terms, 1);
		expect(one).toMatchObject({ totalPriceCents: 13000, totalCostCents: 8000 });
		expect(one.lines).toHaveLength(2);
		expect(one.lines[1]).toMatchObject({
			part: "partner",
			quantity: 1,
			unitPriceCents: 3000,
			unitCostCents: 2000,
		});

		const three = buildQuote(terms, 3);
		expect(three).toMatchObject({ totalPriceCents: 19000, totalCostCents: 12000 });
		expect(three.lines[1]).toMatchObject({ quantity: 3, priceCents: 9000, costCents: 6000 });
	});

	it("ignores partners when the per-partner value is zero", () => {
		const quote = buildQuote({ ...terms, salePricePerPartnerCents: 0, costPerPartnerCents: 0 }, 3);

		expect(quote).toMatchObject({ totalPriceCents: 10000, totalCostCents: 6000 });
	});
});

describe("quoteOrder", () => {
	beforeEach(() => vi.clearAllMocks());

	function entry(code: string, onSale: boolean) {
		return {
			productId: `p-${code}`,
			productVersionId: `v-${code}`,
			code,
			name: code,
			effectiveCost: "60.00",
			effectiveCostPerPartner: "20.00",
			item: { active: true, salePrice: "100.00", salePricePerPartner: "30.00" },
			sellable: true,
			onSale,
		};
	}

	it("fails when the product is off sale or unknown", async () => {
		state.listCatalog.mockResolvedValue([entry("dossie_pf", false)]);

		const failure = { ok: false, reason: "product_not_for_sale" };
		expect(await quoteOrder(identity, "dossie_pf", { partnerCount: 0 })).toEqual(failure);
		expect(await quoteOrder(identity, "dossie_empresarial", { partnerCount: 2 })).toEqual(failure);
	});

	it("quotes the catalog values with the partner count", async () => {
		state.listCatalog.mockResolvedValue([entry("dossie_empresarial", true)]);

		const quote = await quoteOrder(identity, "dossie_empresarial", { partnerCount: 2 });

		expect(quote).toMatchObject({ ok: true, totalPriceCents: 16000, totalCostCents: 10000 });
	});
});
