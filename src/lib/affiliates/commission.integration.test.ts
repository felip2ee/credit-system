// Comissão de afiliado (migração 027) contra um Postgres real: captura, carência, estorno e bloqueio LGPD.
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL, TEST_DATABASE_WEBHOOK_URL } from "@/test/db-env";
import {
	seedClientProfile,
	seedClientWalletTopup,
	seedOrderCatalog,
	seedOrderDossierForSession,
	seedPixCharge,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 2 });

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), hook.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string | null };
const PLATFORM: Ctx = { userId: "", role: "operator", bureauId: null };
const clientCtx = (userId: string, t: SeededTenant): Ctx => ({ userId, role: "client", bureauId: t.bureau.id });
const adminCtx = (t: SeededTenant): Ctx => ({ userId: t.bureauAdmin.userId, role: "bureau_admin", bureauId: t.bureau.id });
const operatorCtx = (t: SeededTenant): Ctx => ({ userId: t.operator.userId, role: "operator", bureauId: t.bureau.id });

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
type Order = { orderRef: string; mode: "online" | "counter"; clientId: string | null; price: string; cost: string };

async function reserve(c: PoolClient, o: Order) {
	await seedOrderDossierForSession(owner, c, { orderRef: o.orderRef, clientProfileId: o.clientId });
	const quote = await seedOrderCatalog(owner, c, { ...o, productCode: "dossie_pf" });
	return c
		.query<SettleRow>("select * from reserve_order($1, $2, $3, $4, $5, $6::jsonb)", [
			o.orderRef, o.mode, o.clientId, o.price, o.cost, JSON.stringify(quote),
		])
		.then((r) => r.rows[0]);
}
const capture = (c: PoolClient, ref: string) =>
	c.query<SettleRow>("select * from capture_order($1)", [ref]).then((r) => r.rows[0]);

