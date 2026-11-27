// Chave de idempotência (063) contra um Postgres real, sob RLS: pedido online, pedido de balcão e pagamento de balcão.
// Cada teste usa um Bureau novo. Contagens pelo pool do dono (sem RLS).
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

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
	});
});

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { claimIdempotencyKey } from "@/lib/idempotency/queries";
import { quoteOrder } from "@/lib/catalog/quote";
import { registerCounterPayment, type RegisterInput } from "@/lib/counter-payments/queries";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { placeOrder, type PlaceOrderOptions } from "@/lib/orders/queries";
import type { OpenOrderInput } from "@/lib/orders/types";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	randomCpf,
	seedBureauCost,
	seedCatalogItem,
	seedClientWalletTopup,
	seedDossier,
	seedOrderDossier,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

async function count(sql: string, params: unknown[]): Promise<number> {
	return Number((await owner.query<{ n: string }>(sql, params)).rows[0].n);
}

async function newTenant(label: string, funds: { client?: string; bureau?: string } = { client: "200.00", bureau: "200.00" }) {
	const t = await seedTenant(owner, label);
	await owner.query("update products set active = true where code = 'dossie_pf'");
	const { rows } = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
	await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: "1.00", costPerPartner: "0.00", setBy: t.bureauAdmin.userId });
	await seedCatalogItem(owner, {
		bureauId: t.bureau.id,
		productId: rows[0].id,
		salePrice: "50.00",
		salePricePerPartner: "0.00",
		updatedBy: t.bureauAdmin.userId,
	});
	if (funds.client) await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: funds.client, createdBy: t.bureauAdmin.userId });
	if (funds.bureau) await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: funds.bureau, createdBy: t.bureauAdmin.userId });
	return t;
}

const buyerOf = (t: SeededTenant): DbIdentity => ({ ...t.client });
const staff = (t: SeededTenant): DbIdentity => ({ ...t.operator });

// O cliente não lê o custo do catálogo: a cotação sai com a identidade da equipe.
async function quote(t: SeededTenant) {
	const q = await quoteOrder(staff(t), "dossie_pf", { partnerCount: 0 });
	if (!q.ok) throw new Error(`quote failed: ${q.reason}`);
	return q;
}

const ownInput: OpenOrderInput = {
	productCode: "dossie_pf",
	self: true,
	subject: null,
	partners: [],
	contact: { email: null, phoneE164: null },
	buyerProfileId: null,
};

// Titular novo a cada chamada: o teto de pedidos por destinatário e por titular não entra no teste.
const counterInput = (): OpenOrderInput => ({
	productCode: "dossie_pf",
	self: false,
	subject: { type: "PF", name: "Fulano de Tal", documentDigits: randomCpf().replace(/\D/g, "") },
	partners: [],
	contact: { email: `contato-${randomUUID()}@example.test`, phoneE164: null },
	buyerProfileId: null,
});

const auditCount = (t: SeededTenant) => count("select count(*) as n from audit_logs where bureau_id = $1", [t.bureau.id]);
const orderCount = (t: SeededTenant) => count("select count(*) as n from dossier_orders where bureau_id = $1", [t.bureau.id]);
const settlementCount = (t: SeededTenant) => count("select count(*) as n from order_settlements where bureau_id = $1", [t.bureau.id]);
const clientReserves = (t: SeededTenant) =>
	count("select count(*) as n from client_ledger_entries where client_profile_id = $1 and kind = 'reserve'", [t.client.userId]);
const keyCount = (t: SeededTenant, scope: string) =>
	count("select count(*) as n from idempotency_keys where bureau_id = $1 and scope = $2", [t.bureau.id, scope]);
const clientWallet = async (t: SeededTenant) =>
	(await owner.query("select available, reserved from client_wallets where client_profile_id = $1", [t.client.userId])).rows[0];

