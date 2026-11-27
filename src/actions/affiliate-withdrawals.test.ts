import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
	session: vi.fn(),
	requestWithdrawal: vi.fn(),
	convertCommission: vi.fn(),
	markWithdrawalPaid: vi.fn(),
	cancelWithdrawal: vi.fn(),
	store: vi.fn(),
	discard: vi.fn(),
	withdrawalsEnabled: vi.fn(),
	affiliateEnabled: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/config", () => ({
	config: { betterAuthUrl: "https://app.example.test" },
	readAffiliateWithdrawalsEnabled: s.withdrawalsEnabled,
}));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: s.session,
	SessionAccessError: class SessionAccessError extends Error {},
}));
vi.mock("@/lib/affiliates/enabled", () => ({ isAffiliateEnabled: s.affiliateEnabled }));
vi.mock("@/lib/affiliates/withdrawals", () => ({
	requestWithdrawal: s.requestWithdrawal,
	convertCommission: s.convertCommission,
	markWithdrawalPaid: s.markWithdrawalPaid,
	cancelWithdrawal: s.cancelWithdrawal,
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

import { ReceiptRejectedError } from "@/lib/payouts/receipt";

import {
	cancelWithdrawalAction,
	convertCommissionAction,
	markWithdrawalPaidAction,
	requestWithdrawalAction,
} from "./affiliate-withdrawals";

const client = { userId: randomUUID(), role: "client", bureauId: randomUUID(), supportSessionId: null, support: null };
const superadmin = { userId: randomUUID(), role: "superadmin", bureauId: null, supportSessionId: null, support: null };
const withdrawalId = randomUUID();
const stored = { objectKey: "ab/obj", mime: "application/pdf", sha256: "a".repeat(64) };

const valid = { amount: "100.00", pixKeyType: "email", pixKey: "ana@example.com", ownKeyDeclaration: true };
const pdf = () => new File([new Uint8Array([37, 80, 68, 70])], "r.pdf", { type: "application/pdf" });
function form(entries: Record<string, string | File>) {
	const data = new FormData();
	for (const [key, value] of Object.entries(entries)) data.set(key, value);
	return data;
}

beforeEach(() => {
	vi.clearAllMocks();
	s.withdrawalsEnabled.mockReturnValue(true);
	s.session.mockResolvedValue(client);
	s.affiliateEnabled.mockResolvedValue(true);
	s.requestWithdrawal.mockResolvedValue({ ok: true, withdrawalId });
	s.convertCommission.mockResolvedValue({ ok: true });
	s.markWithdrawalPaid.mockResolvedValue({ ok: true, replayed: false });
	s.cancelWithdrawal.mockResolvedValue({ ok: true });
	s.store.mockResolvedValue(stored);
	s.discard.mockResolvedValue(undefined);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("requestWithdrawalAction", () => {
	it("requests the withdrawal for a client", async () => {
		const result = await requestWithdrawalAction(valid);

		expect(result).toEqual({ error: null, id: withdrawalId });
		expect(s.requestWithdrawal).toHaveBeenCalledWith(client, { amount: "100.00", pixKeyType: "email", pixKey: "ana@example.com" });
	});

	it("refuses while withdrawals are disabled, before any session or database access", async () => {
		s.withdrawalsEnabled.mockReturnValue(false);

		const result = await requestWithdrawalAction(valid);

		expect(result).toEqual({ error: "O saque ainda não está disponível." });
		expect(s.session).not.toHaveBeenCalled();
		expect(s.requestWithdrawal).not.toHaveBeenCalled();
	});

	it("refuses withdrawal and conversion while the bureau has the affiliate section off", async () => {
		s.affiliateEnabled.mockResolvedValue(false);

		expect(await requestWithdrawalAction(valid)).toEqual({ error: "A afiliação não está disponível neste momento." });
		expect(await convertCommissionAction({ amount: "10.00" })).toEqual({ error: "A afiliação não está disponível neste momento." });
		expect(s.requestWithdrawal).not.toHaveBeenCalled();
		expect(s.convertCommission).not.toHaveBeenCalled();
	});

	it("keeps conversion working while withdrawals are disabled", async () => {
		s.withdrawalsEnabled.mockReturnValue(false);

		expect(await convertCommissionAction({ amount: "10.00" })).toEqual({ error: null });
	});

	it("maps a document key that is not the account's to the pt-BR message", async () => {
		s.requestWithdrawal.mockResolvedValueOnce({ ok: false, reason: "pix_key_not_owner" });

		expect((await requestWithdrawalAction(valid)).error).toBe("A chave CPF/CNPJ precisa ser o documento da sua conta.");
	});

	it("needs the declaration that the key is in the client's name, and writes nothing without it", async () => {
		for (const declaration of [false, undefined, "true", 1]) {
			const result = await requestWithdrawalAction({ ...valid, ownKeyDeclaration: declaration });
			expect(result.error).toMatch(/no meu nome|em seu nome|declar/i);
		}
		expect(s.session).not.toHaveBeenCalled();
		expect(s.requestWithdrawal).not.toHaveBeenCalled();
	});

	it.each([
		["an invalid e-mail", { pixKeyType: "email", pixKey: "ana-at-example" }],
		["an invalid CPF", { pixKeyType: "document", pixKey: "111.111.111-11" }],
		["an invalid CNPJ", { pixKeyType: "document", pixKey: "12.345.678/0001-00" }],
		["a phone that is not E.164", { pixKeyType: "phone", pixKey: "123" }],
		["a random key that is not a uuid", { pixKeyType: "random", pixKey: "abc" }],
		["an unknown key type", { pixKeyType: "card", pixKey: "ana@example.com" }],
		["an empty key", { pixKeyType: "email", pixKey: "  " }],
		["an amount with 3 decimals", { amount: "1.005" }],
		["a zero amount", { amount: "0.00" }],
		["a negative amount", { amount: "-1.00" }],
		["a number instead of text", { amount: 10 }],
	])("rejects %s before any session or write", async (_name, override) => {
		const result = await requestWithdrawalAction({ ...valid, ...override });

		expect(result.error).toBeTruthy();
		expect(s.session).not.toHaveBeenCalled();
		expect(s.requestWithdrawal).not.toHaveBeenCalled();
	});

	it("keeps only the digits of a CPF key and E.164 of a phone key", async () => {
		await requestWithdrawalAction({ ...valid, pixKeyType: "document", pixKey: "111.444.777-35" });
		expect(s.requestWithdrawal).toHaveBeenLastCalledWith(client, { amount: "100.00", pixKeyType: "document", pixKey: "11144477735" });

		await requestWithdrawalAction({ ...valid, pixKeyType: "phone", pixKey: "+5563912345678" });
		expect(s.requestWithdrawal).toHaveBeenLastCalledWith(client, { amount: "100.00", pixKeyType: "phone", pixKey: "+5563912345678" });

		const uuid = randomUUID();
		await requestWithdrawalAction({ ...valid, pixKeyType: "random", pixKey: uuid.toUpperCase() });
		expect(s.requestWithdrawal).toHaveBeenLastCalledWith(client, { amount: "100.00", pixKeyType: "random", pixKey: uuid });
	});

	it.each(["bureau_admin", "operator", "superadmin"])("refuses the %s", async (role) => {
		s.session.mockResolvedValue({ ...client, role });

		const result = await requestWithdrawalAction(valid);

		expect(result.error).toMatch(/permissão/);
		expect(s.requestWithdrawal).not.toHaveBeenCalled();
	});

	it("maps a business reason to pt-BR, an unknown reason to a generic error and hides a thrown error and the key", async () => {
		s.requestWithdrawal.mockResolvedValueOnce({ ok: false, reason: "insufficient_funds" });
		expect((await requestWithdrawalAction(valid)).error).toMatch(/saldo disponível/);
		s.requestWithdrawal.mockResolvedValueOnce({ ok: false, reason: "withdrawal_open" });
		expect((await requestWithdrawalAction(valid)).error).toMatch(/saque em aberto/);
		s.requestWithdrawal.mockResolvedValueOnce({ ok: false, reason: "net_not_positive" });
		expect((await requestWithdrawalAction(valid)).error).toMatch(/taxa/);
		s.requestWithdrawal.mockResolvedValueOnce({ ok: false, reason: "surprise" });
		expect((await requestWithdrawalAction(valid)).error).toBe("Não foi possível concluir a operação.");

		s.requestWithdrawal.mockRejectedValueOnce(new Error("secret db detail ana@example.com"));
		const result = await requestWithdrawalAction(valid);
		expect(result.error).toBe("Falha ao solicitar o saque.");
		expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("ana@example.com");
	});
});

describe("convertCommissionAction", () => {
	it("converts with a request id generated on the server when none is given", async () => {
		expect(await convertCommissionAction({ amount: "40.00" })).toEqual({ error: null });

		expect(s.convertCommission).toHaveBeenCalledWith(client, { amount: "40.00", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
	});

	it("keeps the request id the form sends, so a double click converts once", async () => {
		const requestId = randomUUID();
		await convertCommissionAction({ amount: "40.00", requestId });
		expect(s.convertCommission).toHaveBeenCalledWith(client, { amount: "40.00", requestId });
	});

	it.each(["0", "-1.00", "1.005", "abc", ""])("rejects the amount %j", async (amount) => {
		expect((await convertCommissionAction({ amount })).error).toBeTruthy();
		expect(s.convertCommission).not.toHaveBeenCalled();
	});

	it("refuses a role that is not client and maps insufficient funds", async () => {
		s.session.mockResolvedValue({ ...client, role: "operator" });
		expect((await convertCommissionAction({ amount: "1.00" })).error).toMatch(/permissão/);
		expect(s.convertCommission).not.toHaveBeenCalled();

		s.session.mockResolvedValue(client);
		s.convertCommission.mockResolvedValueOnce({ ok: false, reason: "insufficient_funds" });
		expect((await convertCommissionAction({ amount: "1.00" })).error).toMatch(/saldo disponível/);
	});
});

describe("markWithdrawalPaidAction", () => {
	beforeEach(() => s.session.mockResolvedValue(superadmin));

	it("stores the receipt, marks paid and keeps the object", async () => {
		const result = await markWithdrawalPaidAction(form({ withdrawalId, receipt: pdf() }));

		expect(result).toEqual({ error: null, id: withdrawalId });
		expect(s.markWithdrawalPaid).toHaveBeenCalledWith(superadmin, { id: withdrawalId, receipt: stored });
		expect(s.discard).not.toHaveBeenCalled();
	});

	it("discards the stored object when the database refuses, or when it is a replay", async () => {
		s.markWithdrawalPaid.mockResolvedValueOnce({ ok: false, reason: "already_paid" });
		expect((await markWithdrawalPaidAction(form({ withdrawalId, receipt: pdf() }))).error).toMatch(/outro comprovante/);
		expect(s.discard).toHaveBeenCalledWith(stored.objectKey);

		s.discard.mockClear();
		s.markWithdrawalPaid.mockResolvedValueOnce({ ok: true, replayed: true });
		expect((await markWithdrawalPaidAction(form({ withdrawalId, receipt: pdf() }))).error).toBeNull();
		expect(s.discard).toHaveBeenCalledWith(stored.objectKey);
	});

	it("refuses a missing receipt, a rejected file and a bad id without touching the database", async () => {
		expect((await markWithdrawalPaidAction(form({ withdrawalId }))).error).toMatch(/comprovante/);
		expect((await markWithdrawalPaidAction(form({ withdrawalId: "x", receipt: pdf() }))).error).toBeTruthy();
		s.store.mockRejectedValueOnce(new ReceiptRejectedError("infected"));
		expect((await markWithdrawalPaidAction(form({ withdrawalId, receipt: pdf() }))).error).toMatch(/segurança/);
		expect(s.markWithdrawalPaid).not.toHaveBeenCalled();
	});

	it.each(["client", "bureau_admin", "operator"])("refuses the %s before storing the file", async (role) => {
		s.session.mockResolvedValue({ ...superadmin, role });

		const result = await markWithdrawalPaidAction(form({ withdrawalId, receipt: pdf() }));

		expect(result.error).toMatch(/permissão/);
		expect(s.store).not.toHaveBeenCalled();
	});

	it("refuses a superadmin in a support session", async () => {
		s.session.mockResolvedValue({ ...superadmin, supportSessionId: randomUUID() });
		expect((await markWithdrawalPaidAction(form({ withdrawalId, receipt: pdf() }))).error).toMatch(/suporte/);
		expect(s.store).not.toHaveBeenCalled();
	});
});

describe("cancelWithdrawalAction", () => {
	beforeEach(() => s.session.mockResolvedValue(superadmin));

	it("cancels with a reason", async () => {
		expect(await cancelWithdrawalAction({ id: withdrawalId, reason: " Nome não confere " })).toEqual({ error: null, id: withdrawalId });
		expect(s.cancelWithdrawal).toHaveBeenCalledWith(superadmin, { id: withdrawalId, reason: "Nome não confere" });
	});

	it.each([{ id: withdrawalId, reason: "  " }, { id: withdrawalId }, { id: "x", reason: "motivo" }, { id: withdrawalId, reason: "a".repeat(501) }])(
		"rejects invalid input %j",
		async (values) => {
			expect((await cancelWithdrawalAction(values)).error).toBeTruthy();
			expect(s.cancelWithdrawal).not.toHaveBeenCalled();
		},
	);

	it.each(["client", "bureau_admin", "operator"])("refuses the %s", async (role) => {
		s.session.mockResolvedValue({ ...superadmin, role });
		expect((await cancelWithdrawalAction({ id: withdrawalId, reason: "motivo" })).error).toMatch(/permissão/);
		expect(s.cancelWithdrawal).not.toHaveBeenCalled();
	});

	it("refuses a superadmin in a support session", async () => {
		s.session.mockResolvedValue({ ...superadmin, supportSessionId: randomUUID() });
		expect((await cancelWithdrawalAction({ id: withdrawalId, reason: "motivo" })).error).toMatch(/suporte/);
		expect(s.cancelWithdrawal).not.toHaveBeenCalled();
	});
});
