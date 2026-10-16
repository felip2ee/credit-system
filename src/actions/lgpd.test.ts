import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const HOLDER_ID = "00000000-0000-4000-8000-0000000000e1";
const PROFILE_ID = "00000000-0000-4000-8000-0000000000f1";
const REASON = "Pedido do titular por e-mail";

const state = vi.hoisted(() => ({
	role: "bureau_admin" as string,
	sessionError: null as Error | null,
	anonymizeHolder: vi.fn(),
	anonymizeClientAccount: vi.fn(),
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
		return { userId: USER_ID, role: state.role, bureauId: BUREAU_ID, supportSessionId: null };
	}),
}));
vi.mock("@/lib/lgpd/queries", () => ({
	anonymizeHolder: state.anonymizeHolder,
	anonymizeClientAccount: state.anonymizeClientAccount,
}));

import { revalidatePath } from "next/cache";

import { SessionAccessError } from "@/lib/auth/session";

import { anonymizeClientAccountAction, anonymizeHolderAction } from "./lgpd";

const NOT_ALLOWED = "Você não tem permissão para anonimizar dados.";

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "bureau_admin";
	state.sessionError = null;
	state.anonymizeHolder.mockResolvedValue({ ok: true });
	state.anonymizeClientAccount.mockResolvedValue({ ok: true });
});

describe("lgpd permission", () => {
	it("operator is refused", async () => {
		state.role = "operator";

		expect(await anonymizeHolderAction({ holderId: HOLDER_ID, reason: REASON })).toEqual({ error: NOT_ALLOWED });
		expect(await anonymizeClientAccountAction({ profileId: PROFILE_ID, reason: REASON })).toEqual({ error: NOT_ALLOWED });
		expect(state.anonymizeHolder).not.toHaveBeenCalled();
		expect(state.anonymizeClientAccount).not.toHaveBeenCalled();
	});

	it("an expired session is refused", async () => {
		state.sessionError = new SessionAccessError("session_required");

		expect(await anonymizeHolderAction({ holderId: HOLDER_ID, reason: REASON })).toEqual({ error: NOT_ALLOWED });
	});
});

describe("lgpd input", () => {
	it("reason shorter than 10 chars is refused", async () => {
		const result = await anonymizeHolderAction({ holderId: HOLDER_ID, reason: "curto" });

		expect(result.error).toBe("Informe o motivo com pelo menos 10 caracteres.");
		expect(state.anonymizeHolder).not.toHaveBeenCalled();
	});

	it("reason longer than 500 chars and a bad id are refused", async () => {
		expect((await anonymizeHolderAction({ holderId: HOLDER_ID, reason: "x".repeat(501) })).error).toBe(
			"O motivo aceita até 500 caracteres.",
		);
		expect((await anonymizeClientAccountAction({ profileId: "nao-uuid", reason: REASON })).error).toBe("Identificador inválido.");
	});
});

describe("anonymizeHolderAction", () => {
	it.each([
		["open_orders", "Há pedido em andamento para este titular. Conclua ou cancele antes de anonimizar."],
		["already_anonymized", "Já anonimizado."],
		["not_found", "Titular não encontrado."],
	])("%s maps to the pt-BR message", async (reason, message) => {
		state.anonymizeHolder.mockResolvedValue({ ok: false, reason });

		expect(await anonymizeHolderAction({ holderId: HOLDER_ID, reason: REASON })).toEqual({ error: message });
		expect(revalidatePath).not.toHaveBeenCalled();
	});

	it("success revalidates the holder page", async () => {
		expect(await anonymizeHolderAction({ holderId: HOLDER_ID, reason: REASON })).toEqual({ error: null });

		expect(state.anonymizeHolder).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }), { holderId: HOLDER_ID, reason: REASON });
		expect(revalidatePath).toHaveBeenCalledWith("/holders/[id]", "page");
		expect(revalidatePath).toHaveBeenCalledWith("/holders");
	});

	it("an unexpected error returns a generic message without its text", async () => {
		state.anonymizeHolder.mockRejectedValue(new Error("document 123.456.789-09 leaked"));
		const spy = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await anonymizeHolderAction({ holderId: HOLDER_ID, reason: REASON });

		expect(result).toEqual({ error: "Falha ao anonimizar o titular." });
		expect(JSON.stringify(spy.mock.calls)).not.toContain("123.456.789-09");
		spy.mockRestore();
	});
});

describe("anonymizeClientAccountAction", () => {
	it("balance maps to the pt-BR message", async () => {
		state.anonymizeClientAccount.mockResolvedValue({ ok: false, reason: "balance" });

		expect(await anonymizeClientAccountAction({ profileId: PROFILE_ID, reason: REASON })).toEqual({
			error: "A conta tem saldo. Devolva ou zere o saldo antes de anonimizar.",
		});
	});

	it("success revalidates the holder page", async () => {
		expect(await anonymizeClientAccountAction({ profileId: PROFILE_ID, reason: REASON })).toEqual({ error: null });

		expect(revalidatePath).toHaveBeenCalledWith("/holders/[id]", "page");
	});
});
