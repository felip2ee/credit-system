import { beforeEach, describe, expect, it, vi } from "vitest";

const OWN_BUREAU = "00000000-0000-4000-8000-0000000000b1";
const OTHER_BUREAU = "00000000-0000-4000-8000-0000000000b2";

const state = vi.hoisted(() => ({
	sessionError: null as Error | null,
	role: "bureau_admin" as string,
	bureauId: "00000000-0000-4000-8000-0000000000b1" as string | null,
	supportSessionId: null as string | null,
	listPayableEntries: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
	SessionAccessError: class SessionAccessError extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	},
	getRequiredSession: vi.fn(async () => {
		if (state.sessionError) throw state.sessionError;
		return {
			userId: "u1",
			role: state.role,
			bureauId: state.bureauId,
			supportSessionId: state.supportSessionId,
		};
	}),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (
		_identity: unknown,
		work: (client: unknown) => unknown,
	) => work({}),
}));
vi.mock("@/lib/payables/queries", () => ({
	listPayableEntries: state.listPayableEntries,
}));

import { loadMorePayablesAction } from "./payables-ledger";

const NOT_ALLOWED = "Você não tem permissão para ver os lançamentos.";
const cursor =
	"2026-10-14T10:00:00.000000Z_00000000-0000-4000-8000-000000000001";

beforeEach(() => {
	vi.clearAllMocks();
	state.sessionError = null;
	state.role = "bureau_admin";
	state.bureauId = OWN_BUREAU;
	state.supportSessionId = null;
	state.listPayableEntries.mockResolvedValue({ rows: [], nextCursor: null });
});

describe("loadMorePayablesAction", () => {
	it("reads the session Bureau for a bureau_admin, ignoring the Bureau id in the input", async () => {
		const result = await loadMorePayablesAction({
			bureauId: OTHER_BUREAU,
			cursor,
		});

		expect(result.error).toBeNull();
		expect(state.listPayableEntries).toHaveBeenCalledWith({}, OWN_BUREAU, {
			cursor,
		});
	});

	it("lets the superadmin choose the Bureau", async () => {
		state.role = "superadmin";
		state.bureauId = null;

		const result = await loadMorePayablesAction({
			bureauId: OTHER_BUREAU,
			cursor,
		});

		expect(result.error).toBeNull();
		expect(state.listPayableEntries).toHaveBeenCalledWith({}, OTHER_BUREAU, {
			cursor,
		});
	});

	it("refuses a session in support, even a superadmin", async () => {
		state.role = "superadmin";
		state.supportSessionId = "00000000-0000-4000-8000-0000000000e1";

		const result = await loadMorePayablesAction({ bureauId: OTHER_BUREAU, cursor });

		expect(result.error).toBe("Encerre a sessão de suporte para ver os lançamentos.");
		expect(state.listPayableEntries).not.toHaveBeenCalled();
	});

	it("denies the operator, who has no payout:read", async () => {
		state.role = "operator";

		expect(
			(await loadMorePayablesAction({ bureauId: OWN_BUREAU, cursor })).error,
		).toBe(NOT_ALLOWED);
		expect(state.listPayableEntries).not.toHaveBeenCalled();
	});

	it("denies a non-superadmin session without a Bureau", async () => {
		state.bureauId = null;

		expect(
			(await loadMorePayablesAction({ bureauId: OWN_BUREAU, cursor })).error,
		).toBe(NOT_ALLOWED);
		expect(state.listPayableEntries).not.toHaveBeenCalled();
	});

	it("rejects invalid input", async () => {
		expect(
			(await loadMorePayablesAction({ bureauId: "x", cursor })).error,
		).toBe("Dados inválidos.");
	});
});
