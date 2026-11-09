import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const CHARGE_ID = "5f1c1d5e-3c34-4e55-9c3a-0d1b6a7c9e10";

const s = vi.hoisted(() => ({
	role: "client" as string,
	bureauId: "00000000-0000-4000-8000-0000000000b1" as string | null,
	sessionError: null as Error | null,
	view: vi.fn(),
	feeConfig: vi.fn(),
	pixFee: vi.fn(),
	nfseOn: vi.fn(),
	status: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
	SessionAccessError: class SessionAccessError extends Error {},
	getRequiredSession: vi.fn(async () => {
		if (s.sessionError) throw s.sessionError;
		return { userId: USER_ID, role: s.role, bureauId: s.bureauId, supportSessionId: null };
	}),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work({}),
}));
vi.mock("@/lib/config", () => ({ readCardFeeConfig: s.feeConfig, readPixFeeConfig: s.pixFee }));
vi.mock("@/lib/nfse/invoice", () => ({ isNfseConfigured: s.nfseOn }));
vi.mock("@/lib/payers/queries", () => ({ getOwnerPayerView: s.view }));
vi.mock("@/lib/wallet/pix-charges", () => ({ getChargeStatus: s.status }));

import { SessionAccessError } from "@/lib/auth/session";

import { getChargeStatusAction, getCheckoutContextAction } from "./checkout-context";

const NOT_ALLOWED = "Você não tem permissão para recarregar a carteira.";
const view = {
	name: "Ana",
	emailMasked: "a***@x.com",
	phoneMasked: null,
	documentMasked: "***.982.***-**",
	postalCodeMasked: null,
	hasAddressNumber: false,
	source: "payer_profile",
};

beforeEach(() => {
	vi.clearAllMocks();
	s.role = "client";
	s.bureauId = BUREAU_ID;
	s.sessionError = null;
	s.view.mockResolvedValue(view);
	s.feeConfig.mockReturnValue({ bands: [{ maxInstallments: 12, percent: 3.99, fixedCents: 49 }], minInstallmentCents: 500 });
	s.pixFee.mockReturnValue({ feeCents: 199 });
	s.nfseOn.mockReturnValue(false);
	s.status.mockResolvedValue({ status: "paid", billingType: "CREDIT_CARD" });
});

describe("getCheckoutContextAction", () => {
	it("returns masks, the missing fields per method, the card switch and the installment plans", async () => {
		const result = await getCheckoutContextAction({ scope: "client", amount: "100.00" });

		expect(result.error).toBeNull();
		expect(result.owner).toEqual(view);
		expect(result.missing).toEqual({ PIX: [], CREDIT_CARD: ["phone", "postalCode", "addressNumber"] });
		expect(result.cardEnabled).toBe(true);
		expect(result.installmentOptions).toHaveLength(12);
		expect(result.installmentOptions?.[0]).toEqual({ installments: 1, totalCents: 10467, installmentCents: 10467 });
	});

	it("returns the Pix summary (recharge + fee = total) for the typed amount", async () => {
		const result = await getCheckoutContextAction({ scope: "client", amount: "100.00" });
		const noAmount = await getCheckoutContextAction({ scope: "client", amount: "abc" });

		expect(result).toMatchObject({ pixEnabled: true, pixCharge: { rechargeCents: 10000, feeCents: 199, totalCents: 10199 } });
		expect(noAmount).toMatchObject({ pixEnabled: true, pixCharge: null });
	});

	it("turns Pix off when the fee config is invalid", async () => {
		s.pixFee.mockImplementationOnce(() => {
			throw new Error("PIX_FEE_CENTS must be a non-negative integer");
		});
		vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await getCheckoutContextAction({ scope: "client", amount: "100.00" });

		expect(result).toMatchObject({ pixEnabled: false, pixCharge: null });
	});

	it("asks for the address in Pix when the NFS-e is on", async () => {
		s.nfseOn.mockReturnValue(true);

		const result = await getCheckoutContextAction({ scope: "client", amount: "100.00" });

		expect(result.missing?.PIX).toEqual(["postalCode", "addressNumber"]);
	});

	it("hides the card with an empty or invalid fee table, and has no plans for an invalid amount", async () => {
		s.feeConfig.mockReturnValueOnce(null);
		const off = await getCheckoutContextAction({ scope: "client", amount: "100.00" });
		const noAmount = await getCheckoutContextAction({ scope: "client", amount: "abc" });

		expect(off).toMatchObject({ cardEnabled: false, installmentOptions: [] });
		expect(noAmount).toMatchObject({ cardEnabled: true, installmentOptions: [] });
	});

	it.each([
		["client", "bureau"],
		["operator", "bureau"],
		["bureau_admin", "client"],
		["superadmin", "bureau"],
	])("denies role %s on scope %s", async (role, scope) => {
		s.role = role;

		expect(await getCheckoutContextAction({ scope, amount: "100.00" })).toEqual({ error: NOT_ALLOWED });
		expect(s.view).not.toHaveBeenCalled();
	});

	it("allows the Bureau admin on the Bureau scope with the Bureau identity", async () => {
		s.role = "bureau_admin";

		const result = await getCheckoutContextAction({ scope: "bureau", amount: "100.00" });

		expect(result.error).toBeNull();
		expect(s.view).toHaveBeenCalledWith({}, expect.objectContaining({ role: "bureau_admin" }), { kind: "bureau", bureauId: BUREAU_ID });
	});

	it("rejects a malformed body and a missing session", async () => {
		expect((await getCheckoutContextAction({ scope: "all", amount: "1" })).error).toBe("Dados inválidos.");
		s.sessionError = new SessionAccessError("session_required");
		expect(await getCheckoutContextAction({ scope: "client", amount: "100.00" })).toEqual({ error: NOT_ALLOWED });
	});

	it("returns a safe message when the read fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		s.view.mockRejectedValue(new Error("db down at 52998224725"));

		const result = await getCheckoutContextAction({ scope: "client", amount: "100.00" });

		expect(result.error).toMatch(/Não foi possível/);
		expect(JSON.stringify(result)).not.toContain("52998224725");
	});
});

describe("getChargeStatusAction", () => {
	it("asks for the status inside the scope of the requester only", async () => {
		const asClient = await getChargeStatusAction(CHARGE_ID);
		s.role = "bureau_admin";
		const asBureau = await getChargeStatusAction(CHARGE_ID);

		expect(asClient).toEqual({ error: null, status: "paid" });
		expect(asBureau).toEqual({ error: null, status: "paid" });
		expect(s.status).toHaveBeenNthCalledWith(1, {}, CHARGE_ID, { kind: "client", clientProfileId: USER_ID });
		expect(s.status).toHaveBeenNthCalledWith(2, {}, CHARGE_ID, { kind: "bureau", bureauId: BUREAU_ID });
	});

	it("reports not found for a charge outside the scope, and rejects a non-uuid id", async () => {
		s.status.mockResolvedValue(null);

		expect(await getChargeStatusAction(CHARGE_ID)).toEqual({ error: "Cobrança não encontrada." });
		expect(await getChargeStatusAction("1; drop table")).toEqual({ error: "Cobrança não encontrada." });
	});

	it("denies roles without the top-up permission", async () => {
		s.role = "operator";

		expect(await getChargeStatusAction(CHARGE_ID)).toEqual({ error: NOT_ALLOWED });
		expect(s.status).not.toHaveBeenCalled();
	});
});
