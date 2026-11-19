// Comissão de afiliado (migrações 027 e 055) contra um Postgres real: captura, carência, estorno e bloqueio LGPD.
// Modelo da 055: o Bureau recebe uma % do preço bruto (o seed fixa 20% com preço 400,00 e custo 320,00) e o afiliado, uma
// % única do Bureau (bureau_affiliate_settings) também sobre o preço bruto, paga pela plataforma.
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
		clientProfileId: buyer.userId, amount: o.funds ?? "400.00", createdBy: buyer.userId,
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

async function placeAndCapture(s: Scenario, price = "400.00", cost = "320.00") {
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

// Estorno de 30,00 sobre a carteira zerada do indicado (a falta inteira): reverte 30,00 da comissão mais nova.
async function refund30(s: Scenario) {
	const charge = await seedPixCharge(owner, {
		bureauId: s.t.bureau.id, requestedBy: s.buyerId, clientProfileId: s.buyerId, amount: "30.00", status: "paid",
	});
	await hook.query("select apply_asaas_payment($1, 'PAYMENT_REFUNDED', $2, '{}'::jsonb)", [
		`evt-${randomBytes(6).toString("hex")}`,
		charge.asaasPaymentId,
	]);
}

describe("comissão na captura", () => {
	it("grava 40,00 pendente (10% de 400,00), accrual 80,00 do Bureau (20%) e saldo pendente do afiliado", async () => {
		const s = await scenario("Com 10");
		const order = await placeAndCapture(s);

		const [c] = await commissionsOf(order.orderRef);
		expect(c).toMatchObject({ pct: "10.00", margin: "400.00", amount: "40.00", reversed_amount: "0.00", status: "pending" });
		// Carência padrão de 30 dias (settings), gravada na comissão.
		const days = (c.release_at.getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(29.9);
		expect(days).toBeLessThan(30.1);
		expect(await accruals(order.orderRef)).toEqual(["80.00"]);
		expect(await wallet(s.affiliateId)).toEqual({ pending: "40.00", available: "0.00" });
		const audit = await owner.query(
			"select metadata from audit_logs where action = 'affiliate.commission' and record_id = $1",
			[c.id],
		);
		expect(audit.rows).toHaveLength(1);
		expect(JSON.stringify(audit.rows[0].metadata)).not.toMatch(/\d{11}/);
	});

	it("a % 100 do afiliado fica limitada ao que sobra depois do Bureau: 320,00, e a plataforma fica com 0,00", async () => {
		const s = await scenario("Com 100", { pct: "100" });
		const order = await placeAndCapture(s);

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ pct: "100.00", margin: "400.00", amount: "320.00", status: "pending" });
		expect(await accruals(order.orderRef)).toEqual(["80.00"]);
		expect(await wallet(s.affiliateId)).toEqual({ pending: "320.00", available: "0.00" });
	});

	it("Bureau com 0%: sem accrual, e a comissão do afiliado sai inteira da plataforma", async () => {
		const s = await scenario("Bureau zero");
		const order = await placeAndCapture(s, "400.00", "400.00");

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ margin: "400.00", amount: "40.00" });
		expect(await accruals(order.orderRef)).toEqual([]);
		expect(await wallet(s.affiliateId)).toEqual({ pending: "40.00", available: "0.00" });
	});

	it("pedido de balcão não gera comissão", async () => {
		const s = await scenario("Balcão");
		await seedWalletTopup(owner, { bureauId: s.t.bureau.id, amount: "1000.00", createdBy: s.t.bureauAdmin.userId });
		const order: Order = { orderRef: randomUUID(), mode: "counter", clientId: null, price: "400.00", cost: "320.00" };
		expect(await committed(operatorCtx(s.t), (c) => reserve(c, order))).toMatchObject({ ok: true });
		expect(await committed(adminCtx(s.t), (c) => capture(c, order.orderRef))).toMatchObject({ ok: true });

		expect(await commissionsOf(order.orderRef)).toEqual([]);
	});

	it("comprador sem vínculo não gera comissão; o accrual do Bureau é o mesmo", async () => {
		const s = await scenario("Sem vínculo", { linked: false });
		const order = await placeAndCapture(s);

		expect(await commissionsOf(order.orderRef)).toEqual([]);
		expect(await accruals(order.orderRef)).toEqual(["80.00"]);
	});

	it("indicado sem telefone verificado não gera comissão; o accrual do Bureau é o mesmo", async () => {
		const s = await scenario("Sem telefone", { verified: false });
		const order = await placeAndCapture(s);

		expect(await commissionsOf(order.orderRef)).toEqual([]);
		expect(await accruals(order.orderRef)).toEqual(["80.00"]);
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "0.00" });
	});

	it("afiliado anonimizado não recebe comissão", async () => {
		const s = await scenario("Afiliado anon");
		await ownerUpdateProfile(s.affiliateId, "anonymized_at = now()");
		const order = await placeAndCapture(s);

		expect(await commissionsOf(order.orderRef)).toEqual([]);
		expect(await accruals(order.orderRef)).toEqual(["80.00"]);
	});

	it("afiliado inativo não recebe comissão", async () => {
		const s = await scenario("Afiliado inativo");
		await ownerUpdateProfile(s.affiliateId, "is_active = false");
		const order = await placeAndCapture(s);

		expect(await commissionsOf(order.orderRef)).toEqual([]);
		expect(await accruals(order.orderRef)).toEqual(["80.00"]);
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "0.00" });
	});

	it("o livro do afiliado não guarda o id do indicado nem a referência da cobrança (captura, liberação e estorno)", async () => {
		const s = await scenario("Livro neutro", { funds: "800.00" });
		const released = await placeAndCapture(s);
		const reversed = await placeAndCapture(s);
		const commissionId = (await commissionsOf(released.orderRef))[0].id;
		await backdate(commissionId);
		await release();
		await refund30(s);

		const { rows } = await owner.query<{ kind: string; reference: string; created_by: string; idempotency_key: string }>(
			"select kind, reference, created_by, idempotency_key from affiliate_ledger_entries where profile_id = $1 order by seq",
			[s.affiliateId],
		);
		expect(rows.map((r) => r.kind)).toEqual(["commission", "commission", "commission_release", "commission_reversal"]);
		for (const row of rows) {
			expect(row.created_by).toBe(s.affiliateId);
			expect(row.reference).toMatch(/^commission:[0-9a-f-]{36}$/);
		}
		expect(rows[2].reference).toBe(`commission:${commissionId}`);
		expect(JSON.stringify(rows)).not.toContain(s.buyerId);
		expect(JSON.stringify(rows)).not.toContain("pix_charge");
		// A chave de idempotência do estorno também não leva o id da cobrança.
		const { rows: charges } = await owner.query<{ id: string }>("select id from pix_charges where client_profile_id = $1", [s.buyerId]);
		expect(charges.length).toBeGreaterThan(0);
		for (const charge of charges) expect(JSON.stringify(rows)).not.toContain(charge.id);
		expect(rows[3].idempotency_key).toMatch(/^refund:[0-9a-f-]{36}:[0-9a-f]{32}$/);
		expect((await commissionsOf(reversed.orderRef))[0].reversed_amount).toBe("30.00");
	});

	it("captura repetida mantém uma comissão só", async () => {
		const s = await scenario("Repetida");
		const order = await placeAndCapture(s);
		expect(await committed(adminCtx(s.t), (c) => capture(c, order.orderRef))).toMatchObject({ ok: true, status: "captured" });

		expect(await commissionsOf(order.orderRef)).toHaveLength(1);
		expect(await accruals(order.orderRef)).toEqual(["80.00"]);
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

	it("uma linha antiga de affiliate_rates é ignorada: vale só a % de afiliados do Bureau", async () => {
		const s = await scenario("Taxa própria");
		await owner.query("insert into affiliate_rates (bureau_id, affiliate_profile_id, pct) values ($1, $2, 25)", [
			s.t.bureau.id, s.affiliateId,
		]);
		const order = await placeAndCapture(s);

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ pct: "10.00", amount: "40.00" });
		expect(await accruals(order.orderRef)).toEqual(["80.00"]);
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

	const clawback = (chargeId: string) =>
		owner
			.query<{ amount: string }>("select amount from bureau_payable_entries where pix_charge_id = $1 and kind = 'reversal'", [chargeId])
			.then((r) => r.rows.map((x) => x.amount));

	it("reverte a comissão pendente primeiro: falta de 30,00 sai da comissão e o Bureau não paga nada", async () => {
		const s = await scenario("Estorno pendente");
		const order = await placeAndCapture(s);
		// Carteira zerada pelo pedido: o estorno de 30,00 falta inteiro. O accrual de 80,00 do Bureau cobriria, mas a
		// comissão pendente vem antes.
		const charge = await chargeAfterOrder(s, "30.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ reversed_amount: "30.00", status: "pending" });
		expect(await wallet(s.affiliateId)).toEqual({ pending: "10.00", available: "0.00" });
		expect(await clawback(charge.id)).toEqual([]);
		expect(await shortfall(charge.id)).toBe("0.00");
	});

	it("falta de 50,00 com comissão pendente de 40,00: reverte 40,00 e o Bureau paga os 10,00 que restam", async () => {
		const s = await scenario("Estorno comissão e Bureau");
		const order = await placeAndCapture(s);
		const charge = await chargeAfterOrder(s, "50.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ reversed_amount: "40.00", status: "reversed" });
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "0.00" });
		expect(await clawback(charge.id)).toEqual(["-10.00"]);
		expect(await shortfall(charge.id)).toBe("0.00");
	});

	it("marca a comissão como revertida quando o estorno a cobre inteira", async () => {
		const s = await scenario("Estorno total");
		const order = await placeAndCapture(s);
		const charge = await chargeAfterOrder(s, "1000.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ reversed_amount: "40.00", status: "reversed" });
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "0.00" });
		// 1000 - 40 (comissão) - 80 (clawback do Bureau) = 880 continua como falta.
		expect(await shortfall(charge.id)).toBe("880.00");
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
		// 390 - 80 (clawback do Bureau) = 310 continua como falta; a comissão liberada não é tocada.
		expect(await shortfall(charge.id)).toBe("310.00");
	});

	it("repetir o evento de estorno não reverte duas vezes", async () => {
		const s = await scenario("Estorno repetido");
		const order = await placeAndCapture(s);
		const charge = await chargeAfterOrder(s, "390.00");
		await refund(charge.asaasPaymentId);

		expect(await refund(charge.asaasPaymentId)).toBe("duplicate");

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ reversed_amount: "40.00", status: "reversed" });
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "0.00" });
	});
});

