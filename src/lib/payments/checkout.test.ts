import { beforeEach, describe, expect, it, vi } from "vitest";

const BUREAU_ID = "00000000-0000-4000-8000-0000000000b1";
const USER_ID = "00000000-0000-4000-8000-000000000001";
const KEY = "5f1c1d5e-3c34-4e55-9c3a-0d1b6a7c9e10";
const CPF = "52998224725";
const CARD_NUMBER = "4242424242424242";
const CVV = "987";

const s = vi.hoisted(() => ({
	keyring: vi.fn(),
	feeConfig: vi.fn(),
	pixFee: vi.fn(),
	nfseOn: vi.fn(),
	asaas: {
		createPixCharge: vi.fn(),
		createCardCharge: vi.fn(),
		findCustomerByExternalReference: vi.fn(),
		customerExists: vi.fn(),
		createCustomer: vi.fn(),
		updateCustomer: vi.fn(),
	},
	view: vi.fn(),
	load: vi.fn(),
	save: vi.fn(),
	claim: vi.fn(),
	clear: vi.fn(),
	synced: vi.fn(),
	lock: vi.fn(),
	reserve: vi.fn(),
	setCustomer: vi.fn(),
	bind: vi.fn(),
	status: vi.fn(),
	cancel: vi.fn(),
	attempts: vi.fn(),
	ipAttempts: vi.fn(),
	bureauAttempts: vi.fn(),
	pendingBureau: vi.fn(),
	pendingClient: vi.fn(),
	emailVerified: vi.fn(),
	clientWallet: vi.fn(),
	bureauWallet: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/transaction", () => ({
	withUserTransaction: async (_identity: unknown, work: (client: unknown) => unknown) => work({}),
}));
vi.mock("@/lib/config", () => ({ readPiiKeyring: s.keyring, readCardFeeConfig: s.feeConfig, readPixFeeConfig: s.pixFee }));
vi.mock("@/lib/nfse/invoice", () => ({ isNfseConfigured: s.nfseOn }));
vi.mock("@/lib/asaas", async () => {
	const actual = await vi.importActual<typeof import("@/lib/asaas/client")>("@/lib/asaas/client");
	return {
		getAsaasClient: () => s.asaas,
		AsaasHttpError: actual.AsaasHttpError,
		AsaasOutcomeUnknownError: actual.AsaasOutcomeUnknownError,
		CardDeclinedError: actual.CardDeclinedError,
	};
});
vi.mock("@/lib/payers/queries", () => ({
	getOwnerPayerView: s.view,
	loadOwnerPayerForCharge: s.load,
	saveOwnerPayer: s.save,
	claimAsaasCustomer: s.claim,
	clearAsaasCustomer: s.clear,
	markPayerSynced: s.synced,
}));
vi.mock("@/lib/account/queries", () => ({ getClientAccountStatus: s.emailVerified }));
vi.mock("@/lib/wallet/client-queries", () => ({ getClientWallet: s.clientWallet }));
vi.mock("@/lib/wallet/queries", () => ({ getWallet: s.bureauWallet }));
vi.mock("@/lib/wallet/pix-charges", () => ({
	MAX_CARD_ATTEMPTS_PER_HOUR: 5,
	MAX_CARD_ATTEMPTS_PER_IP_PER_HOUR: 10,
	MAX_CARD_ATTEMPTS_PER_BUREAU_PER_HOUR: 40,
	MAX_PENDING_PIX_CHARGES: 10,
	lockChargeScope: s.lock,
	reserveCharge: s.reserve,
	setChargeCustomer: s.setCustomer,
	bindAsaasCharge: s.bind,
	getChargeStatus: s.status,
	cancelUnboundPixCharge: s.cancel,
	countRecentCardAttempts: s.attempts,
	countRecentCardAttemptsByIp: s.ipAttempts,
	countRecentCardAttemptsByBureau: s.bureauAttempts,
	countPendingPixCharges: s.pendingBureau,
	countPendingClientPixCharges: s.pendingClient,
}));

import { AsaasHttpError, AsaasOutcomeUnknownError, CardDeclinedError } from "@/lib/asaas";
import { PiiDecryptError } from "@/lib/pii/crypto";
import type { CheckoutInput } from "@/lib/validators/checkout";
import { computeCardCharge } from "@/lib/wallet/card-fees";

