// Comissão do Bureau e bloqueio de produto (055). Só o superadmin fora de suporte escreve; a equipe do Bureau lê
// a própria % e os próprios bloqueios (RLS de bureau_commission_rates e bureau_product_blocks).
import type { PoolClient } from "pg";

import { writeAuditEvent } from "@/lib/audit/write";
import { platformWriteIdentity, withUserTransaction, type DbIdentity } from "@/lib/db/transaction";

const HISTORY_LIMIT = 20;

// A soma da % do Bureau com a % de afiliados não pode passar de 100 (a comissão do afiliado sai da parte da plataforma).
export class SplitOver100Error extends Error {
	constructor() {
		super("bureau commission + affiliate pct above 100");
	}
}

// Serializa os escritores da soma bureau% + afiliados% (override, % de afiliados, % global): toma o lock antes de ler
// e de escrever, para duas escritas concorrentes não passarem juntas de 100. Solta no commit ou rollback.
export async function lockCommissionSplit(client: PoolClient): Promise<void> {
	await client.query("select pg_advisory_xact_lock(hashtextextended('commission_split', 0))");
}

// Roda dentro da transação da escrita, depois de lockCommissionSplit: achou um Bureau acima de 100, lança e desfaz tudo. `bureauId` nulo olha todos
// (mudança da % global). Sem linha em bureau_affiliate_settings a % de afiliados é 0.
export async function assertSplitWithin100(client: PoolClient, bureauId: string | null): Promise<void> {
	const { rowCount } = await client.query(
		`select 1
       from bureaus b
       left join bureau_affiliate_settings s on s.bureau_id = b.id
      where ($1::uuid is null or b.id = $1)
        and coalesce(
              (select r.pct from bureau_commission_rates r where r.bureau_id = b.id order by r.id desc limit 1),
              (select (g.value #>> '{}')::numeric from settings g
                where g.key = 'bureau_commission_pct' and jsonb_typeof(g.value) = 'number'),
              0) + coalesce(s.default_pct, 0) > 100
      limit 1`,
		[bureauId],
	);
	if (rowCount) throw new SplitOver100Error();
}

type PgError = { code?: string };

export type CommissionWriteResult = { ok: true } | { ok: false; reason: "not_found" | "split_over_100" };

function toFailure(error: unknown): CommissionWriteResult {
	if (error instanceof SplitOver100Error) return { ok: false, reason: "split_over_100" };
	// Bureau ou produto inexistente (chave estrangeira).
	if ((error as PgError).code === "23503") return { ok: false, reason: "not_found" };
	throw error;
}

// Nova linha em bureau_commission_rates (override vigente). pct nulo volta à % global.
export async function setBureauCommissionOverride(
	identity: DbIdentity,
	bureauId: string,
	pct: number | null,
): Promise<CommissionWriteResult> {
	try {
		return await withUserTransaction(platformWriteIdentity(identity), async (client) => {
			await lockCommissionSplit(client);
			const previous = await client.query<{ pct: string | null }>(
				"select pct from bureau_commission_rates where bureau_id = $1 order by id desc limit 1",
				[bureauId],
			);
			await client.query(
				"insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, $2, $3)",
				[bureauId, pct, identity.userId],
			);
			await assertSplitWithin100(client, bureauId);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				bureauId,
				action: "commission.bureau_set",
				targetTable: "bureaus",
				targetId: bureauId,
				metadata: {
					bureau_id: bureauId,
					from: previous.rows[0]?.pct == null ? null : Number(previous.rows[0].pct),
					to: pct,
				},
			});
			return { ok: true as const };
		});
	} catch (error) {
		return toFailure(error);
	}
}

// Nova linha em bureau_product_blocks. blocked = false desfaz o bloqueio e mantém o histórico.
export async function setProductBlock(
	identity: DbIdentity,
	bureauId: string,
	productId: string,
	blocked: boolean,
): Promise<CommissionWriteResult> {
	try {
		return await withUserTransaction(platformWriteIdentity(identity), async (client) => {
			await client.query(
				"insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by) values ($1, $2, $3, $4)",
				[bureauId, productId, blocked, identity.userId],
			);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				bureauId,
				action: "catalog.block_set",
				targetTable: "products",
				targetId: productId,
				metadata: { bureau_id: bureauId, product_id: productId, blocked },
			});
			return { ok: true as const };
		});
	} catch (error) {
		return toFailure(error);
	}
}

export type CommissionRateRow = { id: string; pct: string | null; setBy: string; createdAt: Date };

// Histórico do override (mais novo primeiro). O primeiro é o vigente.
export async function listBureauCommissionRates(identity: DbIdentity, bureauId: string): Promise<CommissionRateRow[]> {
	const { rows } = await withUserTransaction(identity, (client) =>
		client.query<{ id: string; pct: string | null; set_by: string; created_at: Date }>(
			`select id, pct, set_by, created_at from bureau_commission_rates
        where bureau_id = $1 order by id desc limit ${HISTORY_LIMIT}`,
			[bureauId],
		),
	);
	return rows.map((r) => ({ id: r.id, pct: r.pct, setBy: r.set_by, createdAt: r.created_at }));
}

export type ProductBlockRow = {
	productId: string;
	code: string;
	name: string;
	productActive: boolean;
	blocked: boolean;
	history: { id: string; blocked: boolean; setBy: string; createdAt: Date }[];
};

// Todos os produtos com o estado de bloqueio vigente no Bureau e o histórico (mais novo primeiro).
export async function listBureauProductBlocks(identity: DbIdentity, bureauId: string): Promise<ProductBlockRow[]> {
	return withUserTransaction(identity, async (client) => {
		const products = await client.query<{ id: string; code: string; name: string; active: boolean }>(
			"select id, code, name, active from products order by name",
		);
		const history = await client.query<{
			id: string; // bigint volta como string do pg
			product_id: string;
			blocked: boolean;
			set_by: string;
			created_at: Date;
		}>(
			`select id, product_id, blocked, set_by, created_at from (
         select b.*, row_number() over (partition by product_id order by id desc) as rn
           from bureau_product_blocks b where bureau_id = $1) h
        where rn <= ${HISTORY_LIMIT} order by id desc`,
			[bureauId],
		);
		return products.rows.map((p) => {
			const rows = history.rows
				.filter((h) => h.product_id === p.id)
				.map((h) => ({ id: h.id, blocked: h.blocked, setBy: h.set_by, createdAt: h.created_at }));
			return {
				productId: p.id,
				code: p.code,
				name: p.name,
				productActive: p.active,
				blocked: rows[0]?.blocked ?? false,
				history: rows,
			};
		});
	});
}
