// Split recusado pelo Asaas na criação da cobrança (walletId desconhecido): primeiro sai só o item do afiliado, depois
// o split inteiro. Toda parte recusada vira valor a pagar por fora (086; o sócio segue `refused`). Checkout (Pix e
// cartão) e link de pagamento contra um Postgres real, Asaas fake.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system_test",
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
		DATABASE_WEBHOOK_URL: process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system_test",
		PII_ENCRYPTION_KEY: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
		CARD_FEE_TABLE: "12:3.99:49",
		CARD_MIN_INSTALLMENT_CENTS: "500",
	});
});

// Splits enviados em cada chamada de cobrança, uma falha injetada antes do Asaas e um gancho depois da cobrança criada.
const hooks = vi.hoisted(() => ({
	sent: [] as number[],
	fail: null as null | ((items: number) => Error | null),
	created: null as null | ((asaasPaymentId: string, externalReference: string) => Promise<unknown>),
}));

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/asaas", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/asaas")>();
	const fake = await vi.importActual<typeof import("@/lib/asaas/fake")>("@/lib/asaas/fake");
	const base = fake.createFakeAsaasClient();
	async function record<T extends { asaasPaymentId: string }>(
		input: { split?: unknown[]; externalReference: string },
		create: () => Promise<T>,
	) {
		const items = input.split?.length ?? 0;
		hooks.sent.push(items);
		const failure = hooks.fail?.(items);
		if (failure) throw failure;
		const charge = await create();
		await hooks.created?.(charge.asaasPaymentId, input.externalReference);
		return charge;
	}
	const client: typeof base = {
		...base,
		createPixCharge: (input) => record(input, () => base.createPixCharge(input)),
		createCardCharge: (input) => record(input, () => base.createCardCharge(input)),
	};
	return { ...actual, getAsaasClient: () => client };
});

import { AsaasOutcomeUnknownError } from "@/lib/asaas";
import { FAKE_UNKNOWN_WALLET_ID, getFakeChargeSplit, resetFakeChargeSplits, resetFakeCustomers } from "@/lib/asaas/fake";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { createPaymentLink, resolvePaymentLink } from "@/lib/payment-links/queries";
import { getOrCreateLinkPixCharge } from "@/lib/payment-links/pix";
import type { CheckoutInput } from "@/lib/validators/checkout";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedClientProfile, seedOrderDossier, seedSuperadmin, seedTenant, type SeededTenant, type SeedSuperadmin } from "@/test/seed";

import { runCheckout } from "./checkout";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const CPF = "52998224725";
const GOOD_CARD = "4242424242424242";
const DECLINED_CARD = "4000000000000002";
const DECLINED_MESSAGE = /recusado pelo emissor/;
let SA: SeedSuperadmin;
let ipSeq = 0;
const runSalt = Math.floor(Math.random() * 200) + 20;
const meta = () => ({ remoteIp: `11.${runSalt}.0.${(ipSeq++ % 250) + 1}`, description: "Recarga" });

beforeAll(async () => {
	SA = await seedSuperadmin(owner);
});
afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});
beforeEach(async () => {
	hooks.sent = [];
	hooks.fail = null;
	hooks.created = null;
	resetFakeChargeSplits();
	resetFakeCustomers();
	vi.spyOn(console, "error").mockImplementation(() => {});
	// O walletId desconhecido de um bureau de outro teste reservaria o do afiliado (trigger da 084).
	await owner.query("delete from bureau_asaas_wallets where asaas_wallet_id = $1", [FAKE_UNKNOWN_WALLET_ID]);
});
// Sócios são globais: não podem vazar para as cobranças de outros arquivos.
afterEach(() => owner.query("delete from platform_partners"));

