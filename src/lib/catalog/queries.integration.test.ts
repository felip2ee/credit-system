// Queries do catálogo contra um Postgres real, sob RLS. Cada teste usa Bureaus e produtos novos.

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ??
			"postgres://app_runtime:test@localhost:54329/credit_system",
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
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedBureauCost,
	seedCatalogItem,
	seedProduct,
	seedProductVersion,
	seedSuperadmin,
	seedTenant,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

import {
	createProduct,
	createProductVersion,
	getEffectiveTerms,
	listBureauCosts,
	listCatalog,
	listProducts,
	listProductVersions,
	setBureauProductCost,
	updateProduct,
	upsertCatalogItem,
} from "./queries";
import { quoteOrder } from "./quote";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let tenant: SeededTenant;
let other: SeededTenant;
let superadmin: SeedSuperadmin;
let sa: DbIdentity;
let admin: DbIdentity;
let operator: DbIdentity;

beforeAll(async () => {
	tenant = await seedTenant(owner, "Catalogo Q");
	other = await seedTenant(owner, "Catalogo Q2");
	superadmin = await seedSuperadmin(owner);
	sa = { userId: superadmin.userId, role: "superadmin", bureauId: null };
	admin = { ...tenant.bureauAdmin };
	operator = { ...tenant.operator };
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

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

describe("produtos e versões (superadmin)", () => {
	it("creates a product, edits it and adds a version without changing the old one", async () => {
		const code = `prod_${Math.random().toString(36).slice(2, 10)}`;
		const created = await createProduct(sa, {
			code,
			name: "Produto Teste",
			kind: "main",
			addonFor: [],
			depsProduct: "Smart PF 002",
			baseCost: "5.00",
		});
		if (!created.ok) throw new Error("createProduct failed");

		expect(await createProduct(sa, { code, name: "Dup", kind: "main", addonFor: [], depsProduct: null, baseCost: "1.00" }))
			.toEqual({ ok: false, reason: "code_taken" });

		expect(await updateProduct(sa, { id: created.id, name: "Produto Renomeado", active: false })).toEqual({ ok: true });
		const v2 = await createProductVersion(sa, { productId: created.id, depsProduct: null, baseCost: "6.50" });
		expect(v2).toMatchObject({ ok: true, version: 2 });

		const listed = (await listProducts(sa)).find((p) => p.id === created.id);
		expect(listed).toMatchObject({ name: "Produto Renomeado", active: false, version: 2, baseCost: "6.50", depsProduct: null });
		const versions = await listProductVersions(sa, created.id);
		expect(versions.map((v) => [v.version, v.baseCost, v.depsProduct])).toEqual([
			[2, "6.50", null],
			[1, "5.00", "Smart PF 002"],
		]);
		expect(await auditRows("catalog.product.create", created.id)).toHaveLength(1);
		expect(await auditRows("catalog.product.update", created.id)).toHaveLength(1);
		expect(await auditRows("catalog.product.version", v2.ok ? v2.versionId : "")).toHaveLength(1);
	});

	it("returns not_found for an unknown product", async () => {
		const ghost = "00000000-0000-4000-8000-00000000dead";
		expect(await updateProduct(sa, { id: ghost, name: "X", active: true })).toEqual({ ok: false, reason: "not_found" });
		expect(await createProductVersion(sa, { productId: ghost, depsProduct: null, baseCost: "1.00" })).toEqual({
			ok: false,
			reason: "not_found",
		});
	});
});

describe("custo efetivo e override", () => {
	it("uses the base cost, then the override, and audits old and new cost on the target bureau", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00" });
		await seedProductVersion(owner, { productId: product.id, version: 2, baseCost: "6.00" });

		expect(await getEffectiveTerms(admin, product.id)).toMatchObject({ effectiveCost: "6.00" });

		expect(await setBureauProductCost(sa, tenant.bureau.id, product.id, "9.50")).toEqual({ ok: true });
		expect(await getEffectiveTerms(admin, product.id)).toMatchObject({ effectiveCost: "9.50" });
		// Outro Bureau não é afetado.
		expect(await getEffectiveTerms(other.bureauAdmin, product.id)).toMatchObject({ effectiveCost: "6.00" });

		expect(await setBureauProductCost(sa, tenant.bureau.id, product.id, "7.25")).toEqual({ ok: true });
		const costs = (await listBureauCosts(sa, tenant.bureau.id)).find((c) => c.productId === product.id);
		expect(costs).toMatchObject({ effectiveCost: "7.25", source: "override" });
		expect(costs?.history.map((h) => h.cost)).toEqual(["7.25", "9.50"]);
		const otherCosts = (await listBureauCosts(sa, other.bureau.id)).find((c) => c.productId === product.id);
		expect(otherCosts).toMatchObject({ effectiveCost: "6.00", source: "default", history: [] });

		const events = await auditRows("catalog.cost.set", product.id);
		expect(events.map((e) => [e.bureau_id, e.metadata.old_cost, e.metadata.new_cost])).toEqual([
			[tenant.bureau.id, "6.00", "9.50"],
			[tenant.bureau.id, "9.50", "7.25"],
		]);
	});

	it("returns not_found for an unknown bureau", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00" });

		expect(await setBureauProductCost(sa, "00000000-0000-4000-8000-00000000dead", product.id, "1.00")).toEqual({
			ok: false,
			reason: "not_found",
		});
	});
});

