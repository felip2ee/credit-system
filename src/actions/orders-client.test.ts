import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const DOSSIER_ID = "00000000-0000-4000-8000-0000000000d1";
const CPF = "390.533.447-05";

const state = vi.hoisted(() => ({
	role: "client" as string,
	sessionError: null as Error | null,
	slugRows: [{ slug: "bureau-teste" }] as { slug: string }[],
	catalog: [] as { code: string; name: string; salePrice: string; salePricePerPartner: string }[],
	placeOrder: vi.fn(),
	query: vi.fn(),
	accountStatus: vi.fn(),
	holderType: vi.fn(),
	cancelMyOrder: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
	headers: () => new Headers({ "x-forwarded-for": "203.0.113.9", "user-agent": "vitest-agent" }),
}));
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
vi.mock("@/lib/account/queries", () => ({ getClientAccountStatus: state.accountStatus }));
vi.mock("@/lib/orders/client-queries", () => ({ getMyHolderType: state.holderType }));
vi.mock("@/lib/orders/client-ops", () => ({
	cancelMyOrder: state.cancelMyOrder,
}));

import { revalidatePath } from "next/cache";

import { getPublicCatalog } from "@/lib/bureaus/public";

import { cancelMyOrderAction, openClientOrderAction } from "./orders-client";

