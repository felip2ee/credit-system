import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const DOSSIER_ID = "00000000-0000-4000-8000-0000000000d1";
const PAYMENT_ID = "00000000-0000-4000-8000-0000000000a1";

const state = vi.hoisted(() => ({
	role: "operator" as string,
	supportSessionId: null as string | null,
	sessionError: null as Error | null,
	registerCounterPayment: vi.fn(),
	voidCounterPayment: vi.fn(),
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
vi.mock("@/lib/counter-payments/queries", () => ({
	registerCounterPayment: state.registerCounterPayment,
	voidCounterPayment: state.voidCounterPayment,
}));

import { revalidatePath } from "next/cache";

import { SessionAccessError } from "@/lib/auth/session";

import { registerCounterPaymentAction, voidCounterPaymentAction } from "./counter-payments";

const NOT_ALLOWED = "Você não tem permissão para registrar pagamentos de balcão.";
const AMOUNT_INVALID = "Informe um valor entre 0,01 e 99.999.999,99, com até 2 casas decimais.";
const form = {
	dossierId: DOSSIER_ID,
	method: "cash",
	amount: "25.50",
	note: "recibo 12",
	receivedAt: "2026-10-14",
};
const voidForm = { id: PAYMENT_ID, reason: "Valor digitado errado" };

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "operator";
	state.supportSessionId = null;
	state.sessionError = null;
	state.registerCounterPayment.mockResolvedValue({ ok: true, id: PAYMENT_ID });
	state.voidCounterPayment.mockResolvedValue({ ok: true });
});

describe("counter payment permission", () => {
	it("allows operator and bureau_admin", async () => {
		for (const role of ["operator", "bureau_admin"]) {
			state.role = role;
			expect(await registerCounterPaymentAction(form)).toEqual({ error: null, id: PAYMENT_ID });
			expect((await voidCounterPaymentAction(voidForm)).error).toBeNull();
		}
	});

	it("refuses a superadmin in support with a clear message before touching the database", async () => {
		state.role = "superadmin";
		state.supportSessionId = "00000000-0000-4000-8000-0000000000e1";
		const message = "Encerre a sessão de suporte para registrar pagamentos de balcão.";

		expect((await registerCounterPaymentAction(form)).error).toBe(message);
		expect((await voidCounterPaymentAction(voidForm)).error).toBe(message);
		expect(state.registerCounterPayment).not.toHaveBeenCalled();
		expect(state.voidCounterPayment).not.toHaveBeenCalled();
	});

	it("denies client and a superadmin outside support", async () => {
		for (const role of ["client", "superadmin"]) {
			state.role = role;
			expect((await registerCounterPaymentAction(form)).error).toBe(NOT_ALLOWED);
			expect((await voidCounterPaymentAction(voidForm)).error).toBe(NOT_ALLOWED);
		}
		expect(state.registerCounterPayment).not.toHaveBeenCalled();
		expect(state.voidCounterPayment).not.toHaveBeenCalled();
	});

	it("maps an invalid session to no permission", async () => {
		state.sessionError = new SessionAccessError("session_required");
		expect((await registerCounterPaymentAction(form)).error).toBe(NOT_ALLOWED);
	});
});

describe("registerCounterPaymentAction validation", () => {
	it.each([
		["zero amount", { amount: "0" }, AMOUNT_INVALID],
		["zero with decimals", { amount: "0.00" }, AMOUNT_INVALID],
		["3 decimal places", { amount: "10.005" }, AMOUNT_INVALID],
		["negative amount", { amount: "-5.00" }, AMOUNT_INVALID],
		["method outside the enum", { method: "boleto" }, "Forma de pagamento inválida."],
		["invalid dossierId", { dossierId: "abc" }, "Dossiê inválido."],
		["note above 500 characters", { note: "x".repeat(501) }, "Observação com no máximo 500 caracteres."],
		["invalid date", { receivedAt: "ontem" }, "Data de recebimento inválida."],
		["null date (would become 1970)", { receivedAt: null }, "Data de recebimento inválida."],
		["numeric date", { receivedAt: 0 }, "Data de recebimento inválida."],
		["empty date", { receivedAt: "" }, "Data de recebimento inválida."],
		["a date-time instead of a date", { receivedAt: "2026-10-14T12:00:00Z" }, "Data de recebimento inválida."],
		["an impossible calendar date", { receivedAt: "2026-02-30" }, "Data de recebimento inválida."],
		["a date before 2000", { receivedAt: "1999-12-31" }, "Data de recebimento inválida."],
		["a future date", { receivedAt: "2999-01-01" }, "A data de recebimento não pode ser futura."],
	])("rejects %s", async (_name, patch, message) => {
		expect((await registerCounterPaymentAction({ ...form, ...patch })).error).toBe(message);
		expect(state.registerCounterPayment).not.toHaveBeenCalled();
	});

	it("passes parsed values and revalidates the list", async () => {
		await registerCounterPaymentAction({ ...form, note: "  " });
		expect(state.registerCounterPayment).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER_ID, role: "operator", bureauId: BUREAU_ID }),
			{ dossierId: DOSSIER_ID, method: "cash", amount: "25.50", note: null, receivedAt: new Date("2026-10-14"), idempotencyKey: null },
		);
		expect(revalidatePath).toHaveBeenCalledWith("/settings/counter-payments");
	});

	it("passes the idempotency key to the query and refuses a key that is not a uuid", async () => {
		const key = "3f1f3a52-6a4f-4d6b-9a55-2b3d6a1c9e10";
		await registerCounterPaymentAction({ ...form, idempotencyKey: key });
		expect(state.registerCounterPayment).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ idempotencyKey: key }),
		);
		expect((await registerCounterPaymentAction({ ...form, idempotencyKey: "abc" })).error).toBe("Chave de envio inválida.");
	});

	it("maps an idempotency conflict to a message", async () => {
		state.registerCounterPayment.mockResolvedValue({ ok: false, reason: "idempotency_conflict" });
		expect((await registerCounterPaymentAction(form)).error).toMatch(/Este pagamento já foi registrado com outros dados/);
	});

	it("maps a failure to a message without revalidating", async () => {
		state.registerCounterPayment.mockResolvedValue({ ok: false, reason: "not_found" });
		expect((await registerCounterPaymentAction(form)).error).toBe("Dossiê não encontrado.");
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("refuses an online order with a clear message and revalidates nothing", async () => {
		state.registerCounterPayment.mockResolvedValue({ ok: false, reason: "online_order" });
		expect(await registerCounterPaymentAction(form)).toEqual({
			error: "Este pedido é pago online pelo cliente; não aceita pagamento de balcão.",
		});
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it.each([
		["order_not_payable", "Este pedido não aguarda pagamento (já foi pago, por exemplo por link, ou foi cancelado)."],
		["amount_exceeds_due", "O valor é maior que o saldo a pagar deste pedido."],
	])("maps %s to a pt-BR message", async (reason, message) => {
		state.registerCounterPayment.mockResolvedValue({ ok: false, reason });
		expect((await registerCounterPaymentAction(form)).error).toBe(message);
	});

	it("maps an unknown or missing failure reason to a generic error, never undefined", async () => {
		for (const reason of ["invalid_state", "surprise", undefined]) {
			state.registerCounterPayment.mockResolvedValue({ ok: false, reason });
			state.voidCounterPayment.mockResolvedValue({ ok: false, reason });
			expect((await registerCounterPaymentAction(form)).error).toBe("Não foi possível concluir a operação.");
			expect((await voidCounterPaymentAction(voidForm)).error).toBe("Não foi possível concluir a operação.");
		}
	});

	it("returns a generic error when the query throws", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		state.registerCounterPayment.mockRejectedValue(new Error("db down"));
		expect((await registerCounterPaymentAction(form)).error).toBe("Falha ao registrar o pagamento.");
	});
});

describe("voidCounterPaymentAction", () => {
	it("requires a reason and a valid id", async () => {
		expect((await voidCounterPaymentAction({ ...voidForm, reason: "   " })).error).toBe("Informe o motivo da anulação.");
		expect((await voidCounterPaymentAction({ ...voidForm, id: "abc" })).error).toBe("Pagamento inválido.");
		expect(state.voidCounterPayment).not.toHaveBeenCalled();
	});

	it("revalidates on success and maps repeated voids", async () => {
		expect(await voidCounterPaymentAction(voidForm)).toEqual({ error: null, id: PAYMENT_ID });
		expect(state.voidCounterPayment).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }), voidForm);
		expect(revalidatePath).toHaveBeenCalledWith("/settings/counter-payments");

		vi.clearAllMocks();
		state.voidCounterPayment.mockResolvedValue({ ok: false, reason: "already_voided" });
		expect((await voidCounterPaymentAction(voidForm)).error).toBe("Este pagamento já foi anulado.");
		expect(revalidatePath).not.toHaveBeenCalled();
	});
});