import { runCheckout } from "./checkout";

const session = { userId: USER_ID, role: "client" as const, bureauId: BUREAU_ID, supportSessionId: null };
const clientScope = { kind: "client" as const, clientProfileId: USER_ID };
const bureauScope = { kind: "bureau" as const, bureauId: BUREAU_ID };
const meta = { remoteIp: "203.0.113.7", description: "Recarga de créditos" };
const FEES = { bands: [{ maxInstallments: 12, percent: 3.99, fixedCents: 49 }], minInstallmentCents: 500 };

const fullView = {
	name: "Ana Souza",
	emailMasked: "a***@x.com",
	phoneMasked: "(**) *****-4321",
	documentMasked: "***.982.***-**",
	postalCodeMasked: "*****-678",
	hasAddressNumber: true,
	source: "payer_profile" as const,
};
const fullPayer = {
	name: "Ana Souza",
	cpfCnpj: CPF,
	email: "ana@example.com",
	phone: "+5511987654321",
	postalCode: "01310100",
	addressNumber: "100",
};
const loaded = (over = {}) => ({
	payer: fullPayer,
	payerProfileId: "pp1",
	asaasCustomerId: "cus_1",
	owned: true,
	stale: false,
	...over,
});
const pixInput = (over: Partial<CheckoutInput> = {}): CheckoutInput => ({
	amount: "100.00",
	method: "PIX",
	payerKind: "owner",
	idempotencyKey: KEY,
	...over,
});
const cardInput = (over: Partial<CheckoutInput> = {}): CheckoutInput =>
	pixInput({
		method: "CREDIT_CARD",
		installments: 3,
		card: { number: CARD_NUMBER, holderName: "ANA SOUZA", expiryMonth: "12", expiryYear: "2099", cvv: CVV },
		...over,
	});
const otherPayer = {
	name: "Bia Lima",
	document: "11144477735",
	email: "bia@example.com",
	phone: "+5511999998888",
	postalCode: "04538133",
	addressNumber: "10",
};

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	vi.clearAllMocks();
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
	s.keyring.mockReturnValue({ activeKeyId: "k1", keys: new Map() });
	s.feeConfig.mockReturnValue(FEES);
	s.pixFee.mockReturnValue({ feeCents: 0 });
	s.nfseOn.mockReturnValue(false);
	s.view.mockResolvedValue(fullView);
	s.load.mockResolvedValue(loaded());
	s.save.mockResolvedValue({ ok: true });
	s.emailVerified.mockResolvedValue({ emailVerified: true });
	s.clientWallet.mockResolvedValue({ available: "0.00" });
	s.bureauWallet.mockResolvedValue({ available: "0.00" });
	s.reserve.mockResolvedValue({ ok: true, id: "ch1", expiresAt: new Date("2030-01-01T00:30:00Z"), reused: false });
	s.claim.mockImplementation(async (_client: unknown, _profile: string, id: string) => id);
	s.setCustomer.mockResolvedValue(undefined);
	s.bind.mockResolvedValue(true);
	s.status.mockResolvedValue({ status: "pending", billingType: "PIX" });
	s.cancel.mockResolvedValue(undefined);
	s.attempts.mockResolvedValue(1);
	s.ipAttempts.mockResolvedValue(1);
	s.bureauAttempts.mockResolvedValue(1);
	s.clear.mockResolvedValue(undefined);
	s.asaas.customerExists.mockResolvedValue(true);
	s.pendingBureau.mockResolvedValue(1);
	s.pendingClient.mockResolvedValue(1);
	s.asaas.createPixCharge.mockResolvedValue({ asaasPaymentId: "pay_1", pixPayload: "000201pix", qrImageBase64: "QUJD" });
	s.asaas.createCardCharge.mockResolvedValue({ asaasPaymentId: "pay_1", asaasInstallmentId: "ins_1", brand: "VISA", last4: "4242" });
	s.asaas.findCustomerByExternalReference.mockResolvedValue(null);
	s.asaas.createCustomer.mockResolvedValue({ asaasCustomerId: "cus_new" });
});

