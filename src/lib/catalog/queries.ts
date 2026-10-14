// Catálogo e preços (M2). Produtos e custos: superadmin. Itens de catálogo: bureau_admin.
// A permissão `catalog:*` é checada na action; aqui o RLS e a trigger de 010_catalog.sql barram o resto.
import { writeAuditEvent } from "@/lib/audit/write";
import { platformIdentity, withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { ProductCreate } from "@/lib/validators/catalog";

import { fromCents, isPriceSellable, toCents } from "./money";

export type CatalogConflict =
	| "price_below_cost"
	| "cost_not_set"
	| "addon_requires_main"
	| "product_inactive";

export type ProductKind = "main" | "addon";

export type ProductSummary = {
	id: string;
	code: string;
	name: string;
	kind: ProductKind;
	addonFor: string[] | null;
	active: boolean;
	versionId: string;
	version: number;
	depsProduct: string | null;
	baseCost: string;
};

export type ProductVersionRow = {
	id: string;
	version: number;
	depsProduct: string | null;
	baseCost: string;
	createdAt: Date;
};

export type BureauCostRow = {
	productId: string;
	code: string;
	name: string;
	kind: ProductKind;
	productActive: boolean;
	productVersionId: string;
	effectiveCost: string;
	source: "override" | "default";
	history: { id: number; cost: string; setBy: string; createdAt: Date }[];
};

export type CatalogEntry = {
	productId: string;
	productVersionId: string;
	code: string;
	name: string;
	kind: ProductKind;
	addonFor: string[] | null;
	effectiveCost: string;
	item: { active: boolean; salePrice: string } | null;
	// Regra de preço: custo efetivo > 0 e preço >= custo. Falso com item = "Preço abaixo do custo".
	sellable: boolean;
	// À venda: item ativo, sellable e, para adicional, algum produto main compatível à venda.
	onSale: boolean;
};

const COST_HISTORY_LIMIT = 20;

const TRIGGER_REASONS: Record<string, CatalogConflict> = {
	"catalog: sale price below effective cost": "price_below_cost",
	"catalog: addon needs an active compatible main product": "addon_requires_main",
	"catalog: product is inactive": "product_inactive",
	"catalog: cost not set": "cost_not_set",
};

type PgError = { code?: string; constraint?: string; message?: string };

// Falha fechada do SQL (corrida entre a validação e a trigger) vira conflito de negócio.
function triggerConflict(error: unknown): CatalogConflict | null {
	const pg = error as PgError;
	return pg.code === "23514" ? (TRIGGER_REASONS[pg.message ?? ""] ?? null) : null;
}

function requireBureau(identity: DbIdentity): string {
	if (!identity.bureauId) throw new Error("Identidade sem Bureau.");
	return identity.bureauId;
}

export async function createProduct(
	identity: DbIdentity,
	input: ProductCreate,
): Promise<
	{ ok: true; id: string; versionId: string } | { ok: false; reason: "code_taken" | "addon_for_unknown" }
> {
	try {
		return await withUserTransaction(platformIdentity(identity), async (client) => {
			if (input.kind === "addon") {
				const mains = await client.query<{ code: string }>(
					"select code from products where kind = 'main' and code = any ($1)",
					[input.addonFor],
				);
				if (new Set(input.addonFor).size !== mains.rowCount) {
					return { ok: false as const, reason: "addon_for_unknown" as const };
				}
			}
			const product = await client.query<{ id: string }>(
				"insert into products (code, name, kind, addon_for) values ($1, $2, $3, $4) returning id",
				[input.code, input.name, input.kind, input.kind === "addon" ? input.addonFor : null],
			);
			const id = product.rows[0].id;
			const version = await client.query<{ id: string }>(
				`insert into product_versions (product_id, version, deps_product, base_cost, created_by)
         values ($1, 1, $2, $3, $4) returning id`,
				[id, input.depsProduct, input.baseCost, identity.userId],
			);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "catalog.product.create",
				targetTable: "products",
				targetId: id,
				metadata: { code: input.code, kind: input.kind, base_cost: input.baseCost },
			});
			return { ok: true as const, id, versionId: version.rows[0].id };
		});
	} catch (error) {
		const pg = error as PgError;
		if (pg.code === "23505" && pg.constraint === "products_code_key") {
			return { ok: false, reason: "code_taken" };
		}
		throw error;
	}
}

