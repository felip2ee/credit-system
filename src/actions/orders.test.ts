import { beforeEach, describe, expect, it, vi } from "vitest";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const BUYER_ID = "00000000-0000-4000-8000-0000000000c1";
const DOSSIER_ID = "00000000-0000-4000-8000-0000000000d1";
const TX_CLIENT = { tx: true };

const state = vi.hoisted(() => ({
	role: "operator" as string,
	supportSessionId: null as string | null,
	sessionError: null as Error | null,
	quoteOrder: vi.fn(),
	placeOrder: vi.fn(),
	cancelOrder: vi.fn(),
	releaseDelivery: vi.fn(),
	revokeDelivery: vi.fn(),
	runOrderNow: vi.fn(),
	updateOrderContact: vi.fn(),
	issueRequest: vi.fn(),
	readScrTermSettings: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/config", () => ({ config: { betterAuthUrl: "https://app.example.test" } }));
vi.mock("@/lib/auth/session", () => ({
	SessionAccessError: class SessionAccessError extends Error {},
	getRequiredSession: vi.fn(async () => {
		if (state.sessionError) throw state.sessionError;
		return { userId: USER_ID, role: state.role, bureauId: BUREAU_ID, supportSessionId: state.supportSessionId };
	}),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work(TX_CLIENT),
}));
vi.mock("@/lib/catalog/quote", () => ({ quoteOrder: state.quoteOrder }));
vi.mock("@/lib/orders/contact", () => ({ updateOrderContact: state.updateOrderContact }));
vi.mock("@/lib/orders/issue-request", () => ({ issueRequest: state.issueRequest }));
vi.mock("@/lib/settings/readers", () => ({ readScrTermSettings: state.readScrTermSettings }));
vi.mock("@/lib/orders/execute", () => ({ runOrderNow: state.runOrderNow }));
vi.mock("@/lib/orders/queries", () => ({
	placeOrder: state.placeOrder,
	cancelOrder: state.cancelOrder,
	releaseDelivery: state.releaseDelivery,
	revokeDelivery: state.revokeDelivery,
}));

import { revalidatePath } from "next/cache";

import { SessionAccessError } from "@/lib/auth/session";

import {
	cancelOrderAction,
	openCounterOrderAction,
	releaseOrderAction,
	revokeOrderAction,
	runOrderNowAction,
	updateOrderContactAction,
} from "./orders";

const NOT_ALLOWED = "Ação não permitida.";
const SUPPORT = "Encerre a sessão de suporte para operar pedidos.";
const GENERIC = "Não foi possível concluir. Tente novamente.";
const QUOTE = { ok: true, lines: [], totalCostCents: 1000, totalPriceCents: 3000 };
const CONSULTATION_ID = "00000000-0000-4000-8000-0000000000e1";
const contactChange = { dossierId: DOSSIER_ID, consultationId: CONSULTATION_ID, contactEmail: "Novo@Example.test", contactPhone: "" };
const REQUEST = { scrId: "s1", publicToken: "t1", holderId: "h1", type: "PF", document: "39053344705", name: "Maria", email: "novo@example.test", phoneE164: null };
const counterOrder = {
	productCode: "dossie_pf",
	buyerProfileId: BUYER_ID,
	subject: { name: "Maria Souza", document: "390.533.447-05" },
	contactEmail: "maria@example.test",
	contactPhone: "(11) 91234-5678",
};

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "operator";
	state.supportSessionId = null;
	state.sessionError = null;
	state.quoteOrder.mockResolvedValue(QUOTE);
	state.placeOrder.mockResolvedValue({ ok: true, dossierId: DOSSIER_ID, state: "ready" });
	state.cancelOrder.mockResolvedValue({ ok: true });
	state.releaseDelivery.mockResolvedValue({ ok: true });
	state.revokeDelivery.mockResolvedValue({ ok: true });
	state.runOrderNow.mockResolvedValue("completed");
	state.updateOrderContact.mockResolvedValue({ ok: true, request: REQUEST, deferred: false });
	state.readScrTermSettings.mockResolvedValue({ authorizedName: "Bureau" });
	state.issueRequest.mockResolvedValue({ ok: true });
});

describe("staff gate", () => {
	const actions: [string, () => Promise<{ error: string | null }>][] = [
		["openCounterOrderAction", () => openCounterOrderAction(counterOrder)],
		["runOrderNowAction", () => runOrderNowAction(DOSSIER_ID)],
		["cancelOrderAction", () => cancelOrderAction(DOSSIER_ID)],
		["releaseOrderAction", () => releaseOrderAction(DOSSIER_ID)],
		["revokeOrderAction", () => revokeOrderAction({ dossierId: DOSSIER_ID, reason: "Erro" })],
		["updateOrderContactAction", () => updateOrderContactAction(contactChange)],
	];

	it.each(actions)("%s refuses a role without consultations:write", async (_name, run) => {
		state.role = "client";

		await expect(run()).resolves.toEqual({ error: NOT_ALLOWED });
	});

	it.each(actions)("%s refuses an invalid session", async (_name, run) => {
		state.sessionError = new SessionAccessError("session_required");

		await expect(run()).resolves.toEqual({ error: NOT_ALLOWED });
	});

	it.each(actions)("%s refuses a support session", async (_name, run) => {
		state.role = "superadmin";
		state.supportSessionId = "support-1";

		await expect(run()).resolves.toEqual({ error: SUPPORT });
	});

	it("never reaches the queries when the gate refuses", async () => {
		state.role = "client";
		for (const [, run] of actions) await run();

		for (const fn of [state.quoteOrder, state.placeOrder, state.cancelOrder, state.releaseDelivery, state.revokeDelivery, state.runOrderNow, state.updateOrderContact, state.issueRequest]) {
			expect(fn).not.toHaveBeenCalled();
		}
	});
});

describe("openCounterOrderAction", () => {
	it("quotes by partner count, places the order and revalidates the list", async () => {
		const result = await openCounterOrderAction(counterOrder);

		expect(result).toEqual({ error: null, id: DOSSIER_ID });
		expect(state.quoteOrder).toHaveBeenCalledWith(expect.objectContaining({ role: "operator" }), "dossie_pf", { partnerCount: 0 });
		const [identity, input, quote] = state.placeOrder.mock.calls[0];
		expect(identity).toMatchObject({ userId: USER_ID });
		expect(input).toMatchObject({
			productCode: "dossie_pf",
			self: false,
			buyerProfileId: BUYER_ID,
			subject: { type: "PF", name: "Maria Souza", documentDigits: "39053344705" },
			contact: { email: "maria@example.test", phoneE164: "+5511912345678" },
		});
		expect(quote).toBe(QUOTE);
		expect(revalidatePath).toHaveBeenCalledWith("/dossiers");
	});

	it("passes the idempotency key to placeOrder; without a key there are no options", async () => {
		await openCounterOrderAction({ ...counterOrder, idempotencyKey: "3f1f3a52-6a4f-4d6b-9a55-2b3d6a1c9e10" });
		expect(state.placeOrder.mock.calls[0][3]).toEqual({ idempotencyKey: "3f1f3a52-6a4f-4d6b-9a55-2b3d6a1c9e10" });

		state.placeOrder.mockClear();
		await openCounterOrderAction(counterOrder);
		expect(state.placeOrder.mock.calls[0][3]).toBeUndefined();
	});

	it("quotes the partner count of a dossie_empresarial", async () => {
		const partner = (document: string) => ({ document, name: "Sócio", email: `${document}@example.test` });
		await openCounterOrderAction({
			...counterOrder,
			productCode: "dossie_empresarial",
			subject: { name: "Empresa Ltda", document: "11.222.333/0001-81" },
			partners: [partner("390.533.447-05"), partner("529.982.247-25"), partner("390.533.447-05")],
		});

		// O mesmo CPF duas vezes conta um sócio só: a cotação casa com o total do banco.
		expect(state.quoteOrder).toHaveBeenCalledWith(expect.anything(), "dossie_empresarial", { partnerCount: 2 });
		expect(state.placeOrder.mock.calls[0][1].partners).toHaveLength(2);
	});

	it("zod refuses a bad payload before the gate", async () => {
		const result = await openCounterOrderAction({ ...counterOrder, subject: { name: "Maria Souza", document: "111.111.111-11" } });

		expect(result).toEqual({ error: "CPF inválido." });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("refuses an invalid phone without placing the order", async () => {
		const result = await openCounterOrderAction({ ...counterOrder, contactPhone: "123" });

		expect(result).toEqual({ error: "Celular inválido. Use DDD e número." });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it("accepts a counter order without contact: the server decides when the subject is the buyer", async () => {
		await expect(openCounterOrderAction({ ...counterOrder, contactEmail: "", contactPhone: "" })).resolves.toEqual({ error: null, id: DOSSIER_ID });

		expect(state.placeOrder.mock.calls[0][1].contact).toEqual({ email: null, phoneE164: null });
	});

	it("keeps a missing phone as null", async () => {
		await openCounterOrderAction({ ...counterOrder, contactPhone: "" });

		expect(state.placeOrder.mock.calls[0][1].contact.phoneE164).toBeNull();
	});

	it.each([
		["product_not_for_sale", "Produto indisponível neste Bureau."],
	])("maps the quote failure %s", async (reason, message) => {
		state.quoteOrder.mockResolvedValue({ ok: false, reason });

		await expect(openCounterOrderAction(counterOrder)).resolves.toEqual({ error: message });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it.each([
		["insufficient_balance", "Saldo do Bureau insuficiente para reservar o repasse à plataforma. Recarregue a carteira."],
		["kind_mismatch", "O documento não combina com o produto."],
		["contact_is_buyer", "Informe o e-mail e o celular do titular, não os seus."],
		["buyer_not_found", "Cliente comprador não encontrado neste Bureau."],
	])("maps %s", async (reason, message) => {
		state.placeOrder.mockResolvedValue({ ok: false, reason });

		await expect(openCounterOrderAction(counterOrder)).resolves.toEqual({ error: message });
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("turns an exception into the generic message", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.placeOrder.mockRejectedValue(new Error("boom 39053344705"));

		await expect(openCounterOrderAction(counterOrder)).resolves.toEqual({ error: GENERIC });
		expect(JSON.stringify(spy.mock.calls)).not.toContain("39053344705");
		spy.mockRestore();
	});
});

describe("runOrderNowAction", () => {
	it("refuses a non-uuid id without running", async () => {
		await expect(runOrderNowAction("abc")).resolves.toEqual({ error: "Pedido não encontrado." });
		expect(state.runOrderNow).not.toHaveBeenCalled();
	});

	it.each([
		["completed", { error: null, id: DOSSIER_ID }],
		["not_claimed", { error: "O pedido não está pronto para execução." }],
		["retry", { error: "Serviço da consulta indisponível. Nova tentativa automática em alguns minutos." }],
		["failed", { error: "A consulta não foi concluída. A reserva foi liberada." }],
	])("maps the outcome %s", async (outcome, expected) => {
		state.runOrderNow.mockResolvedValue(outcome);

		await expect(runOrderNowAction(DOSSIER_ID)).resolves.toEqual(expected);
		expect(state.runOrderNow).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }), DOSSIER_ID);
	});

	it("revalidates the dossier page when the state changed", async () => {
		state.runOrderNow.mockResolvedValue("failed");

		await runOrderNowAction(DOSSIER_ID);

		expect(revalidatePath).toHaveBeenCalledWith(`/dossiers/${DOSSIER_ID}`);
	});

	it("does not revalidate when nothing was claimed", async () => {
		state.runOrderNow.mockResolvedValue("not_claimed");

		await runOrderNowAction(DOSSIER_ID);

		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("catches a database exception", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.runOrderNow.mockRejectedValue(new Error("db down"));

		await expect(runOrderNowAction(DOSSIER_ID)).resolves.toEqual({ error: GENERIC });
		spy.mockRestore();
	});
});

describe("cancelOrderAction", () => {
	it("cancels by staff inside a transaction and revalidates the page", async () => {
		await expect(cancelOrderAction(DOSSIER_ID)).resolves.toEqual({ error: null, id: DOSSIER_ID });

		expect(state.cancelOrder).toHaveBeenCalledWith(TX_CLIENT, expect.objectContaining({ userId: USER_ID }), DOSSIER_ID, "cancelled_by_staff");
		expect(revalidatePath).toHaveBeenCalledWith(`/dossiers/${DOSSIER_ID}`);
	});

	it.each([
		["not_found", "Pedido não encontrado."],
		["invalid_state", "O pedido mudou de estado. Recarregue a página."],
	])("maps %s", async (reason, message) => {
		state.cancelOrder.mockResolvedValue({ ok: false, reason });

		await expect(cancelOrderAction(DOSSIER_ID)).resolves.toEqual({ error: message });
	});

	it("refuses a non-uuid id", async () => {
		await expect(cancelOrderAction("abc")).resolves.toEqual({ error: "Pedido não encontrado." });
		expect(state.cancelOrder).not.toHaveBeenCalled();
	});
});

describe("releaseOrderAction", () => {
	it("releases with the site URL from the config", async () => {
		await expect(releaseOrderAction(DOSSIER_ID)).resolves.toEqual({ error: null, id: DOSSIER_ID });

		expect(state.releaseDelivery).toHaveBeenCalledWith(
			TX_CLIENT,
			expect.objectContaining({ userId: USER_ID }),
			DOSSIER_ID,
			"https://app.example.test",
		);
		expect(revalidatePath).toHaveBeenCalledWith(`/dossiers/${DOSSIER_ID}`);
	});

	it.each([
		["not_found", "Pedido não encontrado."],
		["invalid_state", "O pedido mudou de estado. Recarregue a página."],
		["no_buyer", "Este pedido não tem cliente comprador. Entregue o PDF pela equipe."],
	])("maps %s", async (reason, message) => {
		state.releaseDelivery.mockResolvedValue({ ok: false, reason });

		await expect(releaseOrderAction(DOSSIER_ID)).resolves.toEqual({ error: message });
	});
});

describe("revokeOrderAction", () => {
	it("revokes with the reason and revalidates the page", async () => {
		await expect(revokeOrderAction({ dossierId: DOSSIER_ID, reason: "  Entregue por engano " })).resolves.toEqual({
			error: null,
			id: DOSSIER_ID,
		});

		expect(state.revokeDelivery).toHaveBeenCalledWith(TX_CLIENT, expect.objectContaining({ userId: USER_ID }), DOSSIER_ID, "Entregue por engano");
		expect(revalidatePath).toHaveBeenCalledWith(`/dossiers/${DOSSIER_ID}`);
	});

	it("does not call the query without a reason", async () => {
		await expect(revokeOrderAction({ dossierId: DOSSIER_ID, reason: "   " })).resolves.toEqual({ error: "Informe o motivo." });
		expect(state.revokeDelivery).not.toHaveBeenCalled();
	});

	it("maps invalid_state", async () => {
		state.revokeDelivery.mockResolvedValue({ ok: false, reason: "invalid_state" });

		await expect(revokeOrderAction({ dossierId: DOSSIER_ID, reason: "Erro" })).resolves.toEqual({
			error: "O pedido mudou de estado. Recarregue a página.",
		});
	});
});

describe("updateOrderContactAction", () => {
	it("changes the contact in a transaction, issues the new request and revalidates the page", async () => {
		await expect(updateOrderContactAction(contactChange)).resolves.toEqual({ error: null, id: DOSSIER_ID });

		expect(state.updateOrderContact).toHaveBeenCalledWith(TX_CLIENT, {
			dossierId: DOSSIER_ID,
			consultationId: CONSULTATION_ID,
			email: "Novo@Example.test",
			phoneE164: null,
		});
		expect(state.issueRequest).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }), REQUEST, { authorizedName: "Bureau" }, "https://app.example.test");
		expect(revalidatePath).toHaveBeenCalledWith(`/dossiers/${DOSSIER_ID}`);
	});

	it("accepts a resend with no contact and normalizes the phone", async () => {
		await updateOrderContactAction({ ...contactChange, contactEmail: "", contactPhone: "(11) 91234-5678" });

		expect(state.updateOrderContact.mock.calls[0][1]).toMatchObject({ email: null, phoneE164: "+5511912345678" });
	});

	it.each([
		["a bad dossier id", { ...contactChange, dossierId: "abc" }],
		["a bad e-mail", { ...contactChange, contactEmail: "sem-arroba" }],
	])("zod refuses %s before the database", async (_name, values) => {
		const result = await updateOrderContactAction(values);

		expect(result.error).toBeTruthy();
		expect(state.updateOrderContact).not.toHaveBeenCalled();
	});

	it("refuses an invalid phone without calling the database", async () => {
		await expect(updateOrderContactAction({ ...contactChange, contactPhone: "123" })).resolves.toEqual({
			error: "Celular inválido. Use DDD e número.",
		});
		expect(state.updateOrderContact).not.toHaveBeenCalled();
	});

	it.each([
		["invalid_state", "O pedido não aguarda mais a autorização ou não há contato novo para enviar. Recarregue a página."],
		["contact_limit_reached", "Esta autorização já teve 5 trocas ou reenvios nas últimas 24 horas. Tente novamente amanhã."],
		["not_found", "Pedido não encontrado."],
		["contact_is_buyer", "Informe o e-mail e o celular do titular, não os do comprador."],
		["too_many_requests", "Este titular já recebeu pedidos de autorização recentes. Tente novamente amanhã."],
		["resend_too_soon", "O pedido de autorização acabou de ser enviado. Aguarde 2 minutos para reenviar."],
		["invalid_input", "Contato inválido. Confira o e-mail e o celular."],
	])("maps %s and sends nothing", async (reason, message) => {
		state.updateOrderContact.mockResolvedValue({ ok: false, reason });

		await expect(updateOrderContactAction(contactChange)).resolves.toEqual({ error: message });
		expect(state.issueRequest).not.toHaveBeenCalled();
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("reports a failed immediate send; the tick retries because the contact is already saved", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.issueRequest.mockResolvedValue({ ok: false, reason: "invalid_recipient" });

		const result = await updateOrderContactAction(contactChange);

		expect(result.error).toContain("Contato atualizado");
		expect(result.id).toBe(DOSSIER_ID);
		expect(revalidatePath).toHaveBeenCalledWith(`/dossiers/${DOSSIER_ID}`);
		spy.mockRestore();
	});

	it("saves the contact but sends nothing while the order awaits payment", async () => {
		state.updateOrderContact.mockResolvedValue({ ok: true, request: null, deferred: true });

		await expect(updateOrderContactAction(contactChange)).resolves.toEqual({
			error: null,
			id: DOSSIER_ID,
			notice: "Contato atualizado. A autorização sai depois do pagamento.",
		});
		expect(state.issueRequest).not.toHaveBeenCalled();
		expect(revalidatePath).toHaveBeenCalledWith(`/dossiers/${DOSSIER_ID}`);
	});

	it("treats a superseded issue as success: a newer contact change sends the link", async () => {
		state.issueRequest.mockResolvedValue({ ok: false, reason: "superseded" });

		await expect(updateOrderContactAction(contactChange)).resolves.toEqual({ error: null, id: DOSSIER_ID });
	});

	it("does not issue when the authorization has no name or e-mail", async () => {
		state.updateOrderContact.mockResolvedValue({ ok: true, request: null, deferred: false });

		await expect(updateOrderContactAction(contactChange)).resolves.toEqual({ error: null, id: DOSSIER_ID });
		expect(state.issueRequest).not.toHaveBeenCalled();
	});

	it("turns an exception into the generic message without leaking the contact", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.updateOrderContact.mockRejectedValue(new Error("boom novo@example.test"));

		await expect(updateOrderContactAction(contactChange)).resolves.toEqual({ error: GENERIC });
		expect(JSON.stringify(spy.mock.calls)).not.toContain("novo@example.test");
		spy.mockRestore();
	});
});
