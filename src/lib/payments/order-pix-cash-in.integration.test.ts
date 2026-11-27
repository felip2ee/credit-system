// Pix de pedido + split na entrada (087) contra um Postgres real, sob RLS, com o driver Asaas fake: a cobrança do pedido
// nasce com o plano de split (checkout real), e apply_asaas_payment lança a comissão em todo resultado em que o dinheiro
// entrou (order_paid, order_reserve_failed, order_not_payable) e a reverte uma vez no estorno e no chargeback.
// Pedido 50,00 (dossie_pf); taxa do Pix 1,99 repassada ao pagador: a base da comissão é o preço (amount), nunca a taxa.
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
		ASAAS_WEBHOOK_TOKEN: "c".repeat(32),
		PIX_FEE_CENTS: "199",
		DATABASE_WEBHOOK_URL:
			process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system_test",
		PII_ENCRYPTION_KEY: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
	});
});

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import {
	ASAAS_EVENT_PAYMENT_CHARGEBACK_REQUESTED,
	ASAAS_EVENT_PAYMENT_CONFIRMED,
	ASAAS_EVENT_PAYMENT_RECEIVED,
	ASAAS_EVENT_PAYMENT_REFUNDED,
} from "@/lib/asaas/client";
import { buildFakePaymentEvent, getFakeChargeSplit, resetFakeChargeSplits, resetFakeCustomers } from "@/lib/asaas/fake";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { openOrder } from "@/lib/orders/queries";
import type { OpenOrderInput } from "@/lib/orders/types";
import { runCheckout } from "@/lib/payments/checkout";
import { applyAsaasPayment } from "@/lib/wallet/pix-charges";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedBureauCost,
	seedCatalogItem,
	seedClientProfile,
	seedSuperadmin,
	seedTenant,
	seedWalletTopup,
	type SeedSuperadmin,
	type SeededTenant,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 6 });
const CPF = "52998224725";
const WALLET = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const PRICE = "50.00";
const TOTAL = 51.99;

let SA: SeedSuperadmin;

beforeAll(async () => {
	SA = await seedSuperadmin(owner);
});

// A soma das camadas olha todos os bureaus do banco: tira o que estes testes configuraram para não vazar. Gatilhos
// append-only ficam de fora (como em cash-in.integration.test.ts).
afterAll(async () => {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		const mine = "(select id from bureaus where name like 'Ord CashIn%')";
		await client.query(`delete from bureau_commission_rates where bureau_id in ${mine}`);
		await client.query(`delete from bureau_referrals where referred_bureau_id in ${mine} or referrer_bureau_id in ${mine}`);
		await client.query(`delete from bureau_affiliate_settings where bureau_id in ${mine}`);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

beforeEach(() => {
	resetFakeChargeSplits();
	resetFakeCustomers();
	if (!process.env.T3_DEBUG) vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	await owner.query("delete from platform_partners");
});

const input: OpenOrderInput = {
	productCode: "dossie_pf",
	self: true,
	subject: null,
	partners: [],
	contact: { email: null, phoneE164: null },
	buyerProfileId: null,
};

async function setSalePrice(t: SeededTenant, salePrice: string) {
	const { rows } = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
	await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: rows[0].id, salePrice, salePricePerPartner: "0.00", updatedBy: t.bureauAdmin.userId });
}