describe("LGPD", () => {
	const anonymize = (s: Scenario) =>
		committed(adminCtx(s.t), (c) =>
			c.query<{ result: string }>("select lgpd_anonymize_client_account($1) as result", [s.affiliateId]).then((r) => r.rows[0].result),
		);

	it("anonimizar afiliado com comissão disponível devolve 'commission' e nada muda", async () => {
		const s = await scenario("LGPD saldo");
		const order = await placeAndCapture(s);
		await backdate((await commissionsOf(order.orderRef))[0].id);
		await release();

		expect(await anonymize(s)).toBe("commission");

		const { rows } = await owner.query("select anonymized_at from profiles where id = $1", [s.affiliateId]);
		expect(rows[0].anonymized_at).toBeNull();
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "40.00" });
	});

	it("anonimizar afiliado com saque aberto devolve 'commission'", async () => {
		const s = await scenario("LGPD saque");
		await owner.query("select affiliate_wallet_post_entry($1, 'commission', '50.00', 'seed-c', 'seed', $1)", [s.affiliateId]);
		await owner.query("select affiliate_wallet_post_entry($1, 'commission_release', '50.00', 'seed-r', 'seed', $1)", [s.affiliateId]);
		await owner.query("select affiliate_wallet_post_entry($1, 'withdrawal_hold', '50.00', 'seed-h', 'seed', $1)", [s.affiliateId]);
		await owner.query(
			`insert into affiliate_withdrawals (bureau_id, profile_id, amount, fee, net, pix_key_type, pix_key, holder_name)
			 values ($1, $2, 50, 0, 50, 'email', 'a@example.test', 'Afiliado')`,
			[s.t.bureau.id, s.affiliateId],
		);

		expect(await anonymize(s)).toBe("commission");
	});

	it("só com comissão pendente a anonimização passa e a pendente é perdida (reversão, auditoria sem documento)", async () => {
		const s = await scenario("LGPD pendente");
		const order = await placeAndCapture(s);
		const commissionId = (await commissionsOf(order.orderRef))[0].id;

		expect(await anonymize(s)).toBe("ok");

		expect((await commissionsOf(order.orderRef))[0]).toMatchObject({ amount: "40.00", reversed_amount: "40.00", status: "reversed" });
		expect(await wallet(s.affiliateId)).toEqual({ pending: "0.00", available: "0.00" });
		const ledger = await owner.query<{ kind: string; amount: string; idempotency_key: string }>(
			"select kind, amount, idempotency_key from affiliate_ledger_entries where profile_id = $1 order by seq desc limit 1",
			[s.affiliateId],
		);
		expect(ledger.rows[0]).toEqual({ kind: "commission_reversal", amount: "40.00", idempotency_key: `lgpd:${commissionId}` });
		const audit = await owner.query<{ metadata: unknown }>(
			"select metadata from audit_logs where action = 'affiliate.forfeit' and record_id = $1",
			[commissionId],
		);
		expect(audit.rows).toHaveLength(1);
		expect(JSON.stringify(audit.rows[0].metadata)).toBe(JSON.stringify({ amount: "40.00" }));
	});

	it("depois de anonimizado, um novo pedido do indicado não gera comissão", async () => {
		const s = await scenario("LGPD depois", { funds: "2000.00" });
		await placeAndCapture(s);
		expect(await anonymize(s)).toBe("ok");

		const next = await placeAndCapture(s);

		expect(await commissionsOf(next.orderRef)).toEqual([]);
	});

	it("anonimizar afiliado sem saldo continua funcionando", async () => {
		const s = await scenario("LGPD zero");

		expect(await anonymize(s)).toBe("ok");
	});
});
