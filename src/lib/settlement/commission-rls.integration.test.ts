// Permissões e RLS da comissão dos Bureaus (migração 048): só o superadmin (sem suporte) escreve preço, % do Bureau,
// bloqueio e % de afiliados; o Bureau, o operador, o cliente e o superadmin em suporte não escrevem nada disto.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import {
	seedSupportSession,
	seedSuperadmin,
	seedTenant,
	withDbContext,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

type Actor = { userId: string; role: string; bureauId: string | null; supportSessionId?: string | null };

let T: SeededTenant;
let foreign: SeededTenant;
let sa: SeedSuperadmin;
let supportActor: Actor;
let productId: string;
let affiliateId: string;

beforeAll(async () => {
	[T, foreign, sa] = await Promise.all([seedTenant(owner, "com rls T"), seedTenant(owner, "com rls F"), seedSuperadmin(owner)]);
	productId = (await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'")).rows[0].id;
	affiliateId = T.client.userId;
	const session = await seedSupportSession(owner, { superadminId: sa.userId, bureauId: T.bureau.id });
	supportActor = { userId: sa.userId, role: "superadmin", bureauId: T.bureau.id, supportSessionId: session };
	// Linhas legadas e novas para as leituras e os updates.
	await owner.query(
		"insert into bureau_catalog_items (bureau_id, product_id, active, sale_price, updated_by) values ($1, $2, false, 10, $3)",
		[T.bureau.id, productId, T.bureauAdmin.userId],
	);
	await owner.query("insert into affiliate_rates (bureau_id, affiliate_profile_id, pct) values ($1, $2, 5)", [T.bureau.id, affiliateId]);
	await owner.query("insert into bureau_affiliate_settings (bureau_id, default_pct) values ($1, 5)", [T.bureau.id]);
	await owner.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, 20, $2)", [T.bureau.id, T.bureauAdmin.userId]);
	await owner.query("insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by) values ($1, $2, true, $3)", [
		T.bureau.id, productId, T.bureauAdmin.userId,
	]);
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end()]);
});

// Resultado de uma escrita sob o papel: "denied" (privilégio ou política recusa) ou o número de linhas tocadas.
async function attempt(actor: Actor, sql: string, params: unknown[]): Promise<"denied" | number> {
	return withDbContext(app, actor, async (client) => {
		try {
			return (await client.query(sql, params)).rowCount ?? 0;
		} catch (error) {
			// 23514: o guard do item do catálogo (before insert) recusa antes da política quando o papel não lê as versões.
			if (["42501", "23514"].includes((error as { code?: string }).code ?? "")) return "denied";
			throw error;
		}
	});
}
const asActor = (i: { userId: string; role: string; bureauId: string | null }): Actor => ({ userId: i.userId, role: i.role, bureauId: i.bureauId });