const NOT_ALLOWED = "Ação não permitida.";
const GENERIC = "Não foi possível concluir. Tente novamente.";
const ownOrder = { productCode: "dossie_pf", self: true };
const thirdOrder = {
	productCode: "dossie_pf",
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
		{ code: "dossie_pf", name: "Dossiê Pessoa Física", salePrice: "50.00", salePricePerPartner: "0.00" },
		{ code: "dossie_empresarial", name: "Dossiê Empresarial", salePrice: "80.00", salePricePerPartner: "30.00" },
	];
	state.query.mockImplementation(async () => ({ rows: state.slugRows }));
	state.placeOrder.mockResolvedValue({ ok: true, dossierId: DOSSIER_ID, state: "awaiting_authorization" });
	state.accountStatus.mockResolvedValue({ termsAccepted: true, emailVerified: true });
	state.holderType.mockResolvedValue("PF");
	state.cancelMyOrder.mockResolvedValue({ ok: true });
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

	it("refuses a client without accepted terms and does not place the order", async () => {
		state.accountStatus.mockResolvedValue({ termsAccepted: false, emailVerified: true });

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({
			error: "Aceite os termos de uso antes de fazer um pedido.",
		});
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("refuses a client with an unverified e-mail and does not place the order", async () => {
		state.accountStatus.mockResolvedValue({ termsAccepted: true, emailVerified: false });

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({
			error: "Confirme seu e-mail antes de comprar créditos.",
		});
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("zod refuses a bad payload without calling placeOrder", async () => {
		const result = await openClientOrderAction({ ...thirdOrder, subject: { name: "Maria Souza", document: "111.111.111-11" } });

		expect(result).toEqual({ error: "CPF inválido." });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("the price comes from the public catalog, never from the form", async () => {
		const result = await openClientOrderAction({ ...ownOrder, price: "0.01", totalPriceCents: 1 });

		expect(result).toEqual({ error: null, id: DOSSIER_ID });
		expect(getPublicCatalog).toHaveBeenCalledWith("bureau-teste");
		const [identity, input, quote] = state.placeOrder.mock.calls[0];
		expect(identity).toMatchObject({ userId: USER_ID, role: "client" });
		expect(input).toMatchObject({ productCode: "dossie_pf", self: true, partners: [], buyerProfileId: null });
		expect(quote).toEqual({
			ok: true,
			lines: [
				{ productVersionId: "", code: "dossie_pf", part: "base", quantity: 1, unitPriceCents: 5000, priceCents: 5000 },
			],
			totalPriceCents: 5000,
			bureauCommissionCents: 0,
			platformShareCents: 5000,
		});
		expect(revalidatePath).toHaveBeenCalledWith("/portal/pesquisas");
	});

	it("quotes base plus the per-partner value and sends the partners", async () => {
		const partner = (document: string) => ({ document, name: "Sócio", email: `${document}@example.test` });
		await openClientOrderAction({
			productCode: "dossie_empresarial",
			self: false,
			subject: { name: "Empresa Ltda", document: "11.222.333/0001-81" },
			contactEmail: "resp@example.test",
			partners: [partner(CPF), partner("529.982.247-25")],
			declarationAccepted: true,
			declarationVersion: 3,
		});

		const [, input, quote] = state.placeOrder.mock.calls[0];
		expect(input.partners).toHaveLength(2);
		expect(input.partners[0]).toMatchObject({ documentDigits: "39053344705", name: "Sócio" });
		expect(quote.lines.map((l: { part: string; quantity: number; priceCents: number }) => [l.part, l.quantity, l.priceCents])).toEqual([
			["base", 1, 8000],
			["partner", 2, 6000],
		]);
		expect(quote.totalPriceCents).toBe(14000);
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

	it("fails closed when the Bureau has no slug", async () => {
		state.slugRows = [];

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({ error: GENERIC });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it.each([
		["insufficient_balance", "Saldo insuficiente. Compre créditos para continuar."],
		["product_not_for_sale", "Produto indisponível neste Bureau."],
		["kind_mismatch", "O documento não combina com o produto."],
		["self_holder_missing", "Sua conta não tem Titular. Fale com o Bureau."],
		["contact_is_buyer", "Informe o e-mail e o celular do titular, não os seus."],
		["buyer_not_found", "Cliente comprador não encontrado neste Bureau."],
		[
			"third_party_not_allowed",
			"No portal, o Dossiê Pessoa Física é só para você. Envie seu link para a outra pessoa consultar na conta dela.",
		],
		["price_mismatch", "O preço mudou. Revise e confirme de novo."],
		["declaration_outdated", "A declaração mudou. Leia e confirme de novo."],
	])("maps %s to its message", async (reason, message) => {
		state.placeOrder.mockResolvedValue({ ok: false, reason });

		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({ error: message });
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it.each([
		"coupon_invalid",
		"coupon_expired",
		"coupon_exhausted",
		"coupon_client_limit",
		"coupon_product_not_allowed",
	])("maps %s to the single generic coupon message (never reveals the reason)", async (reason) => {
		state.placeOrder.mockResolvedValue({ ok: false, reason });

		await expect(openClientOrderAction({ ...ownOrder, couponCode: "VERAO10" })).resolves.toEqual({
			error: "Cupom inválido ou indisponível",
		});
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("maps coupon_funds_insufficient to the generic coupon message (no Bureau finances leak)", async () => {
		state.placeOrder.mockResolvedValue({ ok: false, reason: "coupon_funds_insufficient" });

		await expect(openClientOrderAction({ ...ownOrder, couponCode: "VERAO10" })).resolves.toEqual({
			error: "Cupom inválido ou indisponível",
		});
	});

	it("passes the coupon code, trimmed and upper-case, to placeOrder; a blank code sends none", async () => {
		await openClientOrderAction({ ...ownOrder, couponCode: "  verao10 " });
		expect(state.placeOrder.mock.calls[0][3]).toEqual({ couponCode: "VERAO10" });

		state.placeOrder.mockClear();
		await openClientOrderAction({ ...ownOrder, couponCode: "   " });
		expect(state.placeOrder.mock.calls[0][3]).toBeUndefined();
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

describe("declaration for orders with members", () => {
	const company = {
		productCode: "dossie_empresarial",
		self: false,
		subject: { name: "Empresa Ltda", document: "11.222.333/0001-81" },
		contactEmail: "resp@example.test",
		partners: [{ document: CPF, name: "Sócio", email: "socio@example.test" }],
	};
	const SEEN_VERSION = 3;
	const pfOfCompanyAccount = { ...thirdOrder, subject: { name: "Responsável", document: CPF } };

	it.each([
		["dossie_empresarial", company],
		["dossie_pf of a PJ account", pfOfCompanyAccount],
	])("%s without the declaration opens nothing", async (name, order) => {
		state.holderType.mockResolvedValue("PJ");

		await expect(openClientOrderAction(order)).resolves.toEqual({ error: "Marque a declaração para continuar." });
		await expect(openClientOrderAction({ ...order, declarationAccepted: false })).resolves.toEqual({
			error: "Marque a declaração para continuar.",
		});
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it.each([
		["dossie_empresarial", company],
		["dossie_pf of a PJ account", pfOfCompanyAccount],
	])("%s with the declaration passes the version the client saw, IP and user agent", async (name, order) => {
		state.holderType.mockResolvedValue("PJ");

		await expect(openClientOrderAction({ ...order, declarationAccepted: true, declarationVersion: SEEN_VERSION })).resolves.toEqual({
			error: null,
			id: DOSSIER_ID,
		});

		expect(state.placeOrder.mock.calls[0][3]).toEqual({
			declaration: { version: SEEN_VERSION, ip: "203.0.113.9", userAgent: "vitest-agent" },
		});
	});

	it("a stale version goes to the database as sent and comes back as declaration_outdated", async () => {
		state.placeOrder.mockResolvedValue({ ok: false, reason: "declaration_outdated" });

		await expect(openClientOrderAction({ ...company, declarationAccepted: true, declarationVersion: 2 })).resolves.toEqual({
			error: "A declaração mudou. Leia e confirme de novo.",
		});
		expect(state.placeOrder.mock.calls[0][3]).toMatchObject({ declaration: { version: 2 } });
	});

	it("an order with members and no declaration version opens nothing", async () => {
		await expect(openClientOrderAction({ ...company, declarationAccepted: true })).resolves.toEqual({
			error: "A declaração mudou. Leia e confirme de novo.",
		});
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("dossie_pf of a PF account does not need the declaration and sends none", async () => {
		await expect(openClientOrderAction(ownOrder)).resolves.toEqual({ error: null, id: DOSSIER_ID });

		expect(state.placeOrder.mock.calls[0][3]).toBeUndefined();
	});

	it("a PF account that asks for a third-party dossie_pf reaches the database rule", async () => {
		state.placeOrder.mockResolvedValue({ ok: false, reason: "third_party_not_allowed" });

		await expect(openClientOrderAction(thirdOrder)).resolves.toEqual({
			error: "No portal, o Dossiê Pessoa Física é só para você. Envie seu link para a outra pessoa consultar na conta dela.",
		});
	});
});

describe("cancelMyOrderAction", () => {
	it.each(["operator", "bureau_admin", "superadmin"])("refuses the %s role", async (role) => {
		state.role = role;

		await expect(cancelMyOrderAction(DOSSIER_ID)).resolves.toEqual({ error: NOT_ALLOWED });
		expect(state.cancelMyOrder).not.toHaveBeenCalled();
	});

	it("refuses an id that is not a uuid", async () => {
		await expect(cancelMyOrderAction("abc")).resolves.toEqual({ error: "Pedido não encontrado." });
		expect(state.cancelMyOrder).not.toHaveBeenCalled();
	});

	it("cancels the own order and revalidates the list and the order page", async () => {
		await expect(cancelMyOrderAction(DOSSIER_ID)).resolves.toEqual({ error: null, id: DOSSIER_ID });

		expect(state.cancelMyOrder).toHaveBeenCalledWith(expect.anything(), DOSSIER_ID);
		expect(revalidatePath).toHaveBeenCalledWith("/portal/pesquisas");
		expect(revalidatePath).toHaveBeenCalledWith(`/portal/pesquisas/${DOSSIER_ID}`);
	});

	it.each([
		["not_found", "Pedido não encontrado."],
		["invalid_state", "O pedido mudou de estado. Recarregue a página."],
	])("maps %s to its message", async (reason, message) => {
		state.cancelMyOrder.mockResolvedValue({ ok: false, reason });

		await expect(cancelMyOrderAction(DOSSIER_ID)).resolves.toEqual({ error: message });
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("turns an exception into the generic message", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.cancelMyOrder.mockRejectedValue(new Error("boom"));

		await expect(cancelMyOrderAction(DOSSIER_ID)).resolves.toEqual({ error: GENERIC });
		spy.mockRestore();
	});
});
