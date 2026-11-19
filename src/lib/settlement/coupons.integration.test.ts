// Cupons de desconto (migração 049): reserva, captura e liberação com dinheiro no SQL. Postgres real, sob RLS.
// Preço de tabela 100, custo 60 salvo indicação. A falta do cupom é custo - preço pago.
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { cancelOrder, failOrder } from "@/lib/orders/queries";
import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL, TEST_DATABASE_WEBHOOK_URL } from "@/test/db-env";
import {
	seedClientProfile,
	seedClientWalletTopup,
	seedOrderCatalog,
	seedOrderDossier,
	seedPayableEntry,
	seedPixCharge,
	seedSuperadmin,
	seedTenant,
	seedWalletTopup,
	randomCpf,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 12 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 2 });

let superadmin: SeedSuperadmin;

beforeAll(async () => {
	superadmin = await seedSuperadmin(owner);
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), hook.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string | null };
const clientCtx = (t: SeededTenant, userId = t.client.userId): Ctx => ({ userId, role: "client", bureauId: t.bureau.id });
const adminCtx = (t: SeededTenant): Ctx => ({ userId: t.bureauAdmin.userId, role: "bureau_admin", bureauId: t.bureau.id });
const superCtx = (): Ctx => ({ userId: superadmin.userId, role: "superadmin", bureauId: null });
const staff = (t: SeededTenant): DbIdentity => ({ userId: t.bureauAdmin.userId, role: "bureau_admin", bureauId: t.bureau.id });