describe("escrita: ninguém no Bureau, nem o superadmin em suporte", () => {
	const writes = (who: Actor, bureauId: string) => [
		["bureau_commission_rates", "insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, 10, $2)", [bureauId, who.userId]],
		["bureau_product_blocks", "insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by) values ($1, $3, true, $2)", [bureauId, who.userId, productId]],
		["bureau_affiliate_settings update", "update bureau_affiliate_settings set default_pct = 9, updated_by = $2 where bureau_id = $1", [bureauId, who.userId]],
		["bureau_affiliate_settings insert", "insert into bureau_affiliate_settings (bureau_id, default_pct, updated_by) values ($1, 9, $2) on conflict (bureau_id) do update set default_pct = 9, updated_by = $2", [bureauId, who.userId]],
		["bureau_catalog_items update", "update bureau_catalog_items set sale_price = 99 where bureau_id = $1", [bureauId]],
		["bureau_catalog_items insert", "insert into bureau_catalog_items (bureau_id, product_id, active, sale_price, updated_by) values ($1, $3, false, 9, $2)", [bureauId, who.userId, productId]],
		["bureau_product_costs insert", "insert into bureau_product_costs (bureau_id, product_id, cost, set_by) values ($1, $3, 1, $2)", [bureauId, who.userId, productId]],
		["affiliate_rates update", "update affiliate_rates set pct = 50 where bureau_id = $1", [bureauId]],
		["affiliate_rates delete", "delete from affiliate_rates where bureau_id = $1", [bureauId]],
		["affiliate_rates insert", "insert into affiliate_rates (bureau_id, affiliate_profile_id, pct) values ($1, $2, 1) on conflict (bureau_id, affiliate_profile_id) do update set pct = 1", [bureauId, affiliateId]],
	] as const;

	const actors = (): [string, () => Actor][] => [
		["bureau_admin", () => asActor(T.bureauAdmin)],
		["operator", () => asActor(T.operator)],
		["client", () => asActor(T.client)],
		["superadmin em suporte", () => supportActor],
	];
	for (const [name, actor] of actors()) {
		it(`${name} não escreve nenhuma destas tabelas`, async () => {
			const who = actor();
			for (const [label, sql, params] of writes(who, T.bureau.id)) {
				const outcome = await attempt(who, sql, [...params]);
				expect(outcome === "denied" || outcome === 0, `${name}: ${label} => ${outcome}`).toBe(true);
			}
		});
	}

	it("o bureau_admin de outro Bureau também não", async () => {
		const who = asActor(foreign.bureauAdmin);
		for (const [label, sql, params] of writes(who, T.bureau.id)) {
			const outcome = await attempt(who, sql, [...params]);
			expect(outcome === "denied" || outcome === 0, `${label} => ${outcome}`).toBe(true);
		}
	});

	it("o superadmin sem suporte escreve override, bloqueio e % de afiliados, mas não o legado", async () => {
		const who = asActor(sa);
		const [rate, block, affUpdate, affInsert, ...legacy] = writes(who, T.bureau.id);
		expect(await attempt(who, rate[1], [...rate[2]])).toBe(1);
		expect(await attempt(who, block[1], [...block[2]])).toBe(1);
		expect(await attempt(who, affUpdate[1], [...affUpdate[2]])).toBe(1);
		expect(await attempt(who, affInsert[1], [...affInsert[2]])).toBe(1);
		for (const [label, sql, params] of legacy) {
			const outcome = await attempt(who, sql, [...params]);
			expect(outcome === "denied" || outcome === 0, `${label} => ${outcome}`).toBe(true);
		}
	});

	it("set_by e updated_by têm de ser o próprio superadmin", async () => {
		const who = asActor(sa);
		expect(
			await attempt(who, "insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, 10, $2)", [T.bureau.id, T.bureauAdmin.userId]),
		).toBe("denied");
		expect(
			await attempt(who, "update bureau_affiliate_settings set default_pct = 9, updated_by = $2 where bureau_id = $1", [T.bureau.id, T.bureauAdmin.userId]),
		).toBe("denied");
	});
});