describe("auditoria: bureauId explícito", () => {
	const writeAs = (identity: DbIdentity, action: string, bureauId: string, targetId: string) =>
		withUserTransaction(identity, (client) =>
			writeAuditEvent(client, { actorId: identity.userId, action, targetId, bureauId }),
		);

	it("operator cannot force bureauId in audit", async () => {
		const targetId = (await seedProduct(owner)).id;

		await writeAs(operator, "catalog.test.forced", other.bureau.id, targetId);

		const [row] = await auditRows("catalog.test.forced", targetId);
		expect(row.bureau_id).toBe(tenant.bureau.id);
	});

	it("honors bureauId only for the superadmin cost event; other superadmin events stay platform-level", async () => {
		const targetId = (await seedProduct(owner)).id;

		await expect(writeAs(sa, "catalog.test.forced", tenant.bureau.id, targetId)).rejects.toThrow(/row-level security/);
		await writeAs(sa, "catalog.cost.set", tenant.bureau.id, targetId);

		const [row] = await auditRows("catalog.cost.set", targetId);
		expect(row.bureau_id).toBe(tenant.bureau.id);
	});
});

describe("itens de catálogo (bureau_admin)", () => {
	it("rejects a price below cost, activating without cost and an inactive product", async () => {
		const priced = await seedProduct(owner, { baseCost: "5.00" });
		const free = await seedProduct(owner, { baseCost: "0.00" });
		const inactive = await seedProduct(owner, { baseCost: "1.00" });
		await owner.query("update products set active = false where id = $1", [inactive.id]);

		expect(await upsertCatalogItem(admin, priced.id, { active: true, salePrice: "4.99" })).toEqual({
			ok: false,
			reason: "price_below_cost",
		});
		expect(await upsertCatalogItem(admin, free.id, { active: true, salePrice: "10.00" })).toEqual({
			ok: false,
			reason: "cost_not_set",
		});
		expect(await upsertCatalogItem(admin, inactive.id, { active: true, salePrice: "10.00" })).toEqual({
			ok: false,
			reason: "product_inactive",
		});
		expect(await entryOf(admin, priced.id)).toMatchObject({ item: null, onSale: false });
	});

	it("saves price and audits old and new price", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00" });

		expect(await upsertCatalogItem(admin, product.id, { active: true, salePrice: "10.00" })).toEqual({ ok: true });
		expect(await upsertCatalogItem(admin, product.id, { active: true, salePrice: "12.50" })).toEqual({ ok: true });

		expect(await entryOf(admin, product.id)).toMatchObject({
			item: { active: true, salePrice: "12.50" },
			sellable: true,
			onSale: true,
		});
		const events = await auditRows("catalog.item.upsert", product.id);
		expect(events.map((e) => [e.metadata.old_price, e.metadata.new_price, e.metadata.active])).toEqual([
			[null, "10.00", true],
			["10.00", "12.50", true],
		]);
	});

	it("cost above price removes item from sale", async () => {
		const product = await seedProduct(owner, { baseCost: "5.00" });
		await seedCatalogItem(owner, {
			bureauId: tenant.bureau.id,
			productId: product.id,
			salePrice: "10.00",
			updatedBy: admin.userId,
		});
		expect(await publicCodes(tenant.bureau.slug)).toContain(product.code);

		await setBureauProductCost(sa, tenant.bureau.id, product.id, "12.00");

		expect(await entryOf(admin, product.id)).toMatchObject({
			item: { active: true, salePrice: "10.00" },
			sellable: false,
			onSale: false,
		});
		expect(await publicCodes(tenant.bureau.slug)).not.toContain(product.code);

		// Com o custo acima do preço o admin ainda desativa o item sem mexer no preço.
		expect(await upsertCatalogItem(admin, product.id, { active: false, salePrice: "10.00" })).toEqual({ ok: true });
		expect(await upsertCatalogItem(admin, product.id, { active: true, salePrice: "10.00" })).toEqual({
			ok: false,
			reason: "price_below_cost",
		});
		// Reajustar o preço devolve o item à venda.
		expect(await upsertCatalogItem(admin, product.id, { active: true, salePrice: "12.00" })).toEqual({ ok: true });
		expect(await publicCodes(tenant.bureau.slug)).toContain(product.code);
	});

	it("addon leaves sale when last compatible main leaves", async () => {
		const main = await seedProduct(owner, { baseCost: "1.00" });
		const addon = await seedProduct(owner, { kind: "addon", addonFor: [main.code], baseCost: "1.00" });

		expect(await upsertCatalogItem(admin, addon.id, { active: true, salePrice: "3.00" })).toEqual({
			ok: false,
			reason: "addon_requires_main",
		});
		expect(await upsertCatalogItem(admin, main.id, { active: true, salePrice: "5.00" })).toEqual({ ok: true });
		expect(await upsertCatalogItem(admin, addon.id, { active: true, salePrice: "3.00" })).toEqual({ ok: true });
		expect(await entryOf(admin, addon.id)).toMatchObject({ onSale: true });
		expect(await publicCodes(tenant.bureau.slug)).toEqual(expect.arrayContaining([main.code, addon.code]));

		await upsertCatalogItem(admin, main.id, { active: false, salePrice: "5.00" });

		expect(await entryOf(admin, addon.id)).toMatchObject({ item: { active: true }, onSale: false });
		expect(await publicCodes(tenant.bureau.slug)).not.toContain(addon.code);
	});

	it("operator reads the catalog and cannot write", async () => {
		const product = await seedProduct(owner, { baseCost: "1.00" });

		expect(await entryOf(operator, product.id)).toMatchObject({ item: null });
		await expect(upsertCatalogItem(operator, product.id, { active: true, salePrice: "5.00" })).rejects.toThrow();
	});

	it("returns not_found for an unknown product and ignores items of other bureaus", async () => {
		const product = await seedProduct(owner, { baseCost: "1.00" });
		await seedCatalogItem(owner, {
			bureauId: other.bureau.id,
			productId: product.id,
			salePrice: "9.00",
			updatedBy: other.bureauAdmin.userId,
		});

		expect(await entryOf(admin, product.id)).toMatchObject({ item: null });
		expect(await upsertCatalogItem(admin, "00000000-0000-4000-8000-00000000dead", { active: true, salePrice: "5.00" }))
			.toEqual({ ok: false, reason: "not_found" });
	});
});

