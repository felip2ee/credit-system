// M3b / migrations 016-019 (correções do painel 3): estorno de PIX que reverte o valor a repassar, reserva por pedido,
// reserve_order conferindo o catálogo e PAYMENT_PARTIALLY_REFUNDED. Postgres real, sob RLS.
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	TEST_DATABASE_OWNER_URL,
	TEST_DATABASE_URL,
	TEST_DATABASE_WEBHOOK_URL,
} from "@/test/db-env";
import {
	seedCatalogItem,
	seedClientWalletTopup,
	seedOrderCatalog,
	seedOrderDossierForSession,
	seedPixCharge,
	seedProduct,
	seedProductVersion,
	seedSuperadmin,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 2 });

let superadmin: SeedSuperadmin;

beforeAll(async () => {
	superadmin = await seedSuperadmin(owner);
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), hook.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string | null };
const ctxOf = (id: Ctx): Ctx => ({ userId: id.userId, role: id.role, bureauId: id.bureauId });
const clientCtx = (t: SeededTenant) => ctxOf(t.client);
const adminCtx = (t: SeededTenant) => ctxOf(t.bureauAdmin);
const operatorCtx = (t: SeededTenant) => ctxOf(t.operator);
const superadminCtx = (): Ctx => ({ userId: superadmin.userId, role: "superadmin", bureauId: null });

