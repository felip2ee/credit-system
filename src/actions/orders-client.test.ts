import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const DOSSIER_ID = "00000000-0000-4000-8000-0000000000d1";
const CPF = "390.533.447-05";

const state = vi.hoisted(() => ({
	role: "client" as string,
	sessionError: null as Error | null,
	slugRows: [{ slug: "bureau-teste" }] as { slug: string }[],
	catalog: [] as { code: string; name: string; kind: "main" | "addon"; salePrice: string }[],
	placeOrder: vi.fn(),
	query: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/config", () => ({ config: { betterAuthUrl: "https://app.example.test" } }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => {
		if (state.sessionError) throw state.sessionError;
		return { userId: USER_ID, role: state.role, bureauId: BUREAU_ID, supportSessionId: null };
	}),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work({ query: state.query }),
}));
vi.mock("@/lib/bureaus/public", () => ({ getPublicCatalog: vi.fn(async () => state.catalog) }));
vi.mock("@/lib/orders/queries", () => ({ placeOrder: state.placeOrder }));

import { revalidatePath } from "next/cache";

import { getPublicCatalog } from "@/lib/bureaus/public";

import { openClientOrderAction } from "./orders-client";

const NOT_ALLOWED = "Ação não permitida.";
const GENERIC = "Não foi possível concluir. Tente novamente.";
const ownOrder = { productCode: "consulta_pf", withAi: false, self: true };
const thirdOrder = {
	productCode: "consulta_pf",
	withAi: false,
	self: false,
	subject: { name: "Maria Souza", document: CPF },
	contactEmail: "maria@example.test",
	contactPhone: "(11) 91234-5678",
};

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "client";
	state.sessionError = null;
	state.slugRows = [{ slug: "bureau-teste" }];
	state.catalog = [
		{ code: "consulta_pf", name: "Consulta PF", kind: "main", salePrice: "50.00" },
		{ code: "parecer_ia", name: "Parecer IA", kind: "addon", salePrice: "12.50" },
	];
	state.query.mockImplementation(async () => ({ rows: state.slugRows }));
	state.placeOrder.mockResolvedValue({ ok: true, dossierId: DOSSIER_ID, state: "awaiting_authorization" });
});

describe("openClientOrderAction", () => {
	it.each(["operator", "bureau_admin", "superadmin"])("refuses the %s role", async (role) => {
		state.role = role;

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({ error: NOT_ALLOWED });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("refuses an invalid session", async () => {
		state.sessionError = new Error("no session");

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({ error: NOT_ALLOWED });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("zod refuses a bad payload without calling placeOrder", async () => {
		const result = await openClientOrderAction({ ...thirdOrder, subject: { name: "Maria Souza", document: "111.111.111-11" } });

		expect(result).toEqual({ error: "CPF inválido." });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("the price comes from the public catalog, never from the form", async () => {
		const result = await openClientOrderAction({ ...ownOrder, withAi: true, price: "0.01", totalPriceCents: 1 });

		expect(result).toEqual({ error: null, id: DOSSIER_ID });
		expect(getPublicCatalog).toHaveBeenCalledWith("bureau-teste");
		const [identity, input, quote] = state.placeOrder.mock.calls[0];
		expect(identity).toMatchObject({ userId: USER_ID, role: "client" });
		expect(input).toMatchObject({ productCode: "consulta_pf", withAi: true, self: true, buyerProfileId: null });
		expect(quote).toEqual({
			ok: true,
			lines: [
				{ code: "consulta_pf", priceCents: 5000, costCents: 0, productVersionId: "" },
				{ code: "parecer_ia", priceCents: 1250, costCents: 0, productVersionId: "" },
			],
			totalCostCents: 0,
			totalPriceCents: 6250,
		});
		expect(revalidatePath).toHaveBeenCalledWith("/portal/pesquisas");
	});

	it("sends the third-party subject and the contact in E.164", async () => {
		await openClientOrderAction(thirdOrder);

		const [, input] = state.placeOrder.mock.calls[0];
		expect(input).toMatchObject({
			self: false,
			subject: { type: "PF", name: "Maria Souza", documentDigits: "39053344705" },
			contact: { email: "maria@example.test", phoneE164: "+5511912345678" },
		});
	});

	it("refuses an invalid phone without calling placeOrder", async () => {
		const result = await openClientOrderAction({ ...thirdOrder, contactPhone: "123" });

		expect(result).toEqual({ error: "Celular inválido. Use DDD e número." });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("refuses a product missing from the public catalog", async () => {
		state.catalog = [];

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({ error: "Produto indisponível neste Bureau." });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("refuses the AI add-on missing from the public catalog", async () => {
		state.catalog = state.catalog.filter((item) => item.kind === "main");

		await expect(openClientOrderAction({ ...ownOrder, withAi: true })).resolves.toEqual({
			error: "Parecer IA indisponível para este produto.",
		});
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("fails closed when the Bureau has no slug", async () => {
		state.slugRows = [];

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({ error: GENERIC });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it.each([
		["insufficient_balance", "Saldo insuficiente. Compre créditos para continuar."],
		["product_not_for_sale", "Produto indisponível neste Bureau."],
		["addon_not_for_sale", "Parecer IA indisponível para este produto."],
		["kind_mismatch", "O documento não combina com o produto."],
		["self_holder_missing", "Sua conta não tem Titular. Fale com o Bureau."],
		["contact_is_buyer", "Informe o e-mail e o celular do titular, não os seus."],
		["buyer_not_found", "Cliente comprador não encontrado neste Bureau."],
	])("maps %s to its message", async (reason, message) => {
		state.placeOrder.mockResolvedValue({ ok: false, reason });

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({ error: message });
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("logs only the step and the reason for an unmapped reason", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.placeOrder.mockResolvedValue({ ok: false, reason: "price_below_cost" });

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({ error: GENERIC });
		expect(spy).toHaveBeenCalledWith("[orders] openClientOrderAction falhou", { reason: "price_below_cost" });
		spy.mockRestore();
	});

	it("turns an exception into the generic message without leaking details", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.placeOrder.mockRejectedValue(Object.assign(new Error("secret 39053344705"), { code: "40001" }));

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({ error: GENERIC });
		expect(JSON.stringify(spy.mock.calls)).not.toContain("39053344705");
		spy.mockRestore();
	});
});
