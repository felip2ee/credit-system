import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ session: vi.fn(), setEnabled: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: s.session,
	SessionAccessError: class SessionAccessError extends Error {},
}));
vi.mock("@/lib/affiliates/enabled", () => ({ setAffiliateEnabled: s.setEnabled }));

import { setAffiliateEnabledAction } from "./affiliate-settings";

const identity = (role: string) => ({ userId: randomUUID(), role, bureauId: randomUUID(), supportSessionId: null, support: null });

beforeEach(() => {
	vi.clearAllMocks();
	s.setEnabled.mockResolvedValue({ error: null });
});

describe("setAffiliateEnabledAction", () => {
	it("turns the switch for the bureau_admin, taking the bureau from the session", async () => {
		const admin = identity("bureau_admin");
		s.session.mockResolvedValue(admin);

		expect(await setAffiliateEnabledAction({ enabled: true, bureauId: randomUUID() })).toEqual({ error: null });
		expect(s.setEnabled).toHaveBeenCalledWith(admin, { enabled: true });
	});

	it.each(["operator", "client"])("refuses a %s", async (role) => {
		s.session.mockResolvedValue(identity(role));

		expect((await setAffiliateEnabledAction({ enabled: true })).error).toMatch(/permissão/);
		expect(s.setEnabled).not.toHaveBeenCalled();
	});

	it("rejects a non-boolean value before reading the session", async () => {
		expect((await setAffiliateEnabledAction({ enabled: "true" })).error).toBeTruthy();
		expect(s.session).not.toHaveBeenCalled();
	});
});
