import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DbIdentity } from "@/lib/db/transaction";

const state = vi.hoisted(() => ({ listCatalog: vi.fn(), getEffectiveCommission: vi.fn() }));
vi.mock("./queries", () => ({
	listCatalog: state.listCatalog,
	getEffectiveCommission: state.getEffectiveCommission,
	pctToHundredths: (pct: string) => Math.round(Number(pct) * 100),
}));

import { buildQuote, commissionCents, quoteOrder } from "./quote";

const identity: DbIdentity = { userId: "u", role: "bureau_admin", bureauId: "b" };

const terms = {
	productVersionId: "v-dossie_empresarial",
	code: "dossie_empresarial",
	salePriceCents: 10000,
	salePricePerPartnerCents: 3000,
};

describe("commissionCents", () => {
	it("rounds half up like the SQL round(price * pct / 100, 2)", () => {
		expect(commissionCents(40000, 2000)).toBe(8000); // 400,00 a 20%
		expect(commissionCents(1001, 1500)).toBe(150); // 10,01 a 15%: 1,5015 -> 1,50
		expect(commissionCents(1, 500)).toBe(0); // 0,01 a 5%
		expect(commissionCents(1001, 5000)).toBe(501); // 10,01 a 50%: 5,005 -> 5,01
		expect(commissionCents(1001, 0)).toBe(0);
	});
});

describe("buildQuote", () => {
	it("charges only the base value without partners; no commission without a pct", () => {
		const quote = buildQuote(terms, 0);

		expect(quote).toMatchObject({ totalPriceCents: 10000, bureauCommissionCents: 0, platformShareCents: 10000 });
		expect(quote.lines).toHaveLength(1);
		expect(quote.lines[0]).toEqual({
			productVersionId: terms.productVersionId,
			code: terms.code,
			part: "base",
			quantity: 1,
			unitPriceCents: 10000,
			priceCents: 10000,
		});
	});

	it("adds one partner line with the quantity", () => {
		const one = buildQuote(terms, 1);
		expect(one.totalPriceCents).toBe(13000);
		expect(one.lines[1]).toMatchObject({ part: "partner", quantity: 1, unitPriceCents: 3000 });

		const three = buildQuote(terms, 3);
		expect(three.totalPriceCents).toBe(19000);
		expect(three.lines[1]).toMatchObject({ quantity: 3, priceCents: 9000 });
	});

	it("ignores partners when the per-partner value is zero", () => {
		expect(buildQuote({ ...terms, salePricePerPartnerCents: 0 }, 3).totalPriceCents).toBe(10000);
	});

	it("splits the total into Bureau commission and platform share that add up to the price", () => {
		const quote = buildQuote(terms, 2, 2000);

		expect(quote).toMatchObject({ totalPriceCents: 16000, bureauCommissionCents: 3200, platformShareCents: 12800 });
	});
});

describe("quoteOrder", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.getEffectiveCommission.mockResolvedValue({ pct: "20.00", source: "global" });
	});

	function entry(code: string) {
		return {
			productId: `p-${code}`,
			productVersionId: `v-${code}`,
			code,
			name: code,
			salePrice: "100.00",
			salePricePerPartner: "30.00",
		};
	}

	it("fails when the product is off sale or unknown", async () => {
		state.listCatalog.mockResolvedValue([entry("dossie_pf")]);

		const failure = { ok: false, reason: "product_not_for_sale" };
		expect(await quoteOrder(identity, "dossie_empresarial", { partnerCount: 2 })).toEqual(failure);
	});

	it("fails with commission_not_configured when no pct is defined", async () => {
		state.listCatalog.mockResolvedValue([entry("dossie_empresarial")]);
		state.getEffectiveCommission.mockResolvedValue({ pct: null, source: "none" });

		expect(await quoteOrder(identity, "dossie_empresarial", { partnerCount: 0 })).toEqual({
			ok: false,
			reason: "commission_not_configured",
		});
	});

	it("quotes the platform price with the partner count and the effective commission", async () => {
		state.listCatalog.mockResolvedValue([entry("dossie_empresarial")]);

		const quote = await quoteOrder(identity, "dossie_empresarial", { partnerCount: 2 });

		expect(quote).toMatchObject({
			ok: true,
			totalPriceCents: 16000,
			bureauCommissionCents: 3200,
			platformShareCents: 12800,
		});
		expect(state.getEffectiveCommission).toHaveBeenCalledWith(identity, "b");
	});
});