describe("leitura", () => {
	const countOf = (actor: Actor, table: string) =>
		withDbContext(app, actor, async (c) => Number((await c.query(`select count(*) as n from ${table} where bureau_id = $1`, [T.bureau.id])).rows[0].n));

	it("a equipe do Bureau e o superadmin leem a % e o bloqueio; outro Bureau e o cliente não leem", async () => {
		for (const actor of [asActor(T.bureauAdmin), asActor(T.operator), asActor(sa), supportActor]) {
			expect(await countOf(actor, "bureau_commission_rates")).toBeGreaterThanOrEqual(1);
			expect(await countOf(actor, "bureau_product_blocks")).toBeGreaterThanOrEqual(1);
		}
		for (const actor of [asActor(foreign.bureauAdmin), asActor(foreign.operator), asActor(T.client)]) {
			expect(await countOf(actor, "bureau_commission_rates")).toBe(0);
			expect(await countOf(actor, "bureau_product_blocks")).toBe(0);
		}
	});

	it("o cliente não lê commission_pct nem bureau_commission da liquidação, mas lê o preço", async () => {
		const orderRef = randomUUID();
		await owner.query(
			`insert into order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost, commission_pct, bureau_commission)
       values ($1, $2, 'online', $3, 100, 80, 20, 20)`,
			[orderRef, T.bureau.id, T.client.userId],
		);
		const client = asActor(T.client);
		expect(await attempt(client, "select commission_pct from order_settlements where order_ref = $1", [orderRef])).toBe("denied");
		expect(await attempt(client, "select bureau_commission from order_settlements where order_ref = $1", [orderRef])).toBe("denied");
		expect(await attempt(client, "select cost from order_settlements where order_ref = $1", [orderRef])).toBe("denied");
		expect(await attempt(client, "select price from order_settlements where order_ref = $1", [orderRef])).toBe(1);
	});

	it("app_runtime não executa resolve_bureau_commission_pct", async () => {
		expect(await attempt(asActor(T.bureauAdmin), "select resolve_bureau_commission_pct($1)", [T.bureau.id])).toBe("denied");
	});
});

describe("auditoria do superadmin", () => {
	const auditSql =
		"insert into audit_logs (bureau_id, user_id, action, table_name, record_id, metadata) values ($1, $2, $3, $4, $5, '{}'::jsonb)";
	const audit = (actor: Actor, action: string, table: string, bureauId: string | null, recordId: string) =>
		attempt(actor, auditSql, [bureauId, actor.userId, action, table, recordId]);
	// Grava a linha de negócio e o audit na mesma transação (como o código real); "denied" se o audit for recusado.
	const backedAudit = (actor: Actor, backing: string | null, action: string, table: string, bureauId: string, recordId: string, backingBureauId = bureauId) =>
		withDbContext(app, actor, async (client) => {
			if (backing) await client.query(backing, [backingBureauId, actor.userId, productId].slice(0, backing.includes("$3") ? 3 : 2));
			try {
				return (await client.query(auditSql, [bureauId, actor.userId, action, table, recordId])).rowCount ?? 0;
			} catch (error) {
				if ((error as { code?: string }).code === "42501") return "denied";
				throw error;
			}
		});
	const overrideSql = "insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, 10, $2)";
	const blockSql = "insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by) values ($1, $3, true, $2)";
	const affiliateSql =
		"insert into bureau_affiliate_settings (bureau_id, default_pct, updated_by) values ($1, 7, $2) on conflict (bureau_id) do update set default_pct = 7, updated_by = $2, updated_at = now()";

	it("superadmin sem suporte grava commission.bureau_set, catalog.block_set e affiliate.rate do Bureau alvo, com a linha de negócio da mesma transação", async () => {
		const who = asActor(sa);
		expect(await backedAudit(who, overrideSql, "commission.bureau_set", "bureaus", T.bureau.id, T.bureau.id)).toBe(1);
		expect(await backedAudit(who, blockSql, "catalog.block_set", "products", T.bureau.id, productId)).toBe(1);
		expect(await backedAudit(who, affiliateSql, "affiliate.rate", "bureau_affiliate_settings", T.bureau.id, T.bureau.id)).toBe(1);
		// A % global não tem Bureau alvo: o ramo normal do superadmin (bureau_id nulo).
		expect(await audit(who, "settings.bureau_commission", "settings", null, randomUUID())).toBe(1);
	});

	it("recusa audit forjado: sem a linha de negócio da mesma transação, de outro Bureau ou de outro produto", async () => {
		const who = asActor(sa);
		expect(await audit(who, "commission.bureau_set", "bureaus", T.bureau.id, T.bureau.id)).toBe("denied");
		expect(await audit(who, "catalog.block_set", "products", T.bureau.id, productId)).toBe("denied");
		expect(await audit(who, "affiliate.rate", "bureau_affiliate_settings", T.bureau.id, T.bureau.id)).toBe("denied");
		// A linha de negócio é de outro Bureau, o audit aponta para T.
		expect(await backedAudit(who, overrideSql, "commission.bureau_set", "bureaus", T.bureau.id, T.bureau.id, foreign.bureau.id)).toBe("denied");
		expect(await backedAudit(who, blockSql, "catalog.block_set", "products", T.bureau.id, productId, foreign.bureau.id)).toBe("denied");
		// Bloqueio de outro produto.
		const otherProduct = (await owner.query<{ id: string }>("select id from products where id <> $1 limit 1", [productId])).rows[0];
		if (otherProduct) {
			expect(await backedAudit(who, blockSql, "catalog.block_set", "products", T.bureau.id, otherProduct.id)).toBe("denied");
		}
		// Linha de afiliados de transação anterior (xmin antigo): não vale para um audit novo.
		await owner.query(
			"insert into bureau_affiliate_settings (bureau_id, default_pct, updated_by) values ($1, 3, $2) on conflict (bureau_id) do update set default_pct = 3, updated_by = $2",
			[foreign.bureau.id, sa.userId],
		);
		expect(await audit(who, "affiliate.rate", "bureau_affiliate_settings", foreign.bureau.id, foreign.bureau.id)).toBe("denied");
	});

	it("não grava com outra tabela, em sessão de suporte ou fora do papel de superadmin", async () => {
		expect(await backedAudit(asActor(sa), overrideSql, "commission.bureau_set", "products", T.bureau.id, T.bureau.id)).toBe("denied");
		expect(await backedAudit(asActor(sa), blockSql, "catalog.block_set", "bureaus", T.bureau.id, productId)).toBe("denied");
		expect(await audit(supportActor, "commission.bureau_set", "bureaus", foreign.bureau.id, foreign.bureau.id)).toBe("denied");
		expect(await audit(asActor(T.operator), "commission.bureau_set", "bureaus", foreign.bureau.id, foreign.bureau.id)).toBe("denied");
		expect(await audit(asActor(T.client), "catalog.block_set", "products", foreign.bureau.id, productId)).toBe("denied");
	});
});