// Bureau com walletId (bom, desconhecido ou nenhum), indicador sem walletId (accrual) e afiliado de link em modo Pix ou,
// com affiliateWallet, em modo conta Asaas.
async function network(bureauWallet: string | null, affiliateWallet?: string) {
	const [t, referrer] = await Promise.all([seedTenant(owner, "Split Recusado"), seedTenant(owner, "Split Indicador")]);
	await owner.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, 20, $2)", [t.bureau.id, SA.userId]);
	if (bureauWallet) {
		await owner.query("insert into bureau_asaas_wallets (bureau_id, asaas_wallet_id) values ($1, $2)", [t.bureau.id, bureauWallet]);
	}
	await owner.query("insert into bureau_referrals (referrer_bureau_id, referred_bureau_id, pct) values ($1, $2, 5)", [
		referrer.bureau.id,
		t.bureau.id,
	]);
	const affiliate = await seedClientProfile(owner, t.bureau.id);
	await owner.query("insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)", [
		t.client.userId,
		affiliate.userId,
		t.bureau.id,
	]);
	await owner.query("insert into bureau_affiliate_settings (bureau_id, default_pct, affiliate_enabled) values ($1, 10, true)", [t.bureau.id]);
	const client = await owner.connect();
	try {
		// O trigger protect_profile_contact só libera as funções da conta: o superusuário o desliga na transação.
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		await client.query("update profiles set phone_e164 = '+5563999990000', phone_verified_at = now() where id = $1", [t.client.userId]);
		await client.query("commit");
	} finally {
		client.release();
	}
	if (affiliateWallet) {
		await owner.query("update affiliate_wallets set payout_method = 'asaas', asaas_wallet_id = $2 where profile_id = $1", [
			affiliate.userId,
			affiliateWallet,
		]);
	}
	return { ...t, referrer, affiliate };
}

const addPartner = (wallet: string = randomUUID()) =>
	owner.query("insert into platform_partners (name, asaas_wallet_id, pct) values ('Sócio', $1, 10)", [wallet]);

const input = (over: Partial<CheckoutInput> = {}): CheckoutInput => ({
	amount: "100.00",
	method: "PIX",
	payerKind: "other",
	declaration: true,
	payer: { name: "Bia Lima", document: CPF, email: "bia@example.com", phone: "+5511999998888", postalCode: "04538133", addressNumber: "10" },
	idempotencyKey: randomUUID(),
	...over,
});
const card = (number: string) =>
	input({ method: "CREDIT_CARD", installments: 1, card: { number, holderName: "BIA LIMA", expiryMonth: "12", expiryYear: "2099", cvv: "987" } });
const buy = (t: SeededTenant, body: CheckoutInput) =>
	runCheckout(t.client, { kind: "client", clientProfileId: t.client.userId }, body, meta());

const chargeOf = async (ref: string) =>
	(await owner.query<{ id: string; status: string; asaas_payment_id: string | null }>(
		"select id, status, asaas_payment_id from pix_charges where external_reference = $1",
		[ref],
	)).rows[0];
const lines = async (chargeId: string) =>
	(await owner.query<{ line: string }>(
		"select beneficiary_kind || ':' || payout_method || ':' || status as line from charge_splits where pix_charge_id = $1 order by 1",
		[chargeId],
	)).rows.map((r) => r.line);
const refusedAudits = async (chargeId: string) =>
	(await owner.query<{ metadata: Record<string, unknown> }>(
		"select metadata from audit_logs where action = 'charge_split.refused' and metadata ->> 'pix_charge_id' = $1",
		[chargeId],
	)).rows.map((r) => r.metadata);

// Evento do webhook do Asaas, como o app_webhook o entrega.
const webhook = (event: string, asaasPaymentId: string, externalReference?: string, value?: number) =>
	getWebhookPool()
		.query<{ result: string }>("select apply_asaas_payment($1, $2, $3, $4) as result", [
			`evt_${randomUUID()}`,
			event,
			asaasPaymentId,
			JSON.stringify({ payment: { externalReference, value } }),
		])
		.then((r) => r.rows[0].result);
// Valores a repassar e comissões que a cobrança gerou.
const payables = async (chargeId: string) =>
	(await owner.query<{ line: string }>(
		"select bureau_id || ':' || kind || ':' || amount as line from bureau_payable_entries where pix_charge_id = $1",
		[chargeId],
	)).rows.map((r) => r.line).sort();
const commissions = async (chargeId: string) =>
	(await owner.query<{ line: string }>(
		"select affiliate_profile_id || ':' || status || ':' || amount || ':' || reversed_amount as line from affiliate_commissions where order_ref = $1",
		[chargeId],
	)).rows.map((r) => r.line);
