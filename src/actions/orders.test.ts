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
} from "./orders";

const NOT_ALLOWED = "Ação não permitida.";
const SUPPORT = "Encerre a sessão de suporte para operar pedidos.";
const GENERIC = "Não foi possível concluir. Tente novamente.";
const QUOTE = { ok: true, lines: [], totalCostCents: 1000, totalPriceCents: 3000 };
const counterOrder = {
	productCode: "consulta_pf",
	withAi: true,
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
});

describe("staff gate", () => {
	const actions: [string, () => Promise<{ error: string | null }>][] = [
		["openCounterOrderAction", () => openCounterOrderAction(counterOrder)],
		["runOrderNowAction", () => runOrderNowAction(DOSSIER_ID)],
		["cancelOrderAction", () => cancelOrderAction(DOSSIER_ID)],
		["releaseOrderAction", () => releaseOrderAction(DOSSIER_ID)],
		["revokeOrderAction", () => revokeOrderAction({ dossierId: DOSSIER_ID, reason: "Erro" })],
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

		for (const fn of [state.quoteOrder, state.placeOrder, state.cancelOrder, state.releaseDelivery, state.revokeDelivery, state.runOrderNow]) {
			expect(fn).not.toHaveBeenCalled();
		}
	});
});

describe("openCounterOrderAction", () => {
	it("quotes with the AI flag, places the order and revalidates the list", async () => {
		const result = await openCounterOrderAction(counterOrder);

		expect(result).toEqual({ error: null, id: DOSSIER_ID });
		expect(state.quoteOrder).toHaveBeenCalledWith(expect.objectContaining({ role: "operator" }), "consulta_pf", { withAi: true });
		const [identity, input, quote] = state.placeOrder.mock.calls[0];
		expect(identity).toMatchObject({ userId: USER_ID });
		expect(input).toMatchObject({
			productCode: "consulta_pf",
			withAi: true,
			self: false,
			buyerProfileId: BUYER_ID,
			subject: { type: "PF", name: "Maria Souza", documentDigits: "39053344705" },
			contact: { email: "maria@example.test", phoneE164: "+5511912345678" },
		});
		expect(quote).toBe(QUOTE);
		expect(revalidatePath).toHaveBeenCalledWith("/dossiers");
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

	it("keeps a missing phone as null", async () => {
		await openCounterOrderAction({ ...counterOrder, contactPhone: "" });

		expect(state.placeOrder.mock.calls[0][1].contact.phoneE164).toBeNull();
	});

	it.each([
		["product_not_for_sale", "Produto indisponível neste Bureau."],
		["addon_not_for_sale", "Parecer IA indisponível para este produto."],
	])("maps the quote failure %s", async (reason, message) => {
		state.quoteOrder.mockResolvedValue({ ok: false, reason });

		await expect(openCounterOrderAction(counterOrder)).resolves.toEqual({ error: message });
		expect(state.placeOrder).not.toHaveBeenCalled();
	});

	it.each([
		["insufficient_balance", "Saldo do Bureau insuficiente para reservar o custo. Recarregue a carteira."],
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
