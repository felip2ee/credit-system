import { beforeEach, describe, expect, it, vi } from "vitest";

const HOLDER_ID = "00000000-0000-4000-8000-0000000000c1";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000d1";

const state = vi.hoisted(() => ({
	role: "bureau_admin" as string,
	permissions: ["credits:adjust"] as string[],
	sessionError: null as Error | null,
	adjust: vi.fn(),
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
		return { userId: "u1", role: state.role, bureauId: "b1", supportSessionId: null };
	}),
}));
vi.mock("@/lib/wallet/client-adjustment", () => ({ adjustClientBalance: state.adjust }));

import { revalidatePath } from "next/cache";

import { SessionAccessError } from "@/lib/auth/session";

import { adjustClientBalanceAction } from "./client-balance";

const valid = { holderId: HOLDER_ID, requestId: REQUEST_ID, direction: "credit", amount: "100.00", reason: "Correção de cobrança" };

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "bureau_admin";
	state.sessionError = null;
	state.adjust.mockResolvedValue({ ok: true, adjustmentId: "a1" });
});

describe("adjustClientBalanceAction", () => {
	it.each([
		["short reason", { ...valid, reason: "abc" }],
		["blank reason", { ...valid, reason: "     " }],
		["long reason", { ...valid, reason: "x".repeat(501) }],
		["zero amount", { ...valid, amount: "0.00" }],
		["negative amount", { ...valid, amount: "-1.00" }],
		["three decimals", { ...valid, amount: "1.001" }],
		["above the cap", { ...valid, amount: "100000000.00" }],
		["bad direction", { ...valid, direction: "transfer" }],
		["document in the reason", { ...valid, reason: "Cliente 12345678901 pediu" }],
		["formatted CPF in the reason", { ...valid, reason: "CPF 123.456.789-01 no pedido" }],
		["bad holder id", { ...valid, holderId: "nope" }],
		["missing request id", { ...valid, requestId: undefined }],
		["bad request id", { ...valid, requestId: "nope" }],
		["not an object", null],
	])("rejects %s before any session or query", async (_name, values) => {
		const result = await adjustClientBalanceAction(values);
		expect(result.error).toEqual(expect.any(String));
		expect(state.adjust).not.toHaveBeenCalled();
	});

	it("tells the user not to write a document in the reason", async () => {
		expect(await adjustClientBalanceAction({ ...valid, reason: "Cliente 12345678901 pediu" })).toEqual({
			error: "Não escreva CPF ou CNPJ no motivo.",
		});
	});

	it("denies a role without credits:adjust before the query", async () => {
		state.role = "operator";
		expect(await adjustClientBalanceAction(valid)).toEqual({ error: "Você não tem permissão para ajustar o saldo de clientes." });
		expect(state.adjust).not.toHaveBeenCalled();
	});

	it("denies an expired session", async () => {
		state.sessionError = new SessionAccessError("session_required");
		expect((await adjustClientBalanceAction(valid)).error).toContain("permissão");
		expect(state.adjust).not.toHaveBeenCalled();
	});

	it("adjusts as the session, passes parsed values and revalidates", async () => {
		expect(await adjustClientBalanceAction({ ...valid, reason: "  Correção de cobrança  " })).toEqual({ error: null });
		expect(state.adjust).toHaveBeenCalledWith(expect.objectContaining({ userId: "u1", role: "bureau_admin" }), {
			holderId: HOLDER_ID,
			requestId: REQUEST_ID,
			direction: "credit",
			amount: "100.00",
			reason: "Correção de cobrança",
		});
		expect(revalidatePath).toHaveBeenCalledWith(`/holders/${HOLDER_ID}`);
		expect(revalidatePath).toHaveBeenCalledWith("/settings/wallet");
	});

	it.each([
		["insufficient_bureau_funds", "Saldo do Bureau insuficiente"],
		["insufficient_client_funds", "Saldo disponível do cliente insuficiente"],
		["not_found", "Cliente não encontrado"],
		["request_conflict", "já foi usado"],
	])("maps %s to a pt-BR message and does not revalidate", async (reason, text) => {
		state.adjust.mockResolvedValue({ ok: false, reason });
		expect((await adjustClientBalanceAction(valid)).error).toContain(text);
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("tells the maximum when the debit exceeds what the Bureau credited", async () => {
		state.adjust.mockResolvedValue({ ok: false, reason: "exceeds_bureau_credit", maxDebit: "20.00" });
		const result = await adjustClientBalanceAction({ ...valid, direction: "debit" });
		expect(result.error).toContain("O Bureau só pode remover o que ele mesmo creditou a este cliente (máximo");
		expect(result.error).toContain("20,00");
	});

	it("falls back to a generic message for an unknown reason", async () => {
		state.adjust.mockResolvedValue({ ok: false, reason: "something_new" });
		expect((await adjustClientBalanceAction(valid)).error).toBe("Não foi possível ajustar o saldo. Tente novamente.");
	});

	it("hides a thrown error behind a generic message", async () => {
		state.adjust.mockRejectedValue(new Error("secret db detail"));
		const result = await adjustClientBalanceAction(valid);
		expect(result.error).toBe("Não foi possível ajustar o saldo. Tente novamente.");
	});
});
