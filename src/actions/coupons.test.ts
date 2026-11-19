import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";

const state = vi.hoisted(() => ({
	role: "client" as string,
	sessionError: null as Error | null,
	catalog: [] as { code: string; name: string; salePrice: string; salePricePerPartner: string }[],
	preview: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => {
		if (state.sessionError) throw state.sessionError;
		return { userId: USER_ID, role: state.role, bureauId: BUREAU_ID, supportSessionId: null };
	}),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) =>
		work({ query: async () => ({ rows: [{ slug: "bureau-teste" }] }) }),
}));
vi.mock("@/lib/bureaus/public", () => ({ getPublicCatalog: vi.fn(async () => state.catalog) }));
vi.mock("@/lib/coupons/queries", () => ({
	createCoupon: vi.fn(),
	updateCoupon: vi.fn(),
	setCouponActive: vi.fn(),
	previewCoupon: state.preview,
}));

import { previewCouponAction } from "./coupons";

const INVALID = "Cupom inválido ou indisponível";
const input = { productCode: "dossie_pf", partners: 0, couponCode: "verao10" };

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "client";
	state.sessionError = null;
	state.catalog = [
		{ code: "dossie_pf", name: "Dossiê Pessoa Física", salePrice: "50.00", salePricePerPartner: "0.00" },
		{ code: "dossie_empresarial", name: "Dossiê Empresarial", salePrice: "80.00", salePricePerPartner: "30.00" },
	];
	state.preview.mockResolvedValue({ couponId: "c1", kind: "percent", value: 20, eligibleProductCodes: ["dossie_pf"] });
});

describe("previewCouponAction", () => {
	it.each(["operator", "bureau_admin", "superadmin"])("refuses the %s role", async (role) => {
		state.role = role;

		await expect(previewCouponAction(input)).resolves.toEqual({ error: "Ação não permitida." });
		expect(state.preview).not.toHaveBeenCalled();
	});

	it("returns list, discount and paid price from the public catalog price", async () => {
		await expect(previewCouponAction(input)).resolves.toEqual({
			error: null,
			listCents: 5000,
			discountCents: 1000,
			paidCents: 4000,
		});
		expect(state.preview).toHaveBeenCalledWith(expect.anything(), "verao10", ["dossie_pf"]);
	});

	it("discounts only the accepted lines and counts the partners in the list price", async () => {
		state.preview.mockResolvedValue({ couponId: "c1", kind: "fixed", value: 15, eligibleProductCodes: ["dossie_empresarial"] });

		await expect(previewCouponAction({ productCode: "dossie_empresarial", partners: 2, couponCode: "X1Y2" })).resolves.toEqual({
			error: null,
			listCents: 14000,
			discountCents: 1500,
			paidCents: 12500,
		});
	});

	it("a coupon that covers the whole price gives paid 0", async () => {
		state.preview.mockResolvedValue({ couponId: "c1", kind: "percent", value: 100, eligibleProductCodes: ["dossie_pf"] });

		await expect(previewCouponAction(input)).resolves.toMatchObject({ error: null, discountCents: 5000, paidCents: 0 });
	});

	it("no preview row (unknown, expired, exhausted, other Bureau, other product) gives the single generic message", async () => {
		state.preview.mockResolvedValue(null);

		await expect(previewCouponAction(input)).resolves.toEqual({ error: INVALID });
	});

	it("a bad payload gives the same generic message", async () => {
		await expect(previewCouponAction({ ...input, productCode: "outro" })).resolves.toEqual({ error: INVALID });
		await expect(previewCouponAction({ ...input, partners: -1 })).resolves.toEqual({ error: INVALID });
		expect(state.preview).not.toHaveBeenCalled();
	});

	it("a product missing from the public catalog gives the generic message", async () => {
		state.catalog = [];

		await expect(previewCouponAction(input)).resolves.toEqual({ error: INVALID });
		expect(state.preview).not.toHaveBeenCalled();
	});

	it("turns an exception into the generic order message, logging only name and code", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.preview.mockRejectedValue(Object.assign(new Error("secret verao10"), { code: "40001" }));

		await expect(previewCouponAction(input)).resolves.toEqual({ error: "Não foi possível concluir. Tente novamente." });
		expect(JSON.stringify(spy.mock.calls)).not.toContain("verao10");
		spy.mockRestore();
	});
});
