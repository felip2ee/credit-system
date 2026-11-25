// Checkout (Pix e cartão) contra um Postgres real, sob RLS, com o driver Asaas fake. Cada teste usa Bureaus novos.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system_test",
		BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
		BETTER_AUTH_URL: "http://localhost:3000",
		DOCUMENT_ROOT: "/tmp/reino-test-documents",
		CLAMAV_HOST: "localhost",
		CLAMAV_PORT: "3310",
		SMTP_HOST: "smtp.example.test",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USER: "credit-system",
		SMTP_PASS: "test-password",
		ASAAS_DRIVER: "fake",
		ASAAS_WEBHOOK_TOKEN: "i".repeat(32),
		DATABASE_WEBHOOK_URL:
			process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system_test",
		PII_ENCRYPTION_KEY: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
		CARD_FEE_TABLE: "12:3.99:49",
		CARD_MIN_INSTALLMENT_CENTS: "500",
	});
});

// Contadores e falhas injetadas no cliente Asaas fake: o resto do comportamento é o do fake.
const hooks = vi.hoisted(() => ({
	pix: 0,
	pixAmounts: [] as string[],
	card: 0,
	customers: 0,
	cardError: null as null | (() => Error),
}));

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/asaas", async () => {
	const actual = await vi.importActual<typeof import("@/lib/asaas")>("@/lib/asaas");
	const fake = await vi.importActual<typeof import("@/lib/asaas/fake")>("@/lib/asaas/fake");
	const base = fake.createFakeAsaasClient();
	const client: typeof base = {
		...base,
		createPixCharge: async (input) => {
			hooks.pix++;
			hooks.pixAmounts.push(input.amount);
			return base.createPixCharge(input);
		},
		createCustomer: async (input) => {
			hooks.customers++;
			return base.createCustomer(input);
		},
		createCardCharge: async (input) => {
			hooks.card++;
			if (hooks.cardError) throw hooks.cardError();
			return base.createCardCharge(input);
		},
	};
	return { ...actual, getAsaasClient: () => client };
});