describe("runCheckout, Pix", () => {
	it("known owner pays Pix with no save, using the Asaas customer of the payer", async () => {
		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result).toEqual({
			error: null,
			id: "ch1",
			method: "PIX",
			pixPayload: "000201pix",
			qrImageBase64: "QUJD",
			expiresAt: "2030-01-01T00:30:00.000Z",
			summary: { rechargeCents: 10000, feeCents: 0, totalCents: 10000 },
		});
		expect(s.save).not.toHaveBeenCalled();
		expect(s.asaas.createPixCharge).toHaveBeenCalledWith({
			customerId: "cus_1",
			amount: "100.00",
			externalReference: KEY,
			description: "Recarga de créditos",
		});
		expect(s.setCustomer).toHaveBeenCalledWith({}, "ch1", "cus_1");
		expect(s.reserve).toHaveBeenCalledWith(
			{},
			session,
			expect.objectContaining({
				scope: clientScope,
				externalReference: KEY,
				billingType: "PIX",
				installments: 1,
				totalCharged: null,
				payerKind: "owner",
				payerDocumentMasked: "***.982.***-**",
			}),
		);
		expect(s.bind).toHaveBeenCalledWith({}, "ch1", { asaasPaymentId: "pay_1", pixPayload: "000201pix" });
	});

	it("Pix with fee charges recharge + fee at Asaas, stores the total and returns the summary", async () => {
		s.pixFee.mockReturnValue({ feeCents: 199 });

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result).toMatchObject({ error: null, summary: { rechargeCents: 10000, feeCents: 199, totalCents: 10199 } });
		expect(s.asaas.createPixCharge).toHaveBeenCalledWith(expect.objectContaining({ amount: "101.99" }));
		expect(s.reserve).toHaveBeenCalledWith(
			{},
			session,
			expect.objectContaining({ amount: "100.00", feeAmount: "1.99", totalCharged: "101.99" }),
		);
	});

	it("Pix fee pads cents (5 cents fee = 0.05) and never uses floats", async () => {
		s.pixFee.mockReturnValue({ feeCents: 5 });

		await runCheckout(session, clientScope, pixInput({ amount: "10.10" }), meta);

		expect(s.asaas.createPixCharge).toHaveBeenCalledWith(expect.objectContaining({ amount: "10.15" }));
		expect(s.reserve).toHaveBeenCalledWith({}, session, expect.objectContaining({ feeAmount: "0.05", totalCharged: "10.15" }));
	});

	it("Pix with an invalid fee config fails closed: no reserve, no Asaas call", async () => {
		s.pixFee.mockImplementation(() => {
			throw new Error("PIX_FEE_CENTS must be a non-negative integer");
		});

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result).toEqual({ error: "Pagamento indisponível. Contate o suporte." });
		expect(s.reserve).not.toHaveBeenCalled();
		expect(s.asaas.createPixCharge).not.toHaveBeenCalled();
	});

	it("a broken Pix fee config does not block the card", async () => {
		s.pixFee.mockImplementation(() => {
			throw new Error("PIX_FEE_CENTS must be a non-negative integer");
		});

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result.error).toBeNull();
	});

	it("asks for the fields the matrix says are missing, and reserves nothing without them", async () => {
		s.view.mockResolvedValue({ ...fullView, documentMasked: null });

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result).toEqual({ error: expect.stringMatching(/dados de pagamento/) });
		expect(s.reserve).not.toHaveBeenCalled();
		expect(s.asaas.createPixCharge).not.toHaveBeenCalled();
	});

	it("saves the typed missing field and loads the owner again before claiming", async () => {
		s.view.mockResolvedValue({ ...fullView, documentMasked: null });
		s.load.mockResolvedValueOnce(loaded({ payer: { ...fullPayer, cpfCnpj: undefined } })).mockResolvedValueOnce(loaded());

		const result = await runCheckout(session, clientScope, pixInput({ payer: { document: CPF } }), meta);

		expect(result.error).toBeNull();
		expect(s.save).toHaveBeenCalledWith({}, session, clientScope, { document: CPF }, expect.anything());
		expect(s.load).toHaveBeenCalledTimes(2);
	});

	it("copies the known Holder data into payer_profiles when the owner has no row yet", async () => {
		s.load
			.mockResolvedValueOnce(loaded({ payerProfileId: null, asaasCustomerId: null, owned: false }))
			.mockResolvedValueOnce(loaded({ asaasCustomerId: null, owned: false }));

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result.error).toBeNull();
		expect(s.save).toHaveBeenCalledWith(
			{},
			session,
			clientScope,
			{ document: CPF, postalCode: "01310100", addressNumber: "100" },
			expect.anything(),
		);
		// Sem cliente Asaas ainda: acha pela referência (nada) e cria com a referência da linha do dono.
		expect(s.asaas.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ externalReference: "pp1" }));
		expect(s.asaas.createPixCharge).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cus_new" }));
	});

	it("requires the address of the owner when the NFS-e is on", async () => {
		s.nfseOn.mockReturnValue(true);
		s.view.mockResolvedValue({ ...fullView, postalCodeMasked: null });

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result.error).toMatch(/dados de pagamento/);
	});

	it("'other' payer persists nothing and never loads the owner data", async () => {
		const result = await runCheckout(session, clientScope, pixInput({ payerKind: "other", payer: otherPayer, declaration: true }), meta);

		expect(result.error).toBeNull();
		expect(s.save).not.toHaveBeenCalled();
		expect(s.load).not.toHaveBeenCalled();
		expect(s.claim).not.toHaveBeenCalled();
		expect(s.asaas.createPixCharge).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cus_new" }));
		expect(s.reserve).toHaveBeenCalledWith(
			{},
			session,
			expect.objectContaining({ payerKind: "other", payerDocumentMasked: "***.444.***-**" }),
		);
	});

	it("'other' payer must send every field", async () => {
		const { phone: _phone, ...partial } = otherPayer;

		const result = await runCheckout(session, clientScope, pixInput({ payerKind: "other", payer: partial, declaration: true }), meta);

		expect(result.error).toMatch(/dados de pagamento/);
		expect(s.reserve).not.toHaveBeenCalled();
	});

	it("'other' payer always gets a new Asaas customer referenced by the charge, never one found by document", async () => {
		await runCheckout(session, clientScope, pixInput({ payerKind: "other", payer: otherPayer, declaration: true }), meta);

		expect(s.asaas.findCustomerByExternalReference).toHaveBeenCalledWith("ch1");
		expect(s.asaas.createCustomer).toHaveBeenCalledWith(
			expect.objectContaining({ cpfCnpj: "11144477735", externalReference: "ch1" }),
		);
		expect(s.asaas.updateCustomer).not.toHaveBeenCalled();
		expect(s.asaas.createPixCharge).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cus_new" }));
	});

	it("cancels the reserved row on a definite Pix error, keeps it on an unknown outcome", async () => {
		s.asaas.createPixCharge.mockRejectedValueOnce(new Error("boom"));
		const definite = await runCheckout(session, clientScope, pixInput(), meta);
		s.cancel.mockClear();
		s.asaas.createPixCharge.mockRejectedValueOnce(new AsaasOutcomeUnknownError("timeout"));
		const unknown = await runCheckout(session, clientScope, pixInput(), meta);

		expect(definite.error).toMatch(/PIX/);
		expect(unknown.error).toMatch(/PIX/);
		expect(s.cancel).not.toHaveBeenCalled();
	});

	it("fails when the Pix cannot be bound to its row", async () => {
		s.bind.mockResolvedValue(false);

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result.error).toMatch(/PIX/);
	});
});

