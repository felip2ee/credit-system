import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const PRODUCT_ID = "00000000-0000-4000-8000-0000000000c1";
const USER_ID = "00000000-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({
	role: "superadmin" as string,
	supportSessionId: null as string | null,
	sessionError: null as Error | null,
	createProduct: vi.fn(),
	updateProduct: vi.fn(),
	createProductVersion: vi.fn(),
	setBureauCommissionOverride: vi.fn(),
	setProductBlock: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
	SessionAccessError: class SessionAccessError extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	},
	getRequiredSession: vi.fn(async () => {
		if (state.sessionError) throw state.sessionError;
		return {
			userId: USER_ID,
			role: state.role,
			bureauId: state.role === "superadmin" ? null : BUREAU_ID,
			supportSessionId: state.supportSessionId,
		};
	}),
}));
vi.mock("@/lib/catalog/queries", () => ({
	createProduct: state.createProduct,
	updateProduct: state.updateProduct,
	createProductVersion: state.createProductVersion,
}));
vi.mock("@/lib/commission/queries", () => ({
	setBureauCommissionOverride: state.setBureauCommissionOverride,
	setProductBlock: state.setProductBlock,
}));

import {
	createProduct,
	createProductVersion,
	setBureauCommissionOverrideAction,
	setProductBlockAction,
	updateProduct,
} from "./catalog";
import { SessionAccessError } from "@/lib/auth/session";

const NOT_ALLOWED = "Você não tem permissão para gerenciar o catálogo.";
const newProduct = {
	code: "consulta_extra",
	name: "Consulta extra",
	depsProduct: "Smart PF 002",
	baseCost: "5.00",
};
const newVersion = { productId: PRODUCT_ID, depsProduct: "", baseCost: "6.50" };
const override = { bureauId: BUREAU_ID, pct: 20 };
const block = { bureauId: BUREAU_ID, productId: PRODUCT_ID, blocked: true };

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "superadmin";
	state.supportSessionId = null;
	state.sessionError = null;
	state.createProduct.mockResolvedValue({ ok: true, id: PRODUCT_ID, versionId: "v1" });
	state.updateProduct.mockResolvedValue({ ok: true });
	state.createProductVersion.mockResolvedValue({ ok: true, versionId: "v2", version: 2 });
	state.setBureauCommissionOverride.mockResolvedValue({ ok: true });
	state.setProductBlock.mockResolvedValue({ ok: true });
});

describe("permission by role", () => {
	it("denies everyone but the superadmin on every platform action (bureau_admin lost catalog:write)", async () => {
		for (const role of ["bureau_admin", "operator", "client"]) {
			state.role = role;
			expect((await createProduct(newProduct)).error).toBe(NOT_ALLOWED);
			expect((await updateProduct({ id: PRODUCT_ID, name: "X", active: true })).error).toBe(NOT_ALLOWED);
			expect((await createProductVersion(newVersion)).error).toBe(NOT_ALLOWED);
			expect((await setBureauCommissionOverrideAction(override)).error).toBe(NOT_ALLOWED);
			expect((await setProductBlockAction(block)).error).toBe(NOT_ALLOWED);
		}
		expect(state.createProduct).not.toHaveBeenCalled();
		expect(state.updateProduct).not.toHaveBeenCalled();
		expect(state.createProductVersion).not.toHaveBeenCalled();
		expect(state.setBureauCommissionOverride).not.toHaveBeenCalled();
		expect(state.setProductBlock).not.toHaveBeenCalled();
	});

	it("lets the superadmin run the platform actions", async () => {
		expect(await createProduct(newProduct)).toEqual({ error: null, id: PRODUCT_ID });
		expect(await createProductVersion(newVersion)).toEqual({ error: null, id: "v2" });
		expect(await setBureauCommissionOverrideAction(override)).toEqual({ error: null, id: BUREAU_ID });
		expect(await setProductBlockAction(block)).toEqual({ error: null, id: PRODUCT_ID });
		expect(state.setBureauCommissionOverride).toHaveBeenCalledWith(
			expect.objectContaining({ role: "superadmin" }),
			BUREAU_ID,
			20,
		);
		expect(state.setProductBlock).toHaveBeenCalledWith(expect.anything(), BUREAU_ID, PRODUCT_ID, true);
	});
});

describe("validation", () => {
	it("rejects invalid money and ids before the query", async () => {
		expect((await createProductVersion({ ...newVersion, baseCost: "-0.01" })).error).toBeTruthy();
		expect((await createProductVersion({ ...newVersion, baseCostPerPartner: "1.234" })).error).toBeTruthy();
		expect((await createProductVersion({ ...newVersion, salePrice: "0.00" })).error).toBeTruthy();
		expect((await createProductVersion({ ...newVersion, salePrice: "1,50" })).error).toBeTruthy();
		expect((await createProductVersion({ ...newVersion, salePricePerPartner: "-1.00" })).error).toBeTruthy();
		expect(state.createProductVersion).not.toHaveBeenCalled();
	});

	it("accepts cost 0, an empty sale price (not for sale) and passes the prices", async () => {
		expect(await createProductVersion({ ...newVersion, baseCost: "0.00", baseCostPerPartner: "2.50" })).toEqual({
			error: null,
			id: "v2",
		});
		expect(state.createProductVersion).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ baseCost: "0.00", baseCostPerPartner: "2.50", salePrice: null, salePricePerPartner: "0.00" }),
		);
		await createProductVersion({ ...newVersion, salePrice: "400.00", salePricePerPartner: "30.00" });
		expect(state.createProductVersion).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({ salePrice: "400.00", salePricePerPartner: "30.00" }),
		);
	});

	it("rejects a commission outside 0 to 99.99 or with more than 2 decimals, accepts null to go back to global", async () => {
		for (const pct of [-1, 100, 99.995, 12.345, "20", undefined]) {
			expect((await setBureauCommissionOverrideAction({ ...override, pct })).error).toBeTruthy();
		}
		expect((await setBureauCommissionOverrideAction({ ...override, bureauId: "abc" })).error).toBeTruthy();
		expect(state.setBureauCommissionOverride).not.toHaveBeenCalled();
		for (const pct of [0, 12.5, 99.99, null]) {
			expect(await setBureauCommissionOverrideAction({ ...override, pct })).toEqual({ error: null, id: BUREAU_ID });
		}
		expect(state.setBureauCommissionOverride).toHaveBeenLastCalledWith(expect.anything(), BUREAU_ID, null);
	});

	it("rejects a non boolean block flag and bad ids", async () => {
		expect((await setProductBlockAction({ ...block, blocked: "yes" })).error).toBeTruthy();
		expect((await setProductBlockAction({ ...block, productId: "x" })).error).toBeTruthy();
		expect(state.setProductBlock).not.toHaveBeenCalled();
	});
});