import { POST } from "@/app/api/webhooks/asaas/route";
import { AsaasOutcomeUnknownError, getAsaasClient } from "@/lib/asaas";
import { ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";
import { buildFakePaymentEvent, getFakeCustomer, resetFakeCustomers } from "@/lib/asaas/fake";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import type { CheckoutInput } from "@/lib/validators/checkout";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { leaks } from "@/test/leaks";
import { seedClientProfile, seedTenant, type SeededTenant } from "@/test/seed";
import { computeCardCharge } from "@/lib/wallet/card-fees";

import { runCheckout } from "./checkout";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

function cpfFrom(base: string): string {
	const digit = (digits: string) => {
		const sum = Array.from(digits).reduce((acc, d, i) => acc + Number(d) * (digits.length + 1 - i), 0);
		const rest = (sum * 10) % 11;
		return rest === 10 ? 0 : rest;
	};
	const d1 = digit(base);
	return `${base}${d1}${digit(base + d1)}`;
}
const CPF = cpfFrom("529982247");
const CPF_OTHER = cpfFrom("111444777");
const CEP = "01310100";
const GOOD_CARD = "4242424242424242";
const DECLINED_CARD = "4000000000000002";
const CVV = "987";
// IP novo por teste (e por execução): as contagens de cartão por IP e por Bureau varrem todas as linhas com o mesmo IP.
const runSalt = Math.floor(Math.random() * 200) + 20;
let ipSeq = 0;
const freshMeta = () => ({ remoteIp: `10.${runSalt}.${Math.floor(ipSeq / 250)}.${(ipSeq++ % 250) + 1}`, description: "Recarga" });
let META = freshMeta();
const FEES = { bands: [{ maxInstallments: 12, percent: 3.99, fixedCents: 49 }], minInstallmentCents: 500 };

const cardOf = (number = GOOD_CARD) => ({
	number,
	holderName: "ANA SOUZA",
	expiryMonth: "12",
	expiryYear: "2099",
	cvv: CVV,
});
const input = (over: Partial<CheckoutInput> = {}): CheckoutInput => ({
	amount: "100.00",
	method: "PIX",
	payerKind: "owner",
	idempotencyKey: randomUUID(),
	...over,
});
const cardInput = (over: Partial<CheckoutInput> = {}) =>
	input({ method: "CREDIT_CARD", installments: 3, card: cardOf(), ...over });
const bureauScope = (t: SeededTenant) => ({ kind: "bureau" as const, bureauId: t.bureau.id });
const clientScope = (t: SeededTenant) => ({ kind: "client" as const, clientProfileId: t.client.userId });
// Dados do dono do Bureau (empresa): o Bureau não tem Titular, então tudo vem do formulário.
const bureauPayer = { name: "Bureau Ltda", document: CPF, phone: "+5511987654321", postalCode: CEP, addressNumber: "100" };

async function charge(ref: string) {
	const { rows } = await owner.query<{
		id: string;
		status: string;
		billing_type: string;
		installments: number;
		amount: string;
		fee_amount: string;
		total_charged: string | null;
		asaas_customer_id: string | null;
		asaas_payment_id: string | null;
		asaas_installment_id: string | null;
		payer_kind: string;
		payer_document_masked: string;
		card_last4: string | null;
	}>(
		`select id, status, billing_type, installments, amount, fee_amount, total_charged, asaas_customer_id,
		        asaas_payment_id, asaas_installment_id, payer_kind, payer_document_masked, card_last4
		   from pix_charges where external_reference = $1`,
		[ref],
	);
	return rows[0];
}

const countRows = async (bureauId: string) =>
	Number((await owner.query("select count(*)::int as n from pix_charges where bureau_id = $1", [bureauId])).rows[0].n);

const bureauBalance = async (bureauId: string) =>
	(await owner.query<{ available: string }>("select available from wallets where bureau_id = $1", [bureauId])).rows[0].available;
const clientBalance = async (id: string) =>
	(await owner.query<{ available: string }>("select available from client_wallets where client_profile_id = $1", [id])).rows[0].available;

async function verifyEmail(identity: DbIdentity): Promise<void> {
	await owner.query('update "user" set email_verified = true where id = $1', [identity.userId]);
}

async function giveHolderAddress(t: SeededTenant, document = CPF): Promise<void> {
	await owner.query("update holders set document = $2, zip_code = $3, address_number = '55' where id = $1", [
		t.holder.id,
		document,
		CEP,
	]);
}

function webhook(payload: unknown) {
	return POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers: new Headers({ "content-type": "application/json", [ASAAS_WEBHOOK_TOKEN_HEADER]: "i".repeat(32) }),
			body: JSON.stringify(payload),
		}),
	);
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	hooks.pix = 0;
	hooks.pixAmounts = [];
	hooks.card = 0;
	hooks.customers = 0;
	hooks.cardError = null;
	META = freshMeta();
	resetFakeCustomers();
	errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Bureau Pix (owner)", () => {
	it("asks only what is missing, then the next Pix needs no data and reuses the same Asaas customer", async () => {
		const t = await seedTenant(owner, "Co Pix");
		const admin = t.bureauAdmin;

		const missing = await runCheckout(admin, bureauScope(t), input(), META);
		const first = input({ payer: { name: bureauPayer.name, document: CPF } });
		const created = await runCheckout(admin, bureauScope(t), first, META);
		const second = input();
		const again = await runCheckout(admin, bureauScope(t), second, META);

		expect(missing.error).toMatch(/dados de pagamento/);
		expect(created).toMatchObject({ error: null, method: "PIX" });
		expect(again).toMatchObject({ error: null, method: "PIX" });
		const c1 = await charge(first.idempotencyKey);
		const c2 = await charge(second.idempotencyKey);
		expect(c1).toMatchObject({ status: "pending", payer_kind: "owner", payer_document_masked: "***.982.***-**" });
		expect(c1.asaas_customer_id).toMatch(/^cus_fake_/);
		expect(c2.asaas_customer_id).toBe(c1.asaas_customer_id);
		expect(hooks.customers).toBe(1);
		const { rows } = await owner.query(
			"select document_masked, pii_ciphertext from payer_profiles where bureau_id = $1 and client_profile_id is null",
			[t.bureau.id],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].document_masked).toBe("***.982.***-**");
		expect(rows[0].pii_ciphertext.toString("utf8")).not.toContain(CPF);
	});

	it("double submit with the same key (in parallel) calls Asaas once and keeps one row", async () => {
		const t = await seedTenant(owner, "Co Dup");
		const body = input({ payer: { name: bureauPayer.name, document: CPF } });

		const [a, b] = await Promise.all([
			runCheckout(t.bureauAdmin, bureauScope(t), body, META),
			runCheckout(t.bureauAdmin, bureauScope(t), body, META),
		]);

		expect(hooks.pix).toBe(1);
		expect(await countRows(t.bureau.id)).toBe(1);
		expect([a, b].filter((r) => "reused" in r)).toHaveLength(1);
		expect([a, b].filter((r) => r.error === null && "pixPayload" in r)).toHaveLength(1);
	});

	it("'other' persists nothing in payer_profiles and never reuses a customer found by document", async () => {
		const t = await seedTenant(owner, "Co Other");
		const preexisting = await getAsaasClient().createCustomer({ name: "Pre Existente", cpfCnpj: CPF_OTHER, email: "pre@example.com" });
		hooks.customers = 0;
		const body = input({
			payerKind: "other",
			declaration: true,
			payer: { name: "Bia Lima", document: CPF_OTHER, email: "bia@example.com", phone: "+5511999998888", postalCode: "04538133", addressNumber: "10" },
		});
		const second = { ...body, idempotencyKey: randomUUID() };

		const r1 = await runCheckout(t.bureauAdmin, bureauScope(t), body, META);
		const r2 = await runCheckout(t.bureauAdmin, bureauScope(t), second, META);

		expect([r1.error, r2.error]).toEqual([null, null]);
		expect((await owner.query("select 1 from payer_profiles where bureau_id = $1", [t.bureau.id])).rows).toHaveLength(0);
		const c1 = await charge(body.idempotencyKey);
		const c2 = await charge(second.idempotencyKey);
		expect(c1).toMatchObject({ payer_kind: "other", payer_document_masked: "***.444.***-**" });
		expect(hooks.customers).toBe(2);
		expect(new Set([c1.asaas_customer_id, c2.asaas_customer_id, preexisting.asaasCustomerId]).size).toBe(3);
		expect(getFakeCustomer(c1.asaas_customer_id as string)?.externalReference).toBe(c1.id);
		expect(getFakeCustomer(c2.asaas_customer_id as string)?.externalReference).toBe(c2.id);
		expect(getFakeCustomer(preexisting.asaasCustomerId)).toMatchObject({ name: "Pre Existente", externalReference: null });
	});

	it("refuses the operator at the database: no wallet reservation for a role without wallet:topup rights", async () => {
		const t = await seedTenant(owner, "Co Op");

		const result = await runCheckout(t.operator, bureauScope(t), input({ payer: { name: "X Y", document: CPF } }), META);

		expect(result.error).not.toBeNull();
		expect(hooks.pix).toBe(0);
		expect(await countRows(t.bureau.id)).toBe(0);
	});
});