describe("runCheckout, scope rules", () => {
	it("does not block a client with an unverified e-mail", async () => {
		s.emailVerified.mockResolvedValue({ emailVerified: false });

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result.error).toBeNull();
		expect(s.reserve).toHaveBeenCalled();
	});

	it.each([
		["client", clientScope],
		["Bureau", bureauScope],
	])("blocks a %s without wallet", async (_name, scope) => {
		s.clientWallet.mockResolvedValue(null);
		s.bureauWallet.mockResolvedValue(null);

		const result = await runCheckout(session, scope, pixInput(), meta);

		expect(result.error).toMatch(/Carteira/);
		expect(s.asaas.createPixCharge).not.toHaveBeenCalled();
	});

	it("blocks Pix above the pending cap, counting the new row (cap + 1)", async () => {
		s.pendingBureau.mockResolvedValue(11);

		const blocked = await runCheckout(session, bureauScope, pixInput(), meta);
		s.pendingBureau.mockResolvedValue(10);
		const allowed = await runCheckout(session, bureauScope, pixInput(), meta);

		expect(blocked.error).toMatch(/pendentes/);
		expect(allowed.error).toBeNull();
		expect(s.pendingClient).not.toHaveBeenCalled();
	});

	it("uses the client cap for the client scope", async () => {
		s.pendingClient.mockResolvedValue(11);

		expect((await runCheckout(session, clientScope, pixInput(), meta)).error).toMatch(/pendentes/);
		expect(s.pendingBureau).not.toHaveBeenCalled();
	});

	it("same idempotency key twice: the second does not call Asaas and reports the first order", async () => {
		s.reserve.mockResolvedValue({ ok: true, id: "ch1", expiresAt: new Date(), reused: true });

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result).toEqual({ error: null, id: "ch1", method: "CREDIT_CARD", reused: true });
		expect(s.asaas.createCardCharge).not.toHaveBeenCalled();
		expect(s.asaas.createCustomer).not.toHaveBeenCalled();
		expect(s.attempts).not.toHaveBeenCalled();
	});

	it("maps reference_taken and invalid_amount to safe messages", async () => {
		s.reserve.mockResolvedValueOnce({ ok: false, reason: "reference_taken" });
		s.reserve.mockResolvedValueOnce({ ok: false, reason: "invalid_amount" });

		expect((await runCheckout(session, clientScope, pixInput(), meta)).error).toMatch(/Pedido já usado/);
		expect((await runCheckout(session, clientScope, pixInput(), meta)).error).toBe("Valor inválido.");
	});
});