const affiliateWalletOf = async (profileId: string) =>
	(await owner.query<{ payout_method: string; asaas_wallet_id: string | null }>(
		"select payout_method, asaas_wallet_id from affiliate_wallets where profile_id = $1",
		[profileId],
	)).rows[0];
// Avisos de troca de pagamento depois do cadastro do teste (o próprio cadastro em modo Asaas gera um).
const systemNotices = async (profileId: string) =>
	(await owner.query<{ params: Record<string, string> }>(
		"select params from notifications where reference = 'affiliate_payout:' || $1::text and params ->> 'method' = 'Chave Pix'",
		[profileId],
	)).rows.map((r) => r.params);
const switchAudits = async (profileId: string) =>
	(await owner.query<{ bureau_id: string; metadata: Record<string, unknown> }>(
		"select bureau_id, metadata from audit_logs where action = 'affiliate.payout_method_rejected' and record_id = $1",
		[profileId],
	)).rows;

const PENDING = ["affiliate:pix:pending", "bureau:asaas:pending", "bureau_referrer:accrual:pending"];
const MANUAL = ["affiliate:pix:pending", "bureau:accrual:pending", "bureau_referrer:accrual:pending"];
// Só o item do afiliado saiu: sócio e bureau seguem no split do Asaas.
const AFFILIATE_OUT = ["affiliate:pix:pending", "bureau:asaas:pending", "bureau_referrer:accrual:pending", "partner:asaas:pending"];
// Split inteiro recusado: o sócio não tem repasse manual no sistema e fica `refused`.
const ALL_OUT = [...MANUAL, "partner:asaas:refused"];
const unknownOn = (items: number) => (sent: number) => (sent === items ? new AsaasOutcomeUnknownError("timeout") : null);

describe("checkout with a split that Asaas refuses", () => {
	it.each([
		["Pix", () => input()],
		["card", () => card(GOOD_CARD)],
	])("%s: without an affiliate item, retries once without split, makes the bureau share payable and audits it", async (_name, body) => {
		const t = await network(FAKE_UNKNOWN_WALLET_ID);
		const request = body();

		const result = await buy(t, request);

		expect(result.error).toBeNull();
		expect(hooks.sent).toEqual([1, 0]);
		const charge = await chargeOf(request.idempotencyKey);
		expect(charge.asaas_payment_id).not.toBeNull();
		expect(getFakeChargeSplit(charge.asaas_payment_id!)).toBeUndefined();
		expect(await lines(charge.id)).toEqual(MANUAL);
		const audits = await refusedAudits(charge.id);
		expect(audits).toEqual([
			expect.objectContaining({ beneficiary_kind: "bureau", reason: "split_rejected_on_charge", wallet: `***${FAKE_UNKNOWN_WALLET_ID.slice(-4)}` }),
		]);
		expect(JSON.stringify(audits)).not.toContain(FAKE_UNKNOWN_WALLET_ID);
	});

	it("an unknown result of the retry still marks the lines: the charge may exist without split", async () => {
		const t = await network(FAKE_UNKNOWN_WALLET_ID);
		hooks.fail = unknownOn(0);
		const request = card(GOOD_CARD);

		expect((await buy(t, request)).error).toBeNull();

		expect(hooks.sent).toEqual([1, 0]);
		expect(await lines((await chargeOf(request.idempotencyKey)).id)).toEqual(MANUAL);
	});

	it("a card declined on the retry shows the decline and marks nothing", async () => {
		const t = await network(FAKE_UNKNOWN_WALLET_ID);
		const request = card(DECLINED_CARD);

		expect((await buy(t, request)).error).toMatch(DECLINED_MESSAGE);

		expect(hooks.sent).toEqual([1, 0]);
		const charge = await chargeOf(request.idempotencyKey);
		expect(charge.status).toBe("cancelled");
		expect(await lines(charge.id)).toEqual(PENDING);
	});

	it("a declined card with a good split is not retried", async () => {
		const t = await network(randomUUID());
		const request = card(DECLINED_CARD);

		expect((await buy(t, request)).error).toMatch(DECLINED_MESSAGE);

		expect(hooks.sent).toEqual([1]);
		expect(await lines((await chargeOf(request.idempotencyKey)).id)).toEqual(PENDING);
	});

	it("payment link Pix: retries without split and records the bureau share once when paid (no session)", async () => {
		const t = await seedTenant(owner, "Split Link");
		await addPartner(FAKE_UNKNOWN_WALLET_ID);
		await owner.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, 20, $2)", [t.bureau.id, SA.userId]);
		await owner.query("insert into bureau_asaas_wallets (bureau_id, asaas_wallet_id) values ($1, $2)", [t.bureau.id, randomUUID()]);
		const orderId = randomUUID();
		await seedOrderDossier(owner, { orderRef: orderId, bureauId: t.bureau.id, clientProfileId: null, members: 1 });
		await owner.query("insert into order_settlements (order_ref, bureau_id, mode, price, cost) values ($1, $2, 'counter', 300, 120)", [orderId, t.bureau.id]);
		await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [orderId]);
		const link = await createPaymentLink(t.bureauAdmin, orderId);
		if (!link.ok) throw new Error("expected link");
		const resolved = await resolvePaymentLink(link.token);
		if (!resolved.ok) throw new Error("expected resolved link");

		expect((await getOrCreateLinkPixCharge(link.id)).ok).toBe(true);

		expect(hooks.sent).toEqual([2, 0]);
		const { rows } = await owner.query<{ id: string; asaas_payment_id: string }>(
			"select id, asaas_payment_id from pix_charges where payment_link_id = $1",
			[link.id],
		);
		expect(await lines(rows[0].id)).toEqual(["bureau:accrual:pending", "partner:asaas:refused"]);
		// A baixa do link exige o valor pago.
		expect(await webhook("PAYMENT_RECEIVED", rows[0].asaas_payment_id, undefined, 300)).toBe("link_paid");
		await webhook("PAYMENT_CONFIRMED", rows[0].asaas_payment_id, undefined, 300);
		expect(await payables(rows[0].id)).toEqual([`${t.bureau.id}:accrual:60.00`]);
	});
});