describe("placeOrder online with an idempotency key", () => {
	const place = async (t: SeededTenant, idempotencyKey: string | null, input = ownInput, options: PlaceOrderOptions = {}) =>
		placeOrder(buyerOf(t), input, await quote(t), idempotencyKey ? { ...options, idempotencyKey } : options);

	it("the same key twice returns the same order: one row, one charge, one audit trail", async () => {
		const t = await newTenant("idem online twice");
		const key = randomUUID();

		const first = await place(t, key);
		if (!first.ok) throw new Error(`first failed: ${first.reason}`);
		const auditAfterFirst = await auditCount(t);
		const second = await place(t, key);

		expect(first.duplicate).toBeUndefined();
		expect(second).toEqual({ ok: true, dossierId: first.dossierId, state: first.state, duplicate: true });
		expect(await orderCount(t)).toBe(1);
		expect(await settlementCount(t)).toBe(1);
		expect(await clientReserves(t)).toBe(1);
		expect(await clientWallet(t)).toEqual({ available: "150.00", reserved: "50.00" });
		expect(await auditCount(t)).toBe(auditAfterFirst);
		expect(await keyCount(t, "order")).toBe(1);
	});

	it("parallel submits with the same key end with one order and no error", async () => {
		const t = await newTenant("idem online race");
		const key = randomUUID();

		const results = await Promise.all(Array.from({ length: 6 }, () => place(t, key)));

		for (const r of results) expect(r).toMatchObject({ ok: true });
		const ids = new Set(results.map((r) => (r.ok ? r.dossierId : null)));
		expect(ids.size).toBe(1);
		expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
		expect(await orderCount(t)).toBe(1);
		expect(await settlementCount(t)).toBe(1);
		expect(await clientReserves(t)).toBe(1);
		expect(await clientWallet(t)).toEqual({ available: "150.00", reserved: "50.00" });
	});

	it("different keys create two orders and two charges", async () => {
		const t = await newTenant("idem online two keys");

		const a = await place(t, randomUUID());
		const b = await place(t, randomUUID());

		expect(a).toMatchObject({ ok: true });
		expect(b).toMatchObject({ ok: true });
		expect(a.ok && b.ok && a.dossierId !== b.dossierId).toBe(true);
		expect(await orderCount(t)).toBe(2);
		expect(await clientReserves(t)).toBe(2);
	});

	it("without a key (legacy caller) two submits still create two orders", async () => {
		const t = await newTenant("idem online legacy");

		expect(await place(t, null)).toMatchObject({ ok: true });
		expect(await place(t, null)).toMatchObject({ ok: true });

		expect(await orderCount(t)).toBe(2);
		expect(await keyCount(t, "order")).toBe(0);
	});

	it("the same key with another body is refused and does not return the other order", async () => {
		const t = await newTenant("idem online conflict");
		const key = randomUUID();
		const first = await place(t, key);

		const other = await place(t, key, ownInput, { couponCode: "OUTRO" });

		expect(first).toMatchObject({ ok: true });
		expect(other).toEqual({ ok: false, reason: "idempotency_conflict" });
		expect(await orderCount(t)).toBe(1);
	});

	it("a key conflict or a duplicate with a coupon does not consume a coupon attempt", async () => {
		const t = await newTenant("idem online coupon slot");
		const code = `I${randomUUID().slice(0, 8).toUpperCase()}`;
		await owner.query(
			`insert into coupons (bureau_id, code, kind, value, all_products, valid_from, active, created_by)
			 values ($1, $2, 'percent', '20', true, now() - interval '2 hours', true, $3)`,
			[t.bureau.id, code, t.bureauAdmin.userId],
		);
		const misses = async () =>
			count("select count(*) as n from coupon_attempt_misses where profile_id = $1", [t.client.userId]);
		const key = randomUUID();

		const first = await place(t, key, ownInput, { couponCode: code });
		const duplicate = await place(t, key, ownInput, { couponCode: code });
		const conflicts = [await place(t, key, ownInput, { couponCode: "OUTRO1" }), await place(t, key, ownInput, { couponCode: "OUTRO2" })];

		expect(first).toMatchObject({ ok: true });
		expect(duplicate).toMatchObject({ ok: true, duplicate: true });
		expect(conflicts).toEqual(Array(2).fill({ ok: false, reason: "idempotency_conflict" }));
		expect(await orderCount(t)).toBe(1);
		expect(await misses()).toBe(0);
	});

	it("a refused order keeps no key: the same key works after the client tops up", async () => {
		const t = await newTenant("idem online retry", { bureau: "200.00" });
		const key = randomUUID();

		expect(await place(t, key)).toEqual({ ok: false, reason: "insufficient_balance" });
		expect(await keyCount(t, "order")).toBe(0);
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "100.00", createdBy: t.bureauAdmin.userId });

		expect(await place(t, key)).toMatchObject({ ok: true });
		expect(await orderCount(t)).toBe(1);
	});

	it("a key is scoped to the user: the same uuid from the staff does not collide with the client", async () => {
		const t = await newTenant("idem online scope");
		const key = randomUUID();

		const online = await place(t, key);
		const counter = await placeOrder(staff(t), counterInput(), await quote(t), { idempotencyKey: key });

		expect(online).toMatchObject({ ok: true });
		expect(counter).toMatchObject({ ok: true });
		expect(counter.ok && counter.duplicate).toBeFalsy();
		expect(await orderCount(t)).toBe(2);
	});
});

