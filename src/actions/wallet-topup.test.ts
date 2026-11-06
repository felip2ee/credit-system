import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const KEY = "5f1c1d5e-3c34-4e55-9c3a-0d1b6a7c9e10";

const state = vi.hoisted(() => ({
	role: "bureau_admin" as string,
	bureauId: "00000000-0000-4000-8000-0000000000b1" as string | null,
	sessionError: null as Error | null,
	ip: "203.0.113.7" as string | null,
	runCheckout: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/account/request-meta", () => ({
	requestMeta: () => ({ ip: state.ip, userAgent: null }),
}));
vi.mock("@/lib/auth/session", () => ({
	SessionAccessError: class SessionAccessError extends Error {
		constructor(readonly code: string) {
			super(code);
		}
	},
	getRequiredSession: vi.fn(async () => {
		if (state.sessionError) throw state.sessionError;
		return { userId: USER_ID, role: state.role, bureauId: state.bureauId, supportSessionId: null };
	}),
}));
vi.mock("@/lib/payments/checkout", () => ({ runCheckout: state.runCheckout }));

import { SessionAccessError } from "@/lib/auth/session";

import { requestTopupAction } from "./wallet-topup";

const NOT_ALLOWED = "Você não tem permissão para recarregar a carteira.";
const pix = { amount: "100.00", method: "PIX", payerKind: "owner", idempotencyKey: KEY };
const card = {
	amount: "100.00",
	method: "CREDIT_CARD",
	payerKind: "owner",
	idempotencyKey: KEY,
	installments: 3,
	card: { number: "4242 4242 4242 4242", holderName: "Ana Souza", expiryMonth: "12", expiryYear: "2099", cvv: "123" },
};

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "bureau_admin";
	state.bureauId = BUREAU_ID;
	state.sessionError = null;
	state.ip = "203.0.113.7";
	state.runCheckout.mockResolvedValue({ error: null, id: "c1", method: "PIX", pixPayload: "000201pix", qrImageBase64: "QUJD", expiresAt: "2030-01-01T00:00:00.000Z" });
});

describe("requestTopupAction", () => {
	it.each([
		["amount below the minimum", { ...pix, amount: "9.99" }],
		["missing idempotency key", { ...pix, idempotencyKey: "x" }],
		["card method without card data", { ...pix, method: "CREDIT_CARD" }],
		["other payer without the declaration", { ...pix, payerKind: "other" }],
		["a Pix with installments", { ...pix, installments: 3 }],
	])("rejects %s before the session", async (_name, body) => {
		const result = await requestTopupAction(body);

		expect(result.error).toEqual(expect.any(String));
		expect(state.runCheckout).not.toHaveBeenCalled();
	});

	it("denies a session error and roles without wallet:topup", async () => {
		state.sessionError = new SessionAccessError("session_required");
		expect(await requestTopupAction(pix)).toEqual({ error: NOT_ALLOWED });
		state.sessionError = null;
		for (const role of ["operator", "client", "superadmin"]) {
			state.role = role;
			expect(await requestTopupAction(pix)).toEqual({ error: NOT_ALLOWED });
		}
		expect(state.runCheckout).not.toHaveBeenCalled();
	});

	it("denies a session without Bureau", async () => {
		state.bureauId = null;

		expect(await requestTopupAction(pix)).toEqual({ error: NOT_ALLOWED });
	});

	it("hands the Bureau scope, the parsed input and the device IP to runCheckout", async () => {
		const result = await requestTopupAction(pix);

		expect(result).toMatchObject({ error: null, id: "c1" });
		expect(state.runCheckout).toHaveBeenCalledWith(
			expect.objectContaining({ userId: USER_ID }),
			{ kind: "bureau", bureauId: BUREAU_ID },
			expect.objectContaining({ method: "PIX", idempotencyKey: KEY }),
			{ remoteIp: "203.0.113.7", description: "Recarga de carteira" },
		);
	});

	it("never forwards a client-sent total", async () => {
		await requestTopupAction({ ...card, total: "1.00", totalCents: 100, feeAmount: "0.00" });

		const input = state.runCheckout.mock.calls[0][2];
		expect(input).not.toHaveProperty("total");
		expect(input).not.toHaveProperty("totalCents");
		expect(input).not.toHaveProperty("feeAmount");
		expect(input.card.number).toBe("4242424242424242");
	});

	it("refuses a card charge when the request has no valid device IP, and still allows Pix", async () => {
		state.ip = null;

		const refused = await requestTopupAction(card);
		const allowed = await requestTopupAction(pix);

		expect(refused.error).toMatch(/conexão/);
		expect(allowed.error).toBeNull();
		expect(state.runCheckout).toHaveBeenCalledTimes(1);
	});
});