describe("checkout with a refused affiliate walletId", () => {
	it.each([
		["Pix", () => input()],
		["card", () => card(GOOD_CARD)],
	])("%s: drops only the affiliate item, switches the affiliate to Pix, e-mails and audits", async (_name, body) => {
		await addPartner();
		const t = await network(randomUUID(), FAKE_UNKNOWN_WALLET_ID);
		const request = body();

		expect((await buy(t, request)).error).toBeNull();

		expect(hooks.sent).toEqual([3, 2]);
		const charge = await chargeOf(request.idempotencyKey);
		const sentSplit = getFakeChargeSplit(charge.asaas_payment_id!)!;
		expect(sentSplit.map((i) => i.percentualValue).sort()).toEqual([10, 20]);
		expect(await lines(charge.id)).toEqual(AFFILIATE_OUT);
		expect(await affiliateWalletOf(t.affiliate.userId)).toEqual({ payout_method: "pix", asaas_wallet_id: FAKE_UNKNOWN_WALLET_ID });
		const masked = `***${FAKE_UNKNOWN_WALLET_ID.slice(-4)}`;
		expect(await systemNotices(t.affiliate.userId)).toEqual([
			expect.objectContaining({ actor: expect.stringContaining("o Asaas recusou"), wallet: masked }),
		]);
		const switched = await switchAudits(t.affiliate.userId);
		expect(switched).toEqual([
			{ bureau_id: t.bureau.id, metadata: expect.objectContaining({ from: "asaas", to: "pix", pix_charge_id: charge.id, wallet: masked }) },
		]);
		const refused = await refusedAudits(charge.id);
		expect(refused).toEqual([expect.objectContaining({ beneficiary_kind: "affiliate", manual_method: "pix" })]);
		expect(JSON.stringify([switched, refused])).not.toContain(FAKE_UNKNOWN_WALLET_ID);

		// Pago duas vezes: uma comissão e um accrual (do indicador). O bureau dono recebeu pelo split.
		await webhook("PAYMENT_RECEIVED", charge.asaas_payment_id!);
		await webhook("PAYMENT_CONFIRMED", charge.asaas_payment_id!);
		expect(await commissions(charge.id)).toEqual([`${t.affiliate.userId}:released:10.00:0.00`]);
		expect(await payables(charge.id)).toEqual([`${t.referrer.bureau.id}:accrual:5.00`]);

		await webhook("PAYMENT_REFUNDED", charge.asaas_payment_id!);
		expect(await commissions(charge.id)).toEqual([`${t.affiliate.userId}:reversed:10.00:10.00`]);
		expect(await payables(charge.id)).toEqual([`${t.referrer.bureau.id}:accrual:5.00`, `${t.referrer.bureau.id}:reversal:-5.00`]);
	});

	it("a second rejection drops the whole split, never blames the affiliate and makes every share payable", async () => {
		await addPartner();
		const wallet = randomUUID();
		const t = await network(FAKE_UNKNOWN_WALLET_ID, wallet);
		const request = input();

		expect((await buy(t, request)).error).toBeNull();

		expect(hooks.sent).toEqual([3, 2, 0]);
		const charge = await chargeOf(request.idempotencyKey);
		expect(await lines(charge.id)).toEqual(ALL_OUT);
		expect(await affiliateWalletOf(t.affiliate.userId)).toEqual({ payout_method: "asaas", asaas_wallet_id: wallet });
		expect(await systemNotices(t.affiliate.userId)).toEqual([]);
		expect(await switchAudits(t.affiliate.userId)).toEqual([]);

		await webhook("PAYMENT_RECEIVED", charge.asaas_payment_id!);
		await webhook("PAYMENT_CONFIRMED", charge.asaas_payment_id!);
		const accruals = [`${t.bureau.id}:accrual:20.00`, `${t.referrer.bureau.id}:accrual:5.00`];
		expect(await payables(charge.id)).toEqual([...accruals].sort());
		expect(await commissions(charge.id)).toEqual([`${t.affiliate.userId}:released:10.00:0.00`]);

		await webhook("PAYMENT_REFUNDED", charge.asaas_payment_id!);
		expect(await payables(charge.id)).toEqual(
			[...accruals, `${t.bureau.id}:reversal:-20.00`, `${t.referrer.bureau.id}:reversal:-5.00`].sort(),
		);
		expect(await commissions(charge.id)).toEqual([`${t.affiliate.userId}:reversed:10.00:10.00`]);
		expect(await lines(charge.id)).toEqual(ALL_OUT.map((l) => l.replace(/:(pending|refused)$/, ":refunded")));
	});

	it.each([
		["the retry without the affiliate", 2, randomUUID(), FAKE_UNKNOWN_WALLET_ID, [3, 2], AFFILIATE_OUT],
		["the retry without any split", 0, FAKE_UNKNOWN_WALLET_ID, randomUUID(), [3, 2, 0], ALL_OUT],
	])("an unknown result of %s stops there and switches nobody", async (_name, items, bureauWallet, affiliateWallet, sent, expected) => {
		await addPartner();
		const t = await network(bureauWallet, affiliateWallet);
		hooks.fail = unknownOn(items);
		const request = card(GOOD_CARD);

		expect((await buy(t, request)).error).toBeNull();

		expect(hooks.sent).toEqual(sent);
		expect(await lines((await chargeOf(request.idempotencyKey)).id)).toEqual(expected);
		expect((await affiliateWalletOf(t.affiliate.userId)).payout_method).toBe("asaas");
		expect(await switchAudits(t.affiliate.userId)).toEqual([]);
	});

	it("does not overwrite a walletId the affiliate saved between the charge and the switch", async () => {
		await addPartner();
		const t = await network(randomUUID(), FAKE_UNKNOWN_WALLET_ID);
		const newer = randomUUID();
		hooks.created = () =>
			owner.query("update affiliate_wallets set asaas_wallet_id = $2 where profile_id = $1", [t.affiliate.userId, newer]);
		const request = input();

		expect((await buy(t, request)).error).toBeNull();

		expect(await affiliateWalletOf(t.affiliate.userId)).toEqual({ payout_method: "asaas", asaas_wallet_id: newer });
		expect(await switchAudits(t.affiliate.userId)).toEqual([]);
		expect(await lines((await chargeOf(request.idempotencyKey)).id)).toEqual(AFFILIATE_OUT);
	});

	it("with the affiliate as the only split item, success without split is no proof: payable, no switch", async () => {
		const t = await network(null, FAKE_UNKNOWN_WALLET_ID);
		const request = input();

		expect((await buy(t, request)).error).toBeNull();

		expect(hooks.sent).toEqual([1, 0]);
		expect(await lines((await chargeOf(request.idempotencyKey)).id)).toEqual(MANUAL);
		expect((await affiliateWalletOf(t.affiliate.userId)).payout_method).toBe("asaas");
	});

	it.each([
		["card", () => card(GOOD_CARD)],
		["Pix", () => input()],
	])("%s: a payment confirmed before the lines are marked still records every share once", async (_name, body) => {
		await addPartner();
		const t = await network(FAKE_UNKNOWN_WALLET_ID, randomUUID());
		const results: string[] = [];
		hooks.created = async (paymentId, reference) => results.push(await webhook("PAYMENT_CONFIRMED", paymentId, reference));
		const request = body();

		await buy(t, request);

		expect(results).toEqual(["credited"]);
		const charge = await chargeOf(request.idempotencyKey);
		await webhook("PAYMENT_RECEIVED", charge.asaas_payment_id!, request.idempotencyKey);
		expect(await payables(charge.id)).toEqual([`${t.bureau.id}:accrual:20.00`, `${t.referrer.bureau.id}:accrual:5.00`].sort());
		expect(await commissions(charge.id)).toEqual([`${t.affiliate.userId}:released:10.00:0.00`]);
		expect((await lines(charge.id)).filter((l) => l.endsWith(":done"))).toHaveLength(3);
	});
});