// Dono (superusuário) escreve o telefone: o trigger protect_profile_contact só libera as funções da conta.
async function ownerUpdateProfile(profileId: string, set: string) {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		await client.query(`update profiles set ${set} where id = $1`, [profileId]);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

type Scenario = { t: SeededTenant; affiliateId: string; buyerId: string };

// Afiliado e indicado no mesmo Bureau, com % padrão do Bureau. O indicado tem telefone verificado, salvo pedido.
async function scenario(
	label: string,
	o: { pct?: string; linked?: boolean; verified?: boolean; funds?: string } = {},
): Promise<Scenario> {
	const t = await seedTenant(owner, label);
	const affiliate = await seedClientProfile(owner, t.bureau.id);
	// O cliente do seed tem Titular próprio: reserve_order exige o Dossiê do pedido sobre ele.
	const buyer = t.client;
	if (o.linked ?? true) {
		await owner.query(
			"insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)",
			[buyer.userId, affiliate.userId, t.bureau.id],
		);
	}
	if (o.verified ?? true) {
		await ownerUpdateProfile(buyer.userId, "phone_e164 = '+5563999990000', phone_verified_at = now()");
	}
	await setDefaultPct(t, o.pct ?? "10");
	await seedClientWalletTopup(owner, {
		clientProfileId: buyer.userId, amount: o.funds ?? "1000.00", createdBy: buyer.userId,
	});
	return { t, affiliateId: affiliate.userId, buyerId: buyer.userId };
}

async function setDefaultPct(t: SeededTenant, pct: string) {
	await owner.query(
		`insert into bureau_affiliate_settings (bureau_id, default_pct) values ($1, $2)
     on conflict (bureau_id) do update set default_pct = excluded.default_pct`,
		[t.bureau.id, pct],
	);
}

async function placeAndCapture(s: Scenario, price = "1000.00", cost = "600.00") {
	const order: Order = { orderRef: randomUUID(), mode: "online", clientId: s.buyerId, price, cost };
	expect(await committed(clientCtx(s.buyerId, s.t), (c) => reserve(c, order))).toMatchObject({ ok: true });
	expect(await committed(adminCtx(s.t), (c) => capture(c, order.orderRef))).toMatchObject({ ok: true });
	return order;
}

async function commissionsOf(orderRef: string) {
	const { rows } = await owner.query<{
		id: string; pct: string; margin: string; amount: string; reversed_amount: string; status: string; release_at: Date;
	}>("select id, pct, margin, amount, reversed_amount, status, release_at from affiliate_commissions where order_ref = $1", [
		orderRef,
	]);
	return rows;
}
async function accruals(orderRef: string) {
	const { rows } = await owner.query<{ amount: string }>(
		"select amount from bureau_payable_entries where order_ref = $1 and kind = 'accrual'",
		[orderRef],
	);
	return rows.map((r) => r.amount);
}
async function wallet(profileId: string) {
	const { rows } = await owner.query<{ pending: string; available: string }>(
		"select pending, available from affiliate_wallets where profile_id = $1",
		[profileId],
	);
	return rows[0];
}
const release = () =>
	committed(PLATFORM, (c) =>
		c.query<{ n: number }>("select release_due_commissions() as n").then((r) => r.rows[0].n),
	);
const backdate = (id: string) =>
	owner.query("update affiliate_commissions set release_at = now() - interval '1 minute' where id = $1", [id]);

describe("comissão na captura", () => {
	it("grava 40,00 pendente, accrual 360,00 e saldo pendente do afiliado (10% de 400,00)", async () => {
		const s = await scenario("Com 10");
		const order = await placeAndCapture(s);

		const [c] = await commissionsOf(order.orderRef);
		expect(c).toMatchObject({ pct: "10.00", margin: "400.00", amount: "40.00", reversed_amount: "0.00", status: "pending" });
		// Carência padrão de 30 dias (settings), gravada na comissão.
		const days = (c.release_at.getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(29.9);
		expect(days).toBeLessThan(30.1);
		expect(await accruals(order.orderRef)).toEqual(["360.00"]);
		expect(await wallet(s.affiliateId)).toEqual({ pending: "40.00", available: "0.00" });
		const audit = await owner.query(
			"select metadata from audit_logs where action = 'affiliate.commission' and record_id = $1",
			[c.id],
		);
		expect(audit.rows).toHaveLength(1);
		expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/\d{11}/);
	});

	it("a % 100 vira comissão de 400,00 e não deixa accrual", async () => {
		const s = await scenario("Com 100", { pct: "100" });
		const order = await placeAndCapture(s);

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ amount: "400.00", status: "pending" });
		expect(await accruals(order.orderRef)).toEqual([]);
		expect(await wallet(s.affiliateId)).toEqual({ pending: "400.00", available: "0.00" });
	});

	it("margem 0 não gera comissão", async () => {
		const s = await scenario("Margem zero");
		const order = await placeAndCapture(s, "600.00", "600.00");

		expect(await commissionsOf(order.orderRef)).toEqual([]);
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "0.00" });
	});

	it("pedido de balcão não gera comissão", async () => {
		const s = await scenario("Balcão");
		await seedWalletTopup(owner, { bureauId: s.t.bureau.id, amount: "1000.00", createdBy: s.t.bureauAdmin.userId });
		const order: Order = { orderRef: randomUUID(), mode: "counter", clientId: null, price: "1000.00", cost: "600.00" };
		expect(await committed(operatorCtx(s.t), (c) => reserve(c, order))).toMatchObject({ ok: true });
		expect(await committed(adminCtx(s.t), (c) => capture(c, order.orderRef))).toMatchObject({ ok: true });

		expect(await commissionsOf(order.orderRef)).toEqual([]);
	});

	it("comprador sem vínculo não gera comissão e o accrual fica com a margem inteira", async () => {
		const s = await scenario("Sem vínculo", { linked: false });
		const order = await placeAndCapture(s);

		expect(await commissionsOf(order.orderRef)).toEqual([]);
		expect(await accruals(order.orderRef)).toEqual(["400.00"]);
	});

	it("indicado sem telefone verificado não gera comissão e o accrual fica com a margem inteira", async () => {
		const s = await scenario("Sem telefone", { verified: false });
		const order = await placeAndCapture(s);

		expect(await commissionsOf(order.orderRef)).toEqual([]);
		expect(await accruals(order.orderRef)).toEqual(["400.00"]);
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "0.00" });
	});

	it("afiliado anonimizado não recebe comissão", async () => {
		const s = await scenario("Afiliado anon");
		await ownerUpdateProfile(s.affiliateId, "anonymized_at = now()");
		const order = await placeAndCapture(s);

		expect(await commissionsOf(order.orderRef)).toEqual([]);
		expect(await accruals(order.orderRef)).toEqual(["400.00"]);
	});

	it("captura repetida mantém uma comissão só", async () => {
		const s = await scenario("Repetida");
		const order = await placeAndCapture(s);
		expect(await committed(adminCtx(s.t), (c) => capture(c, order.orderRef))).toMatchObject({ ok: true, status: "captured" });

		expect(await commissionsOf(order.orderRef)).toHaveLength(1);
		expect(await accruals(order.orderRef)).toEqual(["360.00"]);
		expect(await wallet(s.affiliateId)).toEqual({ pending: "40.00", available: "0.00" });
	});

	it("mudar a % depois da captura não altera a comissão gravada; o pedido seguinte usa a % nova", async () => {
		const s = await scenario("Muda pct", { funds: "2000.00" });
		const first = await placeAndCapture(s);
		await setDefaultPct(s.t, "20");
		const second = await placeAndCapture(s);

		expect((await commissionsOf(first.orderRef))[0]).toMatchObject({ pct: "10.00", amount: "40.00" });
		expect((await commissionsOf(second.orderRef))[0]).toMatchObject({ pct: "20.00", amount: "80.00" });
		expect(await wallet(s.affiliateId)).toEqual({ pending: "120.00", available: "0.00" });
	});

	it("a % própria do afiliado vale mais que a % padrão do Bureau", async () => {
		const s = await scenario("Taxa própria");
		await owner.query("insert into affiliate_rates (bureau_id, affiliate_profile_id, pct) values ($1, $2, 25)", [
			s.t.bureau.id, s.affiliateId,
		]);
		const order = await placeAndCapture(s);

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ pct: "25.00", amount: "100.00" });
		expect(await accruals(order.orderRef)).toEqual(["300.00"]);
	});

	it("app_runtime não escreve em affiliate_commissions direto", async () => {
		const s = await scenario("Sem escrita");
		const order = await placeAndCapture(s);
		const [c] = await commissionsOf(order.orderRef);

		await expect(
			committed(adminCtx(s.t), (client) =>
				client.query("update affiliate_commissions set status = 'released' where id = $1", [c.id]),
			),
		).rejects.toMatchObject({ code: "42501" });
	});
});

