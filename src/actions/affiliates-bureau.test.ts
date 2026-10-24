import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const AFFILIATE_ID = "00000000-0000-4000-8000-0000000000a1";

const state = vi.hoisted(() => ({
	role: "bureau_admin" as string,
	supportSessionId: null as string | null,
	setBureauDefaultPct: vi.fn(),
	setAffiliatePct: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
	SessionAccessError: class SessionAccessError extends Error {},
	getRequiredSession: vi.fn(async () => ({
		userId: USER_ID,
		role: state.role,
		bureauId: state.role === "superadmin" ? null : BUREAU_ID,
		supportSessionId: state.supportSessionId,
	})),
}));
vi.mock("@/lib/affiliates/rates", () => ({
	setBureauDefaultPct: state.setBureauDefaultPct,
	setAffiliatePct: state.setAffiliatePct,
}));

import { setAffiliatePctAction, setDefaultPctAction } from "./affiliates-bureau";

const NOT_ALLOWED = "Você não tem permissão para gerenciar afiliados.";

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "bureau_admin";
	state.supportSessionId = null;
	state.setBureauDefaultPct.mockResolvedValue(undefined);
	state.setAffiliatePct.mockResolvedValue({ ok: true });
});

describe("setDefaultPctAction", () => {
	it("saves a valid % for the bureau admin", async () => {
		await expect(setDefaultPctAction({ pct: "5" })).resolves.toEqual({ error: null });
		expect(state.setBureauDefaultPct).toHaveBeenCalledWith(expect.objectContaining({ role: "bureau_admin" }), "5");
	});

	it.each(["101", "-1", "abc", "", "5.123"])("rejects pct %j before the query", async (pct) => {
		const result = await setDefaultPctAction({ pct });
		expect(result.error).toBeTruthy();
		expect(state.setBureauDefaultPct).not.toHaveBeenCalled();
	});

	it.each(["operator", "client", "superadmin"])("refuses %s", async (role) => {
		state.role = role;
		await expect(setDefaultPctAction({ pct: "5" })).resolves.toEqual({ error: NOT_ALLOWED });
		expect(state.setBureauDefaultPct).not.toHaveBeenCalled();
	});

	it("turns a database failure into a generic error", async () => {
		state.setBureauDefaultPct.mockRejectedValue(new Error("boom"));
		await expect(setDefaultPctAction({ pct: "5" })).resolves.toEqual({ error: "Não foi possível salvar a porcentagem." });
	});
});

describe("setAffiliatePctAction", () => {
	it("saves an own % and clears it with null", async () => {
		await expect(setAffiliatePctAction({ affiliateProfileId: AFFILIATE_ID, pct: "10" })).resolves.toEqual({ error: null });
		expect(state.setAffiliatePct).toHaveBeenCalledWith(expect.anything(), AFFILIATE_ID, "10");
		await expect(setAffiliatePctAction({ affiliateProfileId: AFFILIATE_ID, pct: null })).resolves.toEqual({ error: null });
		expect(state.setAffiliatePct).toHaveBeenLastCalledWith(expect.anything(), AFFILIATE_ID, null);
	});

	it("rejects pct 101 and a malformed id", async () => {
		expect((await setAffiliatePctAction({ affiliateProfileId: AFFILIATE_ID, pct: "101" })).error).toBeTruthy();
		expect((await setAffiliatePctAction({ affiliateProfileId: "x", pct: "5" })).error).toBeTruthy();
		expect(state.setAffiliatePct).not.toHaveBeenCalled();
	});

	it("reports an affiliate from another bureau as not found", async () => {
		state.setAffiliatePct.mockResolvedValue({ ok: false, reason: "not_found" });
		await expect(setAffiliatePctAction({ affiliateProfileId: AFFILIATE_ID, pct: "5" })).resolves.toEqual({
			error: "Afiliado não encontrado.",
		});
	});

	it("refuses a non-admin", async () => {
		state.role = "operator";
		await expect(setAffiliatePctAction({ affiliateProfileId: AFFILIATE_ID, pct: "5" })).resolves.toEqual({ error: NOT_ALLOWED });
	});
});
