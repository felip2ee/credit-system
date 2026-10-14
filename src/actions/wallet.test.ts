import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const KEY = "00000000-0000-4000-8000-0000000000a1";

const state = vi.hoisted(() => ({
	role: "superadmin" as string,
	supportSessionId: null as string | null,
	sessionError: null as Error | null,
	adjustWalletWithAudit: vi.fn(),
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
vi.mock("@/lib/wallet/queries", () => ({
	adjustWalletWithAudit: state.adjustWalletWithAudit,
}));

import { revalidatePath } from "next/cache";

import { SessionAccessError } from "@/lib/auth/session";

import { adjustWalletAction } from "./wallet";

const NOT_ALLOWED = "Você não tem permissão para ajustar a carteira.";
const form = {
	bureauId: BUREAU_ID,
	amount: "-12.50",
	reason: "Estorno de consulta",
	idempotencyKey: KEY,
};

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "superadmin";
	state.supportSessionId = null;
	state.sessionError = null;
	state.adjustWalletWithAudit.mockResolvedValue({
		ok: true,
		entryId: "e1",
		available: "87.50",
		reserved: "0.00",
		replayed: false,
	});
});

describe("adjustWalletAction permission", () => {
	it("denies bureau_admin, operator and client", async () => {
		for (const role of ["bureau_admin", "operator", "client"]) {
			state.role = role;
			expect((await adjustWalletAction(form)).error).toBe(NOT_ALLOWED);
		}
		expect(state.adjustWalletWithAudit).not.toHaveBeenCalled();
	});

	it("denies a superadmin in a support session", async () => {
		state.supportSessionId = "00000000-0000-4000-8000-0000000000d1";
		expect((await adjustWalletAction(form)).error).toBeTruthy();
		expect(state.adjustWalletWithAudit).not.toHaveBeenCalled();
	});

	it("maps an invalid session to no permission", async () => {
		state.sessionError = new SessionAccessError("session_required");
		expect((await adjustWalletAction(form)).error).toBe(NOT_ALLOWED);
	});
});

describe("adjustWalletAction validation", () => {
	it("rejects zero, more than 2 decimals, out-of-range amounts, a blank reason and a bad bureauId", async () => {
		for (const amount of [
			"0",
			"0.00",
			"-0",
			"1.234",
			"-1.234",
			"abc",
			"100000000.00",
			"+5.00",
			"1,50",
			"",
		]) {
			expect(
				(await adjustWalletAction({ ...form, amount })).error,
				amount,
			).toBeTruthy();
		}
		expect(
			(await adjustWalletAction({ ...form, reason: "   " })).error,
		).toBeTruthy();
		expect(
			(await adjustWalletAction({ ...form, reason: "x".repeat(501) })).error,
		).toBeTruthy();
		expect(
			(await adjustWalletAction({ ...form, bureauId: "abc" })).error,
		).toBeTruthy();
		expect(
			(await adjustWalletAction({ ...form, idempotencyKey: "abc" })).error,
		).toBeTruthy();
		expect(state.adjustWalletWithAudit).not.toHaveBeenCalled();
	});

	it("accepts signed amounts with up to 2 decimals", async () => {
		for (const amount of [
			"10",
			"10.5",
			"-10.55",
			"99999999.99",
			"-99999999.99",
		]) {
			expect(
				(await adjustWalletAction({ ...form, amount })).error,
				amount,
			).toBeNull();
		}
	});
});

describe("adjustWalletAction", () => {
	it("adjusts the target bureau as the superadmin and revalidates", async () => {
		const result = await adjustWalletAction({
			...form,
			reason: "  Estorno de consulta  ",
		});

		expect(result).toEqual({ error: null, id: "e1" });
		expect(state.adjustWalletWithAudit).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER_ID, role: "superadmin" }),
			{
				bureauId: BUREAU_ID,
				amount: "-12.50",
				reason: "Estorno de consulta",
				idempotencyKey: KEY,
			},
		);
		expect(revalidatePath).toHaveBeenCalledWith(
			`/superadmin/bureaus/${BUREAU_ID}`,
		);
	});

	it("returns a message for each business failure", async () => {
		for (const reason of [
			"insufficient_balance",
			"idempotency_conflict",
			"not_found",
			"invalid_amount",
		]) {
			state.adjustWalletWithAudit.mockResolvedValueOnce({ ok: false, reason });
			const result = await adjustWalletAction(form);
			expect(result.error, reason).toBeTruthy();
		}
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("returns a generic error when the query throws", async () => {
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});
		state.adjustWalletWithAudit.mockRejectedValueOnce(new Error("db down"));
		expect((await adjustWalletAction(form)).error).toBe(
			"Falha ao ajustar a carteira.",
		);
		spy.mockRestore();
	});
});
