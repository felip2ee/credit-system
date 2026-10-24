import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import {
	seedBureauCost,
	seedCatalogItem,
	seedProduct,
	seedProductVersion,
	seedSuperadmin,
	seedTenant,
	withDbContext,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

let tenantA: SeededTenant;
let tenantB: SeededTenant;
let superadmin: SeedSuperadmin;

beforeAll(async () => {
	tenantA = await seedTenant(owner, "Catalogo A");
	tenantB = await seedTenant(owner, "Catalogo B");
	superadmin = await seedSuperadmin(owner);
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end()]);
});

const adminOf = (t: SeededTenant) => ({
	userId: t.bureauAdmin.userId,
	role: "bureau_admin",
	bureauId: t.bureau.id,
});
const operatorOf = (t: SeededTenant) => ({
	userId: t.operator.userId,
	role: "operator",
	bureauId: t.bureau.id,
});
const superadminCtx = () => ({
	userId: superadmin.userId,
	role: "superadmin",
	bureauId: null,
});

const insertItem = `insert into bureau_catalog_items (bureau_id, product_id, active, sale_price, updated_by)
  values ($1, $2, $3, $4, $5)`;

describe("catalogo (schema e RLS)", () => {
	it("product_versions immutable", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00" });

		await expect(
			withDbContext(app, superadminCtx(), (c) =>
				c.query("update product_versions set base_cost = 1 where id = $1", [
					product.versionId,
				]),
			),
		).rejects.toThrow(/permission denied/);
		await expect(
			withDbContext(app, superadminCtx(), (c) =>
				c.query("delete from product_versions where id = $1", [
					product.versionId,
				]),
			),
		).rejects.toThrow(/permission denied/);
		// A trigger também barra o dono da tabela.
		await expect(
			owner.query("update product_versions set base_cost = 1 where id = $1", [
				product.versionId,
			]),
		).rejects.toThrow(/immutable/);
		await expect(
			owner.query("delete from product_versions where id = $1", [
				product.versionId,
			]),
		).rejects.toThrow(/immutable/);
	});

	it("superadmin without support reads zero rows of other tenant tables", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00" });
		await seedCatalogItem(owner, {
			bureauId: tenantA.bureau.id,
			productId: product.id,
			salePrice: "7.00",
			updatedBy: tenantA.bureauAdmin.userId,
		});

		const adminItems = await withDbContext(app, adminOf(tenantA), (c) =>
			c.query("select 1 from bureau_catalog_items"),
		);
		expect(adminItems.rowCount).toBeGreaterThan(0);

		const { items, holders } = await withDbContext(
			app,
			superadminCtx(),
			async (c) => ({
				items: await c.query("select 1 from bureau_catalog_items"),
				holders: await c.query("select 1 from holders"),
			}),
		);
		expect(items.rowCount).toBe(0);
		expect(holders.rowCount).toBe(0);
	});

	it("superadmin reads and inserts bureau_product_costs without support", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00" });
		await seedBureauCost(owner, {
			bureauId: tenantA.bureau.id,
			productId: product.id,
			cost: "6.00",
			setBy: superadmin.userId,
		});

		const read = await withDbContext(app, superadminCtx(), (c) =>
			c.query("select cost from bureau_product_costs where bureau_id = $1", [
				tenantA.bureau.id,
			]),
		);
		expect(read.rows.map((r) => r.cost)).toContain("6.00");

		const inserted = await withDbContext(app, superadminCtx(), (c) =>
			c.query(
				`insert into bureau_product_costs (bureau_id, product_id, cost, set_by)
         values ($1, $2, '7.50', $3) returning cost`,
				[tenantB.bureau.id, product.id, superadmin.userId],
			),
		);
		expect(inserted.rows[0].cost).toBe("7.50");

		await expect(
			withDbContext(app, superadminCtx(), (c) =>
				c.query("update bureau_product_costs set cost = 1"),
			),
		).rejects.toThrow(/permission denied/);
		await expect(
			withDbContext(app, superadminCtx(), (c) =>
				c.query("delete from bureau_product_costs"),
			),
		).rejects.toThrow(/permission denied/);
	});

	it("cross-bureau catalog access denied", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00" });
		await seedCatalogItem(owner, {
			bureauId: tenantB.bureau.id,
			productId: product.id,
			salePrice: "9.00",
			updatedBy: tenantB.bureauAdmin.userId,
		});
		await seedBureauCost(owner, {
			bureauId: tenantB.bureau.id,
			productId: product.id,
			cost: "6.00",
			setBy: superadmin.userId,
		});
		const admin = adminOf(tenantA);

		const reads = await withDbContext(app, admin, async (c) => ({
			items: await c.query(
				"select 1 from bureau_catalog_items where bureau_id = $1",
				[tenantB.bureau.id],
			),
			costs: await c.query(
				"select 1 from bureau_product_costs where bureau_id = $1",
				[tenantB.bureau.id],
			),
		}));
		expect(reads.items.rowCount).toBe(0);
		expect(reads.costs.rowCount).toBe(0);

		const updated = await withDbContext(app, admin, (c) =>
			c.query(
				"update bureau_catalog_items set sale_price = '20.00' where bureau_id = $1",
				[tenantB.bureau.id],
			),
		);
		expect(updated.rowCount).toBe(0);

		await expect(
			withDbContext(app, admin, (c) =>
				c.query(insertItem, [
					tenantB.bureau.id,
					product.id,
					false,
					"9.00",
					tenantB.bureauAdmin.userId,
				]),
			),
		).rejects.toThrow(/row-level security/);
		// bureau_admin nunca grava custo, nem no próprio Bureau.
		for (const bureauId of [tenantA.bureau.id, tenantB.bureau.id]) {
			await expect(
				withDbContext(app, admin, (c) =>
					c.query(
						`insert into bureau_product_costs (bureau_id, product_id, cost, set_by)
             values ($1, $2, '1.00', $3)`,
						[bureauId, product.id, admin.userId],
					),
				),
			).rejects.toThrow(/row-level security/);
		}
	});

	it("operator reads catalog and cannot write", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00" });
		await seedCatalogItem(owner, {
			bureauId: tenantA.bureau.id,
			productId: product.id,
			salePrice: "8.00",
			updatedBy: tenantA.bureauAdmin.userId,
		});
		const operator = operatorOf(tenantA);

		const reads = await withDbContext(app, operator, async (c) => ({
			items: await c.query(
				"select 1 from bureau_catalog_items where product_id = $1",
				[product.id],
			),
			products: await c.query("select 1 from products where id = $1", [
				product.id,
			]),
			versions: await c.query(
				"select 1 from product_versions where product_id = $1",
				[product.id],
			),
		}));
		expect(reads.items.rowCount).toBe(1);
		expect(reads.products.rowCount).toBe(1);
		expect(reads.versions.rowCount).toBe(1);

		const updated = await withDbContext(app, operator, (c) =>
			c.query(
				"update bureau_catalog_items set sale_price = '20.00' where product_id = $1",
				[product.id],
			),
		);
		expect(updated.rowCount).toBe(0);
		const other = await seedProduct(owner, { baseCost: "5.00" });
		await expect(
			withDbContext(app, operator, (c) =>
				c.query(insertItem, [
					tenantA.bureau.id,
					other.id,
					true,
					"8.00",
					operator.userId,
				]),
			),
		).rejects.toThrow(/row-level security/);
		const renamed = await withDbContext(app, operator, (c) =>
			c.query("update products set name = 'x'"),
		);
		expect(renamed.rowCount).toBe(0);
	});

	it("trigger rejects price below cost", async () => {
		const tenant = await seedTenant(owner, "Catalogo preco");
		const admin = adminOf(tenant);
		const product = await seedProduct(owner, { baseCost: "10.00" });
		const args = (price: string, active = true) => [
			tenant.bureau.id,
			product.id,
			active,
			price,
			admin.userId,
		];

		await expect(
			withDbContext(app, admin, (c) => c.query(insertItem, args("9.99"))),
		).rejects.toThrow(/below effective cost/);
		await expect(
			withDbContext(app, admin, (c) =>
				c.query(insertItem, args("9.99", false)),
			),
		).rejects.toThrow(/below effective cost/);

		await withDbContext(app, admin, async (c) => {
			await c.query(insertItem, args("10.00"));
			await expect(
				c.query(
					"update bureau_catalog_items set sale_price = '9.99' where bureau_id = $1 and product_id = $2",
					[tenant.bureau.id, product.id],
				),
			).rejects.toThrow(/below effective cost/);
		});

		// Override do Bureau vale no lugar do custo padrão.
		await seedBureauCost(owner, {
			bureauId: tenant.bureau.id,
			productId: product.id,
			cost: "12.00",
			setBy: superadmin.userId,
		});
		await expect(
			withDbContext(app, admin, (c) => c.query(insertItem, args("11.99"))),
		).rejects.toThrow(/below effective cost/);
		await withDbContext(app, admin, (c) => c.query(insertItem, args("12.00")));

		// Custo subiu acima do preço: desativar continua possível.
		await seedCatalogItem(owner, {
			bureauId: tenant.bureau.id,
			productId: product.id,
			salePrice: "12.00",
			updatedBy: admin.userId,
		});
		await seedBureauCost(owner, {
			bureauId: tenant.bureau.id,
			productId: product.id,
			cost: "15.00",
			setBy: superadmin.userId,
		});
		const deactivated = await withDbContext(app, admin, (c) =>
			c.query(
				"update bureau_catalog_items set active = false where bureau_id = $1 and product_id = $2",
				[tenant.bureau.id, product.id],
			),
		);
		expect(deactivated.rowCount).toBe(1);
	});

	it("trigger accepts cost 0 and activation without any cost override", async () => {
		const tenant = await seedTenant(owner, "Catalogo custo zero");
		const admin = adminOf(tenant);
		const product = await seedProduct(owner, { baseCost: "0.00" });

		await withDbContext(app, admin, (c) =>
			c.query(insertItem, [tenant.bureau.id, product.id, true, "5.00", admin.userId]),
		);
		await seedBureauCost(owner, {
			bureauId: tenant.bureau.id,
			productId: product.id,
			cost: "0.00",
			setBy: superadmin.userId,
		});
		const { rows } = await owner.query(
			"select cost, cost_per_partner from bureau_product_costs where bureau_id = $1",
			[tenant.bureau.id],
		);
		expect(rows).toEqual([{ cost: "0.00", cost_per_partner: "0.00" }]);
	});

	it("trigger checks the per-partner price against the per-partner cost", async () => {
		const tenant = await seedTenant(owner, "Catalogo por socio");
		const admin = adminOf(tenant);
		const product = await seedProduct(owner, { baseCost: "10.00", baseCostPerPartner: "4.00" });
		const insertPartnerItem = (price: string, perPartner: string, active = true) =>
			withDbContext(app, admin, (c) =>
				c.query(
					`insert into bureau_catalog_items (bureau_id, product_id, active, sale_price, sale_price_per_partner, updated_by)
           values ($1, $2, $3, $4, $5, $6)`,
					[tenant.bureau.id, product.id, active, price, perPartner, admin.userId],
				),
			);

		await expect(insertPartnerItem("10.00", "3.99")).rejects.toThrow(/partner price below partner cost/);
		await expect(insertPartnerItem("9.99", "4.00")).rejects.toThrow(/below effective cost/);
		await insertPartnerItem("10.00", "4.00");
		// withDbContext desfaz no fim: o item que os próximos passos usam entra pelo dono.
		await seedCatalogItem(owner, {
			bureauId: tenant.bureau.id,
			productId: product.id,
			salePrice: "10.00",
			salePricePerPartner: "4.00",
			updatedBy: admin.userId,
		});

		// Subir só o valor por sócio abaixo do custo por sócio falha no UPDATE.
		await expect(
			withDbContext(app, admin, (c) =>
				c.query(
					"update bureau_catalog_items set sale_price_per_partner = '3.00' where bureau_id = $1 and product_id = $2",
					[tenant.bureau.id, product.id],
				),
			),
		).rejects.toThrow(/partner price below partner cost/);

		// Custo por sócio do Bureau sobe: desativar continua possível.
		await seedBureauCost(owner, {
			bureauId: tenant.bureau.id,
			productId: product.id,
			cost: "10.00",
			costPerPartner: "6.00",
			setBy: superadmin.userId,
		});
		const deactivated = await withDbContext(app, admin, (c) =>
			c.query(
				"update bureau_catalog_items set active = false where bureau_id = $1 and product_id = $2",
				[tenant.bureau.id, product.id],
			),
		);
		expect(deactivated.rowCount).toBe(1);
	});

	it("trigger refuses a per-partner price on dossie_pf only", async () => {
		const tenant = await seedTenant(owner, "Catalogo pf sem socio");
		const admin = adminOf(tenant);
		const { rows } = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
		const insertPf = (perPartner: string) =>
			withDbContext(app, admin, (c) =>
				c.query(
					`insert into bureau_catalog_items (bureau_id, product_id, active, sale_price, sale_price_per_partner, updated_by)
           values ($1, $2, true, '5.00', $3, $4)`,
					[tenant.bureau.id, rows[0].id, perPartner, admin.userId],
				),
			);

		// O seed deixa dossie_pf inativo: o trigger do item exige produto ativo.
		await owner.query("update products set active = true where code = 'dossie_pf'");
		await expect(insertPf("1.00")).rejects.toThrow(/per-partner price only for dossie_empresarial/);
		await insertPf("0.00");
	});

	it("public_bureau_catalog columns, inactive bureau and per-field price rule", async () => {
		const tenant = await seedTenant(owner, "Catalogo publico");
		const admin = tenant.bureauAdmin.userId;
		const bureauId = tenant.bureau.id;
		const main = await seedProduct(owner, { baseCost: "10.00", baseCostPerPartner: "4.00" });
		const hidden = await seedProduct(owner, { baseCost: "10.00" });
		const raisedCost = await seedProduct(owner, { baseCost: "10.00" });
		const raisedPartnerCost = await seedProduct(owner, { baseCost: "10.00", baseCostPerPartner: "4.00" });
		await seedCatalogItem(owner, {
			bureauId,
			productId: main.id,
			salePrice: "15.00",
			salePricePerPartner: "5.00",
			updatedBy: admin,
		});
		// Item inativo: fora da venda.
		await seedCatalogItem(owner, {
			bureauId,
			productId: hidden.id,
			salePrice: "15.00",
			updatedBy: admin,
			active: false,
		});
		// Custo base sobe acima do preço: fora da venda, preço intacto.
		await seedCatalogItem(owner, { bureauId, productId: raisedCost.id, salePrice: "15.00", updatedBy: admin });
		await seedBureauCost(owner, {
			bureauId,
			productId: raisedCost.id,
			cost: "20.00",
			setBy: superadmin.userId,
		});
		// Só o custo por sócio sobe acima do valor por sócio: também fora da venda.
		await seedCatalogItem(owner, {
			bureauId,
			productId: raisedPartnerCost.id,
			salePrice: "15.00",
			salePricePerPartner: "5.00",
			updatedBy: admin,
		});
		await seedBureauCost(owner, {
			bureauId,
			productId: raisedPartnerCost.id,
			cost: "10.00",
			costPerPartner: "6.00",
			setBy: superadmin.userId,
		});

		const result = await app.query("select * from public_bureau_catalog($1)", [tenant.bureau.slug]);
		expect(result.fields.map((f) => f.name)).toEqual(["code", "name", "sale_price", "sale_price_per_partner"]);
		expect(result.rows.map((r) => [r.code, r.sale_price, r.sale_price_per_partner])).toEqual([
			[main.code, "15.00", "5.00"],
		]);

		// Bureau inativo e slug inexistente.
		await owner.query("update bureaus set status = 'inactive' where id = $1", [bureauId]);
		const inactive = await app.query("select code from public_bureau_catalog($1)", [tenant.bureau.slug]);
		expect(inactive.rowCount).toBe(0);
		const missing = await app.query("select code from public_bureau_catalog($1)", ["slug-que-nao-existe"]);
		expect(missing.rowCount).toBe(0);
	});

	it("resolve_product_terms uses override then base cost, base and per partner", async () => {
		const tenant = await seedTenant(owner, "Catalogo termos");
		const other = await seedTenant(owner, "Catalogo termos outro");
		const product = await seedProduct(owner, { baseCost: "10.00", baseCostPerPartner: "3.00" });
		const resolve = (t: SeededTenant) =>
			withDbContext(app, adminOf(t), async (c) => {
				const { rows } = await c.query(
					"select product_version_id, effective_cost, effective_cost_per_partner from resolve_product_terms($1, $2)",
					[t.bureau.id, product.id],
				);
				return rows;
			});

		expect(await resolve(tenant)).toEqual([
			{ product_version_id: product.versionId, effective_cost: "10.00", effective_cost_per_partner: "3.00" },
		]);

		const version2 = await seedProductVersion(owner, {
			productId: product.id,
			version: 2,
			baseCost: "11.00",
			baseCostPerPartner: "3.50",
		});
		expect(await resolve(tenant)).toEqual([
			{ product_version_id: version2, effective_cost: "11.00", effective_cost_per_partner: "3.50" },
		]);

		for (const [cost, costPerPartner] of [
			["12.00", "5.00"],
			["9.50", "2.25"],
		]) {
			await seedBureauCost(owner, {
				bureauId: tenant.bureau.id,
				productId: product.id,
				cost,
				costPerPartner,
				setBy: superadmin.userId,
			});
		}
		// Override mais recente vence (os dois campos); outro Bureau segue no custo padrão.
		expect(await resolve(tenant)).toEqual([
			{ product_version_id: version2, effective_cost: "9.50", effective_cost_per_partner: "2.25" },
		]);
		expect(await resolve(other)).toEqual([
			{ product_version_id: version2, effective_cost: "11.00", effective_cost_per_partner: "3.50" },
		]);
	});
});
