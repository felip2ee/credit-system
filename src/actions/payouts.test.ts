import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
	session: vi.fn(),
	createPayout: vi.fn(),
	markPayoutPaid: vi.fn(),
	cancelPayout: vi.fn(),
	store: vi.fn(),
	discard: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: s.session,
	SessionAccessError: class SessionAccessError extends Error {},
}));
vi.mock("@/lib/payouts/queries", () => ({
	createPayout: s.createPayout,
	markPayoutPaid: s.markPayoutPaid,
	cancelPayout: s.cancelPayout,
}));
vi.mock("@/lib/payouts/receipt", () => {
	class ReceiptRejectedError extends Error {
		constructor(readonly reason: string) {
			super(reason);
		}
	}
	class ScannerUnavailableError extends Error {}
	return {
		ReceiptRejectedError,
		ScannerUnavailableError,
		storePayoutReceipt: s.store,
		discardPayoutReceipt: s.discard,
	};
});

import { ReceiptRejectedError, ScannerUnavailableError } from "@/lib/payouts/receipt";

import { cancelPayoutAction, createPayoutAction, markPayoutPaidAction } from "./payouts";

const superadmin = { userId: randomUUID(), role: "superadmin", bureauId: null, supportSessionId: null, support: null };
const asRole = (role: string) => ({ ...superadmin, role });
const bureauId = randomUUID();
const payoutId = randomUUID();
const stored = { objectKey: "ab/obj", mime: "application/pdf", sha256: "a".repeat(64) };

function form(entries: Record<string, string | File>) {
	const data = new FormData();
	for (const [key, value] of Object.entries(entries)) data.set(key, value);
	return data;
}
const pdf = () => new File([new Uint8Array([37, 80, 68, 70])], "r.pdf", { type: "application/pdf" });