describe("card", () => {
	it("charges the server total, stores fee and total, and does not credit before the webhook", async () => {
		const t = await seedTenant(owner, "Co Card");
		const body = cardInput({ payer: bureauPayer });
		const expected = computeCardCharge(FEES, { rechargeCents: 10000, installments: 3 });

		const result = await runCheckout(t.bureauAdmin, bureauScope(t), body, META);

		expect(result).toMatchObject({ error: null, method: "CREDIT_CARD" });
		const row = await charge(body.idempotencyKey);
		expect(row).toMatchObject({
			status: "pending",
			billing_type: "CREDIT_CARD",
			installments: 3,
			amount: "100.00",
			fee_amount: (expected.feeCents / 100).toFixed(2),
			total_charged: (expected.totalCents / 100).toFixed(2),
			card_last4: "4242",
			asaas_installment_id: `ins_fake_${body.idempotencyKey}`,
		});
		expect(await bureauBalance(t.bureau.id)).toBe("0.00");
	});

	it("a refusal leaves no live row, credits nothing and counts toward the hourly limit", async () => {
		const t = await seedTenant(owner, "Co Decline");
		const body = cardInput({ payer: bureauPayer, card: cardOf(DECLINED_CARD) });

		const result = await runCheckout(t.bureauAdmin, bureauScope(t), body, META);

		expect(result.error).toMatch(/recusado/);
		expect((await charge(body.idempotencyKey)).status).toBe("cancelled");
		expect(await bureauBalance(t.bureau.id)).toBe("0.00");
		const pending = await owner.query("select 1 from pix_charges where bureau_id = $1 and status = 'pending'", [t.bureau.id]);
		expect(pending.rows).toHaveLength(0);
	});

	it("an unknown outcome keeps the row pending and a resend with the same key makes no second call", async () => {
		const t = await seedTenant(owner, "Co Unknown");
		const body = cardInput({ payer: bureauPayer });
		hooks.cardError = () => new AsaasOutcomeUnknownError("timeout");

		const first = await runCheckout(t.bureauAdmin, bureauScope(t), body, META);
		hooks.cardError = null;
		const resend = await runCheckout(t.bureauAdmin, bureauScope(t), body, META);

		expect(first).toMatchObject({ error: null, method: "CREDIT_CARD" });
		expect(resend).toMatchObject({ error: null, reused: true });
		expect(hooks.card).toBe(1);
		expect((await charge(body.idempotencyKey)).status).toBe("pending");
	});

	it("allows 5 card attempts per hour and blocks the 6th without leaving a row or calling Asaas", async () => {
		const t = await seedTenant(owner, "Co Limit");
		await runCheckout(t.bureauAdmin, bureauScope(t), cardInput({ payer: bureauPayer, card: cardOf(DECLINED_CARD) }), META);
		for (let i = 0; i < 4; i++) {
			await runCheckout(t.bureauAdmin, bureauScope(t), cardInput({ card: cardOf(DECLINED_CARD) }), META);
		}
		hooks.card = 0;
		const sixthKey = randomUUID();

		const sixth = await runCheckout(t.bureauAdmin, bureauScope(t), cardInput({ idempotencyKey: sixthKey }), META);

		expect(sixth.error).toMatch(/Muitas tentativas/);
		expect(hooks.card).toBe(0);
		expect(await charge(sixthKey)).toBeUndefined();
		expect(await countRows(t.bureau.id)).toBe(5);
	});

	it("blocks the 11th card attempt from one IP across Bureaus, leaves no row and does not call Asaas", async () => {
		const [a, b, c] = [await seedTenant(owner, "Co Ip A"), await seedTenant(owner, "Co Ip B"), await seedTenant(owner, "Co Ip C")];
		const declined = () => cardInput({ payer: bureauPayer, card: cardOf(DECLINED_CARD) });
		for (const t of [a, b]) {
			for (let i = 0; i < 5; i++) await runCheckout(t.bureauAdmin, bureauScope(t), declined(), META);
		}
		hooks.card = 0;
		const eleventhKey = randomUUID();

		const eleventh = await runCheckout(c.bureauAdmin, bureauScope(c), cardInput({ payer: bureauPayer, idempotencyKey: eleventhKey }), META);
		const otherIp = await runCheckout(c.bureauAdmin, bureauScope(c), cardInput({ payer: bureauPayer }), freshMeta());

		expect(eleventh.error).toMatch(/Muitas tentativas/);
		expect(await charge(eleventhKey)).toBeUndefined();
		expect(await countRows(c.bureau.id)).toBe(1);
		expect(hooks.card).toBe(1);
		expect(otherIp.error).toBeNull();
	});

	it("simulation: card 3x for the Bureau owner, 3 webhooks, the balance rises once by the recharge", async () => {
		const t = await seedTenant(owner, "Co E2E");
		const body = cardInput({ payer: bureauPayer });
		const result = await runCheckout(t.bureauAdmin, bureauScope(t), body, META);
		expect(result.error).toBeNull();
		const row = await charge(body.idempotencyKey);
		const installment = row.asaas_installment_id as string;
		const share = Number(row.total_charged) / 3;

		const events = [row.asaas_payment_id as string, `pay_p2_${randomUUID()}`, `pay_p3_${randomUUID()}`].map((id) =>
			buildFakePaymentEvent({
				eventId: `evt_${randomUUID()}`,
				asaasPaymentId: id,
				value: share,
				event: "PAYMENT_CONFIRMED",
				externalReference: body.idempotencyKey,
				installment,
			}),
		);
		for (const event of events) expect((await webhook(event)).status).toBe(200);

		expect(await bureauBalance(t.bureau.id)).toBe("100.00");
		expect((await charge(body.idempotencyKey)).status).toBe("paid");
	});
});