describe("placeOrder at the counter with an idempotency key", () => {
	const place = async (t: SeededTenant, input: OpenOrderInput, idempotencyKey: string | null) =>
		placeOrder(staff(t), input, await quote(t), idempotencyKey ? { idempotencyKey } : {});
	const bureauWallet = async (t: SeededTenant) =>
		(await owner.query("select available, reserved from wallets where bureau_id = $1", [t.bureau.id])).rows[0];

	it("the same key twice returns the same order: one row, one reservation, one audit trail", async () => {
		const t = await newTenant("idem counter twice");
		const input = counterInput();
		const key = randomUUID();

		const first = await place(t, input, key);
		if (!first.ok) throw new Error(`first failed: ${first.reason}`);
		const walletAfterFirst = await bureauWallet(t);
		const auditAfterFirst = await auditCount(t);
		const second = await place(t, input, key);

		expect(second).toEqual({ ok: true, dossierId: first.dossierId, state: first.state, duplicate: true });
		expect(await orderCount(t)).toBe(1);
		expect(await settlementCount(t)).toBe(1);
		expect(await bureauWallet(t)).toEqual(walletAfterFirst);
		expect(await auditCount(t)).toBe(auditAfterFirst);
	});

	it("parallel submits with the same key end with one order and no error", async () => {
		const t = await newTenant("idem counter race");
		const input = counterInput();
		const key = randomUUID();

		const results = await Promise.all(Array.from({ length: 6 }, () => place(t, input, key)));

		for (const r of results) expect(r).toMatchObject({ ok: true });
		expect(new Set(results.map((r) => (r.ok ? r.dossierId : null))).size).toBe(1);
		expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
		expect(await orderCount(t)).toBe(1);
		expect(await settlementCount(t)).toBe(1);
	});

	it("different keys create two orders; no key keeps the legacy behavior", async () => {
		const t = await newTenant("idem counter keys");

		await place(t, counterInput(), randomUUID());
		await place(t, counterInput(), randomUUID());
		expect(await orderCount(t)).toBe(2);

		await place(t, counterInput(), null);
		await place(t, counterInput(), null);
		expect(await orderCount(t)).toBe(4);
	});

	it("the same key with another subject is refused", async () => {
		const t = await newTenant("idem counter conflict");
		const key = randomUUID();
		await place(t, counterInput(), key);

		expect(await place(t, counterInput(), key)).toEqual({ ok: false, reason: "idempotency_conflict" });
		expect(await orderCount(t)).toBe(1);
	});
});

