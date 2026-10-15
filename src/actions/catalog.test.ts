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
	setBureauProductCost: vi.fn(),
	upsertCatalogItem: vi.fn(),
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
	setBureauProductCost: state.setBureauProductCost,
	upsertCatalogItem: state.upsertCatalogItem,
}));

import {
	createProduct,
	createProductVersion,
	setBureauProductCost,
	updateProduct,
	upsertCatalogItem,
} from "./catalog";
import { SessionAccessError } from "@/lib/auth/session";

const NOT_ALLOWED = "Você não tem permissão para gerenciar o catálogo.";
const newProduct = {
	code: "consulta_extra",
	name: "Consulta extra",
	kind: "main",
	depsProduct: "Smart PF 002",
	baseCost: "5.00",
};
const newVersion = { productId: PRODUCT_ID, depsProduct: "", baseCost: "6.50" };
const cost = { bureauId: BUREAU_ID, productId: PRODUCT_ID, cost: "7.25" };
const item = { productId: PRODUCT_ID, active: true, salePrice: "10.00" };

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "superadmin";
	state.supportSessionId = null;
	state.sessionError = null;
	state.createProduct.mockResolvedValue({ ok: true, id: PRODUCT_ID, versionId: "v1" });
	state.updateProduct.mockResolvedValue({ ok: true });
	state.createProductVersion.mockResolvedValue({ ok: true, versionId: "v2", version: 2 });
	state.setBureauProductCost.mockResolvedValue({ ok: true });
	state.upsertCatalogItem.mockResolvedValue({ ok: true });
});

describe("permission by role", () => {
	it("denies everyone but the superadmin on base product, version and cost actions", async () => {
		for (const role of ["bureau_admin", "operator", "client"]) {
			state.role = role;
			expect((await createProduct(newProduct)).error).toBe(NOT_ALLOWED);
			expect((await updateProduct({ id: PRODUCT_ID, name: "X", active: true })).error).toBe(NOT_ALLOWED);
			expect((await createProductVersion(newVersion)).error).toBe(NOT_ALLOWED);
			expect((await setBureauProductCost(cost)).error).toBe(NOT_ALLOWED);
		}
		expect(state.createProduct).not.toHaveBeenCalled();
		expect(state.updateProduct).not.toHaveBeenCalled();
		expect(state.createProductVersion).not.toHaveBeenCalled();
		expect(state.setBureauProductCost).not.toHaveBeenCalled();
	});

	it("denies everyone but the bureau_admin on the catalog item action", async () => {
		for (const role of ["superadmin", "operator", "client"]) {
			state.role = role;
			expect((await upsertCatalogItem(item)).error).toBe(NOT_ALLOWED);
		}
		expect(state.upsertCatalogItem).not.toHaveBeenCalled();
	});

	it("lets the superadmin run the platform actions", async () => {
		expect(await createProduct(newProduct)).toEqual({ error: null, id: PRODUCT_ID });
		expect(await createProductVersion(newVersion)).toEqual({ error: null, id: "v2" });
		expect(await setBureauProductCost(cost)).toEqual({ error: null, id: PRODUCT_ID });
		expect(state.setBureauProductCost).toHaveBeenCalledWith(
			expect.objectContaining({ role: "superadmin" }),
			BUREAU_ID,
			PRODUCT_ID,
			"7.25",
		);
	});
});

describe("validation", () => {
	it("rejects invalid money and ids before the query", async () => {
		for (const bad of ["0", "-1.00", "1.234", "abc", "100000000.00", " 10.00", "1,50"]) {
			expect((await setBureauProductCost({ ...cost, cost: bad })).error).toBeTruthy();
		}
		expect((await setBureauProductCost({ ...cost, bureauId: "abc" })).error).toBeTruthy();
		expect((await createProductVersion({ ...newVersion, baseCost: "0.00" })).error).toBeTruthy();
		expect(state.setBureauProductCost).not.toHaveBeenCalled();
		expect(state.createProductVersion).not.toHaveBeenCalled();
	});

	it("requires compatible mains for an addon and none for a main", async () => {
		expect((await createProduct({ ...newProduct, kind: "addon" })).error).toBeTruthy();
		expect((await createProduct({ ...newProduct, addonFor: ["consulta_pf"] })).error).toBeTruthy();
		expect(state.createProduct).not.toHaveBeenCalled();
	});
});

