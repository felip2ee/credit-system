import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({
	role: "superadmin" as string,
	supportSessionId: null as string | null,
	setBureauDefaultPct: vi.fn(),
	revalidatePath: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: state.revalidatePath }));
vi.mock("@/lib/auth/session", () => ({
	SessionAccessError: class SessionAccessError extends Error {},
	getRequiredSession: vi.fn(async () => ({
		userId: USER_ID,
		role: state.role,
		bureauId: state.role === "superadmin" ? null : BUREAU_ID,
		supportSessionId: state.supportSessionId,
	})),
}));
vi.mock("@/lib/affiliates/rates", () => ({ setBureauDefaultPct: state.setBureauDefaultPct }));

import { setBureauAffiliatePctAction } from "./affiliates-superadmin";

const NOT_ALLOWED = "Você não tem permissão para gerenciar afiliados.";

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "superadmin";
	state.supportSessionId = null;
	state.setBureauDefaultPct.mockResolvedValue({ ok: true });
});

describe("setBureauAffiliatePctAction", () => {
	it("saves a valid % for the superadmin and revalidates", async () => {
		await expect(setBureauAffiliatePctAction({ bureauId: BUREAU_ID, pct: "5" })).resolves.toEqual({ error: null, id: BUREAU_ID });
		expect(state.setBureauDefaultPct).toHaveBeenCalledWith(expect.objectContaining({ role: "superadmin" }), BUREAU_ID, "5");
		expect(state.revalidatePath).toHaveBeenCalledWith(`/superadmin/bureaus/${BUREAU_ID}`);
	});

	it.each(["101", "-1", "abc", "", "5.123"])("rejects pct %j before the query", async (pct) => {
		expect((await setBureauAffiliatePctAction({ bureauId: BUREAU_ID, pct })).error).toBeTruthy();
		expect(state.setBureauDefaultPct).not.toHaveBeenCalled();
	});

	it("rejects a malformed bureau id", async () => {
		expect((await setBureauAffiliatePctAction({ bureauId: "x", pct: "5" })).error).toBeTruthy();
		expect(state.setBureauDefaultPct).not.toHaveBeenCalled();
	});

	it.each(["bureau_admin", "operator", "client"])("refuses %s", async (role) => {
		state.role = role;
		await expect(setBureauAffiliatePctAction({ bureauId: BUREAU_ID, pct: "5" })).resolves.toEqual({ error: NOT_ALLOWED });
		expect(state.setBureauDefaultPct).not.toHaveBeenCalled();
	});

	it("refuses the superadmin inside a support session", async () => {
		state.supportSessionId = "00000000-0000-4000-8000-0000000000c1";
		expect((await setBureauAffiliatePctAction({ bureauId: BUREAU_ID, pct: "5" })).error).toMatch(/suporte/);
		expect(state.setBureauDefaultPct).not.toHaveBeenCalled();
	});

	it("maps split_over_100 and not_found to a message", async () => {
		state.setBureauDefaultPct.mockResolvedValueOnce({ ok: false, reason: "split_over_100" });
		expect((await setBureauAffiliatePctAction({ bureauId: BUREAU_ID, pct: "50" })).error).toMatch(/100%/);
		state.setBureauDefaultPct.mockResolvedValueOnce({ ok: false, reason: "not_found" });
		expect((await setBureauAffiliatePctAction({ bureauId: BUREAU_ID, pct: "50" })).error).toBe("Bureau não encontrado.");
		expect(state.revalidatePath).not.toHaveBeenCalled();
	});

	it("turns a database failure into a generic error", async () => {
		state.setBureauDefaultPct.mockRejectedValue(new Error("boom"));
		await expect(setBureauAffiliatePctAction({ bureauId: BUREAU_ID, pct: "5" })).resolves.toEqual({
			error: "Não foi possível salvar a porcentagem.",
		});
	});
});