async function committed<T>(ctx: Ctx, work: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true),
              set_config('app.user_role', $2, true),
              set_config('app.bureau_id', $3, true),
              set_config('app.support_session_id', '', true)`,
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
type Quote = { lines: { code: string }[] };

const reserveRaw = (
	c: PoolClient,
	o: { orderRef: string; mode: "online" | "counter"; clientId: string | null; price: string; cost: string; quote: Quote },
) =>
	c
		.query<SettleRow>("select * from reserve_order($1, $2, $3, $4, $5, $6::jsonb)", [
			o.orderRef,
			o.mode,
			o.clientId,
			o.price,
			o.cost,
			JSON.stringify(o.quote),
		])
		.then((r) => r.rows[0]);
// Cria o Dossiê e o produto que casam com preço e custo, e reserva.
async function reserve(
	c: PoolClient,
	o: { orderRef: string; mode: "online" | "counter"; clientId: string | null; price: string; cost: string },
) {
	await seedOrderDossierForSession(owner, c, { orderRef: o.orderRef, clientProfileId: o.clientId });
	return reserveRaw(c, { ...o, quote: await seedOrderCatalog(owner, c, { ...o, productCode: "dossie_pf" }) });
}
const capture = (c: PoolClient, ref: string) =>
	c.query<SettleRow>("select * from capture_order($1)", [ref]).then((r) => r.rows[0]);
const release = (c: PoolClient, ref: string) =>
	c.query<SettleRow>("select * from release_order($1)", [ref]).then((r) => r.rows[0]);

const onlineOrder = (t: SeededTenant, price: string, cost: string) => ({
	orderRef: randomUUID(),
	mode: "online" as const,
	clientId: t.client.userId,
	price,
	cost,
});

const hookEvent = (type: string, asaasPaymentId: string) =>
	hook
		.query<{ apply_asaas_payment: string }>("select apply_asaas_payment($1, $2, $3, '{}'::jsonb)", [
			`evt-${randomBytes(6).toString("hex")}`,
			type,
			asaasPaymentId,
		])
		.then((r) => r.rows[0].apply_asaas_payment);
const refund = (asaasPaymentId: string) => hookEvent("PAYMENT_REFUNDED", asaasPaymentId);

async function clientBalance(clientId: string) {
	const { rows } = await owner.query<{ available: string; reserved: string }>(
		"select available, reserved from client_wallets where client_profile_id = $1",
		[clientId],
	);
	return rows[0];
}
async function bureauBalance(bureauId: string) {
	const { rows } = await owner.query<{ available: string; reserved: string }>(
		"select available, reserved from wallets where bureau_id = $1",
		[bureauId],
	);
	return rows[0];
}
async function chargeRow(id: string) {
	const { rows } = await owner.query<{ status: string; refund_shortfall: string }>(
		"select status, refund_shortfall from pix_charges where id = $1",
		[id],
	);
	return rows[0];
}
async function payable(bureauId: string) {
	const { rows } = await owner.query<{
		kind: string;
		amount: string;
		order_ref: string | null;
		pix_charge_id: string | null;
	}>(
		"select kind, amount, order_ref, pix_charge_id from bureau_payable_entries where bureau_id = $1 order by created_at, id",
		[bureauId],
	);
	return rows;
}
async function payableBalance(bureauId: string) {
	const { rows } = await owner.query<{ total: string }>(
		"select coalesce(sum(amount), 0)::text as total from bureau_payable_entries where bureau_id = $1",
		[bureauId],
	);
	return rows[0].total;
}
async function settlementRow(orderRef: string) {
	const { rows } = await owner.query<{ status: string; price: string; cost: string; quote: unknown }>(
		"select status, price, cost, quote from order_settlements where order_ref = $1",
		[orderRef],
	);
	return rows[0];
}
const ledgerKinds = async (clientId: string, orderRef: string) =>
	(
		await owner.query<{ kind: string }>(
			"select kind from client_ledger_entries where client_profile_id = $1 and reference = $2 order by seq",
			[clientId, `order:${orderRef}`],
		)
	).rows.map((r) => r.kind);

// Cliente com saldo `funds` e uma cobrança PIX do cliente já paga de `chargeAmount` (a que será estornada).
async function setup(label: string, funds: string, chargeAmount: string) {
	const t = await seedTenant(owner, label);
	await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: funds, createdBy: t.client.userId });
	const charge = await seedPixCharge(owner, {
		bureauId: t.bureau.id,
		requestedBy: t.client.userId,
		clientProfileId: t.client.userId,
		amount: chargeAmount,
		status: "paid",
	});
	return { t, charge };
}

async function placeAndCapture(t: SeededTenant, price: string, cost: string) {
	const order = onlineOrder(t, price, cost);
	expect(await committed(clientCtx(t), (c) => reserve(c, order))).toMatchObject({ ok: true });
	expect(await committed(adminCtx(t), (c) => capture(c, order.orderRef))).toMatchObject({ ok: true });
	return order;
}

describe("A1: estorno de PIX do cliente reverte o valor a repassar", () => {
	it("reverses the whole accrual and records the rest as shortfall (reviewer scenario)", async () => {
		const { t, charge } = await setup("A1 cenário", "100.00", "100.00");
		const order = await placeAndCapture(t, "100.00", "30.00");
		expect(await payableBalance(t.bureau.id)).toBe("70.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect(await payable(t.bureau.id)).toEqual([
			{ kind: "accrual", amount: "70.00", order_ref: order.orderRef, pix_charge_id: null },
			{ kind: "reversal", amount: "-70.00", order_ref: null, pix_charge_id: charge.id },
		]);
		expect(await chargeRow(charge.id)).toEqual({ status: "refunded", refund_shortfall: "30.00" });
		expect(await payableBalance(t.bureau.id)).toBe("0.00");
		const paid = await committed(superadminCtx(), (c) =>
			c.query("select * from create_payout($1, now())", [t.bureau.id]).then((r) => r.rows[0]),
		);
		expect(paid).toMatchObject({ ok: false, reason: "nothing_to_pay" });
	});

	it("reverses only the shortfall when it is smaller than the accrual", async () => {
		const { t, charge } = await setup("A1 menor", "150.00", "100.00");
		await placeAndCapture(t, "100.00", "10.00");
		// Carteira com 50 sobrando: o estorno de 100 tira 50 dela e falta 50. O acréscimo é 90.
		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		const rows = await payable(t.bureau.id);
		expect(rows.map((r) => [r.kind, r.amount])).toEqual([
			["accrual", "90.00"],
			["reversal", "-50.00"],
		]);
		expect(await chargeRow(charge.id)).toEqual({ status: "refunded", refund_shortfall: "0.00" });
		expect(await payableBalance(t.bureau.id)).toBe("40.00");
	});

	it("writes no reversal when the Bureau has no accrual", async () => {
		const { t, charge } = await setup("A1 zero", "100.00", "100.00");
		await placeAndCapture(t, "100.00", "100.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect(await payable(t.bureau.id)).toEqual([]);
		expect(await chargeRow(charge.id)).toEqual({ status: "refunded", refund_shortfall: "100.00" });
	});

	it("never reverses more than the unpaid balance (a paid-out accrual is not clawed back)", async () => {
		const { t, charge } = await setup("A1 pago", "100.00", "100.00");
		await placeAndCapture(t, "100.00", "30.00");
		const payout = await committed(superadminCtx(), async (c) => {
			const made = await c
				.query<{ payout_id: string }>("select * from create_payout($1, now() + interval '1 day')", [t.bureau.id])
				.then((r) => r.rows[0]);
			await c.query("select * from mark_payout_paid($1, $2, 'application/pdf', $3)", [
				made.payout_id,
				`receipts/${randomUUID()}.pdf`,
				createHash("sha256").update(randomUUID()).digest("hex"),
			]);
			return made;
		});
		expect(payout.payout_id).toBeTruthy();
		expect(await payableBalance(t.bureau.id)).toBe("0.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect((await payable(t.bureau.id)).map((r) => r.kind)).toEqual(["accrual", "payout"]);
		expect(await chargeRow(charge.id)).toEqual({ status: "refunded", refund_shortfall: "100.00" });
	});

	it("never reverses an accrual already selected into an open payout, and keeps the whole shortfall", async () => {
		const { t, charge } = await setup("A1 aberto", "100.00", "100.00");
		await placeAndCapture(t, "100.00", "30.00"); // +70
		const open = await committed(superadminCtx(), (c) =>
			c
				.query<{ payout_id: string; amount: string }>("select * from create_payout($1, now() + interval '1 day')", [
					t.bureau.id,
				])
				.then((r) => r.rows[0]),
		);
		expect(open.amount).toBe("70.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect((await payable(t.bureau.id)).map((r) => r.kind)).toEqual(["accrual"]);
		expect(await chargeRow(charge.id)).toEqual({ status: "refunded", refund_shortfall: "100.00" });

		// Pagar o repasse inteiro não deixa nenhum estorno solto para abater de acréscimos futuros.
		await committed(superadminCtx(), (c) =>
			c.query("select * from mark_payout_paid($1, $2, 'application/pdf', $3)", [
				open.payout_id,
				`receipts/${randomUUID()}.pdf`,
				createHash("sha256").update(randomUUID()).digest("hex"),
			]),
		);
		expect((await payable(t.bureau.id)).map((r) => r.kind)).toEqual(["accrual", "payout"]);
		expect(await payableBalance(t.bureau.id)).toBe("0.00");
	});

	it("reverses only the part of the balance that no payout holds", async () => {
		const { t, charge } = await setup("A1 misto", "200.00", "100.00");
		await placeAndCapture(t, "100.00", "30.00"); // +70, vai para o repasse aberto
		await committed(superadminCtx(), (c) =>
			c.query("select * from create_payout($1, now() + interval '1 day')", [t.bureau.id]),
		);
		await placeAndCapture(t, "100.00", "50.00"); // +50, livre

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		const rows = await payable(t.bureau.id);
		expect(rows.map((r) => [r.kind, r.amount])).toEqual([
			["accrual", "70.00"],
			["accrual", "50.00"],
			["reversal", "-50.00"],
		]);
		expect(await chargeRow(charge.id)).toEqual({ status: "refunded", refund_shortfall: "50.00" });
	});

	it("pays the netted amount and never counts a reversal twice", async () => {
		const { t, charge } = await setup("A1 repasse", "200.00", "100.00");
		await placeAndCapture(t, "100.00", "30.00"); // +70
		await placeAndCapture(t, "100.00", "50.00"); // +50
		expect(await refund(charge.asaasPaymentId)).toBe("refunded"); // -100

		const first = await committed(superadminCtx(), (c) =>
			c
				.query<{ ok: boolean; payout_id: string; amount: string }>(
					"select * from create_payout($1, now() + interval '1 day')",
					[t.bureau.id],
				)
				.then((r) => r.rows[0]),
		);
		expect(first).toMatchObject({ ok: true, amount: "20.00" });
		const items = await owner.query<{ kind: string }>(
			`select e.kind from payout_items i join bureau_payable_entries e on e.id = i.entry_id
        where i.payout_id = $1 order by e.kind`,
			[first.payout_id],
		);
		expect(items.rows.map((r) => r.kind)).toEqual(["accrual", "accrual", "reversal"]);

		// Nova venda e segundo repasse: só o acréscimo novo entra, o estorno já tem repasse.
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "40.00", createdBy: t.client.userId });
		await placeAndCapture(t, "40.00", "30.00"); // +10
		const second = await committed(superadminCtx(), (c) =>
			c
				.query<{ ok: boolean; amount: string }>("select * from create_payout($1, now() + interval '1 day')", [
					t.bureau.id,
				])
				.then((r) => r.rows[0]),
		);
		expect(second).toMatchObject({ ok: true, amount: "10.00" });
		const reversalItems = await owner.query(
			`select 1 from payout_items i join bureau_payable_entries e on e.id = i.entry_id where e.kind = 'reversal' and e.bureau_id = $1`,
			[t.bureau.id],
		);
		expect(reversalItems.rowCount).toBe(1);
	});

	it("does not touch the payable ledger for a Bureau top-up refund", async () => {
		const t = await seedTenant(owner, "A1 bureau");
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "100.00", createdBy: t.bureauAdmin.userId });
		await placeAndCapture(
			(await setup("A1 bureau cliente", "100.00", "100.00")).t,
			"100.00",
			"30.00",
		);
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.bureauAdmin.userId,
			amount: "500.00",
			status: "paid",
		});
		expect(await refund(charge.asaasPaymentId)).toBe("refunded");
		expect(await payable(t.bureau.id)).toEqual([]);
	});
});

describe("A2: a reserva restante é por pedido", () => {
	it("keeps the second order whole when a refund clawed back only the first (reviewer scenario)", async () => {
		const { t, charge } = await setup("A2 cenário", "130.00", "100.00");
		const a = onlineOrder(t, "100.00", "60.00");
		const b = onlineOrder(t, "30.00", "20.00");
		await committed(clientCtx(t), (c) => reserve(c, a));
		await committed(clientCtx(t), (c) => reserve(c, b));
		expect(await clientBalance(t.client.userId)).toEqual({ available: "0.00", reserved: "130.00" });

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");
		expect(await clientBalance(t.client.userId)).toEqual({ available: "0.00", reserved: "30.00" });

		// A perdeu tudo: liberar não devolve nada e não toma a reserva de B.
		expect(await committed(clientCtx(t), (c) => release(c, a.orderRef))).toEqual({
			ok: true,
			reason: null,
			status: "released",
		});
		expect(await clientBalance(t.client.userId)).toEqual({ available: "0.00", reserved: "30.00" });
		expect(await ledgerKinds(t.client.userId, a.orderRef)).toEqual(["reserve"]);

		expect(await committed(adminCtx(t), (c) => capture(c, b.orderRef))).toEqual({
			ok: true,
			reason: null,
			status: "captured",
		});
		expect(await clientBalance(t.client.userId)).toEqual({ available: "0.00", reserved: "0.00" });
		expect((await payable(t.bureau.id)).map((r) => [r.kind, r.amount])).toEqual([["accrual", "10.00"]]);
	});

	it("gives each order only what is left of its own reservation after a partial claw back", async () => {
		const { t, charge } = await setup("A2 parcial", "130.00", "50.00");
		const a = onlineOrder(t, "100.00", "60.00");
		const b = onlineOrder(t, "30.00", "20.00");
		await committed(clientCtx(t), (c) => reserve(c, a));
		await committed(clientCtx(t), (c) => reserve(c, b));
		expect(await refund(charge.asaasPaymentId)).toBe("refunded");
		expect(await clientBalance(t.client.userId)).toEqual({ available: "0.00", reserved: "80.00" });

		// A (a mais antiga) absorveu os 50: sobram 50 dela. B segue inteiro.
		expect(await committed(clientCtx(t), (c) => release(c, a.orderRef))).toMatchObject({ ok: true });
		expect(await clientBalance(t.client.userId)).toEqual({ available: "50.00", reserved: "30.00" });
		expect(await committed(adminCtx(t), (c) => capture(c, b.orderRef))).toMatchObject({
			ok: true,
			status: "captured",
		});
		expect(await clientBalance(t.client.userId)).toEqual({ available: "50.00", reserved: "0.00" });
	});

	it("captures the first order partly clawed back as a release and keeps the second capturable", async () => {
		const { t, charge } = await setup("A2 captura", "130.00", "50.00");
		const a = onlineOrder(t, "100.00", "60.00");
		const b = onlineOrder(t, "30.00", "20.00");
		await committed(clientCtx(t), (c) => reserve(c, a));
		await committed(clientCtx(t), (c) => reserve(c, b));
		await refund(charge.asaasPaymentId);

		expect(await committed(adminCtx(t), (c) => capture(c, a.orderRef))).toEqual({
			ok: false,
			reason: "reservation_clawed_back",
			status: "released",
		});
		expect(await clientBalance(t.client.userId)).toEqual({ available: "50.00", reserved: "30.00" });
		expect(await committed(adminCtx(t), (c) => capture(c, b.orderRef))).toMatchObject({ ok: true });
		expect((await settlementRow(b.orderRef)).status).toBe("captured");
	});

	it("keeps the counter orders of one Bureau apart too", async () => {
		const t = await seedTenant(owner, "A2 balcão");
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "100.00", createdBy: t.bureauAdmin.userId });
		const a = { orderRef: randomUUID(), mode: "counter" as const, clientId: null, price: "80.00", cost: "70.00" };
		const b = { orderRef: randomUUID(), mode: "counter" as const, clientId: null, price: "40.00", cost: "30.00" };
		await committed(operatorCtx(t), (c) => reserve(c, a));
		await committed(operatorCtx(t), (c) => reserve(c, b));
		// Um estorno da recarga do Bureau tira os 70 de A (disponível 0, reservado 100).
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.bureauAdmin.userId,
			amount: "70.00",
			status: "paid",
		});
		expect(await refund(charge.asaasPaymentId)).toBe("refunded");
		expect(await bureauBalance(t.bureau.id)).toEqual({ available: "0.00", reserved: "30.00" });

		expect(await committed(operatorCtx(t), (c) => release(c, a.orderRef))).toMatchObject({ ok: true });
		expect(await bureauBalance(t.bureau.id)).toEqual({ available: "0.00", reserved: "30.00" });
		expect(await committed(operatorCtx(t), (c) => capture(c, b.orderRef))).toMatchObject({
			ok: true,
			status: "captured",
		});
		expect(await bureauBalance(t.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
	});
});

describe("A3: reserve_order confere preço e custo no catálogo", () => {
	// Produto principal à venda por 50, custo 30, no Bureau da sessão.
	const catalogFor = (_t: SeededTenant, c: PoolClient) => seedOrderCatalog(owner, c, { productCode: "dossie_pf", price: "50.00", cost: "30.00" });
	const orderOf = (t: SeededTenant, price: string, cost: string) => onlineOrder(t, price, cost);

	async function newDossier(t: SeededTenant, c: PoolClient, o: { orderRef: string; clientId: string | null }) {
		await seedOrderDossierForSession(owner, c, { orderRef: o.orderRef, clientProfileId: o.clientId });
	}

	it("rejects a price that differs from the catalog and leaves nothing behind", async () => {
		const t = await seedTenant(owner, "A3 preço");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "100.00", createdBy: t.client.userId });
		const order = orderOf(t, "49.99", "30.00");
		const result = await committed(clientCtx(t), async (c) => {
			const quote = await catalogFor(t, c);
			await newDossier(t, c, order);
			return reserveRaw(c, { ...order, quote });
		});
		expect(result).toEqual({ ok: false, reason: "quote_mismatch", status: null });
		expect(await settlementRow(order.orderRef)).toBeUndefined();
		expect(await clientBalance(t.client.userId)).toEqual({ available: "100.00", reserved: "0.00" });
	});

	it("rejects a counter order whose cost differs from the catalog, and reserves the catalog cost otherwise", async () => {
		const t = await seedTenant(owner, "A3 balcão");
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "100.00", createdBy: t.bureauAdmin.userId });
		const wrong = { orderRef: randomUUID(), mode: "counter" as const, clientId: null, price: "50.00", cost: "29.00" };
		const right = { ...wrong, orderRef: randomUUID(), cost: "30.00" };
		const results = await committed(operatorCtx(t), async (c) => {
			const quote = await catalogFor(t, c);
			await newDossier(t, c, wrong);
			await newDossier(t, c, right);
			return [await reserveRaw(c, { ...wrong, quote }), await reserveRaw(c, { ...right, quote })];
		});
		expect(results[0]).toEqual({ ok: false, reason: "quote_mismatch", status: null });
		expect(results[1]).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(await settlementRow(wrong.orderRef)).toBeUndefined();
		expect(await settlementRow(right.orderRef)).toMatchObject({ cost: "30.00", price: "50.00" });
		expect(await bureauBalance(t.bureau.id)).toEqual({ available: "70.00", reserved: "30.00" });
	});

	it("gives a client probe the same answer for every cost and stores the catalog cost", async () => {
		const t = await seedTenant(owner, "A3 oráculo");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "500.00", createdBy: t.client.userId });
		const refs = [randomUUID(), randomUUID(), randomUUID()];
		const costs = ["1.00", "30.00", "49.00"];
		const results = await committed(clientCtx(t), async (c) => {
			const quote = await catalogFor(t, c);
			const out: SettleRow[] = [];
			for (let i = 0; i < refs.length; i++) {
				const ref = refs[i];
				const o = { orderRef: ref, mode: "online" as const, clientId: t.client.userId, price: "50.00", cost: costs[i] };
				await newDossier(t, c, o);
				out.push(await reserveRaw(c, { ...o, quote }));
			}
			// Repetição de um pedido já gravado, com os mesmos custos errados e certos.
			for (const cost of costs) {
				out.push(
					await reserveRaw(c, {
						orderRef: refs[0],
						mode: "online",
						clientId: t.client.userId,
						price: "50.00",
						cost,
						quote,
					}),
				);
			}
			return out;
		});
		for (const r of results) expect(r).toEqual({ ok: true, reason: null, status: "reserved" });
		for (const ref of refs) expect(await settlementRow(ref)).toMatchObject({ cost: "30.00" });
	});

	it("rejects empty, repeated, unknown, inactive and unsellable lines with one reason", async () => {
		const t = await seedTenant(owner, "A3 linhas");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "500.00", createdBy: t.client.userId });
		const inactive = await seedProduct(owner, { baseCost: "10.00" });
		await seedCatalogItem(owner, {
			bureauId: t.bureau.id,
			productId: inactive.id,
			salePrice: "20.00",
			updatedBy: t.bureauAdmin.userId,
			active: false,
		});
		const unsellable = await seedProduct(owner, { baseCost: "10.00" });
		await seedCatalogItem(owner, {
			bureauId: t.bureau.id,
			productId: unsellable.id,
			salePrice: "20.00",
			updatedBy: t.bureauAdmin.userId,
		});
		// O custo sobe acima do preço depois da ativação: o item deixa de estar à venda.
		await seedProductVersion(owner, { productId: unsellable.id, version: 2, baseCost: "25.00" });
		const results = await committed(clientCtx(t), async (c) => {
			const ok = await seedOrderCatalog(owner, c, { productCode: "dossie_pf", price: "50.00", cost: "30.00" });
			const code = ok.lines[0].code;
			const out: SettleRow[] = [];
			const cases: Array<[string, Quote | unknown]> = [
				["20.00", { lines: [] }],
				["20.00", {}],
				["20.00", null],
				["100.00", { lines: [{ code }, { code }] }],
				["50.00", { lines: [{ code: "nao_existe" }] }],
				["50.00", { lines: [{ nope: true }] }],
				["20.00", { lines: [{ code: inactive.code }] }],
				["20.00", { lines: [{ code: unsellable.code }] }],
				["50.00", { lines: "x" }],
			];
			for (const [price, quote] of cases) {
				const o = { orderRef: randomUUID(), mode: "online" as const, clientId: t.client.userId, price, cost: "10.00" };
				await newDossier(t, c, o);
				out.push(
					await c
						.query<SettleRow>("select * from reserve_order($1, 'online', $2, $3, $4, $5::jsonb)", [
							o.orderRef,
							o.clientId,
							o.price,
							o.cost,
							JSON.stringify(quote),
						])
						.then((r) => r.rows[0]),
				);
			}
			return out;
		});
		for (const r of results) expect(r).toEqual({ ok: false, reason: "quote_mismatch", status: null });
		expect(await clientBalance(t.client.userId)).toEqual({ available: "500.00", reserved: "0.00" });
	});

	it("prices a main product with its compatible add-on and refuses an incompatible one", async () => {
		const t = await seedTenant(owner, "A3 adicional");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "500.00", createdBy: t.client.userId });
		const main = await seedProduct(owner, { baseCost: "30.00" });
		await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: main.id, salePrice: "50.00", updatedBy: t.bureauAdmin.userId });
		const addon = await seedProduct(owner, { baseCost: "5.00" });
		await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: addon.id, salePrice: "12.00", updatedBy: t.bureauAdmin.userId });
		const other = await seedProduct(owner, { baseCost: "5.00" });
		await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: other.id, salePrice: "12.00", updatedBy: t.bureauAdmin.userId });
		const good = onlineOrder(t, "62.00", "35.00");
		const twoMains = onlineOrder(t, "62.00", "35.00");
		const results = await committed(clientCtx(t), async (c) => {
			await newDossier(t, c, good);
			await newDossier(t, c, twoMains);
			return [
				await reserveRaw(c, { ...good, quote: { lines: [{ code: main.code }, { code: addon.code }] } }),
				await reserveRaw(c, { ...twoMains, quote: { lines: [{ code: main.code }, { code: other.code }] } }),
			];
		});
		expect(results[0]).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(results[1]).toEqual({ ok: false, reason: "quote_mismatch", status: null });
		expect(await settlementRow(good.orderRef)).toMatchObject({ price: "62.00", cost: "35.00" });
	});

	it("rejects a stale price after the catalog changed", async () => {
		const t = await seedTenant(owner, "A3 preço mudou");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "500.00", createdBy: t.client.userId });
		const product = await seedProduct(owner, { baseCost: "30.00" });
		await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: product.id, salePrice: "50.00", updatedBy: t.bureauAdmin.userId });
		await owner.query("update bureau_catalog_items set sale_price = 60 where bureau_id = $1 and product_id = $2", [
			t.bureau.id,
			product.id,
		]);
		const order = onlineOrder(t, "50.00", "30.00");
		const result = await committed(clientCtx(t), async (c) => {
			await newDossier(t, c, order);
			return reserveRaw(c, { ...order, quote: { lines: [{ code: product.code }] } });
		});
		expect(result).toEqual({ ok: false, reason: "quote_mismatch", status: null });
	});
});

describe("A5: PAYMENT_PARTIALLY_REFUNDED de cobrança do cliente", () => {
	it("answers partial_refund_ignored, keeps the charge paid and moves no balance or payable", async () => {
		const { t, charge } = await setup("A5 cliente", "100.00", "100.00");
		await placeAndCapture(t, "40.00", "30.00");

		expect(await hookEvent("PAYMENT_PARTIALLY_REFUNDED", charge.asaasPaymentId)).toBe("partial_refund_ignored");

		expect(await chargeRow(charge.id)).toEqual({ status: "paid", refund_shortfall: "0.00" });
		expect(await clientBalance(t.client.userId)).toEqual({ available: "60.00", reserved: "0.00" });
		expect((await payable(t.bureau.id)).map((r) => r.kind)).toEqual(["accrual"]);
		const { rows } = await owner.query<{ result: string }>(
			"select result from asaas_webhook_events where asaas_payment_id = $1 and event_type = 'PAYMENT_PARTIALLY_REFUNDED'",
			[charge.asaasPaymentId],
		);
		expect(rows).toEqual([{ result: "partial_refund_ignored" }]);
	});
});
