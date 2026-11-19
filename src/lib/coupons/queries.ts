// Cupons do Bureau (CRUD do admin). RLS: só o bureau_admin lê e escreve em coupons e coupon_products.
// A permissão `coupons:*` é checada na action. O desconto no pedido é decidido no SQL (reserve_order), não aqui.
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import type { CouponCreate, CouponUpdate } from "@/lib/validators/coupons";

export type CouponConflict = "code_taken" | "product_not_found" | "invalid_period" | "not_found";
export type CouponWrite = { ok: true; id: string } | { ok: false; reason: CouponConflict };

export type CouponRow = {
	id: string;
	code: string;
	kind: "percent" | "fixed";
	value: string;
	allProducts: boolean;
	productCodes: string[];
	maxUses: number | null;
	maxUsesPerClient: number | null;
	// Usos que contam contra o limite: reservados ou consumidos.
	uses: number;
	validFrom: Date;
	validUntil: Date | null;
	active: boolean;
	createdAt: Date;
};

type PgError = { code?: string; constraint?: string };

function requireBureau(identity: DbIdentity): string {
	if (!identity.bureauId) throw new Error("Identidade sem Bureau.");
	return identity.bureauId;
}

// Falha que desfaz a transação inteira e vira conflito de negócio em `attempt`.
class CouponFailure extends Error {
	constructor(readonly reason: CouponConflict) {
		super(reason);
	}
}

// Falha de unicidade ou de período do SQL vira conflito de negócio; o resto sobe e desfaz a transação.
async function attempt(work: () => Promise<CouponWrite>): Promise<CouponWrite> {
	try {
		return await work();
	} catch (error) {
		if (error instanceof CouponFailure) return { ok: false, reason: error.reason };
		const pg = error as PgError;
		if (pg.code === "23505" && pg.constraint === "coupons_bureau_code_key") return { ok: false, reason: "code_taken" };
		if (pg.code === "23514" && pg.constraint === "coupons_validity") return { ok: false, reason: "invalid_period" };
		throw error;
	}
}

// coupon_products só vale com all_products falso: com a flag ligada as linhas somem.
async function replaceProducts(
	client: PoolClient,
	bureauId: string,
	couponId: string,
	input: { allProducts: boolean; productCodes: string[] },
): Promise<string[] | null> {
	await client.query("delete from coupon_products where coupon_id = $1 and bureau_id = $2", [couponId, bureauId]);
	if (input.allProducts) return [];
	const codes = Array.from(new Set(input.productCodes));
	const { rows } = await client.query<{ id: string; code: string }>(
		"select id, code from products where code = any($1::text[])",
		[codes],
	);
	if (rows.length !== codes.length) return null;
	await client.query(
		"insert into coupon_products (coupon_id, bureau_id, product_id) select $1, $2, unnest($3::uuid[])",
		[couponId, bureauId, rows.map((r) => r.id)],
	);
	return codes;
}

export async function createCoupon(identity: DbIdentity, input: CouponCreate): Promise<CouponWrite> {
	const bureauId = requireBureau(identity);
	return attempt(() =>
		withUserTransaction(identity, async (client): Promise<CouponWrite> => {
			const { rows } = await client.query<{ id: string }>(
				`insert into coupons
           (bureau_id, code, kind, value, all_products, max_uses, max_uses_per_client, valid_from, valid_until, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()), $9, $10)
         returning id`,
				[
					bureauId,
					input.code,
					input.kind,
					input.value,
					input.allProducts,
					input.maxUses,
					input.maxUsesPerClient,
					input.validFrom,
					input.validUntil,
					identity.userId,
				],
			);
			const id = rows[0].id;
			const products = await replaceProducts(client, bureauId, id, input);
			if (!products) throw new CouponFailure("product_not_found");
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "coupon.create",
				targetTable: "coupons",
				targetId: id,
				metadata: await auditSnapshot(client, bureauId, id),
			});
			return { ok: true, id };
		}),
	);
}

export async function updateCoupon(identity: DbIdentity, input: CouponUpdate): Promise<CouponWrite> {
	const bureauId = requireBureau(identity);
	return attempt(() =>
			withUserTransaction(identity, async (client): Promise<CouponWrite> => {
				const before = await auditSnapshot(client, bureauId, input.id, true);
				if (!before) throw new CouponFailure("not_found");
				await client.query(
					`update coupons set code = $3, kind = $4, value = $5, all_products = $6, max_uses = $7,
             max_uses_per_client = $8, valid_from = coalesce($9::timestamptz, valid_from), valid_until = $10
           where id = $1 and bureau_id = $2`,
					[
						input.id,
						bureauId,
						input.code,
						input.kind,
						input.value,
						input.allProducts,
						input.maxUses,
						input.maxUsesPerClient,
						input.validFrom,
						input.validUntil,
					],
				);
				const products = await replaceProducts(client, bureauId, input.id, input);
				if (!products) throw new CouponFailure("product_not_found");
				await writeAuditEvent(client, {
					actorId: identity.userId,
					action: "coupon.update",
					targetTable: "coupons",
					targetId: input.id,
					metadata: { before, after: await auditSnapshot(client, bureauId, input.id) },
				});
				return { ok: true, id: input.id };
			}),
	);
}