describe("runCheckout, card", () => {
	it("charges the total the server computes and maps cvv to ccv", async () => {
		const expected = computeCardCharge(FEES, { rechargeCents: 10000, installments: 3 });

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result).toEqual({ error: null, id: "ch1", method: "CREDIT_CARD", summary: expect.any(Object) });
		expect(s.reserve).toHaveBeenCalledWith(
			{},
			session,
			expect.objectContaining({
				billingType: "CREDIT_CARD",
				installments: 3,
				amount: "100.00",
				feeAmount: (expected.feeCents / 100).toFixed(2),
				totalCharged: (expected.totalCents / 100).toFixed(2),
			}),
		);
		const call = s.asaas.createCardCharge.mock.calls[0][0];
		expect(call).toMatchObject({
			customerId: "cus_1",
			externalReference: KEY,
			totalCents: expected.totalCents,
			installments: 3,
			installmentCents: expected.installmentCents[0],
			remoteIp: "203.0.113.7",
			card: { holderName: "ANA SOUZA", number: CARD_NUMBER, expiryMonth: "12", expiryYear: "2099", ccv: CVV },
			holder: { name: "Ana Souza", email: "ana@example.com", cpfCnpj: CPF, postalCode: "01310100", addressNumber: "100", phone: "11987654321" },
		});
		expect(call.card).not.toHaveProperty("cvv");
		expect(s.bind).toHaveBeenCalledWith({}, "ch1", {
			asaasPaymentId: "pay_1",
			asaasInstallmentId: "ins_1",
			cardBrand: "VISA",
			cardLast4: "4242",
		});
	});

	it("ignores totals sent by the browser: the object that reaches the server has no field for them", async () => {
		const tampered = { ...cardInput(), total: "1.00", totalCents: 100, feeAmount: "0.00" } as CheckoutInput;
		const expected = computeCardCharge(FEES, { rechargeCents: 10000, installments: 3 });

		await runCheckout(session, clientScope, tampered, meta);

		expect(s.asaas.createCardCharge.mock.calls[0][0].totalCents).toBe(expected.totalCents);
	});

	it("is off when CARD_FEE_TABLE is empty or invalid", async () => {
		s.feeConfig.mockReturnValueOnce(null);
		s.feeConfig.mockImplementationOnce(() => {
			throw new Error("CARD_FEE_TABLE must look like x");
		});

		const empty = await runCheckout(session, clientScope, cardInput(), meta);
		const invalid = await runCheckout(session, clientScope, cardInput(), meta);

		expect(empty.error).toMatch(/indisponível/);
		expect(invalid.error).toMatch(/indisponível/);
		expect(s.reserve).not.toHaveBeenCalled();
	});

	it("refuses an installment plan below the minimum installment", async () => {
		const result = await runCheckout(session, clientScope, cardInput({ amount: "10.00", installments: 12 }), meta);

		expect(result.error).toMatch(/Parcela abaixo/);
		expect(s.reserve).not.toHaveBeenCalled();
	});

	it("requires address and phone for the card even when the NFS-e is off", async () => {
		s.view.mockResolvedValue({ ...fullView, phoneMasked: null, postalCodeMasked: null, hasAddressNumber: false });

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result.error).toMatch(/dados de pagamento/);
	});

	it("allows 5 attempts in the hour and blocks the 6th, rolling the reservation back", async () => {
		s.attempts.mockResolvedValue(5);
		const fifth = await runCheckout(session, clientScope, cardInput(), meta);
		s.attempts.mockResolvedValue(6);
		s.asaas.createCardCharge.mockClear();
		const sixth = await runCheckout(session, clientScope, cardInput(), meta);

		expect(fifth.error).toBeNull();
		expect(sixth.error).toMatch(/Muitas tentativas/);
		expect(s.asaas.createCardCharge).not.toHaveBeenCalled();
	});

	it("a refusal cancels the reserved row, credits nothing and shows the refusal message", async () => {
		s.asaas.createCardCharge.mockRejectedValue(new CardDeclinedError());

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result).toEqual({ error: new CardDeclinedError().message });
		expect(s.cancel).toHaveBeenCalledWith({}, "ch1");
		expect(s.bind).not.toHaveBeenCalled();
	});

	it("an unknown outcome keeps the row pending, makes no second call and reports processing", async () => {
		s.asaas.createCardCharge.mockRejectedValue(new AsaasOutcomeUnknownError("timeout"));

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result).toEqual({ error: null, id: "ch1", method: "CREDIT_CARD", summary: expect.any(Object) });
		expect(s.asaas.createCardCharge).toHaveBeenCalledTimes(1);
		expect(s.cancel).not.toHaveBeenCalled();
		expect(s.bind).not.toHaveBeenCalled();
	});

	it("an unknown outcome while creating the customer closes the row: no charge exists yet", async () => {
		s.load.mockResolvedValue(loaded({ asaasCustomerId: null, owned: false }));
		s.asaas.createCustomer.mockRejectedValue(new AsaasOutcomeUnknownError("timeout"));

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result.error).toMatch(/cartão/);
		expect(s.cancel).toHaveBeenCalledWith({}, "ch1");
		expect(s.asaas.createCardCharge).not.toHaveBeenCalled();
	});

	it.each(["paid", "refunded"])("does not raise the unbound alarm when the bind is false because the webhook won the race (%s)", async (status) => {
		s.bind.mockResolvedValue(false);
		s.status.mockResolvedValue({ status, billingType: "CREDIT_CARD" });
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result).toEqual({ error: null, id: "ch1", method: "CREDIT_CARD", summary: expect.any(Object) });
		expect(s.status).toHaveBeenCalledWith({}, "ch1", clientScope);
		expect(JSON.stringify(log.mock.calls)).not.toContain("sem ligação");
		log.mockRestore();
	});

	it("raises the unbound alarm when the bind is false and the charge is still pending", async () => {
		s.bind.mockResolvedValue(false);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		await runCheckout(session, clientScope, cardInput(), meta);

		expect(JSON.stringify(log.mock.calls)).toContain("COBRANÇA sem ligação");
		log.mockRestore();
	});

	it("still reports processing when the bind fails after the charge exists", async () => {
		s.bind.mockResolvedValue(false);

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result).toEqual({ error: null, id: "ch1", method: "CREDIT_CARD", summary: expect.any(Object) });
		expect(s.cancel).not.toHaveBeenCalled();
	});
});

