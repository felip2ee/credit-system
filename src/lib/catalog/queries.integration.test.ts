// Queries do catálogo e da comissão contra um Postgres real, sob RLS. Cada teste usa Bureaus e produtos novos.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ??
			"postgres://app_runtime:test@localhost:54329/credit_system_test",
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

import { writeAuditEvent } from "@/lib/audit/write";
import {
	listBureauCommissionRates,
	listBureauProductBlocks,
	setBureauCommissionOverride,
	setProductBlock,
} from "@/lib/commission/queries";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedCatalogItem,
	seedProduct,
	seedSuperadmin,
	seedTenant,
	setPlatformSale,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

import {
	createProduct,
	createProductVersion,
	getEffectiveCommission,
	listCatalog,
	listProducts,
	listProductVersions,
	triggerConflict,
	updateProduct,
} from "./queries";
import { quoteOrder } from "./quote";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let tenant: SeededTenant;
let other: SeededTenant;
let superadmin: SeedSuperadmin;
let sa: DbIdentity;
let admin: DbIdentity;
let operator: DbIdentity;
// A % global é uma chave única: o arquivo a esvazia e a devolve ao valor de antes no fim.
let globalBefore: { value: unknown }[];

beforeAll(async () => {
	tenant = await seedTenant(owner, "Catalogo Q");
	other = await seedTenant(owner, "Catalogo Q2");
	superadmin = await seedSuperadmin(owner);
	sa = { userId: superadmin.userId, role: "superadmin", bureauId: null };
	admin = { ...tenant.bureauAdmin };
	operator = { ...tenant.operator };
	globalBefore = (await owner.query("select value from settings where key = 'bureau_commission_pct'")).rows;
	await owner.query("delete from settings where key = 'bureau_commission_pct'");
});

afterAll(async () => {
	await owner.query("delete from settings where key = 'bureau_commission_pct'");
	for (const row of globalBefore) {
		await owner.query("insert into settings (key, value) values ('bureau_commission_pct', $1::jsonb)", [
			JSON.stringify(row.value),
		]);
	}
	await Promise.all([owner.end(), pool.end()]);
});

const setGlobal = (pct: number | null) =>
	pct === null
		? owner.query("delete from settings where key = 'bureau_commission_pct'")
		: owner.query(
				`insert into settings (key, value) values ('bureau_commission_pct', $1::jsonb)
         on conflict (key) do update set value = excluded.value`,
				[JSON.stringify(pct)],
			);

const entryOf = async (identity: DbIdentity, productId: string) =>
	(await listCatalog(identity)).find((e) => e.productId === productId);

const publicCodes = async (slug: string) =>
	(await pool.query<{ code: string }>("select code from public_bureau_catalog($1)", [slug])).rows.map(
		(r) => r.code,
	);

async function auditRows(action: string, recordId: string) {
	const { rows } = await owner.query(
		"select bureau_id, user_id, metadata from audit_logs where action = $1 and record_id = $2 order by created_at",
		[action, recordId],
	);
	return rows;
}

const zeroPartner = { salePricePerPartner: "0.00" };
const GHOST = "00000000-0000-4000-8000-00000000dead";