// Dono (superusuário) escreve o telefone: o trigger protect_profile_contact só libera as funções da conta.
async function verifyPhone(profileId: string) {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		await client.query("update profiles set phone_e164 = '+5563999990000', phone_verified_at = now() where id = $1", [profileId]);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

type Mode = "pix" | "asaas";
type Order = {
	t: SeededTenant;
	referrer: SeededTenant;
	affiliateId: string;
	dossierId: string;
	chargeId: string;
	paymentId: string;
};

// Pedido online aguardando pagamento, com a cobrança Pix criada pelo checkout real (plano de split gravado na reserva).
// Bureau 20% sem walletId (accrual), indicador 5% sem walletId (accrual), sócio 10% (walletId), afiliado 10%.
async function newOrder(label: string, affiliateMode: Mode = "pix"): Promise<Order> {
	const t = await seedTenant(owner, `Ord CashIn ${label}`);
	await owner.query("update products set active = true where code = 'dossie_pf'");
	const { rows } = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
	await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: "1.00", costPerPartner: "0.00", setBy: t.bureauAdmin.userId });
	await setSalePrice(t, PRICE);
	await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "200.00", createdBy: t.bureauAdmin.userId });
	await owner.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, 20, $2)", [t.bureau.id, SA.userId]);
	const referrer = await seedTenant(owner, `Ord CashIn Ref ${label}`);
	await owner.query("insert into bureau_referrals (referrer_bureau_id, referred_bureau_id, pct) values ($1, $2, 5)", [referrer.bureau.id, t.bureau.id]);
	await owner.query("insert into platform_partners (name, asaas_wallet_id, pct) values ('Sócio 1', $1, 10)", [WALLET(1)]);

	const affiliate = await seedClientProfile(owner, t.bureau.id);
	await owner.query("insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)", [t.client.userId, affiliate.userId, t.bureau.id]);
	await verifyPhone(t.client.userId);
	await owner.query("insert into bureau_affiliate_settings (bureau_id, default_pct, affiliate_enabled) values ($1, 10, true)", [t.bureau.id]);
	if (affiliateMode === "asaas") {
		await owner.query("update affiliate_wallets set payout_method = 'asaas', asaas_wallet_id = $2 where profile_id = $1", [affiliate.userId, WALLET(3)]);
	}

	const dossierId = await withUserTransaction(t.client as DbIdentity, async (client) => {
		const opened = await openOrder(client, input);
		if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
		return opened.dossierId;
	});
	await owner.query("insert into order_pix_quotes (dossier_id, bureau_id, client_profile_id, price, coupon_code) values ($1, $2, $3, $4, null)", [
		dossierId,
		t.bureau.id,
		t.client.userId,
		PRICE,
	]);
	await owner.query("update holders set document = $2, zip_code = '01310100', address_number = '55' where id = $1", [t.holder.id, CPF]);
	const key = randomUUID();
	const res = await runCheckout(
		t.client,
		{ kind: "client", clientProfileId: t.client.userId, orderId: dossierId },
		{ amount: PRICE, method: "PIX", payerKind: "owner", idempotencyKey: key },
		{ remoteIp: "10.9.9.9", description: "Pedido" },
	);
	if (res.error !== null) throw new Error(`checkout failed: ${res.error}`);
	return { t, referrer, affiliateId: affiliate.userId, dossierId, chargeId: res.id, paymentId: `pay_fake_${key}` };
}

const send = (s: Order, type: string, o: { eventId?: string; value?: number } = {}) =>
	applyAsaasPayment({
		eventId: o.eventId ?? randomUUID(),
		eventType: type,
		asaasPaymentId: s.paymentId,
		payload: buildFakePaymentEvent({ eventId: "x", asaasPaymentId: s.paymentId, value: o.value ?? TOTAL }),
	});
const pay = (s: Order, o?: { eventId?: string; value?: number }) => send(s, ASAAS_EVENT_PAYMENT_RECEIVED, o);
const refund = (s: Order, eventId?: string) => send(s, ASAAS_EVENT_PAYMENT_REFUNDED, { eventId });
const chargeback = (s: Order, eventId?: string) => send(s, ASAAS_EVENT_PAYMENT_CHARGEBACK_REQUESTED, { eventId });

async function rows<R extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<R[]> {
	return (await owner.query<R>(sql, params)).rows;
}
const commissions = (s: Order) =>
	rows<{ amount: string; margin: string; reversed_amount: string; status: string }>(
		"select amount::text, margin::text, reversed_amount::text, status from affiliate_commissions where order_ref = $1",
		[s.chargeId],
	);
const affiliateKinds = async (s: Order) =>
	(await rows<{ kind: string }>("select kind from affiliate_ledger_entries where profile_id = $1 order by kind", [s.affiliateId])).map((r) => r.kind);
const payables = (s: Order) =>
	rows<{ bureau_id: string; kind: string; amount: string; reverses: boolean }>(
		"select bureau_id, kind, amount::text, reverses_entry_id is not null as reverses from bureau_payable_entries where pix_charge_id = $1 order by kind, amount",
		[s.chargeId],
	);
const splitStatuses = async (s: Order) =>
	Object.fromEntries(
		(await rows<{ beneficiary_kind: string; status: string }>("select beneficiary_kind, status from charge_splits where pix_charge_id = $1", [s.chargeId])).map((r) => [
			r.beneficiary_kind,
			r.status,
		]),
	);
const orderRow = async (s: Order) => (await rows<{ state: string; state_reason: string | null }>("select state, state_reason from dossier_orders where dossier_id = $1", [s.dossierId]))[0];
const clientBalance = async (s: Order) =>
	(await rows<{ available: string; reserved: string }>("select available::text, reserved::text from client_wallets where client_profile_id = $1", [s.t.client.userId]))[0];