describe("quoteOrder", () => {
	it("quoteOrder sums product and addon with current versions", async () => {
		const buyer = await seedTenant(owner, "Catalogo Quote");
		const buyerAdmin: DbIdentity = { ...buyer.bureauAdmin };
		const { rows } = await owner.query<{ product_id: string; code: string; version_id: string }>(
			`select p.id as product_id, p.code, v.id as version_id
         from products p
         join lateral (select id from product_versions where product_id = p.id
                        order by version desc limit 1) v on true
        where p.code in ('consulta_pf', 'parecer_ia')`,
		);
		const byCode = Object.fromEntries(rows.map((r) => [r.code, r]));
		// Custo por Bureau (os produtos do seed têm custo padrão 0.00).
		for (const [code, cost, price] of [
			["consulta_pf", "3.00", "10.00"],
			["parecer_ia", "1.50", "4.00"],
		]) {
			await seedBureauCost(owner, {
				bureauId: buyer.bureau.id,
				productId: byCode[code].product_id,
				cost,
				setBy: superadmin.userId,
			});
			await seedCatalogItem(owner, {
				bureauId: buyer.bureau.id,
				productId: byCode[code].product_id,
				salePrice: price,
				updatedBy: buyerAdmin.userId,
			});
		}

		expect(await quoteOrder(buyerAdmin, "consulta_pf", { withAi: false })).toEqual({
			ok: true,
			lines: [{ productVersionId: byCode.consulta_pf.version_id, code: "consulta_pf", costCents: 300, priceCents: 1000 }],
			totalCostCents: 300,
			totalPriceCents: 1000,
		});
		expect(await quoteOrder(buyerAdmin, "consulta_pf", { withAi: true })).toEqual({
			ok: true,
			lines: [
				{ productVersionId: byCode.consulta_pf.version_id, code: "consulta_pf", costCents: 300, priceCents: 1000 },
				{ productVersionId: byCode.parecer_ia.version_id, code: "parecer_ia", costCents: 150, priceCents: 400 },
			],
			totalCostCents: 450,
			totalPriceCents: 1400,
		});
		// Outro produto main sem item no Bureau não está à venda.
		expect(await quoteOrder(buyerAdmin, "consulta_pj", { withAi: false })).toEqual({
			ok: false,
			reason: "product_not_for_sale",
		});
	});
});
