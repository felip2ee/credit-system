// HTTP 400 sobre split/walletId vira AsaasSplitRejectedError; qualquer outro 400 segue como antes.
import { describe, expect, it, vi } from "vitest";

import { AsaasHttpError, AsaasSplitRejectedError, CardDeclinedError, createAsaasClient } from "./client";
import { createFakeAsaasClient, FAKE_UNKNOWN_WALLET_ID } from "./fake";
import type { CardChargeInput } from "./types";

const settings = { apiKey: "secret-key", baseUrl: "https://api.asaas.example" };
const WALLET = "11111111-2222-3333-4444-555555555555";
const split = [{ walletId: WALLET, percentualValue: 10 }];
const pix = { customerId: "cus_1", amount: "25.50", externalReference: "ref-1", description: "Recarga" };
const card: CardChargeInput = {
	customerId: "cus_1",
	externalReference: "ref-1",
	description: "Recarga",
	totalCents: 2550,
	installments: 1,
	installmentCents: 2550,
	card: { holderName: "ANA", number: "4242424242424242", expiryMonth: "12", expiryYear: "2099", ccv: "987" },
	holder: { name: "Ana", email: "a@example.com", cpfCnpj: "52998224725", postalCode: "01310100", addressNumber: "1", phone: "11987654321" },
	remoteIp: "10.0.0.1",
};
const answer = (body: unknown, status = 400) =>
	createAsaasClient(settings, vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { status })));
const errors = (...list: [string, string][]) => ({ errors: list.map(([code, description]) => ({ code, description })) });

const SPLIT_BODIES = [
	errors(["invalid_walletId", "Informe um walletId válido."]),
	errors(["invalid_action", `Wallet [${WALLET}] inexistente.`]),
	errors(["invalid_action", "Habilite o Split de pagamentos em Integrações > Segurança."]),
	errors(["invalid_object", "Não é permitido informar a própria carteira."]),
];
const OTHER_BODIES = [
	errors(["invalid_creditCard", "Transação não autorizada. Verifique os dados do cartão."]),
	errors(["invalid_value", "O campo value deve ser informado"]),
	errors(["invalid_creditCard", "Cartão de carteira digital não autorizado."]),
	errors(["invalid_walletId", "walletId inválido"], ["invalid_value", "O campo value deve ser informado"]),
	{ errors: [] },
	"texto solto sobre split",
	null,
];

describe("Asaas 400 about the split", () => {
	it.each(SPLIT_BODIES)("is AsaasSplitRejectedError for Pix and card, without the body", async (body) => {
		for (const call of [() => answer(body).createPixCharge({ ...pix, split }), () => answer(body).createCardCharge({ ...card, split })]) {
			const error = await call().catch((e: Error) => e);
			expect(error).toBeInstanceOf(AsaasSplitRejectedError);
			expect(error).not.toBeInstanceOf(CardDeclinedError);
			expect((error as Error).message).toBe("Asaas respondeu 400 em POST /v3/payments");
			expect(JSON.stringify(error)).not.toContain(WALLET);
		}
	});

	it.each(OTHER_BODIES)("keeps today's behavior for any other 400: %j", async (body) => {
		await expect(answer(body).createCardCharge({ ...card, split })).rejects.toBeInstanceOf(CardDeclinedError);
		const error = await answer(body).createPixCharge({ ...pix, split }).catch((e: Error) => e);
		expect(error).toBeInstanceOf(AsaasHttpError);
		expect(error).not.toBeInstanceOf(AsaasSplitRejectedError);
	});

	it("is never a split error when the request had no split, or on another status", async () => {
		const body = SPLIT_BODIES[0];
		await expect(answer(body).createCardCharge(card)).rejects.toBeInstanceOf(CardDeclinedError);
		await expect(answer(body).createCardCharge({ ...card, split: [] })).rejects.toBeInstanceOf(CardDeclinedError);
		const unauthorized = await answer(body, 401).createPixCharge({ ...pix, split }).catch((e: Error) => e);
		expect(unauthorized).not.toBeInstanceOf(AsaasSplitRejectedError);
	});

	it("the fake refuses the unknown walletId and accepts the same charge without split", async () => {
		const fake = createFakeAsaasClient();
		const bad = [{ walletId: FAKE_UNKNOWN_WALLET_ID, percentualValue: 10 }];
		await expect(fake.createPixCharge({ ...pix, split: bad })).rejects.toBeInstanceOf(AsaasSplitRejectedError);
		await expect(fake.createCardCharge({ ...card, split: bad })).rejects.toBeInstanceOf(AsaasSplitRejectedError);
		await expect(fake.createPixCharge({ ...pix, split: [] })).resolves.toMatchObject({ asaasPaymentId: "pay_fake_ref-1" });
	});
});
