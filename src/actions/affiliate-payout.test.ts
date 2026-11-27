import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({ session: vi.fn(), setPayoutMethod: vi.fn(), affiliateEnabled: vi.fn() }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: s.session,
	SessionAccessError: class SessionAccessError extends Error {},
}));
vi.mock("@/lib/affiliates/enabled", () => ({ isAffiliateEnabled: s.affiliateEnabled }));
vi.mock("@/lib/affiliates/payout-settings", () => ({ setPayoutMethod: s.setPayoutMethod }));

import { setPayoutMethodAction } from "./affiliate-payout";

const client = { userId: randomUUID(), role: "client", bureauId: randomUUID(), supportSessionId: null, support: null };
const admin = { ...client, userId: randomUUID(), role: "bureau_admin" };
const superadmin = { userId: randomUUID(), role: "superadmin", bureauId: null, supportSessionId: null, support: null };

beforeEach(() => {
	vi.clearAllMocks();
	s.session.mockResolvedValue(client);
	s.affiliateEnabled.mockResolvedValue(true);
	s.setPayoutMethod.mockResolvedValue({ error: null });
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("setPayoutMethodAction", () => {
	it("saves the mode while the bureau has the affiliate section on", async () => {
		expect(await setPayoutMethodAction({ method: "pix" })).toEqual({ error: null, id: client.userId });
		expect(s.setPayoutMethod).toHaveBeenCalledOnce();
	});

	it.each([["client", client], ["bureau_admin", admin]])("refuses a %s while the section is off", async (_name, who) => {
		s.session.mockResolvedValue(who);
		s.affiliateEnabled.mockResolvedValue(false);

		const result = await setPayoutMethodAction({ method: "pix", profileId: randomUUID() });

		expect(result).toEqual({ error: "A afiliação não está disponível neste momento." });
		expect(s.setPayoutMethod).not.toHaveBeenCalled();
	});

	it("does not apply the bureau switch to the superadmin, who has no bureau in the session", async () => {
		s.session.mockResolvedValue(superadmin);
		s.affiliateEnabled.mockResolvedValue(false);

		expect((await setPayoutMethodAction({ method: "pix", profileId: randomUUID() })).error).toBeNull();
		expect(s.affiliateEnabled).not.toHaveBeenCalled();
	});
});
