import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DbIdentity } from "@/lib/db/transaction";

const state = vi.hoisted(() => ({ listCatalog: vi.fn() }));
vi.mock("./queries", () => ({ listCatalog: state.listCatalog }));

import { quoteOrder } from "./quote";

const identity: DbIdentity = { userId: "u", role: "bureau_admin", bureauId: "b" };

function entry(code: string, kind: "main" | "addon", onSale: boolean, extra = {}) {
	return {
		productId: `p-${code}`,
		productVersionId: `v-${code}`,
		code,
		name: code,
		kind,
		addonFor: kind === "addon" ? ["consulta_pf"] : null,
		effectiveCost: "3.00",
		item: { active: true, salePrice: "10.00" },
		sellable: true,
		onSale,
		...extra,
	};
}

beforeEach(() => vi.clearAllMocks());

describe("quoteOrder failures", () => {
	it("fails when the product is off sale, unknown or an addon", async () => {
		state.listCatalog.mockResolvedValue([entry("consulta_pf", "main", false), entry("parecer_ia", "addon", true)]);

		expect(await quoteOrder(identity, "consulta_pf", { withAi: false })).toEqual({
			ok: false,
			reason: "product_not_for_sale",
		});
		expect(await quoteOrder(identity, "nope", { withAi: false })).toMatchObject({ ok: false });
		expect(await quoteOrder(identity, "parecer_ia", { withAi: false })).toMatchObject({ ok: false });
	});

	it("fails with addon_not_for_sale when the addon is off sale or not compatible", async () => {
		state.listCatalog.mockResolvedValue([
			entry("consulta_pf", "main", true),
			entry("parecer_ia", "addon", false),
		]);
		expect(await quoteOrder(identity, "consulta_pf", { withAi: true })).toEqual({
			ok: false,
			reason: "addon_not_for_sale",
		});

		state.listCatalog.mockResolvedValue([
			entry("consulta_pf", "main", true),
			entry("parecer_ia", "addon", true, { addonFor: ["consulta_pj"] }),
		]);
		expect(await quoteOrder(identity, "consulta_pf", { withAi: true })).toMatchObject({
			ok: false,
			reason: "addon_not_for_sale",
		});
	});

	it("ignores the addon when withAi is false", async () => {
		state.listCatalog.mockResolvedValue([
			entry("consulta_pf", "main", true),
			entry("parecer_ia", "addon", false),
		]);

		const quote = await quoteOrder(identity, "consulta_pf", { withAi: false });

		expect(quote).toMatchObject({ ok: true, totalCostCents: 300, totalPriceCents: 1000 });
	});
});