describe("produtos e versões (superadmin)", () => {
	it("creates a product, edits it and adds a priced version without changing the old one", async () => {
		const code = `prod_${Math.random().toString(36).slice(2, 10)}`;
		const created = await createProduct(sa, {
			code,
			name: "Produto Teste",
			depsProduct: "Smart PF 002",
			baseCost: "5.00",
			baseCostPerPartner: "1.50",
			salePrice: null,
			salePricePerPartner: "0.00",
		});
		if (!created.ok) throw new Error("createProduct failed");

		expect(
			await createProduct(sa, {
				code,
				name: "Dup",
				depsProduct: null,
				baseCost: "1.00",
				baseCostPerPartner: "0.00",
				salePrice: null,
				...zeroPartner,
			}),
		).toEqual({ ok: false, reason: "code_taken" });

		expect(await updateProduct(sa, { id: created.id, name: "Produto Renomeado", active: false })).toEqual({ ok: true });
		const v2 = await createProductVersion(sa, {
			productId: created.id,
			depsProduct: null,
			baseCost: "6.50",
			baseCostPerPartner: "2.25",
			salePrice: "400.00",
			salePricePerPartner: "30.00",
		});
		expect(v2).toMatchObject({ ok: true, version: 2 });

		const listed = (await listProducts(sa)).find((p) => p.id === created.id);
		expect(listed).toMatchObject({
			name: "Produto Renomeado",
			active: false,
			version: 2,
			baseCost: "6.50",
			salePrice: "400.00",
			salePricePerPartner: "30.00",
			depsProduct: null,
		});
		const versions = await listProductVersions(sa, created.id);
		expect(versions.map((v) => [v.version, v.baseCost, v.salePrice, v.salePricePerPartner, v.depsProduct])).toEqual([
			[2, "6.50", "400.00", "30.00", null],
			[1, "5.00", null, "0.00", "Smart PF 002"],
		]);
		expect(await auditRows("catalog.product.create", created.id)).toHaveLength(1);
		const [updateEvent] = await auditRows("catalog.product.update", created.id);
		expect(updateEvent.metadata).toMatchObject({ old_name: "Produto Teste", name: "Produto Renomeado", old_active: true, active: false });
		const [versionEvent] = await auditRows("catalog.product.version", v2.ok ? v2.versionId : "");
		expect(versionEvent.metadata).toMatchObject({
			old_deps_product: "Smart PF 002",
			deps_product: null,
			base_cost: "6.50",
			base_cost_per_partner: "2.25",
			old_sale_price: null,
			sale_price: "400.00",
			sale_price_per_partner: "30.00",
		});
	});

	it("returns not_found for an unknown product", async () => {
		expect(await updateProduct(sa, { id: GHOST, name: "X", active: true })).toEqual({ ok: false, reason: "not_found" });
		expect(
			await createProductVersion(sa, {
				productId: GHOST,
				depsProduct: null,
				baseCost: "1.00",
				baseCostPerPartner: "0.00",
				salePrice: null,
				...zeroPartner,
			}),
		).toEqual({ ok: false, reason: "not_found" });
	});

	it("rejects a price below cost, a partner price below cost and a per-partner price on dossie_pf", async () => {
		const priced = await seedProduct(owner, { baseCost: "5.00", baseCostPerPartner: "2.00" });
		const version = (salePrice: string | null, salePricePerPartner: string) => ({
			productId: priced.id,
			depsProduct: null,
			baseCost: "5.00",
			baseCostPerPartner: "2.00",
			salePrice,
			salePricePerPartner,
		});

		expect(await createProductVersion(sa, version("4.99", "2.00"))).toEqual({ ok: false, reason: "price_below_cost" });
		expect(await createProductVersion(sa, version("5.00", "1.99"))).toEqual({
			ok: false,
			reason: "partner_price_below_cost",
		});
		// Preço igual ao custo passa (regra isPriceSellable); sem preço não há o que comparar.
		expect(await createProductVersion(sa, version("5.00", "2.00"))).toMatchObject({ ok: true });
		expect(await createProductVersion(sa, version(null, "0.00"))).toMatchObject({ ok: true });

		const pf = (await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'")).rows[0];
		expect(
			await createProductVersion(sa, {
				productId: pf.id,
				depsProduct: null,
				baseCost: "1.00",
				baseCostPerPartner: "0.00",
				salePrice: "10.00",
				salePricePerPartner: "1.00",
			}),
		).toEqual({ ok: false, reason: "per_partner_not_allowed" });
	});
});

describe("triggerConflict: mensagem real da trigger de preço", () => {
	it("maps the per-partner rejection of dossie_pf and ignores other errors", async () => {
		const pf = (await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'")).rows[0];
		let conflict: ReturnType<typeof triggerConflict> = null;
		try {
			await owner.query(
				`insert into product_versions (product_id, version, base_cost, sale_price, sale_price_per_partner)
         select $1, coalesce(max(version), 0) + 1, 1, 10, 1 from product_versions where product_id = $1`,
				[pf.id],
			);
		} catch (error) {
			conflict = triggerConflict(error);
		}
		expect(conflict).toBe("per_partner_not_allowed");
		expect(triggerConflict({ code: "23514", message: "outra" })).toBeNull();
		expect(triggerConflict({ code: "23505", message: "catalog: per-partner price only for dossie_empresarial" })).toBeNull();
	});
});

describe("catálogo à venda (listCatalog)", () => {
	it("lists only active products whose latest version has a price", async () => {
		const priced = await seedProduct(owner, { baseCost: "1.00", salePrice: "10.00", salePricePerPartner: "2.00" });
		const unpriced = await seedProduct(owner, { baseCost: "1.00" });
		const inactive = await seedProduct(owner, { baseCost: "1.00", salePrice: "10.00" });
		await owner.query("update products set active = false where id = $1", [inactive.id]);

		expect(await entryOf(admin, priced.id)).toMatchObject({
			code: priced.code,
			productVersionId: priced.versionId,
			salePrice: "10.00",
			salePricePerPartner: "2.00",
		});
		expect(await entryOf(admin, unpriced.id)).toBeUndefined();
		expect(await entryOf(admin, inactive.id)).toBeUndefined();
		expect(await publicCodes(tenant.bureau.slug)).toContain(priced.code);
		expect(await publicCodes(tenant.bureau.slug)).not.toContain(unpriced.code);
	});

	it("never falls back to an older priced version when the latest has no price", async () => {
		const product = await seedProduct(owner, { baseCost: "1.00", salePrice: "10.00" });
		expect(await entryOf(admin, product.id)).toMatchObject({ salePrice: "10.00" });

		const next = await createProductVersion(sa, {
			productId: product.id,
			depsProduct: null,
			baseCost: "1.00",
			baseCostPerPartner: "0.00",
			salePrice: null,
			...zeroPartner,
		});
		expect(next).toMatchObject({ ok: true });
		expect(await entryOf(admin, product.id)).toBeUndefined();
		expect(await publicCodes(tenant.bureau.slug)).not.toContain(product.code);
	});

	it("a new priced version replaces the price for new sales", async () => {
		const product = await seedProduct(owner, { baseCost: "1.00", salePrice: "10.00" });
		const v2 = await createProductVersion(sa, {
			productId: product.id,
			depsProduct: null,
			baseCost: "1.00",
			baseCostPerPartner: "0.00",
			salePrice: "12.50",
			...zeroPartner,
		});
		expect(await entryOf(admin, product.id)).toMatchObject({
			salePrice: "12.50",
			productVersionId: v2.ok ? v2.versionId : "",
		});
	});

	it("operator reads the catalog and a superadmin without bureau gets an empty list", async () => {
		const product = await seedProduct(owner, { baseCost: "1.00", salePrice: "10.00" });

		expect(await entryOf(operator, product.id)).toMatchObject({ salePrice: "10.00" });
		expect(await listCatalog(sa)).toEqual([]);
	});

	it("a block hides the product for that bureau only; releasing brings it back and keeps the history", async () => {
		const product = await seedProduct(owner, { baseCost: "1.00", salePrice: "10.00" });

		expect(await setProductBlock(sa, tenant.bureau.id, product.id, true)).toEqual({ ok: true });
		expect(await entryOf(admin, product.id)).toBeUndefined();
		expect(await publicCodes(tenant.bureau.slug)).not.toContain(product.code);
		expect(await entryOf(other.bureauAdmin, product.id)).toMatchObject({ salePrice: "10.00" });

		const row = (await listBureauProductBlocks(sa, tenant.bureau.id)).find((r) => r.productId === product.id);
		expect(row).toMatchObject({ blocked: true });
		// O Bureau lê o próprio bloqueio; o outro Bureau não lê o dele.
		const ownRows = await listBureauProductBlocks(admin, tenant.bureau.id);
		expect(ownRows.find((r) => r.productId === product.id)).toMatchObject({ blocked: true });
		const foreign = await listBureauProductBlocks(other.bureauAdmin, tenant.bureau.id);
		expect(foreign.find((r) => r.productId === product.id)?.history).toEqual([]);

		expect(await setProductBlock(sa, tenant.bureau.id, product.id, false)).toEqual({ ok: true });
		expect(await entryOf(admin, product.id)).toMatchObject({ salePrice: "10.00" });
		const released = (await listBureauProductBlocks(sa, tenant.bureau.id)).find((r) => r.productId === product.id);
		expect(released?.blocked).toBe(false);
		expect(released?.history.map((h) => h.blocked)).toEqual([false, true]);

		const events = await auditRows("catalog.block_set", product.id);
		expect(events.map((e) => [e.bureau_id, e.metadata.blocked, e.metadata.bureau_id])).toEqual([
			[tenant.bureau.id, true, tenant.bureau.id],
			[tenant.bureau.id, false, tenant.bureau.id],
		]);
	});

	it("only the superadmin writes a block (the action also refuses a support session); unknown bureau or product is not_found", async () => {
		const product = await seedProduct(owner, { baseCost: "1.00", salePrice: "10.00" });

		await expect(setProductBlock(admin, tenant.bureau.id, product.id, true)).rejects.toThrow();
		await expect(setProductBlock(operator, tenant.bureau.id, product.id, true)).rejects.toThrow();
		expect(await entryOf(admin, product.id)).toMatchObject({ salePrice: "10.00" });

		expect(await setProductBlock(sa, GHOST, product.id, true)).toEqual({ ok: false, reason: "not_found" });
		expect(await setProductBlock(sa, tenant.bureau.id, GHOST, true)).toEqual({ ok: false, reason: "not_found" });
	});
});

describe("% efetiva do Bureau e override", () => {
	it("override wins over the global; a null override goes back to the global; none = not configured", async () => {
		const fresh = await seedTenant(owner, "Catalogo Pct");
		const bureau = fresh.bureau;
		const staff: DbIdentity = { ...fresh.bureauAdmin };

		expect(await getEffectiveCommission(sa, bureau.id)).toEqual({ pct: null, source: "none" });
		await setGlobal(15);
		expect(await getEffectiveCommission(staff, bureau.id)).toEqual({ pct: "15.00", source: "global" });

		expect(await setBureauCommissionOverride(sa, bureau.id, 22.5)).toEqual({ ok: true });
		expect(await getEffectiveCommission(staff, bureau.id)).toEqual({ pct: "22.50", source: "override" });
		expect(await setBureauCommissionOverride(sa, bureau.id, 0)).toEqual({ ok: true });
		// 0% é um override válido: não cai para o global.
		expect(await getEffectiveCommission(staff, bureau.id)).toEqual({ pct: "0.00", source: "override" });
		expect(await setBureauCommissionOverride(sa, bureau.id, null)).toEqual({ ok: true });
		expect(await getEffectiveCommission(staff, bureau.id)).toEqual({ pct: "15.00", source: "global" });
		await setGlobal(null);
		expect(await getEffectiveCommission(staff, bureau.id)).toEqual({ pct: null, source: "none" });

		const history = await listBureauCommissionRates(sa, bureau.id);
		expect(history.map((h) => h.pct)).toEqual([null, "0.00", "22.50"]);
		const events = await auditRows("commission.bureau_set", bureau.id);
		expect(events.map((e) => [e.bureau_id, e.metadata.from, e.metadata.to])).toEqual([
			[bureau.id, null, 22.5],
			[bureau.id, 22.5, 0],
			[bureau.id, 0, null],
		]);
	});

	it("a bureau staff reads only its own rate", async () => {
		await setBureauCommissionOverride(sa, tenant.bureau.id, 10);
		expect(await getEffectiveCommission(admin, tenant.bureau.id)).toMatchObject({ pct: "10.00", source: "override" });
		// Outro Bureau não enxerga o override deste.
		expect(await getEffectiveCommission(other.bureauAdmin, tenant.bureau.id)).toMatchObject({ source: "none" });
		expect(await getEffectiveCommission(admin, null)).toEqual({ pct: null, source: "none" });
	});

	it("only the superadmin writes an override (the action also refuses a support session)", async () => {
		await expect(setBureauCommissionOverride(admin, tenant.bureau.id, 50)).rejects.toThrow();
		await expect(setBureauCommissionOverride(operator, tenant.bureau.id, 50)).rejects.toThrow();
		expect(await setBureauCommissionOverride(sa, GHOST, 5)).toEqual({ ok: false, reason: "not_found" });
	});

	it("refuses an override that takes the Bureau plus affiliate pct above 100 and rolls everything back", async () => {
		const guarded = await seedTenant(owner, "Catalogo Split");
		await owner.query(
			"insert into bureau_affiliate_settings (bureau_id, default_pct, updated_by) values ($1, 30, $2)",
			[guarded.bureau.id, superadmin.userId],
		);

		expect(await setBureauCommissionOverride(sa, guarded.bureau.id, 70)).toEqual({ ok: true });
		expect(await setBureauCommissionOverride(sa, guarded.bureau.id, 70.01)).toEqual({
			ok: false,
			reason: "split_over_100",
		});
		expect((await listBureauCommissionRates(sa, guarded.bureau.id)).map((h) => h.pct)).toEqual(["70.00"]);
		expect(await auditRows("commission.bureau_set", guarded.bureau.id)).toHaveLength(1);
	});

	it("caps the history at 20 rows", async () => {
		const bureau = (await seedTenant(owner, "Catalogo Hist")).bureau;
		for (let i = 1; i <= 22; i++) await setBureauCommissionOverride(sa, bureau.id, i);
		const history = await listBureauCommissionRates(sa, bureau.id);
		expect(history).toHaveLength(20);
		expect(history[0].pct).toBe("22.00");
		expect(history[19].pct).toBe("3.00");
	});
});

describe("auditoria: bureauId explícito", () => {
	const writeAs = (identity: DbIdentity, action: string, bureauId: string, targetId: string, table = "products") =>
		withUserTransaction(identity, (client) =>
			writeAuditEvent(client, { actorId: identity.userId, action, targetId, bureauId, targetTable: table }),
		);

	it("operator cannot force bureauId in audit", async () => {
		const targetId = (await seedProduct(owner)).id;

		await writeAs(operator, "catalog.test.forced", other.bureau.id, targetId);

		const [row] = await auditRows("catalog.test.forced", targetId);
		expect(row.bureau_id).toBe(tenant.bureau.id);
	});

	it("honors bureauId only for the allowed superadmin events; other superadmin events stay platform-level", async () => {
		const targetId = (await seedProduct(owner)).id;

		await expect(writeAs(sa, "catalog.test.forced", tenant.bureau.id, targetId)).rejects.toThrow(/row-level security/);
		// O custo por Bureau acabou: o evento antigo não passa mais pela política sem a linha de custo.
		await expect(writeAs(sa, "catalog.cost.set", tenant.bureau.id, targetId)).rejects.toThrow(/row-level security/);
		// Evento permitido, só com a tabela alvo certa.
		await expect(writeAs(sa, "catalog.block_set", tenant.bureau.id, targetId, "holders")).rejects.toThrow(/row-level security/);
		// Sem a linha do bloqueio gravada na mesma transação, o evento é forjado e a política recusa.
		await expect(writeAs(sa, "catalog.block_set", tenant.bureau.id, targetId)).rejects.toThrow(/row-level security/);
		await withUserTransaction(sa, async (client) => {
			await client.query("insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by) values ($1, $2, true, $3)", [
				tenant.bureau.id,
				targetId,
				sa.userId,
			]);
			await writeAuditEvent(client, {
				actorId: sa.userId,
				action: "catalog.block_set",
				targetId,
				bureauId: tenant.bureau.id,
				targetTable: "products",
			});
		});
		const [row] = await auditRows("catalog.block_set", targetId);
		expect(row.bureau_id).toBe(tenant.bureau.id);
	});
});

describe("quoteOrder", () => {
	// O seed deixa os dossiês inativos: ativa para cotar.
	beforeAll(() => owner.query("update products set active = true where code in ('dossie_pf', 'dossie_empresarial')"));

	it("quotes the platform price with the partner count and splits Bureau commission and platform share", async () => {
		const buyer = await seedTenant(owner, "Catalogo Quote");
		const buyerAdmin: DbIdentity = { ...buyer.bureauAdmin };
		const empresarial = (await owner.query<{ id: string }>("select id from products where code = 'dossie_empresarial'")).rows[0];
		await setPlatformSale(owner, {
			bureauId: buyer.bureau.id,
			productId: empresarial.id,
			salePrice: "100.00",
			salePricePerPartner: "30.00",
			cost: "80.00", // grava o override de 20%
			setBy: superadmin.userId,
		});
		const versionId = (
			await owner.query<{ product_version_id: string }>("select product_version_id from current_product_price($1)", [empresarial.id])
		).rows[0].product_version_id;

		const quote = await quoteOrder(buyerAdmin, "dossie_empresarial", { partnerCount: 2 });
		expect(quote).toEqual({
			ok: true,
			lines: [
				{
					productVersionId: versionId,
					code: "dossie_empresarial",
					part: "base",
					quantity: 1,
					unitPriceCents: 10000,
					priceCents: 10000,
				},
				{
					productVersionId: versionId,
					code: "dossie_empresarial",
					part: "partner",
					quantity: 2,
					unitPriceCents: 3000,
					priceCents: 6000,
				},
			],
			totalPriceCents: 16000,
			bureauCommissionCents: 3200,
			platformShareCents: 12800,
		});

		// Bloqueado: não à venda.
		await setProductBlock(sa, buyer.bureau.id, empresarial.id, true);
		expect(await quoteOrder(buyerAdmin, "dossie_empresarial", { partnerCount: 0 })).toEqual({
			ok: false,
			reason: "product_not_for_sale",
		});
	});

	it("without any pct the quote fails with commission_not_configured", async () => {
		const buyer = await seedTenant(owner, "Catalogo Quote2");
		const pf = (await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'")).rows[0];
		await seedCatalogItem(owner, {
			bureauId: buyer.bureau.id,
			productId: pf.id,
			salePrice: "50.00",
			updatedBy: superadmin.userId,
		});
		// O seed grava um override; uma linha nula devolve o Bureau ao global, que aqui não existe.
		await owner.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, null, $2)", [
			buyer.bureau.id,
			superadmin.userId,
		]);

		expect(await quoteOrder({ ...buyer.bureauAdmin }, "dossie_pf", { partnerCount: 0 })).toEqual({
			ok: false,
			reason: "commission_not_configured",
		});
	});
});