async function committed<T>(ctx: Ctx, work: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
			        set_config('app.bureau_id', $3, true), set_config('app.support_session_id', '', true)`,
			[ctx.userId, ctx.role, ctx.bureauId ?? ""],
		);
		const result = await work(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

type SettleRow = { ok: boolean; reason: string | null; status: string | null };
const OLD = "2020-01-01T00:00:00Z";

type CouponInput = {
	kind?: "percent" | "fixed";
	value: string;
	allProducts?: boolean;
	productCodes?: string[];
	maxUses?: number | null;
	maxUsesPerClient?: number | null;
	validFrom?: string;
	validUntil?: string | null;
	code?: string;
	active?: boolean;
};

async function seedCoupon(t: SeededTenant, i: CouponInput): Promise<{ id: string; code: string }> {
	const code = i.code ?? `C${randomBytes(4).toString("hex").toUpperCase()}`;
	const { rows } = await owner.query<{ id: string }>(
		`insert into coupons (bureau_id, code, kind, value, all_products, max_uses, max_uses_per_client, valid_from,
		                      valid_until, active, created_by)
		 values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now() - interval '1 hour'), $9, $10, $11) returning id`,
		[
			t.bureau.id, code, i.kind ?? "percent", i.value, i.allProducts ?? true, i.maxUses ?? null,
			i.maxUsesPerClient ?? null, i.validFrom ?? null, i.validUntil ?? null, i.active ?? true, t.bureauAdmin.userId,
		],
	);
	for (const productCode of i.productCodes ?? []) {
		await owner.query(
			"insert into coupon_products (coupon_id, bureau_id, product_id) select $1, $2, id from products where code = $3",
			[rows[0].id, t.bureau.id, productCode],
		);
	}
	return { id: rows[0].id, code: code.trim().toUpperCase() };
}

type Place = { orderRef?: string; clientId?: string; list?: string; cost?: string; paid: string; code?: string | null; product?: string };

// Cria Dossiê e catálogo e reserva com cupom. Devolve a ordem e a resposta de reserve_order.
async function place(t: SeededTenant, p: Place): Promise<{ orderRef: string; res: SettleRow }> {
	const orderRef = p.orderRef ?? randomUUID();
	const clientId = p.clientId ?? t.client.userId;
	await seedOrderDossier(owner, { orderRef, bureauId: t.bureau.id, clientProfileId: clientId, productCode: p.product });
	await committed(clientCtx(t, clientId), (c) =>
		seedOrderCatalog(owner, c, { productCode: p.product ?? "dossie_pf", price: p.list ?? "100.00", cost: p.cost ?? "60.00" }),
	);
	const res = await reserveOnly(t, { ...p, orderRef, clientId });
	return { orderRef, res };
}
async function reserveOnly(t: SeededTenant, p: Place & { orderRef: string; clientId: string }): Promise<SettleRow> {
	return committed(clientCtx(t, p.clientId), (c) =>
		c
			.query<SettleRow>("select * from reserve_order($1, 'online', $2, $3, $4, $5::jsonb, $6)", [
				p.orderRef, p.clientId, p.paid, p.cost ?? "60.00", JSON.stringify({ lines: [] }), p.code ?? null,
			])
			.then((r) => r.rows[0]),
	);
}
const capture = (t: SeededTenant, ref: string) =>
	committed(adminCtx(t), (c) => c.query<SettleRow>("select * from capture_order($1)", [ref]).then((r) => r.rows[0]));
const release = (t: SeededTenant, ref: string) =>
	committed(adminCtx(t), (c) => c.query<SettleRow>("select * from release_order($1)", [ref]).then((r) => r.rows[0]));

async function rows<R>(sql: string, params: unknown[] = []): Promise<R[]> {
	return (await owner.query(sql, params)).rows as R[];
}
const clientWallet = async (id: string) =>
	(await rows<{ available: string; reserved: string }>("select available, reserved from client_wallets where client_profile_id = $1", [id]))[0];
const bureauWallet = async (id: string) =>
	(await rows<{ available: string; reserved: string }>("select available, reserved from wallets where bureau_id = $1", [id]))[0];
const redemption = async (orderRef: string) =>
	(
		await rows<{ status: string; discount: string; funded_wallet: string; funded_payable: string }>(
			"select status, discount, funded_wallet, funded_payable from coupon_redemptions where order_ref = $1",
			[orderRef],
		)
	)[0];
const payableKinds = async (bureauId: string) =>
	(await rows<{ kind: string; amount: string }>("select kind, amount from bureau_payable_entries where bureau_id = $1 order by created_at, id", [bureauId]));
const settlements = async (clientId: string) =>
	Number((await rows<{ n: string }>("select count(*) as n from order_settlements where client_profile_id = $1", [clientId]))[0].n);
const clientLedgerCount = async (clientId: string) =>
	Number((await rows<{ n: string }>("select count(*) as n from client_ledger_entries where client_profile_id = $1 and kind <> 'topup'", [clientId]))[0].n);

// Locatário com saldo do cliente e da carteira do Bureau.
async function tenant(label: string, o: { client?: string; wallet?: string } = {}) {
	const t = await seedTenant(owner, label);
	if (o.client) await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: o.client, createdBy: t.client.userId });
	if (o.wallet) await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: o.wallet, createdBy: t.bureauAdmin.userId });
	return t;
}
// Outro cliente do Bureau, com titular próprio (o Dossiê do pedido nasce sobre ele) e saldo.
async function seedOtherClient(t: SeededTenant, funds = "300.00") {
	const other = await seedClientProfile(owner, t.bureau.id);
	await owner.query(
		`insert into holders (bureau_id, type, name, document, created_by, client_profile_id)
		 values ($1, 'PF', 'Outro titular', $2, $3, $4)`,
		[t.bureau.id, randomCpf(), t.bureauAdmin.userId, other.userId],
	);
	await seedClientWalletTopup(owner, { clientProfileId: other.userId, amount: funds, createdBy: other.userId });
	return other;
}
// Valor a repassar já liberado (acréscimo antigo).
const seedReleased = (t: SeededTenant, amount: string) =>
	seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "accrual", amount, createdAt: OLD });

describe("desconto e preço pago", () => {
	it("percent: 50% of 100 pays 50 and the Bureau covers the 10 missing from its wallet", async () => {
		const t = await tenant("cup pct", { client: "100.00", wallet: "100.00" });
		const c = await seedCoupon(t, { value: "50" });
		const { orderRef, res } = await place(t, { paid: "50.00", code: c.code });
		expect(res).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(await clientWallet(t.client.userId)).toEqual({ available: "50.00", reserved: "50.00" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "90.00", reserved: "10.00" });
		expect(await redemption(orderRef)).toEqual({ status: "reserved", discount: "50.00", funded_wallet: "10.00", funded_payable: "0.00" });
		expect(await payableKinds(t.bureau.id)).toEqual([]);

		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });
		expect(await clientWallet(t.client.userId)).toEqual({ available: "50.00", reserved: "0.00" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "90.00", reserved: "0.00" });
		expect((await redemption(orderRef)).status).toBe("consumed");
		// Margem -10: nenhum acréscimo.
		expect(await payableKinds(t.bureau.id)).toEqual([]);
		const audit = await rows("select 1 from audit_logs where action = 'coupon.redeem' and metadata->>'order_ref' = $1", [orderRef]);
		expect(audit).toHaveLength(1);
	});

	it("percent with price above cost needs no funds and the margin only shrinks", async () => {
		const t = await tenant("cup pct margin", { client: "100.00" });
		const c = await seedCoupon(t, { value: "10" });
		const { orderRef, res } = await place(t, { paid: "90.00", code: c.code });
		expect(res.ok).toBe(true);
		expect(await redemption(orderRef)).toMatchObject({ discount: "10.00", funded_wallet: "0.00", funded_payable: "0.00" });
		await capture(t, orderRef);
		expect(await payableKinds(t.bureau.id)).toEqual([{ kind: "accrual", amount: "30.00" }]);
	});

	it("fixed: value 20 off pays 80; fixed above the base is capped at it (paid 0)", async () => {
		const t = await tenant("cup fixed", { client: "100.00", wallet: "100.00" });
		const small = await seedCoupon(t, { kind: "fixed", value: "20.00" });
		const a = await place(t, { paid: "80.00", code: small.code });
		expect(a.res.ok).toBe(true);
		expect(await redemption(a.orderRef)).toMatchObject({ discount: "20.00", funded_wallet: "0.00" });

		const big = await seedCoupon(t, { kind: "fixed", value: "500.00" });
		const b = await place(t, { paid: "0.00", code: big.code });
		expect(b.res.ok).toBe(true);
		expect(await redemption(b.orderRef)).toMatchObject({ discount: "100.00", funded_wallet: "60.00" });
	});

	it("100% runs with zero client balance: no client wallet entry on reserve, capture or release", async () => {
		const t = await tenant("cup 100", { wallet: "200.00" });
		const c = await seedCoupon(t, { value: "100" });
		const { orderRef, res } = await place(t, { paid: "0.00", code: c.code });
		expect(res).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "140.00", reserved: "60.00" });
		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "140.00", reserved: "0.00" });
		expect(await clientLedgerCount(t.client.userId)).toBe(0);
		expect(await payableKinds(t.bureau.id)).toEqual([]);

		const other = await place(t, { paid: "0.00", code: c.code, clientId: (await seedOtherClient(t, "1.00")).userId });
		expect(other.res.ok).toBe(true);
		expect(await release(t, other.orderRef)).toMatchObject({ ok: true, status: "released" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "140.00", reserved: "0.00" });
	});

	it("rejects a wrong paid price with price_mismatch and keeps nothing", async () => {
		const t = await tenant("cup mismatch", { client: "100.00", wallet: "100.00" });
		const c = await seedCoupon(t, { value: "50" });
		const { orderRef, res } = await place(t, { paid: "40.00", code: c.code });
		expect(res).toMatchObject({ ok: false, reason: "price_mismatch" });
		expect(await redemption(orderRef)).toBeUndefined();
		expect(await settlements(t.client.userId)).toBe(0);
		// Sem cupom, o preço com desconto é recusado.
		expect((await place(t, { cost: "30.00", paid: "50.00", code: null })).res).toMatchObject({ ok: false, reason: "price_mismatch" });
		// Sem cupom, preço 0 continua inválido.
		expect((await place(t, { paid: "0.00", code: null })).res).toMatchObject({ ok: false, reason: "invalid_amount" });
	});

	it("rounds the discount to cents (half up): 50% of 100.01 = 50.01", async () => {
		const t = await tenant("cup round", { client: "100.00", wallet: "100.00" });
		const c = await seedCoupon(t, { value: "50" });
		const { orderRef, res } = await place(t, { list: "100.01", cost: "10.00", paid: "50.00", code: c.code });
		expect(res.ok).toBe(true);
		expect(await redemption(orderRef)).toMatchObject({ discount: "50.01" });
	});

	it("normalizes the code: ' demo ' is DEMO", async () => {
		const t = await tenant("cup norm", { client: "100.00" });
		await seedCoupon(t, { value: "10", code: "DEMO" });
		expect((await place(t, { paid: "90.00", code: "  demo " })).res.ok).toBe(true);
	});
});

describe("escopo, limites e validade", () => {
	it("trunfo accepts any product; a specific coupon accepts only its products (coupon_products ignored when all_products)", async () => {
		const t = await tenant("cup scope", { client: "300.00", wallet: "100.00" });
		const trunfo = await seedCoupon(t, { value: "10", allProducts: true, productCodes: ["dossie_empresarial"] });
		expect((await place(t, { paid: "90.00", code: trunfo.code })).res.ok).toBe(true);

		const onlyEmp = await seedCoupon(t, { value: "10", allProducts: false, productCodes: ["dossie_empresarial"] });
		const pf = await place(t, { paid: "90.00", code: onlyEmp.code });
		expect(pf.res).toMatchObject({ ok: false, reason: "coupon_product_not_allowed" });
		expect(await redemption(pf.orderRef)).toBeUndefined();

		const onlyPf = await seedCoupon(t, { value: "10", allProducts: false, productCodes: ["dossie_pf"] });
		expect((await place(t, { paid: "90.00", code: onlyPf.code })).res.ok).toBe(true);
	});

	it("total limit: the second use is coupon_exhausted until the first is released", async () => {
		const t = await tenant("cup total", { client: "300.00" });
		const c = await seedCoupon(t, { value: "10", maxUses: 1 });
		const first = await place(t, { paid: "90.00", code: c.code });
		expect(first.res.ok).toBe(true);
		expect((await place(t, { paid: "90.00", code: c.code })).res).toMatchObject({ ok: false, reason: "coupon_exhausted" });
		await release(t, first.orderRef);
		expect((await place(t, { paid: "90.00", code: c.code })).res.ok).toBe(true);
	});

	it("per-client limit: the same client is refused, another client is not", async () => {
		const t = await tenant("cup per client", { client: "300.00" });
		const other = await seedOtherClient(t);
		const c = await seedCoupon(t, { value: "10", maxUsesPerClient: 1 });
		expect((await place(t, { paid: "90.00", code: c.code })).res.ok).toBe(true);
		expect((await place(t, { paid: "90.00", code: c.code })).res).toMatchObject({ ok: false, reason: "coupon_client_limit" });
		expect((await place(t, { paid: "90.00", code: c.code, clientId: other.userId })).res.ok).toBe(true);
	});

	it("validity window and inactive: expired, not started, inactive, unknown and another Bureau", async () => {
		const t = await tenant("cup valid", { client: "300.00" });
		const past = await seedCoupon(t, { value: "10", validFrom: "2020-01-01T00:00:00Z", validUntil: "2020-02-01T00:00:00Z" });
		const future = await seedCoupon(t, { value: "10", validFrom: "2099-01-01T00:00:00Z" });
		const off = await seedCoupon(t, { value: "10", active: false });
		const reason = async (code: string) => (await place(t, { paid: "90.00", code })).res.reason;
		expect(await reason(past.code)).toBe("coupon_expired");
		expect(await reason(future.code)).toBe("coupon_expired");
		expect(await reason(off.code)).toBe("coupon_invalid");
		expect(await reason("NAOEXISTE")).toBe("coupon_invalid");

		const b = await tenant("cup other bureau");
		const foreign = await seedCoupon(b, { value: "10" });
		expect(await reason(foreign.code)).toBe("coupon_invalid");
	});

	it("two reservations race for the last use: exactly one passes", async () => {
		for (let round = 0; round < 3; round += 1) {
			const t = await tenant(`cup race ${round}`, { client: "300.00" });
			const c = await seedCoupon(t, { value: "10", maxUses: 1 });
			const refs = [randomUUID(), randomUUID()];
			for (const orderRef of refs) {
				await seedOrderDossier(owner, { orderRef, bureauId: t.bureau.id, clientProfileId: t.client.userId });
			}
			await committed(clientCtx(t), (cl) => seedOrderCatalog(owner, cl, { productCode: "dossie_pf", price: "100.00", cost: "60.00" }));
			const results = await Promise.all(
				refs.map((orderRef) => reserveOnly(t, { orderRef, clientId: t.client.userId, paid: "90.00", code: c.code })),
			);
			expect(results.filter((r) => r.ok)).toHaveLength(1);
			expect(results.filter((r) => r.reason === "coupon_exhausted")).toHaveLength(1);
			const used = await rows("select 1 from coupon_redemptions where coupon_id = $1", [c.id]);
			expect(used).toHaveLength(1);
		}
	});
});

describe("quem paga a falta", () => {
	it("wallet + payable: wallet covers part, released payable covers the rest (coupon_cost)", async () => {
		const t = await tenant("cup mix", { client: "100.00", wallet: "4.00" });
		await seedReleased(t, "100.00");
		const c = await seedCoupon(t, { value: "50" }); // paid 50, falta 10
		const { orderRef, res } = await place(t, { paid: "50.00", code: c.code });
		expect(res.ok).toBe(true);
		expect(await redemption(orderRef)).toMatchObject({ funded_wallet: "4.00", funded_payable: "6.00" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "0.00", reserved: "4.00" });
		expect(await payableKinds(t.bureau.id)).toEqual([
			{ kind: "accrual", amount: "100.00" },
			{ kind: "coupon_cost", amount: "-6.00" },
		]);
		// O saldo liberado fica em 94 e conta no repasse.
		const { rows: buckets } = await committed(adminCtx(t), (cl) => cl.query<{ released: string }>("select released from payable_buckets($1)", [t.bureau.id]));
		expect(buckets[0].released).toBe("94.00");
	});

	it("refuses with coupon_funds_insufficient and leaves no trace; retained accrual does not count", async () => {
		const t = await tenant("cup nofunds", { client: "100.00", wallet: "4.00" });
		await seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "accrual", amount: "100.00" }); // recente: retido
		const c = await seedCoupon(t, { value: "50" });
		const { orderRef, res } = await place(t, { paid: "50.00", code: c.code });
		expect(res).toMatchObject({ ok: false, reason: "coupon_funds_insufficient" });
		expect(await clientWallet(t.client.userId)).toEqual({ available: "100.00", reserved: "0.00" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "4.00", reserved: "0.00" });
		expect(await redemption(orderRef)).toBeUndefined();
		expect(await settlements(t.client.userId)).toBe(0);
		expect((await payableKinds(t.bureau.id)).map((k) => k.kind)).toEqual(["accrual"]);
	});

	it("a payout concurrent with a coupon reservation never spends the same money twice", async () => {
		const cutoff = new Date(Date.now() - 35 * 86400_000).toISOString();
		for (let round = 0; round < 4; round += 1) {
			const t = await tenant(`cup payout ${round}`);
			await seedReleased(t, "100.00");
			const c = await seedCoupon(t, { value: "100" }); // paid 0, falta 60 (todo do repasse)
			const orderRef = randomUUID();
			await seedOrderDossier(owner, { orderRef, bureauId: t.bureau.id, clientProfileId: t.client.userId });
			await committed(clientCtx(t), (cl) => seedOrderCatalog(owner, cl, { productCode: "dossie_pf", price: "100.00", cost: "60.00" }));
			const [reserved, payout] = await Promise.all([
				reserveOnly(t, { orderRef, clientId: t.client.userId, paid: "0.00", code: c.code }),
				committed(superCtx(), (cl) =>
					cl.query<{ ok: boolean; reason: string | null; amount: string | null }>(
						"select ok, reason, amount from create_payout($1, $2)", [t.bureau.id, cutoff]).then((r) => r.rows[0]),
				),
			]);
			expect(payout.ok).toBe(true);
			const spentByCoupon = reserved.ok ? 60 : 0;
			// Ou o repasse leva 100 e o cupom é recusado, ou o cupom leva 60 antes e o repasse leva 40.
			expect(Number(payout.amount) + spentByCoupon).toBe(100);
			if (!reserved.ok) expect(reserved.reason).toBe("coupon_funds_insufficient");
		}
	});
});

describe("devolução", () => {
	async function reservedWithMix(label: string) {
		const t = await tenant(label, { client: "100.00", wallet: "4.00" });
		await seedReleased(t, "100.00");
		const c = await seedCoupon(t, { value: "50", maxUses: 1 });
		const { orderRef, res } = await place(t, { paid: "50.00", code: c.code });
		expect(res.ok).toBe(true);
		return { t, c, orderRef };
	}
	async function expectGivenBack(t: SeededTenant, c: { code: string }, orderRef: string) {
		expect(await redemption(orderRef)).toMatchObject({ status: "released" });
		expect(await clientWallet(t.client.userId)).toEqual({ available: "100.00", reserved: "0.00" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "4.00", reserved: "0.00" });
		expect(await payableKinds(t.bureau.id)).toEqual([
			{ kind: "accrual", amount: "100.00" },
			{ kind: "coupon_cost", amount: "-6.00" },
			{ kind: "coupon_refund", amount: "6.00" },
		]);
		expect(await rows("select 1 from audit_logs where action = 'coupon.release' and metadata->>'order_ref' = $1", [orderRef])).toHaveLength(1);
		// O uso voltou: o mesmo cupom (limite 1) vale de novo.
		expect((await place(t, { paid: "50.00", code: c.code })).res.ok).toBe(true);
	}

	it("release_order gives usage and funds back, once", async () => {
		const { t, c, orderRef } = await reservedWithMix("cup rel");
		expect(await release(t, orderRef)).toMatchObject({ ok: true, status: "released" });
		expect(await release(t, orderRef)).toMatchObject({ ok: true, status: "released" });
		await expectGivenBack(t, c, orderRef);
	});

	it("client cancel (cancel_client_order) gives everything back", async () => {
		const { t, c, orderRef } = await reservedWithMix("cup cancel client");
		const r = await committed(clientCtx(t), (cl) => cl.query<{ ok: boolean }>("select * from cancel_client_order($1)", [orderRef]).then((x) => x.rows[0]));
		expect(r.ok).toBe(true);
		await expectGivenBack(t, c, orderRef);
	});

	it("expiry (cancelOrder from the tick: scr_expired) gives everything back", async () => {
		const { t, c, orderRef } = await reservedWithMix("cup expiry");
		const out = await withUserTransaction(staff(t), (cl) => cancelOrder(cl, staff(t), orderRef, "scr_expired"));
		expect(out).toEqual({ ok: true });
		await expectGivenBack(t, c, orderRef);
	});

	it("order failure (failOrder) gives everything back", async () => {
		const { t, c, orderRef } = await reservedWithMix("cup fail");
		await owner.query("update dossier_orders set state = 'ready' where dossier_id = $1", [orderRef]);
		await owner.query("update dossier_orders set state = 'executing', lease_until = now() + interval '5 minutes' where dossier_id = $1", [orderRef]);
		await withUserTransaction(staff(t), (cl) => failOrder(cl, staff(t), orderRef, "deps_no_data"));
		await expectGivenBack(t, c, orderRef);
	});

	it("a PIX refund that claws back the reservation: capture closes the order and gives the coupon back", async () => {
		const t = await tenant("cup clawback", { client: "50.00", wallet: "100.00" });
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id, requestedBy: t.client.userId, clientProfileId: t.client.userId, amount: "50.00", status: "paid",
		});
		const c = await seedCoupon(t, { value: "50", maxUses: 1 });
		const { orderRef, res } = await place(t, { paid: "50.00", code: c.code });
		expect(res.ok).toBe(true);
		const ev = await hook.query<{ apply_asaas_payment: string }>(
			"select apply_asaas_payment($1, 'PAYMENT_REFUNDED', $2, '{}'::jsonb)", [`evt-${randomBytes(6).toString("hex")}`, charge.asaasPaymentId]);
		expect(ev.rows[0].apply_asaas_payment).toBe("refunded");
		expect(await capture(t, orderRef)).toMatchObject({ ok: false, reason: "reservation_clawed_back", status: "released" });
		expect(await redemption(orderRef)).toMatchObject({ status: "released" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "100.00", reserved: "0.00" });
		// O uso voltou (o cliente ficou sem saldo, então só se conta a redenção).
		expect(await rows("select 1 from coupon_redemptions where coupon_id = $1 and status in ('reserved', 'consumed')", [c.id])).toHaveLength(0);
	});
});

describe("depois da captura", () => {
	it("a PIX refund after capture does not undo coupon_cost, the Bureau wallet capture or the redemption", async () => {
		const t = await tenant("cup refund", { client: "50.00", wallet: "4.00" });
		await seedReleased(t, "100.00");
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id, requestedBy: t.client.userId, clientProfileId: t.client.userId, amount: "50.00", status: "paid",
		});
		const c = await seedCoupon(t, { value: "50" });
		const { orderRef } = await place(t, { paid: "50.00", code: c.code });
		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });
		await hook.query("select apply_asaas_payment($1, 'PAYMENT_REFUNDED', $2, '{}'::jsonb)", [`evt-${randomBytes(6).toString("hex")}`, charge.asaasPaymentId]);

		expect(await redemption(orderRef)).toMatchObject({ status: "consumed", funded_wallet: "4.00", funded_payable: "6.00" });
		expect(await bureauWallet(t.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
		const kinds = (await payableKinds(t.bureau.id)).map((k) => k.kind);
		expect(kinds).toContain("coupon_cost");
		expect(kinds).not.toContain("coupon_refund");
	});

	it("affiliate commission is on the gross price: a coupon that wipes the Bureau commission does not remove it", async () => {
		const t = await tenant("cup affiliate", { client: "500.00", wallet: "100.00" });
		const affiliate = await seedClientProfile(owner, t.bureau.id);
		await owner.query("insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)", [
			t.client.userId, affiliate.userId, t.bureau.id,
		]);
		const conn = await owner.connect();
		try {
			await conn.query("begin");
			await conn.query("set local session_replication_role = replica");
			await conn.query("update profiles set phone_e164 = '+5563999990000', phone_verified_at = now() where id = $1", [t.client.userId]);
			await conn.query("commit");
		} finally {
			conn.release();
		}
		await owner.query(
			"insert into bureau_affiliate_settings (bureau_id, default_pct) values ($1, 10) on conflict (bureau_id) do update set default_pct = 10",
			[t.bureau.id],
		);
		// Preço bruto 100, comissão do Bureau 40%, afiliado 10% do bruto (sai da parte da plataforma, que o cupom não muda).
		// Paga 60 = parte da plataforma: o Bureau fica com 0. Paga 50: o Bureau cobre 10 (a carteira) e fica com 0.
		const zero = await seedCoupon(t, { value: "40" });
		const a = await place(t, { paid: "60.00", code: zero.code });
		expect(await capture(t, a.orderRef)).toMatchObject({ ok: true });
		const neg = await seedCoupon(t, { value: "50" });
		const b = await place(t, { paid: "50.00", code: neg.code });
		expect(await capture(t, b.orderRef)).toMatchObject({ ok: true });
		const commissions = await rows<{ amount: string; margin: string }>(
			"select amount, margin from affiliate_commissions where bureau_id = $1",
			[t.bureau.id],
		);
		expect(commissions).toHaveLength(2);
		for (const c of commissions) expect({ amount: c.amount, margin: c.margin }).toEqual({ amount: "10.00", margin: "100.00" });
		// O Bureau não recebe acréscimo (a comissão dele foi toda para o desconto).
		expect(await payableKinds(t.bureau.id)).toEqual([]);

		// Sem cupom o Bureau recebe os 40 inteiros e o afiliado, os mesmos 10.
		const plain = await place(t, { paid: "100.00" });
		await capture(t, plain.orderRef);
		expect(await rows("select 1 from affiliate_commissions where bureau_id = $1", [t.bureau.id])).toHaveLength(3);
		expect(await payableKinds(t.bureau.id)).toEqual([{ kind: "accrual", amount: "40.00" }]);
	});
});

describe("coupon_preview", () => {
	const preview = (t: SeededTenant, code: string, products: string[] = ["dossie_pf"], ctx: Ctx = clientCtx(t)) =>
		committed(ctx, (c) =>
			c
				.query<{ coupon_id: string; kind: string; value: string; eligible_product_codes: string[] }>(
					"select * from coupon_preview($1, $2::text[])", [code, products])
				.then((r) => r.rows),
		);

	it("returns the coupon for a valid code (normalized) and lists the eligible products", async () => {
		const t = await tenant("prev ok", { client: "10.00" });
		const c = await seedCoupon(t, { value: "25", allProducts: false, productCodes: ["dossie_pf"] });
		const out = await preview(t, ` ${c.code.toLowerCase()} `, ["dossie_pf", "dossie_empresarial"]);
		expect(out).toEqual([{ coupon_id: c.id, kind: "percent", value: "25.00", eligible_product_codes: ["dossie_pf"] }]);
	});

	it("returns zero rows for unknown, another Bureau, expired, inactive and exhausted codes", async () => {
		const t = await tenant("prev bad", { client: "300.00" });
		const other = await tenant("prev other");
		const foreign = await seedCoupon(other, { value: "10" });
		const expired = await seedCoupon(t, { value: "10", validFrom: "2020-01-01T00:00:00Z", validUntil: "2020-02-01T00:00:00Z" });
		const off = await seedCoupon(t, { value: "10", active: false });
		const used = await seedCoupon(t, { value: "10", maxUses: 1 });
		expect((await place(t, { paid: "90.00", code: used.code })).res.ok).toBe(true);
		for (const code of ["NAOEXISTE", foreign.code, expired.code, off.code, used.code]) {
			expect(await preview(t, code)).toEqual([]);
		}
		// Só o cliente chama: a equipe não recebe linha.
		const ok = await seedCoupon(t, { value: "10" });
		expect(await preview(t, ok.code, ["dossie_pf"], adminCtx(t))).toEqual([]);
	});

	it("a product the coupon does not accept comes back out of the eligible list", async () => {
		const t = await tenant("prev product");
		const c = await seedCoupon(t, { value: "10", allProducts: false, productCodes: ["dossie_empresarial"] });
		const out = await preview(t, c.code, ["dossie_pf"]);
		expect(out).toHaveLength(1);
		expect(out[0].eligible_product_codes).toEqual([]);
	});
});