describe("carência", () => {
	it("release_due_commissions libera a comissão vencida e deixa a futura", async () => {
		const s = await scenario("Carência", { funds: "2000.00" });
		const due = await placeAndCapture(s);
		const future = await placeAndCapture(s);
		await backdate((await commissionsOf(due.orderRef))[0].id);

		expect(await release()).toBeGreaterThanOrEqual(1);

		expect((await commissionsOf(due.orderRef))[0]).toMatchObject({ status: "released" });
		expect((await commissionsOf(future.orderRef))[0]).toMatchObject({ status: "pending" });
		expect(await wallet(s.affiliateId)).toEqual({ pending: "40.00", available: "40.00" });
		// Segunda passada: nada novo para esta comissão.
		await release();
		expect(await wallet(s.affiliateId)).toEqual({ pending: "40.00", available: "40.00" });
	});

	it("só a plataforma libera: um usuário do Bureau recebe 0 e nada muda", async () => {
		const s = await scenario("Só plataforma");
		const order = await placeAndCapture(s);
		await backdate((await commissionsOf(order.orderRef))[0].id);

		expect(await committed(adminCtx(s.t), (c) => c.query("select release_due_commissions() as n").then((r) => r.rows[0].n))).toBe(0);
		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ status: "pending" });
	});
});