export async function updateProduct(
	identity: DbIdentity,
	input: { id: string; name: string; active: boolean },
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
	return withUserTransaction(platformIdentity(identity), async (client) => {
		const { rows } = await client.query<{ name: string; active: boolean }>(
			"select name, active from products where id = $1 for update",
			[input.id],
		);
		if (!rows[0]) return { ok: false as const, reason: "not_found" as const };
		await client.query("update products set name = $2, active = $3 where id = $1", [
			input.id,
			input.name,
			input.active,
		]);
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "catalog.product.update",
			targetTable: "products",
			targetId: input.id,
			metadata: {
				old_name: rows[0].name,
				name: input.name,
				old_active: rows[0].active,
				active: input.active,
			},
		});
		return { ok: true as const };
	});
}

export async function createProductVersion(
	identity: DbIdentity,
	input: { productId: string; depsProduct: string | null; baseCost: string },
): Promise<
	{ ok: true; versionId: string; version: number } | { ok: false; reason: "not_found" }
> {
	return withUserTransaction(platformIdentity(identity), async (client) => {
		// A trava no produto serializa a numeração das versões.
		const locked = await client.query(
			"select 1 from products where id = $1 for update",
			[input.productId],
		);
		if (!locked.rowCount) return { ok: false as const, reason: "not_found" as const };
		const previous = await client.query<{ deps_product: string | null }>(
			"select deps_product from product_versions where product_id = $1 order by version desc limit 1",
			[input.productId],
		);
		const { rows } = await client.query<{ id: string; version: number }>(
			`insert into product_versions (product_id, version, deps_product, base_cost, created_by)
       select $1, coalesce(max(version), 0) + 1, $2, $3, $4
         from product_versions where product_id = $1
       returning id, version`,
			[input.productId, input.depsProduct, input.baseCost, identity.userId],
		);
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: "catalog.product.version",
			targetTable: "product_versions",
			targetId: rows[0].id,
			metadata: {
				product_id: input.productId,
				version: rows[0].version,
				old_deps_product: previous.rows[0]?.deps_product ?? null,
				deps_product: input.depsProduct,
				base_cost: input.baseCost,
			},
		});
		return { ok: true as const, versionId: rows[0].id, version: rows[0].version };
	});
}

type ProductRow = {
	id: string;
	code: string;
	name: string;
	kind: ProductKind;
	addon_for: string[] | null;
	active: boolean;
	version_id: string;
	version: number;
	deps_product: string | null;
	base_cost: string;
};

// Lista todos os produtos (ativos e inativos) com a versão vigente.
export async function listProducts(identity: DbIdentity): Promise<ProductSummary[]> {
	return withUserTransaction(platformIdentity(identity), async (client) => {
		const { rows } = await client.query<ProductRow>(
			`select p.id, p.code, p.name, p.kind, p.addon_for, p.active,
              v.id as version_id, v.version, v.deps_product, v.base_cost
         from products p
         join lateral (select * from product_versions where product_id = p.id
                        order by version desc limit 1) v on true
        order by p.kind, p.name`,
		);
		return rows.map((r) => ({
			id: r.id,
			code: r.code,
			name: r.name,
			kind: r.kind,
			addonFor: r.addon_for,
			active: r.active,
			versionId: r.version_id,
			version: r.version,
			depsProduct: r.deps_product,
			baseCost: r.base_cost,
		}));
	});
}

export async function listProductVersions(
	identity: DbIdentity,
	productId: string,
): Promise<ProductVersionRow[]> {
	return withUserTransaction(platformIdentity(identity), async (client) => {
		const { rows } = await client.query<{
			id: string;
			version: number;
			deps_product: string | null;
			base_cost: string;
			created_at: Date;
		}>(
			`select id, version, deps_product, base_cost, created_at
         from product_versions where product_id = $1 order by version desc`,
			[productId],
		);
		return rows.map((r) => ({
			id: r.id,
			version: r.version,
			depsProduct: r.deps_product,
			baseCost: r.base_cost,
			createdAt: r.created_at,
		}));
	});
}