describe("runCheckout, card abuse limits", () => {
	it("passes the request IP to the reservation for the card only", async () => {
		await runCheckout(session, clientScope, cardInput(), meta);
		await runCheckout(session, clientScope, pixInput(), meta);

		expect(s.reserve.mock.calls[0][2]).toMatchObject({ requestIp: "203.0.113.7" });
		expect(s.reserve.mock.calls[1][2]).toMatchObject({ requestIp: null });
	});

	it("allows 10 attempts per IP in the hour and blocks the 11th, rolling the reservation back", async () => {
		s.ipAttempts.mockResolvedValue(10);
		const tenth = await runCheckout(session, clientScope, cardInput(), meta);
		s.ipAttempts.mockResolvedValue(11);
		s.asaas.createCardCharge.mockClear();
		const eleventh = await runCheckout(session, clientScope, cardInput(), meta);

		expect(tenth.error).toBeNull();
		expect(eleventh.error).toMatch(/Muitas tentativas/);
		expect(s.asaas.createCardCharge).not.toHaveBeenCalled();
		expect(s.ipAttempts).toHaveBeenLastCalledWith({}, "203.0.113.7", expect.any(Date));
		const since = s.ipAttempts.mock.calls[0][2] as Date;
		expect(Date.now() - since.getTime()).toBeGreaterThan(3_590_000);
		expect(Date.now() - since.getTime()).toBeLessThan(3_610_000);
	});

	it("allows 40 attempts per Bureau in the hour and blocks the 41st, with the session Bureau only", async () => {
		s.bureauAttempts.mockResolvedValue(40);
		const fortieth = await runCheckout(session, clientScope, cardInput(), meta);
		s.bureauAttempts.mockResolvedValue(41);
		s.asaas.createCardCharge.mockClear();
		const next = await runCheckout(session, clientScope, cardInput(), meta);

		expect(fortieth.error).toBeNull();
		expect(next.error).toMatch(/Muitas tentativas/);
		expect(s.asaas.createCardCharge).not.toHaveBeenCalled();
		expect(s.bureauAttempts).toHaveBeenLastCalledWith({}, BUREAU_ID, expect.any(Date));
	});

	it("an over-limit attempt reserves nothing that survives: the BlockedError aborts before the customer step", async () => {
		s.ipAttempts.mockResolvedValue(11);

		await runCheckout(session, clientScope, cardInput(), meta);

		expect(s.asaas.createCustomer).not.toHaveBeenCalled();
		expect(s.setCustomer).not.toHaveBeenCalled();
		expect(s.bind).not.toHaveBeenCalled();
	});

	it("Pix ignores the IP and Bureau card counters", async () => {
		s.ipAttempts.mockResolvedValue(99);
		s.bureauAttempts.mockResolvedValue(99);

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result.error).toBeNull();
		expect(s.ipAttempts).not.toHaveBeenCalled();
		expect(s.bureauAttempts).not.toHaveBeenCalled();
	});

	it("a reused reservation is not counted again", async () => {
		s.reserve.mockResolvedValue({ ok: true, id: "ch1", expiresAt: new Date(), reused: true });

		await runCheckout(session, clientScope, cardInput(), meta);

		expect(s.ipAttempts).not.toHaveBeenCalled();
		expect(s.bureauAttempts).not.toHaveBeenCalled();
	});
});