describe("Pix fee passthrough (PIX_FEE_CENTS)", () => {
	const withFee = async (value: string | undefined, run: () => Promise<void>) => {
		const before = process.env.PIX_FEE_CENTS;
		if (value === undefined) delete process.env.PIX_FEE_CENTS;
		else process.env.PIX_FEE_CENTS = value;
		try {
			await run();
		} finally {
			if (before === undefined) delete process.env.PIX_FEE_CENTS;
			else process.env.PIX_FEE_CENTS = before;
		}
	};
	const paymentEvent = (row: Awaited<ReturnType<typeof charge>>, ref: string, value: number, event = "PAYMENT_RECEIVED") =>
		buildFakePaymentEvent({
			eventId: `evt_${randomUUID()}`,
			asaasPaymentId: row.asaas_payment_id as string,
			value,
			event,
			externalReference: ref,
		});

	it("charges recharge + fee at Asaas, stores both, credits only the recharge and reverses only the recharge", async () => {
		await withFee("199", async () => {
			const t = await seedTenant(owner, "Co Pix Fee");
			const body = input({ payer: bureauPayer });

			const result = await runCheckout(t.bureauAdmin, bureauScope(t), body, META);

			expect(result).toMatchObject({ error: null, method: "PIX", summary: { rechargeCents: 10000, feeCents: 199, totalCents: 10199 } });
			expect(hooks.pixAmounts).toEqual(["101.99"]);
			const row = await charge(body.idempotencyKey);
			expect(row).toMatchObject({ amount: "100.00", fee_amount: "1.99", total_charged: "101.99", status: "pending" });

			// Só a recarga paga: a taxa faltou, nada é creditado.
			await webhook(paymentEvent(row, body.idempotencyKey, 100));
			expect(await bureauBalance(t.bureau.id)).toBe("0.00");
			expect((await charge(body.idempotencyKey)).status).toBe("pending");

			await webhook(paymentEvent(row, body.idempotencyKey, 101.99));
			expect(await bureauBalance(t.bureau.id)).toBe("100.00");
			expect((await charge(body.idempotencyKey)).status).toBe("paid");

			await webhook(paymentEvent(row, body.idempotencyKey, 101.99, "PAYMENT_REFUNDED"));
			expect(await bureauBalance(t.bureau.id)).toBe("0.00");
			expect((await charge(body.idempotencyKey)).status).toBe("refunded");
		});
	});

	it("zero fee (variable empty) keeps the old behavior: Asaas gets the recharge and total_charged stays null", async () => {
		await withFee(undefined, async () => {
			const t = await seedTenant(owner, "Co Pix NoFee");
			const body = input({ payer: bureauPayer });

			const result = await runCheckout(t.bureauAdmin, bureauScope(t), body, META);

			expect(result).toMatchObject({ error: null, summary: { rechargeCents: 10000, feeCents: 0, totalCents: 10000 } });
			expect(hooks.pixAmounts).toEqual(["100.00"]);
			expect(await charge(body.idempotencyKey)).toMatchObject({ amount: "100.00", fee_amount: "0.00", total_charged: null });
		});
	});

	it("a resend with the same key after the fee changed reuses the row: fee and total unchanged, no Asaas call", async () => {
		const t = await seedTenant(owner, "Co Pix Reuse");
		const body = input({ payer: bureauPayer });
		await withFee("199", async () => {
			expect(await runCheckout(t.bureauAdmin, bureauScope(t), body, META)).toMatchObject({ error: null, method: "PIX" });
		});
		const before = await charge(body.idempotencyKey);

		await withFee("250", async () => {
			expect(await runCheckout(t.bureauAdmin, bureauScope(t), body, META)).toMatchObject({ error: null, reused: true });
		});

		expect(await charge(body.idempotencyKey)).toEqual(before);
		expect(before).toMatchObject({ amount: "100.00", fee_amount: "1.99", total_charged: "101.99" });
		expect(hooks.pix).toBe(1);
		expect(hooks.pixAmounts).toEqual(["101.99"]);
		expect(await countRows(t.bureau.id)).toBe(1);
	});

	it("an invalid fee config fails closed: no row and no Asaas call", async () => {
		await withFee("1.99", async () => {
			const t = await seedTenant(owner, "Co Pix BadFee");
			const body = input({ payer: bureauPayer });

			const result = await runCheckout(t.bureauAdmin, bureauScope(t), body, META);

			expect(result.error).toMatch(/indisponível/);
			expect(hooks.pix).toBe(0);
			expect(await countRows(t.bureau.id)).toBe(0);
		});
	});

	it("the R$ 10,00 to R$ 5.000,00 limit applies to the recharge, not to the total", async () => {
		await withFee("199", async () => {
			const t = await seedTenant(owner, "Co Pix Limit");
			const max = input({ amount: "5000.00", payer: bureauPayer });
			const over = input({ amount: "5000.01", payer: bureauPayer });
			const min = input({ amount: "10.00", payer: bureauPayer });
			const under = input({ amount: "9.99", payer: bureauPayer });

			expect(await runCheckout(t.bureauAdmin, bureauScope(t), max, META)).toMatchObject({ error: null, summary: { totalCents: 500199 } });
			expect(await runCheckout(t.bureauAdmin, bureauScope(t), min, META)).toMatchObject({ error: null, summary: { totalCents: 1199 } });
			expect((await runCheckout(t.bureauAdmin, bureauScope(t), over, META)).error).not.toBeNull();
			expect((await runCheckout(t.bureauAdmin, bureauScope(t), under, META)).error).not.toBeNull();
		});
	});
});

