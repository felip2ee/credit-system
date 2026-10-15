import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-000000000001";

const state = vi.hoisted(() => ({
	role: "client" as string,
	sessionError: null as Error | null,
	adapterCreate: vi.fn(),
	insertCharge: vi.fn(),
	countPending: vi.fn(),
	lock: vi.fn(),
	getClientWallet: vi.fn(),
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
			bureauId: BUREAU_ID,
			supportSessionId: null,
		};
	}),
}));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (
		_identity: unknown,
		work: (client: unknown) => unknown,
	) => work({}),
}));
vi.mock("@/lib/asaas", () => ({
	getAsaasClient: () => ({ createPixCharge: state.adapterCreate }),
}));
vi.mock("@/lib/wallet/pix-charges", () => ({
	createClientPixCharge: state.insertCharge,
	countPendingClientPixCharges: state.countPending,
	lockClientPixCharges: state.lock,
	MAX_PENDING_PIX_CHARGES: 10,
}));
vi.mock("@/lib/wallet/client-queries", () => ({
	getClientWallet: state.getClientWallet,
}));

import { revalidatePath } from "next/cache";

import { SessionAccessError } from "@/lib/auth/session";

import { requestClientTopupAction } from "./credits-topup";

const NOT_ALLOWED = "Você não tem permissão para recarregar a carteira.";
const FAILED = "Não foi possível gerar o PIX. Tente novamente.";

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "client";
	state.sessionError = null;
	state.adapterCreate.mockResolvedValue({
		asaasPaymentId: "pay_secret_id",
		pixPayload: "000201pix",
		qrImageBase64: "QUJD",
	});
	state.getClientWallet.mockResolvedValue({
		available: "0.00",
		reserved: "0.00",
	});
	state.countPending.mockResolvedValue(0);
	state.insertCharge.mockResolvedValue({
		ok: true,
		id: "charge-1",
		expiresAt: new Date("2030-01-01T00:30:00Z"),
	});
});

describe("requestClientTopupAction", () => {
	it("creates the charge for a client and returns what the QR needs, not the Asaas id", async () => {
		const result = await requestClientTopupAction({ amount: "100.00" });

		expect(result).toEqual({
			error: null,
			id: "charge-1",
			pixPayload: "000201pix",
			qrImageBase64: "QUJD",
			expiresAt: "2030-01-01T00:30:00.000Z",
		});
		expect(JSON.stringify(result)).not.toContain("pay_secret_id");
		expect(state.getClientWallet).toHaveBeenCalledWith(
			expect.anything(),
			USER_ID,
		);
		expect(state.countPending).toHaveBeenCalledWith(expect.anything(), USER_ID);
		expect(state.insertCharge).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				userId: USER_ID,
				role: "client",
				bureauId: BUREAU_ID,
			}),
			{
				asaasPaymentId: "pay_secret_id",
				pixPayload: "000201pix",
				amount: "100.00",
			},
		);
		expect(revalidatePath).toHaveBeenCalledWith("/portal/credits");
	});

	it.each(["operator", "bureau_admin", "superadmin"])(
		"denies %s before calling Asaas",
		async (role) => {
			state.role = role;

			expect((await requestClientTopupAction({ amount: "100.00" })).error).toBe(
				NOT_ALLOWED,
			);
			expect(state.adapterCreate).not.toHaveBeenCalled();
			expect(state.insertCharge).not.toHaveBeenCalled();
		},
	);

	it("maps an invalid session to no permission", async () => {
		state.sessionError = new SessionAccessError("session_required");

		expect((await requestClientTopupAction({ amount: "100.00" })).error).toBe(
			NOT_ALLOWED,
		);
	});

	it.each(["9.99", "5000.01", "10.005", "abc", "", "-10.00"])(
		"rejects amount %j",
		async (amount) => {
			const result = await requestClientTopupAction({ amount });

			expect(result.error).toBeTruthy();
			expect(state.adapterCreate).not.toHaveBeenCalled();
		},
	);

	it.each(["10.00", "5000.00"])(
		"accepts the boundary amount %s",
		async (amount) => {
			expect((await requestClientTopupAction({ amount })).error).toBeNull();
		},
	);

	it("returns an error and creates no Asaas charge when the client has no wallet", async () => {
		state.getClientWallet.mockResolvedValue(null);

		const result = await requestClientTopupAction({ amount: "100.00" });

		expect(result.error).toBe("Carteira não encontrada. Contate o suporte.");
		expect(state.adapterCreate).not.toHaveBeenCalled();
		expect(state.insertCharge).not.toHaveBeenCalled();
	});

	it("blocks a new charge at 10 pending charges and calls no Asaas", async () => {
		state.countPending.mockResolvedValue(10);

		const result = await requestClientTopupAction({ amount: "100.00" });

		expect(result.error).toBe(
			"Há PIX pendentes demais. Pague ou aguarde expirar antes de gerar outro.",
		);
		expect(state.adapterCreate).not.toHaveBeenCalled();
	});

	it("still allows a charge at 9 pending charges", async () => {
		state.countPending.mockResolvedValue(9);

		expect(
			(await requestClientTopupAction({ amount: "100.00" })).error,
		).toBeNull();
	});

	it("saves no charge when the adapter fails", async () => {
		state.adapterCreate.mockRejectedValue(new Error("Asaas respondeu 500"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await requestClientTopupAction({ amount: "100.00" });

		expect(result.error).toBe(FAILED);
		expect(state.insertCharge).not.toHaveBeenCalled();
	});

	it("reports an error and skips Asaas when the pre-checks fail", async () => {
		state.getClientWallet.mockRejectedValue(new Error("db down"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		expect((await requestClientTopupAction({ amount: "100.00" })).error).toBe(
			FAILED,
		);
		expect(state.adapterCreate).not.toHaveBeenCalled();
	});

	it("reports an error when the charge cannot be saved, and logs the orphan with payment id and reference", async () => {
		state.insertCharge.mockRejectedValue(new Error("db down"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		expect((await requestClientTopupAction({ amount: "100.00" })).error).toBe(
			FAILED,
		);
		const reference = state.adapterCreate.mock.calls[0][0].externalReference;
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("COBRANÇA ÓRFÃ"),
			{ reason: "save", asaasPaymentId: "pay_secret_id", externalReference: reference },
		);
	});

	it("locks the client, then re-checks the cap in the transaction that inserts", async () => {
		const order: string[] = [];
		state.lock.mockImplementation(async () => void order.push("lock"));
		state.countPending.mockImplementation(async () => (order.push("count"), 0));
		state.insertCharge.mockImplementation(async () => (order.push("insert"), { ok: true, id: "c", expiresAt: new Date() }));

		await requestClientTopupAction({ amount: "100.00" });

		// precheck: count; save: lock, count, insert.
		expect(order).toEqual(["count", "lock", "count", "insert"]);
		expect(state.lock).toHaveBeenCalledWith(expect.anything(), USER_ID);
	});

	it("when concurrent clicks fill the cap after Asaas answered: no insert, loud orphan log, cap error", async () => {
		state.countPending.mockResolvedValueOnce(9).mockResolvedValueOnce(10);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await requestClientTopupAction({ amount: "100.00" });

		expect(result.error).toBe("Há PIX pendentes demais. Pague ou aguarde expirar antes de gerar outro.");
		expect(state.insertCharge).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("COBRANÇA ÓRFÃ"),
			expect.objectContaining({ reason: "limite", asaasPaymentId: "pay_secret_id" }),
		);
	});
});