describe("product_blocked_for_bureau", () => {
	const blocked = (actor: Actor, bureauId: string) =>
		withDbContext(app, actor, async (client) => (await client.query("select product_blocked_for_bureau($1, $2) as b", [bureauId, productId])).rows[0].b);

	it("responde pelo próprio Bureau e ao superadmin; outro Bureau recebe 'bloqueado' sem revelar o estado real", async () => {
		expect(await blocked(asActor(T.bureauAdmin), T.bureau.id)).toBe(true); // bloqueado no beforeAll
		expect(await blocked(asActor(sa), T.bureau.id)).toBe(true);
		expect(await blocked(asActor(sa), foreign.bureau.id)).toBe(false); // liberado de fato
		// Cross-tenant: foreign não está bloqueado, mas T pergunta e recebe true (fechado), nunca o estado real.
		expect(await blocked(asActor(T.bureauAdmin), foreign.bureau.id)).toBe(true);
		expect(await blocked(asActor(foreign.bureauAdmin), T.bureau.id)).toBe(true);
	});

	it("a cópia interna não é executável por app_runtime", async () => {
		expect(await attempt(asActor(T.bureauAdmin), "select product_blocked_for_bureau_internal($1, $2)", [T.bureau.id, productId])).toBe("denied");
	});
});

describe("% global em sessão de suporte", () => {
	it("o RLS recusa escrever bureau_commission_pct em suporte, mas não outras chaves nem fora de suporte", async () => {
		const upsert = "insert into settings (key, value) values ($1, '10'::jsonb) on conflict (key) do update set value = excluded.value";
		expect(await attempt(supportActor, upsert, ["bureau_commission_pct"])).toBe("denied");
		expect(await attempt(asActor(sa), upsert, ["bureau_commission_pct"])).toBe(1);
	});
});