describe("registerCounterPayment with an idempotency key", () => {
	async function setup(label: string) {
		const tenant = await seedTenant(owner, label);
		const dossierId = await seedDossier(owner, { bureauId: tenant.bureau.id, holderId: tenant.holder.id, createdBy: tenant.bureauAdmin.userId });
		await seedOrderDossier(owner, { orderRef: dossierId, bureauId: tenant.bureau.id, clientProfileId: null });
		await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [dossierId]);
		return { tenant, dossierId, operator: { ...tenant.operator } as DbIdentity };
	}
	const pay = (dossierId: string, idempotencyKey: string | null, amount = "25.50"): RegisterInput => ({
		dossierId,
		method: "cash",
		amount,
		note: null,
		receivedAt: new Date("2026-10-14T12:00:00Z"),
		idempotencyKey,
	});
	const payments = (dossierId: string) => count("select count(*) as n from counter_payments where dossier_id = $1", [dossierId]);
	const registerAudits = (dossierId: string) =>
		count("select count(*) as n from audit_logs where action = 'counter.register' and metadata->>'dossier_id' = $1", [dossierId]);

	it("the same key twice returns the same payment: one row, one audit event", async () => {
		const { dossierId, operator } = await setup("idem pay twice");
		const key = randomUUID();

		const first = await registerCounterPayment(operator, pay(dossierId, key));
		const second = await registerCounterPayment(operator, pay(dossierId, key));

		expect(first).toMatchObject({ ok: true });
		expect(second).toEqual({ ok: true, id: first.ok ? first.id : "", duplicate: true });
		expect(await payments(dossierId)).toBe(1);
		expect(await registerAudits(dossierId)).toBe(1);
	});

	it("parallel submits with the same key end with one payment and no error", async () => {
		const { dossierId, operator } = await setup("idem pay race");
		const key = randomUUID();

		const results = await Promise.all(Array.from({ length: 6 }, () => registerCounterPayment(operator, pay(dossierId, key))));

		for (const r of results) expect(r).toMatchObject({ ok: true });
		expect(new Set(results.map((r) => (r.ok ? r.id : null))).size).toBe(1);
		expect(results.filter((r) => r.ok && !r.duplicate)).toHaveLength(1);
		expect(await payments(dossierId)).toBe(1);
		expect(await registerAudits(dossierId)).toBe(1);
	});

	it("different keys register two payments (partial payments stay possible); no key keeps the legacy behavior", async () => {
		const { dossierId, operator } = await setup("idem pay keys");

		await registerCounterPayment(operator, pay(dossierId, randomUUID()));
		await registerCounterPayment(operator, pay(dossierId, randomUUID()));
		expect(await payments(dossierId)).toBe(2);

		await registerCounterPayment(operator, pay(dossierId, null));
		await registerCounterPayment(operator, pay(dossierId, null));
		expect(await payments(dossierId)).toBe(4);
	});

	it("the same key with another amount is refused", async () => {
		const { dossierId, operator } = await setup("idem pay conflict");
		const key = randomUUID();
		await registerCounterPayment(operator, pay(dossierId, key, "10.00"));

		expect(await registerCounterPayment(operator, pay(dossierId, key, "99.00"))).toEqual({ ok: false, reason: "idempotency_conflict" });
		expect(await payments(dossierId)).toBe(1);
	});

	it("a refused payment keeps no key: the retry with the same key works once the order accepts payment", async () => {
		const { tenant, dossierId, operator } = await setup("idem pay refused");
		const key = randomUUID();
		await owner.query("update dossier_orders set state = 'ready' where dossier_id = $1", [dossierId]);

		expect(await registerCounterPayment(operator, pay(dossierId, key))).toEqual({ ok: false, reason: "order_not_payable" });
		expect(await keyCount(tenant, "counter_payment")).toBe(0);
		await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [dossierId]);

		expect(await registerCounterPayment(operator, pay(dossierId, key))).toMatchObject({ ok: true });
		expect(await payments(dossierId)).toBe(1);
	});
});

describe("idempotency_keys isolation", () => {
	const hash = "a".repeat(64);

	it("a user sees only the own keys; another user of the same Bureau or of another Bureau sees none", async () => {
		const t = await seedTenant(owner, "idem rls A");
		const other = await seedTenant(owner, "idem rls B");
		const key = randomUUID();
		await withUserTransaction({ ...t.operator }, (c) => claimIdempotencyKey(c, { scope: "order", key, payload: { a: 1 } }));

		const seen = (who: DbIdentity) =>
			withUserTransaction(who, async (c) => (await c.query("select count(*)::int as n from idempotency_keys where key = $1", [key])).rows[0].n);
		expect(await seen({ ...t.operator })).toBe(1);
		expect(await seen({ ...t.bureauAdmin })).toBe(0);
		expect(await seen({ ...t.client })).toBe(0);
		expect(await seen({ ...other.operator })).toBe(0);
	});

	it("the app cannot write a key for another user or Bureau, rewrite the hash or delete a key", async () => {
		const t = await seedTenant(owner, "idem rls C");
		const other = await seedTenant(owner, "idem rls D");
		const key = randomUUID();
		await withUserTransaction({ ...t.operator }, (c) => claimIdempotencyKey(c, { scope: "order", key, payload: { a: 1 } }));

		const forOtherUser = withUserTransaction({ ...t.operator }, (c) =>
			c.query("insert into idempotency_keys (user_id, scope, key, bureau_id, request_hash) values ($1, 'order', $2, $3, $4)", [
				t.bureauAdmin.userId,
				randomUUID(),
				t.bureau.id,
				hash,
			]),
		);
		await expect(forOtherUser).rejects.toMatchObject({ code: "42501" });
		const forOtherBureau = withUserTransaction({ ...t.operator }, (c) =>
			c.query("insert into idempotency_keys (user_id, scope, key, bureau_id, request_hash) values (app_user_id(), 'order', $1, $2, $3)", [
				randomUUID(),
				other.bureau.id,
				hash,
			]),
		);
		await expect(forOtherBureau).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23503)$/) });
		await expect(
			withUserTransaction({ ...t.operator }, (c) => c.query("update idempotency_keys set request_hash = $2 where key = $1", [key, hash])),
		).rejects.toMatchObject({ code: "42501" });
		await expect(withUserTransaction({ ...t.operator }, (c) => c.query("delete from idempotency_keys where key = $1", [key]))).rejects.toMatchObject({
			code: "42501",
		});
	});
});
