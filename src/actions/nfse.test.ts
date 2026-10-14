import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
	session: vi.fn(),
	retry: vi.fn(),
	reschedule: vi.fn(),
	configured: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: s.session,
	SessionAccessError: class SessionAccessError extends Error {},
}));
vi.mock("@/lib/nfse/queries", () => ({ requestNfseRetry: s.retry }));
vi.mock("@/lib/nfse/invoice", () => ({ rescheduleInvoice: s.reschedule, isNfseConfigured: s.configured }));

import { retryNfseAction } from "./nfse";

const superadmin = { userId: randomUUID(), role: "superadmin", bureauId: null, supportSessionId: null, support: null };
const chargeId = randomUUID();

beforeEach(() => {
	vi.clearAllMocks();
	s.session.mockResolvedValue(superadmin);
	s.configured.mockReturnValue(true);
	s.retry.mockResolvedValue({ ok: true });
	s.reschedule.mockResolvedValue("pending");
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("retryNfseAction", () => {
	it("requests the retry, then schedules the invoice again", async () => {
		const result = await retryNfseAction({ chargeId });

		expect(result).toEqual({ error: null, id: chargeId });
		expect(s.retry).toHaveBeenCalledWith(superadmin, chargeId);
		expect(s.reschedule).toHaveBeenCalledWith(superadmin, chargeId);
	});

	it("rejects an invalid charge id before any session or write", async () => {
		const result = await retryNfseAction({ chargeId: "x" });

		expect(result.error).toBeTruthy();
		expect(s.session).not.toHaveBeenCalled();
		expect(s.retry).not.toHaveBeenCalled();
	});

	it.each(["bureau_admin", "operator", "client"])("refuses the %s", async (role) => {
		s.session.mockResolvedValue({ ...superadmin, role });

		const result = await retryNfseAction({ chargeId });

		expect(result.error).toMatch(/permissão/);
		expect(s.retry).not.toHaveBeenCalled();
	});

	it("refuses a superadmin in a support session", async () => {
		s.session.mockResolvedValue({ ...superadmin, supportSessionId: randomUUID() });

		expect((await retryNfseAction({ chargeId })).error).toMatch(/suporte/);
		expect(s.retry).not.toHaveBeenCalled();
	});

	it("does not touch the charge when the NFS-e is not configured", async () => {
		s.configured.mockReturnValue(false);

		const result = await retryNfseAction({ chargeId });

		expect(result.error).toMatch(/não está configurada/);
		expect(s.retry).not.toHaveBeenCalled();
	});

	it("maps a refused retry (only a failed invoice can be retried)", async () => {
		s.retry.mockResolvedValue({ ok: false, reason: "invalid_state" });

		const result = await retryNfseAction({ chargeId });

		expect(result.error).toMatch(/com falha/);
		expect(s.reschedule).not.toHaveBeenCalled();
	});

	it("reports an error when scheduling fails again", async () => {
		s.reschedule.mockResolvedValue("failed");

		expect((await retryNfseAction({ chargeId })).error).toMatch(/continua com falha/);
	});

	it("hides a thrown error", async () => {
		s.retry.mockRejectedValue(new Error("secret db detail"));

		expect((await retryNfseAction({ chargeId })).error).toBe("Falha ao pedir a nova tentativa da nota.");
	});
});
