// Catálogo e preços (048). Produto, versão e preço de venda: só o superadmin. O Bureau lê o catálogo à venda e a
// sua comissão. A permissão `catalog:*` é checada na action; aqui o RLS e as triggers barram o resto.
import { writeAuditEvent } from "@/lib/audit/write";
import {
	platformIdentity,
	withUserTransaction,
	type DbIdentity,
} from "@/lib/db/transaction";
import type { ProductCreate } from "@/lib/validators/catalog";

import { isPriceSellable, toCents } from "./money";

export type CatalogConflict =
	| "price_below_cost"
	| "partner_price_below_cost"
	| "per_partner_not_allowed";

// Só o Dossiê Empresarial cobra por sócio (a trigger product_versions_sale_guard, 048, repete a regra).
const NO_PARTNER_PRICE_CODE = "dossie_pf";

export type ProductSummary = {
	id: string;
	code: string;
	name: string;
	active: boolean;
	versionId: string;
	version: number;
	depsProduct: string | null;
	baseCost: string;
	baseCostPerPartner: string;
	// Nulo = última versão sem preço: o produto não está à venda.
	salePrice: string | null;
	salePricePerPartner: string;
};

export type ProductVersionRow = {
	id: string;
	version: number;
	depsProduct: string | null;
	baseCost: string;
	baseCostPerPartner: string;
	salePrice: string | null;
	salePricePerPartner: string;
	createdAt: Date;
};

// Produto à venda para o Bureau da identidade: ativo, com preço na última versão e não bloqueado.
export type CatalogEntry = {
	productId: string;
	productVersionId: string;
	code: string;
	name: string;
	salePrice: string;
	salePricePerPartner: string;
};

export type EffectiveCommission = {
	// Decimal em string ("20.00"); nulo = nenhuma % definida (nem override nem global).
	pct: string | null;
	source: "override" | "global" | "none";
};

const TRIGGER_REASONS: Record<string, CatalogConflict> = {
	"catalog: per-partner price only for dossie_empresarial": "per_partner_not_allowed",
};

type PgError = { code?: string; constraint?: string; message?: string };

// Falha fechada do SQL (corrida entre a validação e a trigger) vira conflito de negócio.
export function triggerConflict(error: unknown): CatalogConflict | null {
	const pg = error as PgError;
	return pg.code === "23514"
		? (TRIGGER_REASONS[pg.message ?? ""] ?? null)
		: null;
}

type PriceInput = {
	baseCost: string;
	baseCostPerPartner: string;
	salePrice: string | null;
	salePricePerPartner: string;
};

// Regras do preço de venda da versão: dossie_pf sem preço por sócio; preço >= custo (por campo). Sem preço = sem checagem.
function priceConflict(code: string, input: PriceInput): CatalogConflict | null {
	const perPartner = toCents(input.salePricePerPartner);
	if (code === NO_PARTNER_PRICE_CODE && perPartner !== 0) return "per_partner_not_allowed";
	if (input.salePrice === null) return null;
	if (!isPriceSellable(toCents(input.salePrice), toCents(input.baseCost))) return "price_below_cost";
	if (!isPriceSellable(perPartner, toCents(input.baseCostPerPartner))) return "partner_price_below_cost";
	return null;
}

export async function createProduct(
	identity: DbIdentity,
	input: ProductCreate,
): Promise<
	| { ok: true; id: string; versionId: string }
	| { ok: false; reason: "code_taken" | CatalogConflict }
> {
	const conflict = priceConflict(input.code, input);
	if (conflict) return { ok: false, reason: conflict };
	try {
		return await withUserTransaction(
			platformIdentity(identity),
			async (client) => {
				const product = await client.query<{ id: string }>(
					"insert into products (code, name) values ($1, $2) returning id",
					[input.code, input.name],
				);
				const id = product.rows[0].id;
				const version = await client.query<{ id: string }>(
					`insert into product_versions (product_id, version, deps_product, base_cost, base_cost_per_partner, sale_price, sale_price_per_partner, created_by)
         values ($1, 1, $2, $3, $4, $5, $6, $7) returning id`,
					[
						id,
						input.depsProduct,
						input.baseCost,
						input.baseCostPerPartner,
						input.salePrice,
						input.salePricePerPartner,
						identity.userId,
					],
				);
				await writeAuditEvent(client, {
					actorId: identity.userId,
					action: "catalog.product.create",
					targetTable: "products",
					targetId: id,
					metadata: {
						code: input.code,
						base_cost: input.baseCost,
						base_cost_per_partner: input.baseCostPerPartner,
						sale_price: input.salePrice,
						sale_price_per_partner: input.salePricePerPartner,
					},
				});
				return { ok: true as const, id, versionId: version.rows[0].id };
			},
		);
	} catch (error) {
		const pg = error as PgError;
		if (pg.code === "23505" && pg.constraint === "products_code_key") {
			return { ok: false, reason: "code_taken" };
		}
		const reason = triggerConflict(error);
		if (reason) return { ok: false, reason };
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
		await client.query(
			"update products set name = $2, active = $3 where id = $1",
			[input.id, input.name, input.active],
		);
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
	input: PriceInput & { productId: string; depsProduct: string | null },
): Promise<
	| { ok: true; versionId: string; version: number }
	| { ok: false; reason: "not_found" | CatalogConflict }
> {
	try {
		return await withUserTransaction(platformIdentity(identity), async (client) => {
			// A trava no produto serializa a numeração das versões.
			const locked = await client.query<{ code: string }>(
				"select code from products where id = $1 for update",
				[input.productId],
			);
			if (!locked.rows[0])
				return { ok: false as const, reason: "not_found" as const };
			const conflict = priceConflict(locked.rows[0].code, input);
			if (conflict) return { ok: false as const, reason: conflict };
			const previous = await client.query<{
				deps_product: string | null;
				sale_price: string | null;
				sale_price_per_partner: string;
			}>(
				`select deps_product, sale_price, sale_price_per_partner
           from product_versions where product_id = $1 order by version desc limit 1`,
				[input.productId],
			);
			const { rows } = await client.query<{ id: string; version: number }>(
				`insert into product_versions (product_id, version, deps_product, base_cost, base_cost_per_partner, sale_price, sale_price_per_partner, created_by)
         select $1, coalesce(max(version), 0) + 1, $2, $3, $4, $5, $6, $7
           from product_versions where product_id = $1
         returning id, version`,
				[
					input.productId,
					input.depsProduct,
					input.baseCost,
					input.baseCostPerPartner,
					input.salePrice,
					input.salePricePerPartner,
					identity.userId,
				],
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
					base_cost_per_partner: input.baseCostPerPartner,
					old_sale_price: previous.rows[0]?.sale_price ?? null,
					sale_price: input.salePrice,
					old_sale_price_per_partner: previous.rows[0]?.sale_price_per_partner ?? null,
					sale_price_per_partner: input.salePricePerPartner,
				},
			});
			return {
				ok: true as const,
				versionId: rows[0].id,
				version: rows[0].version,
			};
		});
	} catch (error) {
		const reason = triggerConflict(error);
		if (reason) return { ok: false, reason };
		throw error;
	}
}