// Nova linha em bureau_product_costs (override vigente). Não altera nenhum preço de venda.
export async function setBureauProductCost(
	identity: DbIdentity,
	bureauId: string,
	productId: string,
	cost: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
	try {
		return await withUserTransaction(platformIdentity(identity), async (client) => {
			const previous = await client.query<{ effective_cost: string }>(
				"select effective_cost from resolve_product_terms($1, $2)",
				[bureauId, productId],
			);
			if (!previous.rows[0]) return { ok: false as const, reason: "not_found" as const };
			await client.query(
				"insert into bureau_product_costs (bureau_id, product_id, cost, set_by) values ($1, $2, $3, $4)",
				[bureauId, productId, cost, identity.userId],
			);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				bureauId,
				action: "catalog.cost.set",
				targetTable: "products",
				targetId: productId,
				metadata: { old_cost: previous.rows[0].effective_cost, new_cost: cost },
			});
			return { ok: true as const };
		});
	} catch (error) {
		// Bureau inexistente.
		if ((error as PgError).code === "23503") return { ok: false, reason: "not_found" };
		throw error;
	}
}

export async function listBureauCosts(
	identity: DbIdentity,
	bureauId: string,
): Promise<BureauCostRow[]> {
	return withUserTransaction(platformIdentity(identity), async (client) => {
		const products = await client.query<{
			id: string;
			code: string;
			name: string;
			kind: ProductKind;
			active: boolean;
			product_version_id: string;
			effective_cost: string;
			override_cost: string | null;
		}>(
			`select p.id, p.code, p.name, p.kind, p.active, t.product_version_id, t.effective_cost,
              o.cost as override_cost
         from products p
         cross join lateral resolve_product_terms($1, p.id) t
         left join lateral (select cost from bureau_product_costs
                             where bureau_id = $1 and product_id = p.id
                             order by id desc limit 1) o on true
        order by p.kind, p.name`,
			[bureauId],
		);
		const history = await client.query<{
			id: number;
			product_id: string;
			cost: string;
			set_by: string;
			created_at: Date;
		}>(
			`select id, product_id, cost, set_by, created_at from (
         select c.*, row_number() over (partition by product_id order by id desc) as rn
           from bureau_product_costs c where bureau_id = $1) h
        where rn <= ${COST_HISTORY_LIMIT} order by id desc`,
			[bureauId],
		);
		return products.rows.map((p) => ({
			productId: p.id,
			code: p.code,
			name: p.name,
			kind: p.kind,
			productActive: p.active,
			productVersionId: p.product_version_id,
			effectiveCost: p.effective_cost,
			source: p.override_cost === null ? "default" : "override",
			history: history.rows
				.filter((h) => h.product_id === p.id)
				.map((h) => ({ id: h.id, cost: h.cost, setBy: h.set_by, createdAt: h.created_at })),
		}));
	});
}

type CatalogRow = {
	product_id: string;
	product_version_id: string;
	code: string;
	name: string;
	kind: ProductKind;
	addon_for: string[] | null;
	effective_cost: string;
	item_active: boolean | null;
	sale_price: string | null;
};

