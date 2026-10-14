import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({
	role: "bureau_admin" as string,
	sessionError: null as Error | null,
	adapterCreate: vi.fn(),
	insertCharge: vi.fn(),
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
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work({}),
}));
vi.mock("@/lib/asaas", () => ({ getAsaasClient: () => ({ createPixCharge: state.adapterCreate }) }));
vi.mock("@/lib/wallet/pix-charges", () => ({ createPixCharge: state.insertCharge }));

import { revalidatePath } from "next/cache";

import { SessionAccessError } from "@/lib/auth/session";

import { requestTopupAction } from "./wallet-topup";

const NOT_ALLOWED = "Você não tem permissão para recarregar a carteira.";

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "bureau_admin";
	state.sessionError = null;
	state.adapterCreate.mockResolvedValue({
		asaasPaymentId: "pay_secret_id",
		pixPayload: "000201pix",
		qrImageBase64: "QUJD",
	});
	state.insertCharge.mockResolvedValue({ ok: true, id: "charge-1", expiresAt: new Date("2030-01-01T00:30:00Z") });
});

describe("requestTopupAction", () => {
	it("creates the charge for a bureau_admin and returns what the QR needs, not the Asaas id", async () => {
		const result = await requestTopupAction({ amount: "100.00" });

		expect(result).toEqual({
			error: null,
			id: "charge-1",
			pixPayload: "000201pix",
			qrImageBase64: "QUJD",
			expiresAt: "2030-01-01T00:30:00.000Z",
		});
		expect(JSON.stringify(result)).not.toContain("pay_secret_id");
		const [adapterInput] = state.adapterCreate.mock.calls[0];
		expect(adapterInput).toMatchObject({ amount: "100.00" });
		expect(adapterInput.externalReference).toMatch(/^[0-9a-f-]{36}$/);
		expect(state.insertCharge).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ userId: USER_ID, role: "bureau_admin", bureauId: BUREAU_ID }),
			{ asaasPaymentId: "pay_secret_id", pixPayload: "000201pix", amount: "100.00" },
		);
		expect(revalidatePath).toHaveBeenCalledWith("/settings/wallet");
	});

	it.each(["operator", "client", "superadmin"])("denies %s before calling Asaas", async (role) => {
		state.role = role;

		expect((await requestTopupAction({ amount: "100.00" })).error).toBe(NOT_ALLOWED);
		expect(state.adapterCreate).not.toHaveBeenCalled();
		expect(state.insertCharge).not.toHaveBeenCalled();
	});

	it("maps an invalid session to no permission", async () => {
		state.sessionError = new SessionAccessError("session_required");

		expect((await requestTopupAction({ amount: "100.00" })).error).toBe(NOT_ALLOWED);
	});

	it.each(["9.99", "5000.01", "10.005", "abc", "", "-10.00"])("rejects amount %j", async (amount) => {
		const result = await requestTopupAction({ amount });

		expect(result.error).toBeTruthy();
		expect(state.adapterCreate).not.toHaveBeenCalled();
	});

	it.each(["10.00", "5000.00"])("accepts the boundary amount %s", async (amount) => {
		expect((await requestTopupAction({ amount })).error).toBeNull();
	});

	it("saves no charge when the adapter fails", async () => {
		state.adapterCreate.mockRejectedValue(new Error("Asaas respondeu 500"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await requestTopupAction({ amount: "100.00" });

		expect(result.error).toBe("Não foi possível gerar o PIX. Tente novamente.");
		expect(state.insertCharge).not.toHaveBeenCalled();
	});

	it("reports an error when the charge cannot be saved", async () => {
		state.insertCharge.mockRejectedValue(new Error("db down"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect((await requestTopupAction({ amount: "100.00" })).error).toBe(
			"Não foi possível gerar o PIX. Tente novamente.",
		);
	});
});