describe("support session", () => {
	it("denies the superadmin in a support session on every platform action", async () => {
		state.supportSessionId = "00000000-0000-4000-8000-0000000000e1";
		const denied = "Encerre a sessão de suporte para alterar produtos, preços e comissões.";

		expect((await createProduct(newProduct)).error).toBe(denied);
		expect((await updateProduct({ id: PRODUCT_ID, name: "X", active: true })).error).toBe(denied);
		expect((await createProductVersion(newVersion)).error).toBe(denied);
		expect((await setBureauCommissionOverrideAction(override)).error).toBe(denied);
		expect((await setProductBlockAction(block)).error).toBe(denied);
		expect(state.createProduct).not.toHaveBeenCalled();
		expect(state.setBureauCommissionOverride).not.toHaveBeenCalled();
		expect(state.setProductBlock).not.toHaveBeenCalled();
	});
});

describe("session errors", () => {
	const generic = "Não foi possível verificar sua sessão. Tente novamente.";

	it("maps an invalid session to no permission without logging", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		state.sessionError = new SessionAccessError("session_required");

		expect((await setProductBlockAction(block)).error).toBe(NOT_ALLOWED);
		expect(log).not.toHaveBeenCalled();
		log.mockRestore();
	});

	it("maps any other session failure to a generic message and logs name and code only", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		state.sessionError = Object.assign(new Error("db down: password=secret"), { code: "ECONNREFUSED" });

		expect((await setProductBlockAction(block)).error).toBe(generic);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("requireSession"), {
			name: "Error",
			code: "ECONNREFUSED",
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
		log.mockRestore();
	});

	it("logs the action name when a query throws", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		state.setBureauCommissionOverride.mockRejectedValue(new Error("boom"));

		expect((await setBureauCommissionOverrideAction(override)).error).toBe("Falha ao definir a comissão do Bureau.");
		expect(log).toHaveBeenCalledWith(expect.stringContaining("setBureauCommissionOverride"), {
			name: "Error",
			code: undefined,
		});
		log.mockRestore();
	});
});

describe("query results", () => {
	it("maps createProduct code_taken to a pt-BR message", async () => {
		state.createProduct.mockResolvedValue({ ok: false, reason: "code_taken" });

		expect((await createProduct(newProduct)).error).toBe("Este código já está em uso.");
	});

	it("maps not_found to a pt-BR message on update, version, override and block", async () => {
		const notFound = "Produto ou Bureau não encontrado.";
		state.updateProduct.mockResolvedValue({ ok: false, reason: "not_found" });
		state.createProductVersion.mockResolvedValue({ ok: false, reason: "not_found" });
		state.setBureauCommissionOverride.mockResolvedValue({ ok: false, reason: "not_found" });
		state.setProductBlock.mockResolvedValue({ ok: false, reason: "not_found" });

		expect((await updateProduct({ id: PRODUCT_ID, name: "X", active: true })).error).toBe(notFound);
		expect((await createProductVersion(newVersion)).error).toBe(notFound);
		expect((await setBureauCommissionOverrideAction(override)).error).toBe(notFound);
		expect((await setProductBlockAction(block)).error).toBe(notFound);
	});

	it("maps split_over_100 on the override", async () => {
		state.setBureauCommissionOverride.mockResolvedValue({ ok: false, reason: "split_over_100" });

		expect((await setBureauCommissionOverrideAction(override)).error).toBe(
			"A comissão do Bureau somada à dos afiliados passa de 100%.",
		);
	});

	it.each([
		["price_below_cost", "O preço de venda não pode ser menor que o custo."],
		["partner_price_below_cost", "O valor por sócio não pode ser menor que o custo por sócio."],
		["per_partner_not_allowed", "O Dossiê Pessoa Física não cobra valor por sócio."],
	])("maps the price conflict %s on product and version", async (reason, message) => {
		state.createProduct.mockResolvedValue({ ok: false, reason });
		state.createProductVersion.mockResolvedValue({ ok: false, reason });

		expect((await createProduct(newProduct)).error).toBe(message);
		expect((await createProductVersion(newVersion)).error).toBe(message);
	});
});

describe("input normalization", () => {
	it("accepts a missing depsProduct and passes null", async () => {
		const { depsProduct: _omitted, ...withoutDeps } = newProduct;
		const { depsProduct: _omittedVersion, ...versionWithoutDeps } = newVersion;

		expect(await createProduct(withoutDeps)).toEqual({ error: null, id: PRODUCT_ID });
		expect(await createProductVersion(versionWithoutDeps)).toEqual({ error: null, id: "v2" });
		expect(state.createProduct).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ depsProduct: null }));
		expect(state.createProductVersion).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ depsProduct: null }),
		);
	});
});