describe("runCheckout, Asaas customer deleted after being stored", () => {
	const goneCard = () => s.asaas.createCardCharge.mockRejectedValueOnce(new CardDeclinedError());

	it("card 400 with the stored customer gone: forgets it, remakes it and charges once more (no refusal message)", async () => {
		goneCard();
		s.asaas.customerExists.mockResolvedValue(false);

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result).toEqual({ error: null, id: "ch1", method: "CREDIT_CARD", summary: expect.any(Object) });
		expect(s.clear).toHaveBeenCalledWith({}, "pp1", "cus_1");
		expect(s.asaas.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ externalReference: "pp1" }));
		expect(s.asaas.createCardCharge).toHaveBeenCalledTimes(2);
		expect(s.asaas.createCardCharge.mock.calls[1][0]).toMatchObject({ customerId: "cus_new" });
		expect(s.cancel).not.toHaveBeenCalled();
	});

	it("card 400 with the customer still there is a real refusal: no retry, refusal message", async () => {
		goneCard();

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result).toEqual({ error: new CardDeclinedError().message });
		expect(s.clear).not.toHaveBeenCalled();
		expect(s.asaas.createCardCharge).toHaveBeenCalledTimes(1);
	});

	it("retries only once: a second 400 after the remake is the refusal", async () => {
		s.asaas.createCardCharge.mockRejectedValue(new CardDeclinedError());
		s.asaas.customerExists.mockResolvedValue(false);

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result).toEqual({ error: new CardDeclinedError().message });
		expect(s.asaas.createCardCharge).toHaveBeenCalledTimes(2);
		expect(s.clear).toHaveBeenCalledTimes(1);
	});

	it("customer remake fails: generic message, never the refusal one, and the row is closed", async () => {
		goneCard();
		s.asaas.customerExists.mockResolvedValue(false);
		s.asaas.createCustomer.mockRejectedValue(new Error("boom"));

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result.error).toMatch(/Não foi possível processar o cartão/);
		expect(s.cancel).toHaveBeenCalledWith({}, "ch1");
	});

	it("Pix 400 with the stored customer gone is remade the same way", async () => {
		s.asaas.createPixCharge.mockRejectedValueOnce(new AsaasHttpError(400, "POST /v3/payments"));
		s.asaas.customerExists.mockResolvedValue(false);

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result.error).toBeNull();
		expect(s.asaas.createPixCharge.mock.calls[1][0]).toMatchObject({ customerId: "cus_new" });
	});

	it("a customer we could not check (Asaas down) keeps the normal refusal path", async () => {
		goneCard();
		s.asaas.customerExists.mockRejectedValue(new AsaasOutcomeUnknownError("timeout"));

		const result = await runCheckout(session, clientScope, cardInput(), meta);

		expect(result).toEqual({ error: new CardDeclinedError().message });
		expect(s.clear).not.toHaveBeenCalled();
	});

	it("an 'other' payer never goes through the remake path", async () => {
		goneCard();
		s.asaas.customerExists.mockResolvedValue(false);

		const result = await runCheckout(session, clientScope, cardInput({ payerKind: "other", payer: otherPayer, declaration: true }), meta);

		expect(result).toEqual({ error: new CardDeclinedError().message });
		expect(s.clear).not.toHaveBeenCalled();
		expect(s.asaas.createCardCharge).toHaveBeenCalledTimes(1);
	});
});