describe("upsertCatalogItem", () => {
	beforeEach(() => {
		state.role = "bureau_admin";
	});

	it("takes the bureau from the session and ignores a bureauId in the form", async () => {
		const result = await upsertCatalogItem({ ...item, bureauId: "00000000-0000-4000-8000-0000000000b2" });

		expect(result).toEqual({ error: null, id: PRODUCT_ID });
		expect(state.upsertCatalogItem).toHaveBeenCalledWith(
			expect.objectContaining({ bureauId: BUREAU_ID }),
			PRODUCT_ID,
			{ active: true, salePrice: "10.00" },
		);
	});

	it.each([
		["price_below_cost", "O preço de venda não pode ser menor que o custo."],
		["cost_not_set", "O custo deste produto ainda não foi definido. Peça ao suporte para defini-lo."],
		["addon_requires_main", "Ative antes um produto principal compatível com este adicional."],
		["product_inactive", "Este produto está desativado."],
	])("maps %s to a pt-BR message", async (reason, message) => {
		state.upsertCatalogItem.mockResolvedValue({ ok: false, reason });

		expect((await upsertCatalogItem(item)).error).toBe(message);
	});

	it("returns a safe message when the query throws", async () => {
		state.upsertCatalogItem.mockRejectedValue(new Error("pg: secret detail"));

		expect((await upsertCatalogItem(item)).error).toBe("Falha ao salvar o item do catálogo.");
	});
});

describe("support session", () => {
	it("denies the superadmin in a support session on product, version and cost actions", async () => {
		state.supportSessionId = "00000000-0000-4000-8000-0000000000e1";
		const denied = "Encerre a sessão de suporte para alterar produtos e custos.";

		expect((await createProduct(newProduct)).error).toBe(denied);
		expect((await updateProduct({ id: PRODUCT_ID, name: "X", active: true })).error).toBe(denied);
		expect((await createProductVersion(newVersion)).error).toBe(denied);
		expect((await setBureauProductCost(cost)).error).toBe(denied);
		expect(state.createProduct).not.toHaveBeenCalled();
		expect(state.updateProduct).not.toHaveBeenCalled();
		expect(state.createProductVersion).not.toHaveBeenCalled();
		expect(state.setBureauProductCost).not.toHaveBeenCalled();
	});
});

describe("session errors", () => {
	const generic = "Não foi possível verificar sua sessão. Tente novamente.";

	it("maps an invalid session to no permission without logging", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		state.sessionError = new SessionAccessError("session_required");

		expect((await setBureauProductCost(cost)).error).toBe(NOT_ALLOWED);
		expect(log).not.toHaveBeenCalled();
		log.mockRestore();
	});

	it("maps any other session failure to a generic message and logs name and code only", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		state.sessionError = Object.assign(new Error("db down: password=secret"), { code: "ECONNREFUSED" });

		expect((await setBureauProductCost(cost)).error).toBe(generic);
		expect(log).toHaveBeenCalledWith(expect.stringContaining("requireSession"), {
			name: "Error",
			code: "ECONNREFUSED",
		});
		expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
		log.mockRestore();
	});

	it("logs the action name when a query throws", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		state.setBureauProductCost.mockRejectedValue(new Error("boom"));

		expect((await setBureauProductCost(cost)).error).toBe("Falha ao definir o custo.");
		expect(log).toHaveBeenCalledWith(expect.stringContaining("setBureauProductCost"), {
			name: "Error",
			code: undefined,
		});
		log.mockRestore();
	});
});

describe("query results", () => {
	it.each([
		["code_taken", "Este código já está em uso."],
		["addon_for_unknown", "Os produtos compatíveis devem existir e ser do tipo principal."],
	])("maps createProduct %s to a pt-BR message", async (reason, message) => {
		state.createProduct.mockResolvedValue({ ok: false, reason });

		expect((await createProduct(newProduct)).error).toBe(message);
	});

	it("maps not_found to a pt-BR message on update, version and cost", async () => {
		const notFound = "Produto ou Bureau não encontrado.";
		state.updateProduct.mockResolvedValue({ ok: false, reason: "not_found" });
		state.createProductVersion.mockResolvedValue({ ok: false, reason: "not_found" });
		state.setBureauProductCost.mockResolvedValue({ ok: false, reason: "not_found" });

		expect((await updateProduct({ id: PRODUCT_ID, name: "X", active: true })).error).toBe(notFound);
		expect((await createProductVersion(newVersion)).error).toBe(notFound);
		expect((await setBureauProductCost(cost)).error).toBe(notFound);
	});
});

describe("input normalization", () => {
	it("stores duplicate addonFor codes once", async () => {
		await createProduct({ ...newProduct, kind: "addon", addonFor: ["consulta_pf", "consulta_pf", "consulta_pj"] });

		expect(state.createProduct).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ addonFor: ["consulta_pf", "consulta_pj"] }),
		);
	});

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