beforeEach(() => {
	vi.clearAllMocks();
	s.session.mockResolvedValue(superadmin);
	s.createPayout.mockResolvedValue({ ok: true, payoutId, amount: "40.00" });
	s.markPayoutPaid.mockResolvedValue({ ok: true, bureauId, replayed: false });
	s.cancelPayout.mockResolvedValue({ ok: true, bureauId });
	s.store.mockResolvedValue(stored);
	s.discard.mockResolvedValue(undefined);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("createPayoutAction", () => {
	it("creates the payout for the superadmin", async () => {
		const result = await createPayoutAction({ bureauId, cutoffAt: new Date().toISOString() });

		expect(result).toEqual({ error: null, id: payoutId });
		expect(s.createPayout).toHaveBeenCalledOnce();
	});

	it.each([
		["a Bureau id that is not a uuid", { bureauId: "x", cutoffAt: new Date().toISOString() }],
		["a cutoff far in the future", { bureauId, cutoffAt: "2100-01-01T00:00:00Z" }],
		["an invalid cutoff", { bureauId, cutoffAt: "not-a-date" }],
		["a null cutoff (would become 1970)", { bureauId, cutoffAt: null }],
		["a missing cutoff", { bureauId }],
		["an empty cutoff", { bureauId, cutoffAt: "  " }],
		["a numeric cutoff", { bureauId, cutoffAt: 0 }],
	])("rejects %s before any session or write", async (_n, values) => {
		const result = await createPayoutAction(values);

		expect(result.error).toBeTruthy();
		expect(s.session).not.toHaveBeenCalled();
		expect(s.createPayout).not.toHaveBeenCalled();
	});

	it.each(["bureau_admin", "operator", "client"])("refuses the %s", async (role) => {
		s.session.mockResolvedValue(asRole(role));

		const result = await createPayoutAction({ bureauId, cutoffAt: new Date().toISOString() });

		expect(result.error).toMatch(/permissão/);
		expect(s.createPayout).not.toHaveBeenCalled();
	});

	it("refuses a superadmin in a support session", async () => {
		s.session.mockResolvedValue({ ...superadmin, supportSessionId: randomUUID() });

		const result = await createPayoutAction({ bureauId, cutoffAt: new Date().toISOString() });

		expect(result.error).toMatch(/suporte/);
		expect(s.createPayout).not.toHaveBeenCalled();
	});

	it("maps an unknown or missing failure reason to a generic error, never undefined", async () => {
		for (const reason of ["surprise", undefined]) {
			s.createPayout.mockResolvedValueOnce({ ok: false, reason });
			s.cancelPayout.mockResolvedValueOnce({ ok: false, reason });
			expect((await createPayoutAction({ bureauId, cutoffAt: new Date().toISOString() })).error).toBe(
				"Não foi possível concluir a operação.",
			);
			expect((await cancelPayoutAction({ payoutId })).error).toBe("Não foi possível concluir a operação.");
		}
	});

	it("maps a business failure and hides a thrown error", async () => {
		s.createPayout.mockResolvedValueOnce({ ok: false, reason: "nothing_to_pay" });
		expect((await createPayoutAction({ bureauId, cutoffAt: new Date().toISOString() })).error).toMatch(/Não há valor/);

		s.createPayout.mockRejectedValueOnce(new Error("secret db detail"));
		const result = await createPayoutAction({ bureauId, cutoffAt: new Date().toISOString() });
		expect(result.error).toBe("Falha ao criar o repasse.");
	});
});

describe("markPayoutPaidAction", () => {
	it("stores the receipt, then marks the payout paid and keeps the object", async () => {
		const result = await markPayoutPaidAction(form({ payoutId, receipt: pdf() }));

		expect(result).toEqual({ error: null, id: payoutId });
		expect(s.markPayoutPaid).toHaveBeenCalledWith(superadmin, { payoutId, receipt: stored });
		expect(s.discard).not.toHaveBeenCalled();
	});

	it.each(["bureau_admin", "operator"])("refuses the %s without touching the file", async (role) => {
		s.session.mockResolvedValue(asRole(role));

		const result = await markPayoutPaidAction(form({ payoutId, receipt: pdf() }));

		expect(result.error).toMatch(/permissão/);
		expect(s.store).not.toHaveBeenCalled();
	});

	it("fails without a file", async () => {
		const result = await markPayoutPaidAction(form({ payoutId }));

		expect(result.error).toMatch(/comprovante/);
		expect(s.store).not.toHaveBeenCalled();
		expect(s.markPayoutPaid).not.toHaveBeenCalled();
	});

	it("rejects an invalid payout id", async () => {
		const result = await markPayoutPaidAction(form({ payoutId: "x", receipt: pdf() }));

		expect(result.error).toBeTruthy();
		expect(s.store).not.toHaveBeenCalled();
	});

	it("maps a rejected receipt and an unavailable scanner; nothing is persisted", async () => {
		s.store.mockRejectedValueOnce(new ReceiptRejectedError("too_large"));
		expect((await markPayoutPaidAction(form({ payoutId, receipt: pdf() }))).error).toMatch(/5 MB/);

		s.store.mockRejectedValueOnce(new ScannerUnavailableError("down"));
		expect((await markPayoutPaidAction(form({ payoutId, receipt: pdf() }))).error).toMatch(/verificar o arquivo/);

		expect(s.markPayoutPaid).not.toHaveBeenCalled();
	});

	it("removes the stored object when the SQL function refuses", async () => {
		s.markPayoutPaid.mockResolvedValue({ ok: false, reason: "invalid_state" });

		const result = await markPayoutPaidAction(form({ payoutId, receipt: pdf() }));

		expect(result.error).toBeTruthy();
		expect(s.discard).toHaveBeenCalledWith(stored.objectKey);
	});

	it("removes the stored object when the database refuses with an SQLSTATE (clean rollback)", async () => {
		s.markPayoutPaid.mockRejectedValue(Object.assign(new Error("deadlock"), { code: "40P01" }));

		const result = await markPayoutPaidAction(form({ payoutId, receipt: pdf() }));

		expect(result.error).toBe("Falha ao registrar o pagamento do repasse.");
		expect(s.discard).toHaveBeenCalledWith(stored.objectKey);
	});

	it.each([
		["connection lost without a code", new Error("Connection terminated unexpectedly")],
		["ECONNRESET", Object.assign(new Error("reset"), { code: "ECONNRESET" })],
		["SQLSTATE 08006", Object.assign(new Error("connection failure"), { code: "08006" })],
		["SQLSTATE 57P01", Object.assign(new Error("admin shutdown"), { code: "57P01" })],
	])("keeps the stored object and logs it for reconciliation on an ambiguous commit failure (%s)", async (_name, error) => {
		s.markPayoutPaid.mockRejectedValue(error);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await markPayoutPaidAction(form({ payoutId, receipt: pdf() }));

		expect(result.error).toBe("Falha ao registrar o pagamento do repasse.");
		expect(s.discard).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(expect.stringContaining("comprovante mantido"), { payoutId, objectKey: stored.objectKey });
	});

	it("removes the redundant object on a same-receipt replay but still succeeds", async () => {
		s.markPayoutPaid.mockResolvedValue({ ok: true, bureauId, replayed: true });

		const result = await markPayoutPaidAction(form({ payoutId, receipt: pdf() }));

		expect(result.error).toBeNull();
		expect(s.discard).toHaveBeenCalledWith(stored.objectKey);
	});
});

describe("cancelPayoutAction", () => {
	it("cancels for the superadmin and refuses others", async () => {
		expect(await cancelPayoutAction({ payoutId })).toEqual({ error: null, id: payoutId });

		s.session.mockResolvedValue(asRole("bureau_admin"));
		expect((await cancelPayoutAction({ payoutId })).error).toMatch(/permissão/);
		expect(s.cancelPayout).toHaveBeenCalledOnce();
	});

	it("rejects an invalid id", async () => {
		expect((await cancelPayoutAction({ payoutId: "x" })).error).toBeTruthy();
		expect(s.cancelPayout).not.toHaveBeenCalled();
	});
});
