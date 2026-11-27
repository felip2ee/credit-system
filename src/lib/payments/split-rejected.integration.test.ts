// Split recusado pelo Asaas na criação da cobrança (walletId desconhecido): uma nova tentativa sem split, linhas
// asaas marcadas `refused` (079). Checkout (Pix e cartão) e link de pagamento contra um Postgres real, Asaas fake.
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

// Splits enviados em cada chamada de cobrança e uma falha injetada só na chamada sem split.
const hooks = vi.hoisted(() => ({ sent: [] as number[], retryError: null as null | (() => Error) }));

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
	const record = (split?: unknown[]) => {
		hooks.sent.push(split?.length ?? 0);
		if (!split?.length && hooks.retryError) throw hooks.retryError();
	};
	const client: typeof base = {
		...base,
		createPixCharge: async (input) => {
			record(input.split);
			return base.createPixCharge(input);
		},
		createCardCharge: async (input) => {
			record(input.split);
			return base.createCardCharge(input);
		},
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
beforeEach(() => {
	hooks.sent = [];
	hooks.retryError = null;
	resetFakeChargeSplits();
	resetFakeCustomers();
	vi.spyOn(console, "error").mockImplementation(() => {});
});
// Sócios são globais: não podem vazar para as cobranças de outros arquivos.
afterEach(() => owner.query("delete from platform_partners"));

// Bureau com walletId (bom ou desconhecido), indicador sem walletId (accrual) e afiliado de link em modo Pix.
async function network(bureauWallet: string) {
	const [t, referrer] = await Promise.all([seedTenant(owner, "Split Recusado"), seedTenant(owner, "Split Indicador")]);
	await owner.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, 20, $2)", [t.bureau.id, SA.userId]);
	await owner.query("insert into bureau_asaas_wallets (bureau_id, asaas_wallet_id) values ($1, $2)", [t.bureau.id, bureauWallet]);
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
	return t;
}

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

const PENDING = ["affiliate:pix:pending", "bureau:asaas:pending", "bureau_referrer:accrual:pending"];
const REFUSED = ["affiliate:pix:pending", "bureau:asaas:refused", "bureau_referrer:accrual:pending"];

describe("checkout with a split that Asaas refuses", () => {
	it.each([
		["Pix", () => input()],
		["card", () => card(GOOD_CARD)],
	])("%s: retries once without split, marks only the asaas lines refused and audits it", async (_name, body) => {
		const t = await network(FAKE_UNKNOWN_WALLET_ID);
		const request = body();

		const result = await buy(t, request);

		expect(result.error).toBeNull();
		expect(hooks.sent).toEqual([1, 0]);
		const charge = await chargeOf(request.idempotencyKey);
		expect(charge.asaas_payment_id).not.toBeNull();
		expect(getFakeChargeSplit(charge.asaas_payment_id!)).toBeUndefined();
		expect(await lines(charge.id)).toEqual(REFUSED);
		const audits = await refusedAudits(charge.id);
		expect(audits).toEqual([
			expect.objectContaining({ beneficiary_kind: "bureau", reason: "split_rejected_on_charge", wallet: `***${FAKE_UNKNOWN_WALLET_ID.slice(-4)}` }),
		]);
		expect(JSON.stringify(audits)).not.toContain(FAKE_UNKNOWN_WALLET_ID);
	});

	it("an unknown result of the retry still marks the lines: the charge may exist without split", async () => {
		const t = await network(FAKE_UNKNOWN_WALLET_ID);
		hooks.retryError = () => new AsaasOutcomeUnknownError("timeout");
		const request = card(GOOD_CARD);

		expect((await buy(t, request)).error).toBeNull();

		expect(hooks.sent).toEqual([1, 0]);
		expect(await lines((await chargeOf(request.idempotencyKey)).id)).toEqual(REFUSED);
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

	it("payment link Pix: retries without split and marks the lines (no session)", async () => {
		const t = await seedTenant(owner, "Split Link");
		await owner.query("insert into platform_partners (name, asaas_wallet_id, pct) values ('Sócio', $1, 10)", [FAKE_UNKNOWN_WALLET_ID]);
		const orderId = randomUUID();
		await seedOrderDossier(owner, { orderRef: orderId, bureauId: t.bureau.id, clientProfileId: null, members: 1 });
		await owner.query("insert into order_settlements (order_ref, bureau_id, mode, price, cost) values ($1, $2, 'counter', 300, 120)", [orderId, t.bureau.id]);
		await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [orderId]);
		const link = await createPaymentLink(t.bureauAdmin, orderId);
		if (!link.ok) throw new Error("expected link");
		const resolved = await resolvePaymentLink(link.token);
		if (!resolved.ok) throw new Error("expected resolved link");

		expect((await getOrCreateLinkPixCharge(link.id)).ok).toBe(true);

		expect(hooks.sent).toEqual([1, 0]);
		const { rows } = await owner.query<{ id: string }>("select id from pix_charges where payment_link_id = $1", [link.id]);
		expect(await lines(rows[0].id)).toContain("partner:asaas:refused");
	});
});

describe("charge_split_mark_refused (079)", () => {
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
		await expect(getWebhookPool().query("select charge_split_mark_refused($1)", [id])).rejects.toThrow(/permission denied/);
		expect(await lines(id)).toEqual(PENDING);
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