// Comissão lançada na entrada: afiliado Pix 5,00 (10% de 50,00, nunca de 51,99), Bureau 10,00 e indicador 2,50 (accrual).
const PAID_COMMISSIONS = [{ amount: "5.00", margin: PRICE, reversed_amount: "0.00", status: "released" }];
const paidPayables = (s: Order) =>
	expect.arrayContaining([
		{ bureau_id: s.t.bureau.id, kind: "accrual", amount: "10.00", reverses: false },
		{ bureau_id: s.referrer.bureau.id, kind: "accrual", amount: "2.50", reverses: false },
	]);

type Result = "order_paid" | "order_reserve_failed" | "order_not_payable";

// Leva o pedido ao resultado pedido e paga. reserve_failed: o preço de tabela mudou depois da abertura (a reserva recusa e o
// valor fica como saldo). not_payable: o pedido foi cancelado antes do pagamento tardio (o valor vira saldo).
async function reach(s: Order, result: Result, o: { eventId?: string } = {}): Promise<string> {
	if (result === "order_not_payable") {
		await owner.query("update dossier_orders set state = 'cancelled', state_reason = 'payment_timeout' where dossier_id = $1", [s.dossierId]);
	}
	if (result !== "order_reserve_failed") return pay(s, o);
	await setSalePrice(s.t, "60.00");
	try {
		return await pay(s, o);
	} finally {
		await setSalePrice(s.t, PRICE);
	}
}

describe("o plano de split nasce com a cobrança do pedido", () => {
	it("o checkout do pedido grava as linhas do cliente (sócio, Bureau, indicador, afiliado) sobre o preço, sem a taxa", async () => {
		const s = await newOrder("plan");

		const lines = await rows<{ beneficiary_kind: string; payout_method: string; amount_cents: string; status: string }>(
			"select beneficiary_kind, payout_method, amount_cents::text, status from charge_splits where pix_charge_id = $1 order by beneficiary_kind",
			[s.chargeId],
		);
		expect(lines).toEqual([
			{ beneficiary_kind: "affiliate", payout_method: "pix", amount_cents: "500", status: "pending" },
			{ beneficiary_kind: "bureau", payout_method: "accrual", amount_cents: "1000", status: "pending" },
			{ beneficiary_kind: "bureau_referrer", payout_method: "accrual", amount_cents: "250", status: "pending" },
			{ beneficiary_kind: "partner", payout_method: "asaas", amount_cents: "500", status: "pending" },
		]);
		const [charge] = await rows<{ amount: string; fee_amount: string; total_charged: string }>(
			"select amount::text, fee_amount::text, total_charged::text from pix_charges where id = $1",
			[s.chargeId],
		);
		expect(charge).toEqual({ amount: "50.00", fee_amount: "1.99", total_charged: "51.99" });
		expect(getFakeChargeSplit(s.paymentId)).toEqual([{ walletId: WALLET(1), percentualValue: 10 }]);
	});

	it("afiliado em modo conta Asaas vai ao split da cobrança do pedido", async () => {
		const s = await newOrder("plan asaas", "asaas");

		expect(getFakeChargeSplit(s.paymentId)).toEqual([
			{ walletId: WALLET(3), percentualValue: 10 },
			{ walletId: WALLET(1), percentualValue: 10 },
		]);
	});
});