describe("estorno de PIX do indicado", () => {
	async function chargeAfterOrder(s: Scenario, amount: string) {
		return seedPixCharge(owner, {
			bureauId: s.t.bureau.id, requestedBy: s.buyerId, clientProfileId: s.buyerId, amount, status: "paid",
		});
	}
	const refund = (asaasPaymentId: string) =>
		hook
			.query<{ apply_asaas_payment: string }>("select apply_asaas_payment($1, 'PAYMENT_REFUNDED', $2, '{}'::jsonb)", [
				`evt-${randomBytes(6).toString("hex")}`,
				asaasPaymentId,
			])
			.then((r) => r.rows[0].apply_asaas_payment);
	const shortfall = (chargeId: string) =>
		owner
			.query<{ refund_shortfall: string }>("select refund_shortfall from pix_charges where id = $1", [chargeId])
			.then((r) => r.rows[0].refund_shortfall);

	it("reverte da comissão pendente a falta de 30,00 que sobra depois do clawback", async () => {
		const s = await scenario("Estorno pendente");
		const order = await placeAndCapture(s);
		// Carteira zerada pelo pedido: o estorno de 390,00 falta inteiro; o clawback tira os 360,00 do accrual.
		const charge = await chargeAfterOrder(s, "390.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ reversed_amount: "30.00", status: "pending" });
		expect(await wallet(s.affiliateId)).toEqual({ pending: "10.00", available: "0.00" });
		expect(await shortfall(charge.id)).toBe("0.00");
	});

	it("marca a comissão como revertida quando o estorno a cobre inteira", async () => {
		const s = await scenario("Estorno total");
		const order = await placeAndCapture(s);
		const charge = await chargeAfterOrder(s, "1000.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ reversed_amount: "40.00", status: "reversed" });
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "0.00" });
		// 1000 - 360 (clawback) - 40 (comissão) = 600 continua como falta.
		expect(await shortfall(charge.id)).toBe("600.00");
	});

	it("não toca a comissão já liberada e mantém a falta", async () => {
		const s = await scenario("Estorno liberada");
		const order = await placeAndCapture(s);
		await backdate((await commissionsOf(order.orderRef))[0].id);
		await release();
		const charge = await chargeAfterOrder(s, "390.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ reversed_amount: "0.00", status: "released" });
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "40.00" });
		expect(await shortfall(charge.id)).toBe("30.00");
	});

	it("repetir o evento de estorno não reverte duas vezes", async () => {
		const s = await scenario("Estorno repetido");
		const order = await placeAndCapture(s);
		const charge = await chargeAfterOrder(s, "390.00");
		await refund(charge.asaasPaymentId);

		expect(await refund(charge.asaasPaymentId)).toBe("duplicate");

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ reversed_amount: "30.00" });
	});
});

describe("LGPD", () => {
	it("anonimizar afiliado com saldo de comissão devolve 'commission'", async () => {
		const s = await scenario("LGPD saldo");
		await placeAndCapture(s);

		const result = await committed(adminCtx(s.t), (c) =>
			c.query<{ result: string }>("select lgpd_anonymize_client_account($1) as result", [s.affiliateId]).then((r) => r.rows[0].result),
		);

		expect(result).toBe("commission");
		const { rows } = await owner.query("select anonymized_at from profiles where id = $1", [s.affiliateId]);
		expect(rows[0].anonymized_at).toBeNull();
	});

	it("anonimizar afiliado sem saldo continua funcionando", async () => {
		const s = await scenario("LGPD zero");

		const result = await committed(adminCtx(s.t), (c) =>
			c.query<{ result: string }>("select lgpd_anonymize_client_account($1) as result", [s.affiliateId]).then((r) => r.rows[0].result),
		);

		expect(result).toBe("ok");
	});
});