describe("charge_split_mark_refused (086)", () => {
	const mark = (identity: DbIdentity, chargeId: string) =>
		withUserTransaction(identity, (c) => c.query<{ n: number }>("select charge_split_mark_refused($1) as n", [chargeId])).then((r) => r.rows[0].n);

	async function pendingCharge() {
		const t = await network(randomUUID());
		const request = input();
		await buy(t, request);
		return { t, id: (await chargeOf(request.idempotencyKey)).id };
	}

	it("refuses another user, another bureau, a session-less caller and the webhook role", async () => {
		const { t, id } = await pendingCharge();
		const other = await seedTenant(owner, "Split Outro");

		for (const identity of [t.bureauAdmin, other.client, SA]) await expect(mark(identity, id)).rejects.toThrow(/not_allowed/);
		await expect(pool.query("select charge_split_mark_refused($1)", [id])).rejects.toThrow(/not_allowed/);
		await expect(getWebhookPool().query("select charge_split_mark_refused($1, true, true)", [id])).rejects.toThrow(
			/permission denied/,
		);
		expect(await lines(id)).toEqual(PENDING);
	});

	it("never switches the affiliate when the whole split was dropped", async () => {
		const wallet = randomUUID();
		const t = await network(randomUUID(), wallet);
		hooks.fail = unknownOn(2); // a linha fica pendente, sem marcar
		const request = input();
		await buy(t, request);
		const { id } = await chargeOf(request.idempotencyKey);

		await withUserTransaction(t.client, (c) => c.query("select charge_split_mark_refused($1, false, true)", [id]));

		expect(await affiliateWalletOf(t.affiliate.userId)).toEqual({ payout_method: "asaas", asaas_wallet_id: wallet });
	});

	it("touches only pending asaas lines that Asaas never confirmed, once", async () => {
		const { t, id } = await pendingCharge();
		await owner.query("update charge_splits set status = 'done' where pix_charge_id = $1 and beneficiary_kind = 'bureau'", [id]);

		expect(await mark(t.client, id)).toBe(0);
		expect(await lines(id)).toEqual(["affiliate:pix:pending", "bureau:asaas:done", "bureau_referrer:accrual:pending"]);
	});

	it("refuses an old charge and a cancelled one", async () => {
		const { t, id } = await pendingCharge();
		await owner.query("update pix_charges set status = 'cancelled' where id = $1", [id]);
		await expect(mark(t.client, id)).rejects.toThrow(/not_allowed/);
		const old = await pendingCharge();
		await owner.query("update pix_charges set created_at = now() - interval '2 hours' where id = $1", [old.id]);
		await expect(mark(old.t.client, old.id)).rejects.toThrow(/not_allowed/);
	});
});