type ProductRow = {
	id: string;
	code: string;
	name: string;
	active: boolean;
	version_id: string;
	version: number;
	deps_product: string | null;
	base_cost: string;
	base_cost_per_partner: string;
	sale_price: string | null;
	sale_price_per_partner: string;
};

// Lista todos os produtos (ativos e inativos) com a versão vigente.
export async function listProducts(
	identity: DbIdentity,
): Promise<ProductSummary[]> {
	return withUserTransaction(platformIdentity(identity), async (client) => {
		const { rows } = await client.query<ProductRow>(
			`select p.id, p.code, p.name, p.active,
              v.id as version_id, v.version, v.deps_product, v.base_cost, v.base_cost_per_partner,
              v.sale_price, v.sale_price_per_partner
         from products p
         join lateral (select * from product_versions where product_id = p.id
                        order by version desc limit 1) v on true
        order by p.name`,
		);
		return rows.map((r) => ({
			id: r.id,
			code: r.code,
			name: r.name,
			active: r.active,
			versionId: r.version_id,
			version: r.version,
			depsProduct: r.deps_product,
			baseCost: r.base_cost,
			baseCostPerPartner: r.base_cost_per_partner,
			salePrice: r.sale_price,
			salePricePerPartner: r.sale_price_per_partner,
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
			base_cost_per_partner: string;
			sale_price: string | null;
			sale_price_per_partner: string;
			created_at: Date;
		}>(
			`select id, version, deps_product, base_cost, base_cost_per_partner, sale_price, sale_price_per_partner, created_at
         from product_versions where product_id = $1 order by version desc`,
			[productId],
		);
		return rows.map((r) => ({
			id: r.id,
			version: r.version,
			depsProduct: r.deps_product,
			baseCost: r.base_cost,
			baseCostPerPartner: r.base_cost_per_partner,
			salePrice: r.sale_price,
			salePricePerPartner: r.sale_price_per_partner,
			createdAt: r.created_at,
		}));
	});
}

// Produtos à venda para o Bureau da identidade: ativos, com preço na última versão e não bloqueados pelo superadmin.
export async function listCatalog(
	identity: DbIdentity,
): Promise<CatalogEntry[]> {
	if (!identity.bureauId) return [];
	const bureauId = identity.bureauId;
	const { rows } = await withUserTransaction(identity, (client) =>
		client.query<CatalogEntry>(
			`select p.id as "productId", c.product_version_id as "productVersionId", p.code, p.name,
              c.sale_price as "salePrice", c.sale_price_per_partner as "salePricePerPartner"
         from products p
         cross join lateral current_product_price(p.id) c
        where p.active and not product_blocked_for_bureau($1, p.id)
        order by p.name`,
			[bureauId],
		),
	);
	return rows;
}

// % efetiva do Bureau: o override mais recente (nulo = global) ou a % global. Lê as tabelas sob RLS (a função
// resolve_bureau_commission_pct não tem grant a app_runtime). Superadmin fora de suporte e a equipe do Bureau leem.
export async function getEffectiveCommission(
	identity: DbIdentity,
	bureauId: string | null,
): Promise<EffectiveCommission> {
	if (!bureauId) return { pct: null, source: "none" };
	return withUserTransaction(identity, async (client) => {
		const override = await client.query<{ pct: string | null }>(
			"select pct from bureau_commission_rates where bureau_id = $1 order by id desc limit 1",
			[bureauId],
		);
		if (override.rows[0]?.pct != null) return { pct: override.rows[0].pct, source: "override" as const };
		const global = await client.query<{ pct: string }>(
			`select value #>> '{}' as pct from settings
        where key = 'bureau_commission_pct' and jsonb_typeof(value) = 'number'`,
		);
		return global.rows[0]
			? { pct: Number(global.rows[0].pct).toFixed(2), source: "global" as const }
			: { pct: null, source: "none" as const };
	});
}

// "20.00" -> 2000 (centésimos de %): a mesma escala de commissionCents.
export function pctToHundredths(pct: string): number {
	return Math.round(Number(pct) * 100);
}