describe("client", () => {
	it("pays Pix with the Holder data already known: no field asked, and the copy is stored encrypted", async () => {
		const t = await seedTenant(owner, "Cli Known");
		await verifyEmail(t.client);
		await giveHolderAddress(t);
		const body = input();

		const result = await runCheckout(t.client, clientScope(t), body, META);

		expect(result).toMatchObject({ error: null, method: "PIX" });
		expect(await charge(body.idempotencyKey)).toMatchObject({ payer_document_masked: "***.982.***-**" });
		const { rows } = await owner.query(
			"select document_masked, pii_ciphertext from payer_profiles where client_profile_id = $1",
			[t.client.userId],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].pii_ciphertext.toString("utf8")).not.toContain(CPF);
		expect(await clientBalance(t.client.userId)).toBe("0.00");
	});

	it("without a known document asks for it, and without a verified e-mail refuses before anything is reserved", async () => {
		const t = await seedTenant(owner, "Cli Ask");
		const unverified = await runCheckout(t.client, clientScope(t), input(), META);
		await verifyEmail(t.client);
		// CPF inválido (dígitos repetidos): o Titular não serve como dado conhecido.
		await owner.query("update holders set document = '111.111.111-11' where id = $1", [t.holder.id]);
		const asked = await runCheckout(t.client, clientScope(t), input(), META);

		expect(unverified.error).toMatch(/e-mail/);
		expect(asked.error).toMatch(/dados de pagamento/);
		expect(await countRows(t.bureau.id)).toBe(0);
	});

	it("the Bureau (admin and operator) never reads the payer data of a client", async () => {
		const t = await seedTenant(owner, "Cli Iso");
		await verifyEmail(t.client);
		await giveHolderAddress(t);
		await runCheckout(t.client, clientScope(t), input(), META);
		await runCheckout(t.bureauAdmin, bureauScope(t), input({ payer: { name: "Bureau X", document: CPF_OTHER } }), META);

		for (const identity of [t.bureauAdmin, t.operator]) {
			const { rows } = await withUserTransaction(identity, (c) =>
				c.query("select client_profile_id from payer_profiles"),
			);
			expect(rows.filter((r) => r.client_profile_id !== null)).toHaveLength(0);
		}
		const other = await seedClientProfile(owner, t.bureau.id);
		const { rows } = await withUserTransaction(other, (c) => c.query("select 1 from payer_profiles"));
		expect(rows).toHaveLength(0);
	});

	it("a client cannot pay into the wallet of another client or of the Bureau", async () => {
		const t = await seedTenant(owner, "Cli Scope");
		await verifyEmail(t.client);
		await giveHolderAddress(t);
		const other = await seedClientProfile(owner, t.bureau.id);

		const intoOther = await runCheckout(t.client, { kind: "client", clientProfileId: other.userId }, input(), META);
		const intoBureau = await runCheckout(t.client, bureauScope(t), input({ payer: { name: "Z Z", document: CPF } }), META);

		expect(intoOther.error).not.toBeNull();
		expect(intoBureau.error).not.toBeNull();
		expect(await countRows(t.bureau.id)).toBe(0);
	});
});

describe("sensitive data", () => {
	it("keeps card number, CVV, document and postal code out of audit, logs and results", async () => {
		const t = await seedTenant(owner, "Co Leak");
		const results = [
			await runCheckout(t.bureauAdmin, bureauScope(t), cardInput({ payer: bureauPayer, card: cardOf(DECLINED_CARD) }), META),
			await runCheckout(t.bureauAdmin, bureauScope(t), cardInput(), META),
			await runCheckout(t.bureauAdmin, bureauScope(t), input(), META),
		];

		const audit = await owner.query("select metadata::text as m from audit_logs where bureau_id = $1", [t.bureau.id]);
		const seen = JSON.stringify([results, audit.rows, errorSpy.mock.calls, warnSpy.mock.calls]);
		expect(audit.rows.length).toBeGreaterThan(0);
		for (const secret of [GOOD_CARD, DECLINED_CARD, CVV, CPF, CEP]) expect(leaks(seen, secret), secret).toBe(false);
		expect(leaks(seen, "2099")).toBe(false);
	});
});