export async function setCouponActive(
	identity: DbIdentity,
	input: { id: string; active: boolean },
): Promise<{ ok: true } | { ok: false; reason: "not_found" }> {
	const bureauId = requireBureau(identity);
	return withUserTransaction(identity, async (client) => {
		const { rowCount } = await client.query(
			"update coupons set active = $3 where id = $1 and bureau_id = $2",
			[input.id, bureauId, input.active],
		);
		if (rowCount === 0) return { ok: false as const, reason: "not_found" as const };
		await writeAuditEvent(client, {
			actorId: identity.userId,
			action: input.active ? "coupon.activate" : "coupon.deactivate",
			targetTable: "coupons",
			targetId: input.id,
			metadata: { active: input.active },
		});
		return { ok: true as const };
	});
}

export async function listCoupons(identity: DbIdentity): Promise<CouponRow[]> {
	const bureauId = requireBureau(identity);
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query<{
			id: string;
			code: string;
			kind: "percent" | "fixed";
			value: string;
			all_products: boolean;
			product_codes: string[];
			max_uses: number | null;
			max_uses_per_client: number | null;
			uses: number;
			valid_from: Date;
			valid_until: Date | null;
			active: boolean;
			created_at: Date;
		}>(
			`select c.id, c.code, c.kind, c.value, c.all_products, c.max_uses, c.max_uses_per_client,
              c.valid_from, c.valid_until, c.active, c.created_at,
              coalesce((select array_agg(p.code order by p.code)
                          from coupon_products cp join products p on p.id = cp.product_id
                         where cp.coupon_id = c.id), '{}') as product_codes,
              (select count(*)::int from coupon_redemptions r
                where r.coupon_id = c.id and r.status in ('reserved', 'consumed')) as uses
         from coupons c
        where c.bureau_id = $1
        order by c.created_at desc, c.id`,
			[bureauId],
		);
		return rows.map((r) => ({
			id: r.id,
			code: r.code,
			kind: r.kind,
			value: r.value,
			allProducts: r.all_products,
			productCodes: r.product_codes,
			maxUses: r.max_uses,
			maxUsesPerClient: r.max_uses_per_client,
			uses: r.uses,
			validFrom: r.valid_from,
			validUntil: r.valid_until,
			active: r.active,
			createdAt: r.created_at,
		}));
	});
}

export type CouponPreviewRow = {
	couponId: string;
	kind: "percent" | "fixed";
	// Mesma unidade da coluna: percentual (33.33) ou reais.
	value: number;
	eligibleProductCodes: string[];
};

// O cliente não lê nenhuma tabela de cupom: coupon_preview (security definer) responde só para o cliente da sessão.
// Zero linhas para qualquer caso inválido (código, Bureau, vigência, limites); lista vazia = produto não aceito.
// Nunca grava nada. Devolve null nos dois casos: quem chama não distingue o motivo.
export async function previewCoupon(
	client: PoolClient,
	code: string,
	productCodes: string[],
): Promise<CouponPreviewRow | null> {
	const { rows } = await client.query<{
		coupon_id: string;
		kind: "percent" | "fixed";
		value: string;
		eligible_product_codes: string[];
	}>("select coupon_id, kind, value, eligible_product_codes from coupon_preview($1, $2::text[])", [code, productCodes]);
	const row = rows[0];
	if (!row || row.eligible_product_codes.length === 0) return null;
	return {
		couponId: row.coupon_id,
		kind: row.kind,
		value: Number(row.value),
		eligibleProductCodes: row.eligible_product_codes,
	};
}

// Estado do cupom para a auditoria (antes e depois de uma alteração). Sem dado pessoal: o código é do Bureau, não do cliente.
// Com `lock` trava a linha e devolve null se ela não existe; sem `lock` a linha existe (a transação a acabou de gravar).
async function auditSnapshot(client: PoolClient, bureauId: string, id: string, lock: true): Promise<Record<string, unknown> | null>;
async function auditSnapshot(client: PoolClient, bureauId: string, id: string): Promise<Record<string, unknown>>;
async function auditSnapshot(client: PoolClient, bureauId: string, id: string, lock = false) {
	const { rows } = await client.query<{ snapshot: Record<string, unknown> }>(
		`select jsonb_build_object(
		          'code', c.code, 'kind', c.kind, 'value', c.value::text, 'all_products', c.all_products,
		          'products', coalesce((select jsonb_agg(p.code order by p.code)
		                                  from coupon_products cp join products p on p.id = cp.product_id
		                                 where cp.coupon_id = c.id), '[]'::jsonb),
		          'max_uses', c.max_uses, 'max_uses_per_client', c.max_uses_per_client,
		          'valid_from', c.valid_from, 'valid_until', c.valid_until) as snapshot
		   from coupons c where c.id = $1 and c.bureau_id = $2 ${lock ? "for update of c" : ""}`,
		[id, bureauId],
	);
	if (rows.length === 0 && !lock) throw new Error("Cupom sumiu durante a transação.");
	return rows[0]?.snapshot ?? null;
}