// Produtos ativos com o item do Bureau da identidade. Sem item: `item` nulo.
export async function listCatalog(identity: DbIdentity): Promise<CatalogEntry[]> {
	if (!identity.bureauId) return [];
	const bureauId = identity.bureauId;
	const rows = await withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<CatalogRow>(
			`select p.id as product_id, t.product_version_id, p.code, p.name, p.kind, p.addon_for,
              t.effective_cost, i.active as item_active, i.sale_price
         from products p
         cross join lateral resolve_product_terms($1, p.id) t
         left join bureau_catalog_items i on i.bureau_id = $1 and i.product_id = p.id
        where p.active
        order by p.kind, p.name`,
			[bureauId],
		);
		return rows;
	});

	const base = rows.map((r) => {
		const item = r.sale_price === null ? null : { active: r.item_active === true, salePrice: r.sale_price };
		const sellable =
			item !== null && isPriceSellable(toCents(item.salePrice), toCents(r.effective_cost));
		return { r, item, sellable, baseOnSale: sellable && item?.active === true };
	});
	const mainsOnSale = new Set(
		base.filter((b) => b.r.kind === "main" && b.baseOnSale).map((b) => b.r.code),
	);
	return base.map(({ r, item, sellable, baseOnSale }) => ({
		productId: r.product_id,
		productVersionId: r.product_version_id,
		code: r.code,
		name: r.name,
		kind: r.kind,
		addonFor: r.addon_for,
		effectiveCost: r.effective_cost,
		item,
		sellable,
		onSale: r.kind === "main" ? baseOnSale : baseOnSale && (r.addon_for ?? []).some((c) => mainsOnSale.has(c)),
	}));
}

export async function upsertCatalogItem(
	identity: DbIdentity,
	productId: string,
	input: { active: boolean; salePrice: string },
): Promise<{ ok: true } | { ok: false; reason: CatalogConflict | "not_found" }> {
	const bureauId = requireBureau(identity);
	try {
		return await withUserTransaction(identity, async (client) => {
			const product = (
				await client.query<{ kind: ProductKind; addon_for: string[] | null; active: boolean }>(
					"select kind, addon_for, active from products where id = $1",
					[productId],
				)
			).rows[0];
			const terms = (
				await client.query<{ effective_cost: string }>(
					"select effective_cost from resolve_product_terms($1, $2)",
					[bureauId, productId],
				)
			).rows[0];
			if (!product || !terms) return { ok: false as const, reason: "not_found" as const };
			const existing = (
				await client.query<{ active: boolean; sale_price: string }>(
					`select active, sale_price from bureau_catalog_items
            where bureau_id = $1 and product_id = $2 for update`,
					[bureauId, productId],
				)
			).rows[0];

			const priceCents = toCents(input.salePrice);
			const costCents = toCents(terms.effective_cost);
			// Como a trigger: desativar sem mudar o preço passa mesmo com o custo acima do preço.
			const needsChecks =
				!existing ||
				toCents(existing.sale_price) !== priceCents ||
				(input.active && !existing.active);
			if (needsChecks) {
				if (input.active && !product.active) return fail("product_inactive");
				if (input.active && costCents === 0) return fail("cost_not_set");
				if (priceCents < costCents) return fail("price_below_cost");
				if (input.active && product.kind === "addon") {
					const main = await client.query(
						`select 1 from bureau_catalog_items i
               join products p on p.id = i.product_id
              where i.bureau_id = $1 and i.active and p.active
                and p.kind = 'main' and p.code = any ($2)`,
						[bureauId, product.addon_for ?? []],
					);
					if (!main.rowCount) return fail("addon_requires_main");
				}
			}

			if (existing) {
				const updated = await client.query(
					`update bureau_catalog_items set active = $3, sale_price = $4, updated_by = $5
            where bureau_id = $1 and product_id = $2`,
					[bureauId, productId, input.active, input.salePrice, identity.userId],
				);
				// O RLS bloqueia o UPDATE sem erro (rowCount 0): não pode passar como sucesso.
				if (!updated.rowCount) throw new Error("Atualização do item de catálogo bloqueada.");
			} else {
				await client.query(
					`insert into bureau_catalog_items (bureau_id, product_id, active, sale_price, updated_by)
           values ($1, $2, $3, $4, $5)`,
					[bureauId, productId, input.active, input.salePrice, identity.userId],
				);
			}
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "catalog.item.upsert",
				targetTable: "bureau_catalog_items",
				targetId: productId,
				metadata: {
					old_price: existing?.sale_price ?? null,
					new_price: fromCents(priceCents),
					active: input.active,
				},
			});
			return { ok: true as const };
		});
	} catch (error) {
		const reason = triggerConflict(error);
		if (reason) return { ok: false, reason };
		throw error;
	}
}

function fail(reason: CatalogConflict) {
	return { ok: false as const, reason };
}