describe("runCheckout, PII", () => {
	it("fails closed with a generic message when there is no valid PII key", async () => {
		s.keyring.mockImplementation(() => {
			throw new Error("PII_ENCRYPTION_KEY must look like id:base64");
		});

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result).toEqual({ error: "Pagamento indisponível. Contate o suporte." });
		expect(s.reserve).not.toHaveBeenCalled();
	});

	it("turns an unreadable blob into the generic message", async () => {
		s.load.mockRejectedValue(new PiiDecryptError());

		const result = await runCheckout(session, clientScope, pixInput(), meta);

		expect(result).toEqual({ error: "Pagamento indisponível. Contate o suporte." });
		expect(s.asaas.createPixCharge).not.toHaveBeenCalled();
	});

	it("never puts card number, CVV or the full document in logs, errors or results", async () => {
		const outputs: unknown[] = [];
		s.asaas.createCardCharge.mockRejectedValueOnce(new CardDeclinedError());
		outputs.push(await runCheckout(session, clientScope, cardInput(), meta));
		s.asaas.createCardCharge.mockRejectedValueOnce(new Error(`bad ${CARD_NUMBER} ${CVV} ${CPF}`));
		outputs.push(await runCheckout(session, clientScope, cardInput(), meta));
		s.asaas.createCardCharge.mockRejectedValueOnce(new AsaasOutcomeUnknownError("timeout"));
		outputs.push(await runCheckout(session, clientScope, cardInput(), meta));
		outputs.push(await runCheckout(session, clientScope, cardInput(), meta));

		const seen = JSON.stringify([outputs, errorSpy.mock.calls, warnSpy.mock.calls]);
		for (const secret of [CARD_NUMBER, CVV, CPF, "01310100", "2099"]) expect(seen).not.toContain(secret);
		expect(seen).not.toContain("pay_1");
	});
});
