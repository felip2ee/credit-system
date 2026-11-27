// Comissão dos Bureaus (migração 055) contra um Postgres real: divisão do preço bruto entre Bureau, afiliado e plataforma,
// arredondamento, precedência da %, bloqueio de produto, snapshot do pedido, pedido antigo e balcão.
// O preço do produto é global (versão do superadmin): este arquivo muda o preço do dossie_pf, então o Vitest não pode
// rodar arquivos de integração ao mesmo tempo (fileParallelism: false em vitest.config.ts).
import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import {
	seedClientWalletTopup,
	seedLegacyOnlineOrder,
	seedOrderDossierForSession,
	seedTenant,
	seedWalletTopup,
	seedClientProfile,
	type SeededTenant,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), app.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string };
const clientCtx = (t: SeededTenant): Ctx => ({ userId: t.client.userId, role: "client", bureauId: t.bureau.id });
const adminCtx = (t: SeededTenant): Ctx => ({ userId: t.bureauAdmin.userId, role: "bureau_admin", bureauId: t.bureau.id });
const operatorCtx = (t: SeededTenant): Ctx => ({ userId: t.operator.userId, role: "operator", bureauId: t.bureau.id });

async function committed<T>(ctx: Ctx, work: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
              set_config('app.bureau_id', $3, true), set_config('app.support_session_id', '', true)`,
			[ctx.userId, ctx.role, ctx.bureauId],
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

const productId = async (code = "dossie_pf") =>
	(await owner.query<{ id: string }>("select id from products where code = $1", [code])).rows[0].id;

// Nova versão do produto com este preço (como o superadmin faz); nada muda se o preço vigente já é este.
async function setPrice(price: string | null, code = "dossie_pf") {
	const id = await productId(code);
	await owner.query("update products set active = true where id = $1", [id]);
	await owner.query(
		`insert into product_versions (product_id, version, deps_product, base_cost, base_cost_per_partner, sale_price)
     select product_id, version + 1, deps_product, base_cost, base_cost_per_partner, $2::numeric
       from product_versions where product_id = $1 order by version desc limit 1`,
		[id, price],
	);
}
const setOverride = (t: SeededTenant, pct: string | null) =>
	owner.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, $2, $3)", [t.bureau.id, pct, t.bureauAdmin.userId]);
const setBlock = async (t: SeededTenant, blocked: boolean) =>
	owner.query("insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by) values ($1, $2, $3, $4)", [
		t.bureau.id, await productId(), blocked, t.bureauAdmin.userId,
	]);
const setAffiliatePct = (t: SeededTenant, pct: string) =>
	owner.query(
		`insert into bureau_affiliate_settings (bureau_id, default_pct) values ($1, $2)
     on conflict (bureau_id) do update set default_pct = excluded.default_pct`,
		[t.bureau.id, pct],
	);
const setGlobal = (pct: string | null) =>
	pct === null
		? owner.query("delete from settings where key = 'bureau_commission_pct'")
		: owner.query(
				`insert into settings (key, value, description) values ('bureau_commission_pct', to_jsonb($1::numeric), 'teste')
         on conflict (key) do update set value = excluded.value`,
				[pct],
			);

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

type Opts = { override?: string | null; affPct?: string; linked?: boolean; funds?: string; bureauFunds?: string };

// Bureau novo, comprador com saldo e (opcional) afiliado indicador com telefone verificado do comprador.
async function scenario(label: string, o: Opts = {}) {
	const t = await seedTenant(owner, label);
	const affiliate = await seedClientProfile(owner, t.bureau.id);
	if (o.linked ?? true) {
		await owner.query(
			"insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)",
			[t.client.userId, affiliate.userId, t.bureau.id],
		);
		await ownerUpdateProfile(t.client.userId, "phone_e164 = '+5563999990000', phone_verified_at = now()");
	}
	if (o.override !== undefined && o.override !== null) await setOverride(t, o.override);
	if (o.affPct !== undefined) await setAffiliatePct(t, o.affPct);
	if (o.funds !== "") {
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: o.funds ?? "1000.00", createdBy: t.client.userId });
	}
	if (o.bureauFunds) await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: o.bureauFunds, createdBy: t.bureauAdmin.userId });
	return { t, affiliateId: affiliate.userId };
}

const reserveSql = "select * from reserve_order($1, $2, $3, $4, $5, $6::jsonb)";
async function reserveOnline(t: SeededTenant, price: string) {
	const orderRef = randomUUID();
	const result = await committed(clientCtx(t), async (c) => {
		await seedOrderDossierForSession(owner, c, { orderRef, clientProfileId: t.client.userId });
		return c.query<SettleRow>(reserveSql, [orderRef, "online", t.client.userId, price, "0.00", "{}"]).then((r) => r.rows[0]);
	});
	return { orderRef, result };
}
async function reserveCounter(t: SeededTenant, price: string, cost: string) {
	const orderRef = randomUUID();
	const result = await committed(operatorCtx(t), async (c) => {
		await seedOrderDossierForSession(owner, c, { orderRef, clientProfileId: null });
		return c.query<SettleRow>(reserveSql, [orderRef, "counter", null, price, cost, "{}"]).then((r) => r.rows[0]);
	});
	return { orderRef, result };
}
const capture = (t: SeededTenant, ref: string) =>
	committed(adminCtx(t), (c) => c.query<SettleRow>("select * from capture_order($1)", [ref]).then((r) => r.rows[0]));

async function settlementOf(ref: string) {
	const { rows } = await owner.query<{
		price: string; cost: string; commission_pct: string | null; bureau_commission: string | null; status: string;
	}>("select price, cost, commission_pct, bureau_commission, status from order_settlements where order_ref = $1", [ref]);
	return rows[0];
}
async function accrual(ref: string) {
	const { rows } = await owner.query<{ amount: string }>(
		"select amount from bureau_payable_entries where order_ref = $1 and kind = 'accrual'", [ref]);
	return rows.map((r) => r.amount);
}
async function commissionOf(ref: string) {
	const { rows } = await owner.query<{ pct: string; margin: string; amount: string }>(
		"select pct, margin, amount from affiliate_commissions where order_ref = $1", [ref]);
	return rows;
}
async function bureauWallet(t: SeededTenant) {
	const { rows } = await owner.query<{ available: string; reserved: string }>(
		"select available, reserved from wallets where bureau_id = $1", [t.bureau.id]);
	return rows[0];
}

beforeAll(async () => {
	// Estes testes controlam a % global: sem ela, só o override do Bureau vale.
	await setGlobal(null);
});

describe("pedido online novo (077): a captura não divide o preço", () => {
	it("400,00 com Bureau 20% e afiliado 10%: nada de comissão gravada, accrual ou comissão de afiliado", async () => {
		await setPrice("400.00");
		const { t } = await scenario("Split 400", { override: "20", affPct: "10" });
		const { orderRef, result } = await reserveOnline(t, "400.00");
		expect(result).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(await settlementOf(orderRef)).toMatchObject({
			price: "400.00", cost: "0.00", commission_pct: null, bureau_commission: null, status: "reserved",
		});

		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });

		// Bureau e afiliado recebem pelo split da entrada de dinheiro (073/074), não aqui.
		expect(await accrual(orderRef)).toEqual([]);
		expect(await commissionOf(orderRef)).toEqual([]);
		expect(await owner.query("select 1 from bureau_payable_entries where bureau_id = $1", [t.bureau.id])).toMatchObject({ rowCount: 0 });
	});

	it("sem afiliado também não há accrual", async () => {
		await setPrice("400.00");
		const { t } = await scenario("Split sem afiliado", { override: "20", affPct: "10", linked: false });
		const { orderRef } = await reserveOnline(t, "400.00");
		await capture(t, orderRef);

		expect(await accrual(orderRef)).toEqual([]);
		expect(await commissionOf(orderRef)).toEqual([]);
	});

	it("0,01 com 5%: o pedido é aceito (sem a regra de arredondamento da comissão) e não gera accrual", async () => {
		await setPrice("0.01");
		const { t } = await scenario("Split centavo", { override: "5", affPct: "0", linked: false });
		const { orderRef, result } = await reserveOnline(t, "0.01");
		expect(result).toMatchObject({ ok: true });
		expect(await settlementOf(orderRef)).toMatchObject({ cost: "0.00", commission_pct: null, bureau_commission: null });
		await capture(t, orderRef);

		expect(await accrual(orderRef)).toEqual([]);
	});

	it("Bureau 0%: sem accrual online; no balcão a carteira paga o preço inteiro", async () => {
		await setPrice("400.00");
		const { t } = await scenario("Split zero", { override: "0", linked: false, bureauFunds: "1000.00" });
		const online = await reserveOnline(t, "400.00");
		await capture(t, online.orderRef);
		expect(await accrual(online.orderRef)).toEqual([]);

		const counter = await reserveCounter(t, "400.00", "400.00");
		expect(counter.result).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(await bureauWallet(t)).toEqual({ available: "600.00", reserved: "400.00" });
	});
});

describe("balcão", () => {
	it("debita preço menos a comissão do Bureau da carteira; sem accrual e sem comissão", async () => {
		await setPrice("400.00");
		const { t } = await scenario("Balcão split", { override: "20", affPct: "10", bureauFunds: "1000.00" });
		const { orderRef, result } = await reserveCounter(t, "400.00", "320.00");
		expect(result).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(await settlementOf(orderRef)).toMatchObject({ cost: "320.00", commission_pct: "20.00", bureau_commission: "80.00" });
		expect(await bureauWallet(t)).toEqual({ available: "680.00", reserved: "320.00" });

		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });

		expect(await bureauWallet(t)).toEqual({ available: "680.00", reserved: "0.00" });
		expect(await accrual(orderRef)).toEqual([]);
		expect(await commissionOf(orderRef)).toEqual([]);
	});

	it("recusa preço e custo que não batem com o banco: price_mismatch e cost_mismatch", async () => {
		await setPrice("400.00");
		const { t } = await scenario("Balcão mismatch", { override: "20", bureauFunds: "1000.00" });

		expect((await reserveCounter(t, "399.00", "320.00")).result).toEqual({ ok: false, reason: "price_mismatch", status: null });
		// O custo antigo (sem a comissão) não vale mais.
		expect((await reserveCounter(t, "400.00", "300.00")).result).toEqual({ ok: false, reason: "cost_mismatch", status: null });
		expect(await bureauWallet(t)).toEqual({ available: "1000.00", reserved: "0.00" });
	});
});

describe("precedência da % do Bureau", () => {
	it("override vale mais que a global; override nulo volta à global; sem nenhuma, só o balcão recusa (commission_not_configured)", async () => {
		await setPrice("400.00");
		await setGlobal("12");
		const { t } = await scenario("Precedência", { linked: false, bureauFunds: "1000.00" });
		const resolve = async () =>
			(await owner.query<{ pct: string | null }>("select resolve_bureau_commission_pct($1) as pct", [t.bureau.id])).rows[0].pct;

		expect(await resolve()).toBe("12");
		// Online (077): a % não é gravada no pedido; o balcão ainda grava (a % define o custo da carteira).
		const global = await reserveCounter(t, "400.00", "352.00");
		expect(await settlementOf(global.orderRef)).toMatchObject({ commission_pct: "12.00", bureau_commission: "48.00" });

		await setOverride(t, "30");
		expect(await resolve()).toBe("30.00");
		const overridden = await reserveCounter(t, "400.00", "280.00");
		expect(await settlementOf(overridden.orderRef)).toMatchObject({ commission_pct: "30.00", bureau_commission: "120.00" });

		await setOverride(t, null);
		expect(await resolve()).toBe("12");

		await setOverride(t, "30");
		await setOverride(t, null);
		await setGlobal(null);
		expect(await resolve()).toBeNull();
		// Sem nenhuma %: o pedido online é aceito (não depende dela); o de balcão não, porque a % define o custo.
		const none = await reserveOnline(t, "400.00");
		expect(none.result).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(await settlementOf(none.orderRef)).toMatchObject({ commission_pct: null, bureau_commission: null, cost: "0.00" });
		const noCounter = await reserveCounter(t, "400.00", "400.00");
		expect(noCounter.result).toEqual({ ok: false, reason: "commission_not_configured", status: null });
		expect(await settlementOf(noCounter.orderRef)).toBeUndefined();
	});
});

describe("produto à venda", () => {
	it("produto sem preço na última versão não vende (quote_mismatch) e o preço por sócio do dossie_pf é recusado", async () => {
		await setPrice(null);
		const { t } = await scenario("Sem preço", { override: "20", linked: false });
		const { result } = await reserveOnline(t, "400.00");
		expect(result).toEqual({ ok: false, reason: "quote_mismatch", status: null });
		expect(
			(await owner.query("select * from current_product_price($1)", [await productId()])).rowCount,
		).toBe(0);

		await expect(
			owner.query(
				`insert into product_versions (product_id, version, base_cost, sale_price, sale_price_per_partner)
         select product_id, version + 1, base_cost, 100, 5 from product_versions where product_id = $1 order by version desc limit 1`,
				[await productId()],
			),
		).rejects.toMatchObject({ code: "23514" });
	});

	it("bloqueio: reserve_order recusa, o catálogo público some, outro Bureau não é afetado, liberar volta a vender", async () => {
		await setPrice("400.00");
		const { t } = await scenario("Bloqueio", { override: "20", linked: false });
		const { t: other } = await scenario("Bloqueio outro", { override: "20", linked: false });
		const catalog = async (slug: string) =>
			(await owner.query<{ code: string }>("select code from public_bureau_catalog($1)", [slug])).rows.map((r) => r.code);
		expect(await catalog(t.bureau.slug)).toContain("dossie_pf");

		await setBlock(t, true);

		expect((await reserveOnline(t, "400.00")).result).toEqual({ ok: false, reason: "quote_mismatch", status: null });
		expect(await catalog(t.bureau.slug)).not.toContain("dossie_pf");
		expect((await reserveOnline(other, "400.00")).result).toMatchObject({ ok: true });
		expect(await catalog(other.bureau.slug)).toContain("dossie_pf");

		await setBlock(t, false);

		expect((await reserveOnline(t, "400.00")).result).toMatchObject({ ok: true });
		expect(await catalog(t.bureau.slug)).toContain("dossie_pf");
	});

	it("pedido já reservado captura mesmo se o produto for bloqueado depois", async () => {
		await setPrice("400.00");
		const { t } = await scenario("Bloqueio depois", { override: "20", linked: false });
		const { orderRef } = await reserveOnline(t, "400.00");
		await setBlock(t, true);

		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });
		expect(await accrual(orderRef)).toEqual([]);
	});

	it("o catálogo público devolve o preço da última versão", async () => {
		await setPrice("123.45");
		const { t } = await scenario("Catálogo público", { override: "20", linked: false });
		const { rows } = await owner.query<{ code: string; sale_price: string }>(
			"select code, sale_price from public_bureau_catalog($1) where code = 'dossie_pf'", [t.bureau.slug]);
		expect(rows).toEqual([{ code: "dossie_pf", sale_price: "123.45" }]);
	});
});

describe("snapshot do pedido e transição para a 077", () => {
	it("mudar preço, % global, override e % de afiliados depois da reserva não muda o pedido e a captura não gera comissão", async () => {
		await setPrice("400.00");
		await setGlobal("5");
		const { t } = await scenario("Snapshot", { override: "20", affPct: "10" });
		const { orderRef } = await reserveOnline(t, "400.00");
		const before = await settlementOf(orderRef);

		await setPrice("999.00");
		await setGlobal("50");
		await setOverride(t, "70");
		await capture(t, orderRef);

		expect(await settlementOf(orderRef)).toEqual({ ...before, status: "captured" });
		expect(await accrual(orderRef)).toEqual([]);
		expect(await commissionOf(orderRef)).toEqual([]);
		await setGlobal(null);
	});

	it("transição: pedido reservado antes da 077 (commission_pct gravado) captura com a regra antiga; o novo não gera comissão", async () => {
		await setPrice("400.00");
		const { t } = await scenario("Transição", { override: "20", affPct: "10" });
		// Reserva feita antes do deploy da 077: comissão do Bureau 20% (80,00) gravada.
		const legacy = await seedLegacyOnlineOrder(owner, {
			bureauId: t.bureau.id, clientProfileId: t.client.userId, price: "400.00", commissionPct: "20",
		});
		expect(await settlementOf(legacy)).toMatchObject({ cost: "320.00", commission_pct: "20.00", bureau_commission: "80.00" });
		const fresh = await reserveOnline(t, "400.00");
		expect(await settlementOf(fresh.orderRef)).toMatchObject({ commission_pct: null, bureau_commission: null });

		expect(await capture(t, legacy)).toMatchObject({ ok: true, status: "captured" });
		expect(await capture(t, fresh.orderRef)).toMatchObject({ ok: true, status: "captured" });
		// Capturar de novo (retentativa) não duplica nada em nenhum dos dois.
		expect(await capture(t, legacy)).toMatchObject({ ok: true, status: "captured" });
		expect(await capture(t, fresh.orderRef)).toMatchObject({ ok: true, status: "captured" });

		expect(await accrual(legacy)).toEqual(["80.00"]);
		expect(await commissionOf(legacy)).toEqual([{ pct: "10.00", margin: "400.00", amount: "40.00" }]);
		expect(await accrual(fresh.orderRef)).toEqual([]);
		expect(await commissionOf(fresh.orderRef)).toEqual([]);
	});

	it("pedido antigo (commission_pct nulo) captura pelo ramo antigo: accrual = margem menos comissão, com affiliate_rates", async () => {
		const { t, affiliateId } = await scenario("Pedido antigo", { affPct: "10", funds: "" });
		await owner.query("insert into affiliate_rates (bureau_id, affiliate_profile_id, pct) values ($1, $2, 25)", [t.bureau.id, affiliateId]);
		// Reserva feita antes do deploy: preço 1000, custo de atacado 600, sem commission_pct.
		const orderRef = randomUUID();
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "1000.00", createdBy: t.client.userId });
		await owner.query(
			`insert into order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost)
       values ($1, $2, 'online', $3, 1000, 600)`,
			[orderRef, t.bureau.id, t.client.userId],
		);
		await owner.query("select * from client_wallet_post_entry($1, 'reserve', 1000, $2, $3, null, $4)", [
			t.client.userId, `order:reserve:${orderRef}`, `order:${orderRef}`, t.client.userId,
		]);

		expect(await capture(t, orderRef)).toMatchObject({ ok: true, status: "captured" });

		expect(await accrual(orderRef)).toEqual(["300.00"]);
		expect(await commissionOf(orderRef)).toEqual([{ pct: "25.00", margin: "400.00", amount: "100.00" }]);
	});
});

describe("restrições do banco", () => {
	it("a % global fora de 0 a 99,99 ou com 3 casas é recusada; o override também", async () => {
		for (const bad of ["100", "-1", "12.345"]) {
			await expect(setGlobal(bad)).rejects.toMatchObject({ code: "23514" });
		}
		await expect(
			owner.query(`insert into settings (key, value) values ('bureau_commission_pct', '"12"'::jsonb)`),
		).rejects.toMatchObject({ code: "23514" });
		const { t } = await scenario("Restrição", { linked: false });
		await expect(setOverride(t, "100")).rejects.toMatchObject({ code: "23514" });
	});

	it("a liquidação recusa comissão que não bate com preço e %, e as tabelas novas são append-only", async () => {
		const { t } = await scenario("Restrição liquidação", { linked: false });
		const insert = (commission: string, cost: string) =>
			owner.query(
				`insert into order_settlements (order_ref, bureau_id, mode, price, cost, commission_pct, bureau_commission)
         values ($1, $2, 'counter', 100, $3, 20, $4)`,
				[randomUUID(), t.bureau.id, cost, commission],
			);
		await expect(insert("21.00", "79.00")).rejects.toMatchObject({ code: "23514" });
		await expect(insert("20.00", "70.00")).rejects.toMatchObject({ code: "23514" });
		await expect(insert("20.00", "80.00")).resolves.toBeDefined();
		await expect(
			owner.query(
				"insert into order_settlements (order_ref, bureau_id, mode, price, cost, commission_pct) values ($1, $2, 'counter', 100, 80, 20)",
				[randomUUID(), t.bureau.id],
			),
		).rejects.toMatchObject({ code: "23514" });

		await setOverride(t, "10");
		await setBlock(t, true);
		await expect(owner.query("update bureau_commission_rates set pct = 1 where bureau_id = $1", [t.bureau.id])).rejects.toMatchObject({ code: "23514" });
		await expect(owner.query("delete from bureau_product_blocks where bureau_id = $1", [t.bureau.id])).rejects.toMatchObject({ code: "23514" });
	});
});
