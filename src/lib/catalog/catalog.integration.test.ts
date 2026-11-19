import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import {
	seedBureauCost,
	seedProduct,
	seedProductVersion,
	seedSuperadmin,
	seedTenant,
	setPlatformSale,
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

const insertVersion = (productId: string, version: number, salePrice: string | null, perPartner = "0.00") =>
	owner.query(
		`insert into product_versions (product_id, version, base_cost, sale_price, sale_price_per_partner)
     values ($1, $2, 1, $3, $4)`,
		[productId, version, salePrice, perPartner],
	);

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
		// A trigger também barra o dono da tabela, inclusive no preço de venda.
		await expect(
			owner.query("update product_versions set sale_price = 1 where id = $1", [
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
		const { holders } = await withDbContext(
			app,
			superadminCtx(),
			async (c) => ({ holders: await c.query("select 1 from holders") }),
		);
		expect(holders.rowCount).toBe(0);
	});

	it("superadmin inserts product_versions with a sale price and the per-partner guard holds", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00" });

		const inserted = await withDbContext(app, superadminCtx(), (c) =>
			c.query(
				`insert into product_versions (product_id, version, base_cost, sale_price, sale_price_per_partner, created_by)
         values ($1, 2, 5, '400.00', '30.00', $2) returning sale_price, sale_price_per_partner`,
				[product.id, superadmin.userId],
			),
		);
		expect(inserted.rows[0]).toEqual({ sale_price: "400.00", sale_price_per_partner: "30.00" });

		// Checks de faixa: preço > 0 e dentro do limite; por sócio >= 0.
		await expect(insertVersion(product.id, 3, "0.00")).rejects.toThrow(/sale_price/);
		await expect(insertVersion(product.id, 3, "100000000.00")).rejects.toThrow();
		await expect(insertVersion(product.id, 3, "10.00", "-1.00")).rejects.toThrow();
		// Preço por sócio só no Empresarial.
		const pf = (await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'")).rows[0];
		await expect(insertVersion(pf.id, 999, "10.00", "1.00")).rejects.toThrow(/per-partner price only for dossie_empresarial/);
	});

	it("current_product_price uses only the latest version and never falls back to an older price", async () => {
		const product = await seedProduct(owner, { baseCost: "1.00", salePrice: "10.00", salePricePerPartner: "2.00" });
		const read = () =>
			withDbContext(app, adminOf(tenantA), async (c) =>
				(await c.query("select * from current_product_price($1)", [product.id])).rows,
			);

		expect(await read()).toEqual([
			{ product_version_id: product.versionId, sale_price: "10.00", sale_price_per_partner: "2.00" },
		]);
		const v2 = await seedProductVersion(owner, { productId: product.id, version: 2, baseCost: "1.00", salePrice: "12.00" });
		expect(await read()).toEqual([
			{ product_version_id: v2, sale_price: "12.00", sale_price_per_partner: "0.00" },
		]);
		await seedProductVersion(owner, { productId: product.id, version: 3, baseCost: "1.00" });
		expect(await read()).toEqual([]);
	});

	it("cross-bureau access denied; bureau_admin never writes prices, costs, items, rates or blocks", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00", salePrice: "9.00" });
		await setPlatformSale(owner, {
			bureauId: tenantB.bureau.id,
			productId: product.id,
			salePrice: "9.00",
			cost: "6.00",
			setBy: superadmin.userId,
			active: false,
		});
		await seedBureauCost(owner, {
			bureauId: tenantB.bureau.id,
			productId: product.id,
			cost: "6.00",
			setBy: superadmin.userId,
		});
		const admin = adminOf(tenantA);

		const reads = await withDbContext(app, admin, async (c) => ({
			costs: await c.query("select 1 from bureau_product_costs where bureau_id = $1", [tenantB.bureau.id]),
			rates: await c.query("select 1 from bureau_commission_rates where bureau_id = $1", [tenantB.bureau.id]),
			blocks: await c.query("select 1 from bureau_product_blocks where bureau_id = $1", [tenantB.bureau.id]),
		}));
		expect(reads.costs.rowCount).toBe(0);
		expect(reads.rates.rowCount).toBe(0);
		expect(reads.blocks.rowCount).toBe(0);

		for (const bureauId of [tenantA.bureau.id, tenantB.bureau.id]) {
			await expect(
				withDbContext(app, admin, (c) =>
					c.query(
						`insert into bureau_catalog_items (bureau_id, product_id, active, sale_price, updated_by)
             values ($1, $2, false, '9.00', $3)`,
						[bureauId, product.id, admin.userId],
					),
				),
			).rejects.toThrow(/row-level security/);
			await expect(
				withDbContext(app, admin, (c) =>
					c.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, 10, $2)", [
						bureauId,
						admin.userId,
					]),
				),
			).rejects.toThrow(/row-level security/);
			await expect(
				withDbContext(app, admin, (c) =>
					c.query("insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by) values ($1, $2, true, $3)", [
						bureauId,
						product.id,
						admin.userId,
					]),
				),
			).rejects.toThrow(/row-level security/);
			// O custo por Bureau virou legado: nem o superadmin nem o admin inserem mais.
			await expect(
				withDbContext(app, admin, (c) =>
					c.query("insert into bureau_product_costs (bureau_id, product_id, cost, set_by) values ($1, $2, '1.00', $3)", [
						bureauId,
						product.id,
						admin.userId,
					]),
				),
			).rejects.toThrow(/permission denied|row-level security/);
		}
		await expect(
			withDbContext(app, admin, (c) =>
				c.query("insert into product_versions (product_id, version, base_cost, sale_price) values ($1, 9, 1, '1.00')", [product.id]),
			),
		).rejects.toThrow(/row-level security|permission denied/);
	});

	it("operator reads products, priced versions and its own bureau data and cannot write", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00", salePrice: "8.00" });
		const operator = operatorOf(tenantA);

		const reads = await withDbContext(app, operator, async (c) => ({
			products: await c.query("select 1 from products where id = $1", [product.id]),
			versions: await c.query("select 1 from product_versions where product_id = $1 and sale_price = 8", [product.id]),
		}));
		expect(reads.products.rowCount).toBe(1);
		expect(reads.versions.rowCount).toBe(1);

		await expect(
			withDbContext(app, operator, (c) =>
				c.query("insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by) values ($1, $2, true, $3)", [
					tenantA.bureau.id,
					product.id,
					operator.userId,
				]),
			),
		).rejects.toThrow(/row-level security/);
		const renamed = await withDbContext(app, operator, (c) =>
			c.query("update products set name = 'x'"),
		);
		expect(renamed.rowCount).toBe(0);
	});

	it("public_bureau_catalog: columns, inactive bureau, no price, block and latest-version price", async () => {
		const tenant = await seedTenant(owner, "Catalogo publico");
		const bureauId = tenant.bureau.id;
		const main = await seedProduct(owner, { baseCost: "10.00", baseCostPerPartner: "4.00", salePrice: "15.00", salePricePerPartner: "5.00" });
		const unpriced = await seedProduct(owner, { baseCost: "10.00" });
		const blocked = await seedProduct(owner, { baseCost: "10.00", salePrice: "15.00" });
		const inactiveProduct = await seedProduct(owner, { baseCost: "10.00", salePrice: "15.00" });
		const repriced = await seedProduct(owner, { baseCost: "10.00", salePrice: "15.00" });
		await owner.query("update products set active = false where id = $1", [inactiveProduct.id]);
		await seedProductVersion(owner, { productId: repriced.id, version: 2, baseCost: "10.00", salePrice: "18.00" });
		await owner.query(
			"insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by) values ($1, $2, true, $3)",
			[bureauId, blocked.id, superadmin.userId],
		);

		const result = await app.query("select * from public_bureau_catalog($1)", [tenant.bureau.slug]);
		expect(result.fields.map((f) => f.name)).toEqual(["code", "name", "sale_price", "sale_price_per_partner"]);
		const rows = result.rows.map((r) => [r.code, r.sale_price, r.sale_price_per_partner]);
		expect(rows).toContainEqual([main.code, "15.00", "5.00"]);
		expect(rows).toContainEqual([repriced.code, "18.00", "0.00"]);
		for (const hidden of [unpriced, blocked, inactiveProduct]) {
			expect(rows.map((r) => r[0])).not.toContain(hidden.code);
		}

		// Liberar o produto devolve a venda; outro Bureau nunca foi afetado.
		await owner.query(
			"insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by) values ($1, $2, false, $3)",
			[bureauId, blocked.id, superadmin.userId],
		);
		const released = await app.query("select code from public_bureau_catalog($1)", [tenant.bureau.slug]);
		expect(released.rows.map((r) => r.code)).toContain(blocked.code);

		// Bureau inativo e slug inexistente.
		await owner.query("update bureaus set status = 'inactive' where id = $1", [bureauId]);
		const inactive = await app.query("select code from public_bureau_catalog($1)", [tenant.bureau.slug]);
		expect(inactive.rowCount).toBe(0);
		const missing = await app.query("select code from public_bureau_catalog($1)", ["slug-que-nao-existe"]);
		expect(missing.rowCount).toBe(0);
	});

	it("resolve_product_terms (legado) uses override then base cost, base and per partner", async () => {
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