describe.each<Result>(["order_paid", "order_reserve_failed", "order_not_payable"])("Pix de pedido com resultado %s", (result) => {
	it("lança a comissão uma vez (afiliado Pix, Bureau e indicador), sobre o preço e não sobre a taxa", async () => {
		const s = await newOrder(`once ${result}`);

		expect(await reach(s, result)).toBe(result);

		expect(await commissions(s)).toEqual(PAID_COMMISSIONS);
		expect(await affiliateKinds(s)).toEqual(["commission", "commission_release"]);
		expect(await payables(s)).toEqual(paidPayables(s));
		expect(await payables(s)).toHaveLength(2);
		// Pix de pedido: o sócio é pago pelo split do Asaas e fica pendente até o evento do split.
		expect(await splitStatuses(s)).toEqual({ affiliate: "done", bureau: "done", bureau_referrer: "done", partner: "pending" });
		if (result !== "order_paid") expect(Number((await clientBalance(s)).available)).toBe(50);
	});

	it("webhook repetido (mesmo id ou outro evento do mesmo pagamento) não lança comissão de novo", async () => {
		const s = await newOrder(`dup ${result}`);
		const eventId = randomUUID();
		expect(await reach(s, result, { eventId })).toBe(result);

		expect(await pay(s, { eventId })).toBe("duplicate");
		expect(await send(s, ASAAS_EVENT_PAYMENT_CONFIRMED)).toBe("duplicate");

		expect(await commissions(s)).toEqual(PAID_COMMISSIONS);
		expect(await affiliateKinds(s)).toEqual(["commission", "commission_release"]);
		expect(await payables(s)).toHaveLength(2);
	});

	it("estorno reverte a comissão uma vez, mesmo repetido", async () => {
		const s = await newOrder(`refund ${result}`);
		await reach(s, result);

		expect(await refund(s)).toBe("refunded");
		const eventId = randomUUID();
		expect(await refund(s, eventId)).toBe("duplicate");
		expect(await refund(s, eventId)).toBe("duplicate");

		expect(await commissions(s)).toEqual([{ amount: "5.00", margin: PRICE, reversed_amount: "5.00", status: "reversed" }]);
		expect(await affiliateKinds(s)).toEqual(["commission", "commission_clawback", "commission_release"]);
		const entries = await payables(s);
		expect(entries).toHaveLength(4);
		expect(entries.filter((e) => e.kind === "reversal")).toEqual(
			expect.arrayContaining([
				{ bureau_id: s.t.bureau.id, kind: "reversal", amount: "-10.00", reverses: true },
				{ bureau_id: s.referrer.bureau.id, kind: "reversal", amount: "-2.50", reverses: true },
			]),
		);
		expect(await splitStatuses(s)).toMatchObject({ affiliate: "refunded", bureau: "refunded", bureau_referrer: "refunded" });
		expect((await clientBalance(s)).available).toBe("0.00");
	});

	it("chargeback reverte como o estorno, e um estorno depois dele não reverte de novo", async () => {
		const s = await newOrder(`chargeback ${result}`);
		await reach(s, result);

		expect(await chargeback(s)).toBe("refunded");
		expect(await refund(s)).toBe("duplicate");

		expect(await commissions(s)).toEqual([{ amount: "5.00", margin: PRICE, reversed_amount: "5.00", status: "reversed" }]);
		expect(await affiliateKinds(s)).toEqual(["commission", "commission_clawback", "commission_release"]);
		expect(await payables(s)).toHaveLength(4);
	});
});

describe("Pix de pedido: casos de borda", () => {
	it("estorno de pedido que ainda não executa cancela o pedido e reverte a comissão (066/067 + 079)", async () => {
		const s = await newOrder("cancel");
		expect(await pay(s)).toBe("order_paid");
		expect((await orderRow(s)).state).toBe("awaiting_authorization");

		expect(await refund(s)).toBe("refunded");

		expect(await orderRow(s)).toEqual({ state: "cancelled", state_reason: "payment_refunded" });
		expect(await commissions(s)).toEqual([{ amount: "5.00", margin: PRICE, reversed_amount: "5.00", status: "reversed" }]);
	});

	it("afiliado em modo conta Asaas não ganha lançamento no saldo; Bureau e indicador seguem com accrual", async () => {
		const s = await newOrder("asaas mode", "asaas");

		expect(await pay(s)).toBe("order_paid");

		expect(await commissions(s)).toEqual([]);
		expect(await affiliateKinds(s)).toEqual([]);
		expect(await payables(s)).toEqual(paidPayables(s));
		expect(await splitStatuses(s)).toEqual({ affiliate: "pending", bureau: "done", bureau_referrer: "done", partner: "pending" });
		// A reversão do afiliado em modo Asaas é o Asaas que faz; aqui nada muda no saldo dele.
		expect(await refund(s)).toBe("refunded");
		expect(await affiliateKinds(s)).toEqual([]);
		expect((await payables(s)).filter((e) => e.kind === "reversal")).toHaveLength(2);
	});

	it("pagamento abaixo do total não credita nem lança comissão", async () => {
		const s = await newOrder("short");

		expect(await pay(s, { value: 10 })).toBe("amount_mismatch");

		expect(await commissions(s)).toEqual([]);
		expect(await payables(s)).toEqual([]);
		expect(await splitStatuses(s)).toMatchObject({ bureau: "pending" });
	});

	it("estorno antes do pagamento não lança nem reverte comissão", async () => {
		const s = await newOrder("early refund");

		expect(await refund(s)).toBe("ignored");
		expect(await pay(s)).toBe("duplicate");

		expect(await commissions(s)).toEqual([]);
		expect(await payables(s)).toEqual([]);
	});

	it("PAYMENT_CONFIRMED primeiro e PAYMENT_RECEIVED depois lançam uma vez", async () => {
		const s = await newOrder("confirmed first");

		expect(await send(s, ASAAS_EVENT_PAYMENT_CONFIRMED)).toBe("order_paid");
		expect(await pay(s)).toBe("duplicate");

		expect(await commissions(s)).toEqual(PAID_COMMISSIONS);
		expect(await payables(s)).toHaveLength(2);
	});
});
