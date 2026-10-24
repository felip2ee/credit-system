// Só para testes de integração. Grava via TEST_DATABASE_OWNER_URL (superusuário, ignora RLS).
import { randomBytes, randomInt, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

export type SeedIdentity = {
	userId: string;
	role: "bureau_admin" | "operator" | "client";
	bureauId: string;
};
export type SeedSuperadmin = {
	userId: string;
	role: "superadmin";
	bureauId: null;
};
export type SeededTenant = {
	bureau: { id: string; name: string; slug: string };
	bureauAdmin: SeedIdentity;
	operator: SeedIdentity;
	client: SeedIdentity;
	holder: { id: string; document: string }; // Titular PF ligado ao client
};

const ONE_HOUR_MS = 60 * 60 * 1000;

function randomDigits(length: number): string {
	return Array.from({ length }, () => randomInt(0, 10)).join("");
}

// CPF aleatório com máscara. A coluna document_digits remove a máscara.
export function randomCpf(): string {
	const d = randomDigits(11);
	return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

async function insertUserAndProfile(
	client: PoolClient,
	input: { label: string; role: string; bureauId: string | null },
): Promise<string> {
	const userId = randomUUID();
	const email = `${userId}@example.test`;
	const fullName = `${input.label} ${input.role}`;
	await client.query(
		'insert into "user" (id, name, email) values ($1, $2, $3)',
		[userId, fullName, email],
	);
	await client.query(
		`insert into profiles (id, auth_user_id, full_name, email, role, bureau_id)
     values ($1::uuid, $1::text, $2, $3, $4::user_role, $5)`,
		[userId, fullName, email, input.role, input.bureauId],
	);
	return userId;
}

export async function seedTenant(
	owner: Pool,
	label: string,
): Promise<SeededTenant> {
	const suffix = randomBytes(6).toString("hex");
	const name = `${label} ${suffix}`;
	const slug = `t-${suffix}`;
	const document = randomCpf();
	const client = await owner.connect();
	try {
		await client.query("begin");
		const { rows } = await client.query<{ id: string }>(
			"insert into bureaus (name, slug) values ($1, $2) returning id",
			[name, slug],
		);
		const bureauId = rows[0].id;
		const adminId = await insertUserAndProfile(client, {
			label: name,
			role: "bureau_admin",
			bureauId,
		});
		const operatorId = await insertUserAndProfile(client, {
			label: name,
			role: "operator",
			bureauId,
		});
		const clientId = await insertUserAndProfile(client, {
			label: name,
			role: "client",
			bureauId,
		});
		const holder = await client.query<{ id: string }>(
			`insert into holders (bureau_id, type, name, document, created_by, client_profile_id)
       values ($1, 'PF', $2, $3, $4, $5) returning id`,
			[bureauId, `Titular ${name}`, document, adminId, clientId],
		);
		await client.query("commit");
		return {
			bureau: { id: bureauId, name, slug },
			bureauAdmin: { userId: adminId, role: "bureau_admin", bureauId },
			operator: { userId: operatorId, role: "operator", bureauId },
			client: { userId: clientId, role: "client", bureauId },
			holder: { id: holder.rows[0].id, document },
		};
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

export async function seedSuperadmin(owner: Pool): Promise<SeedSuperadmin> {
	const client = await owner.connect();
	try {
		await client.query("begin");
		const userId = await insertUserAndProfile(client, {
			label: `superadmin ${randomBytes(4).toString("hex")}`,
			role: "superadmin",
			bureauId: null,
		});
		await client.query("commit");
		return { userId, role: "superadmin", bureauId: null };
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

export async function seedSupportSession(
	owner: Pool,
	input: {
		superadminId: string;
		bureauId: string;
		reason?: string;
		startedAt?: Date;
		expiresAt?: Date;
		endedAt?: Date | null;
	},
): Promise<string> {
	// app_support_active() compara com o now() do banco; a margem de 5 s absorve o desvio de relógio entre app e banco.
	const startedAt = input.startedAt ?? new Date(Date.now() - 5_000);
	const expiresAt =
		input.expiresAt ?? new Date(startedAt.getTime() + ONE_HOUR_MS);
	const { rows } = await owner.query<{ id: string }>(
		`insert into support_sessions (superadmin_id, bureau_id, reason, started_at, expires_at, ended_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
		[
			input.superadminId,
			input.bureauId,
			input.reason ?? "teste de isolamento",
			startedAt,
			expiresAt,
			input.endedAt ?? null,
		],
	);
	return rows[0].id;
}

// begin → set_config dos 4 GUCs (local) → work → rollback. Não depende de src/lib.
export async function withDbContext<T>(
	pool: Pool,
	ctx: {
		userId: string;
		role: string;
		bureauId: string | null;
		supportSessionId?: string | null;
	},
	work: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await pool.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true),
              set_config('app.user_role', $2, true),
              set_config('app.bureau_id', $3, true),
              set_config('app.support_session_id', $4, true)`,
			[ctx.userId, ctx.role, ctx.bureauId ?? "", ctx.supportSessionId ?? ""],
		);
		return await work(client);
	} finally {
		try {
			await client.query("rollback");
		} finally {
			client.release();
		}
	}
}

export type SeededProduct = { id: string; code: string; versionId: string };

// Produto novo com código único e versão 1. Evita depender do custo dos produtos do seed.
export async function seedProduct(
	owner: Pool,
	input: {
		code?: string;
		baseCost?: string;
		baseCostPerPartner?: string;
		depsProduct?: string | null;
	} = {},
): Promise<SeededProduct> {
	const code = input.code ?? `prod_${randomBytes(6).toString("hex")}`;
	const client = await owner.connect();
	try {
		await client.query("begin");
		const product = await client.query<{ id: string }>(
			`insert into products (code, name) values ($1, $2) returning id`,
			[code, `Produto ${code}`],
		);
		const version = await client.query<{ id: string }>(
			`insert into product_versions (product_id, version, deps_product, base_cost, base_cost_per_partner)
       values ($1, 1, $2, $3, $4) returning id`,
			[
				product.rows[0].id,
				input.depsProduct ?? null,
				input.baseCost ?? "0.00",
				input.baseCostPerPartner ?? "0.00",
			],
		);
		await client.query("commit");
		return { id: product.rows[0].id, code, versionId: version.rows[0].id };
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

export async function seedProductVersion(
	owner: Pool,
	input: { productId: string; version: number; baseCost: string; baseCostPerPartner?: string },
): Promise<string> {
	const { rows } = await owner.query<{ id: string }>(
		`insert into product_versions (product_id, version, base_cost, base_cost_per_partner)
     values ($1, $2, $3, $4) returning id`,
		[input.productId, input.version, input.baseCost, input.baseCostPerPartner ?? "0.00"],
	);
	return rows[0].id;
}

export async function seedBureauCost(
	owner: Pool,
	input: { bureauId: string; productId: string; cost: string; costPerPartner?: string; setBy: string },
): Promise<void> {
	await owner.query(
		`insert into bureau_product_costs (bureau_id, product_id, cost, cost_per_partner, set_by)
     values ($1, $2, $3, $4, $5)`,
		[input.bureauId, input.productId, input.cost, input.costPerPartner ?? "0.00", input.setBy],
	);
}

export async function seedCatalogItem(
	owner: Pool,
	input: {
		bureauId: string;
		productId: string;
		salePrice: string;
		salePricePerPartner?: string;
		updatedBy: string;
		active?: boolean;
	},
): Promise<void> {
	await owner.query(
		`insert into bureau_catalog_items (bureau_id, product_id, active, sale_price, sale_price_per_partner, updated_by)
     values ($1, $2, $3, $4, $5, $6)`,
		[
			input.bureauId,
			input.productId,
			input.active ?? true,
			input.salePrice,
			input.salePricePerPartner ?? "0.00",
			input.updatedBy,
		],
	);
}

// Saldo inicial por topup real (wallet_post_entry), para a conciliação continuar válida.
export async function seedWalletTopup(
	owner: Pool,
	input: { bureauId: string; amount: string; createdBy: string },
): Promise<void> {
	await owner.query(
		"select * from wallet_post_entry($1, 'topup', $2, $3, 'seed', null, $4)",
		[
			input.bureauId,
			input.amount,
			`seed-${randomBytes(6).toString("hex")}`,
			input.createdBy,
		],
	);
}

export type SeededPixCharge = { id: string; asaasPaymentId: string };

export async function seedPixCharge(
	owner: Pool,
	input: {
		bureauId: string;
		requestedBy: string;
		amount?: string;
		status?: "pending" | "paid" | "expired" | "cancelled" | "refunded";
		expiresAt?: Date;
		clientProfileId?: string;
	},
): Promise<SeededPixCharge> {
	const asaasPaymentId = `pay_${randomBytes(8).toString("hex")}`;
	const { rows } = await owner.query<{ id: string }>(
		`insert into pix_charges (bureau_id, asaas_payment_id, amount, status, pix_payload, expires_at, requested_by, client_profile_id)
     values ($1, $2, $3, $4, 'pix-copia-e-cola-teste', $5, $6, $7) returning id`,
		[
			input.bureauId,
			asaasPaymentId,
			input.amount ?? "100.00",
			input.status ?? "pending",
			input.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000),
			input.requestedBy,
			input.clientProfileId ?? null,
		],
	);
	return { id: rows[0].id, asaasPaymentId };
}

// Outro cliente no mesmo Bureau. O trigger de profiles cria a carteira dele.
export async function seedClientProfile(
	owner: Pool,
	bureauId: string,
): Promise<SeedIdentity> {
	const client = await owner.connect();
	try {
		await client.query("begin");
		const userId = await insertUserAndProfile(client, {
			label: `cliente ${randomBytes(4).toString("hex")}`,
			role: "client",
			bureauId,
		});
		await client.query("commit");
		return { userId, role: "client", bureauId };
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

// Saldo inicial do cliente por topup real (client_wallet_post_entry), para a conciliação continuar válida.
export async function seedClientWalletTopup(
	owner: Pool,
	input: { clientProfileId: string; amount: string; createdBy: string },
): Promise<void> {
	await owner.query(
		"select * from client_wallet_post_entry($1, 'topup', $2, $3, 'seed', null, $4)",
		[
			input.clientProfileId,
			input.amount,
			`seed-${randomBytes(6).toString("hex")}`,
			input.createdBy,
		],
	);
}

export async function seedDossier(
	owner: Pool,
	input: { bureauId: string; holderId: string; createdBy: string },
): Promise<string> {
	const { rows } = await owner.query<{ id: string }>(
		`insert into dossiers (bureau_id, kind, holder_id, product, created_by)
     values ($1, 'PF', $2, 'smart_pf', $3) returning id`,
		[input.bureauId, input.holderId, input.createdBy],
	);
	return rows[0].id;
}

// reserve_order exige que order_ref seja o pedido (dossier_orders) do Bureau. Cria o Dossiê com esse id sobre o titular
// do cliente (ou sobre qualquer titular do Bureau, no balcão) e o pedido que o acompanha: online com o cliente, senão
// balcão. Repetir não faz nada; sem titular elegível não cria nada. `members` cria essa quantidade de consultas no
// Dossiê (reserve_order conta os sócios como membros menos o Titular principal); `productCode` troca o produto do pedido.
export async function seedOrderDossier(
	owner: Pool,
	input: { orderRef: string; bureauId: string; clientProfileId: string | null; productCode?: string; members?: number },
): Promise<void> {
	await owner.query(
		`insert into dossiers (id, bureau_id, kind, holder_id, product, created_by)
     select $1, $2, 'PF', h.id, 'smart_pf', h.created_by from holders h
      where h.bureau_id = $2 and ($3::uuid is null or h.client_profile_id = $3)
      order by h.created_at limit 1
     on conflict do nothing`,
		[input.orderRef, input.bureauId, input.clientProfileId],
	);
	await owner.query(
		`insert into dossier_orders (dossier_id, bureau_id, mode, client_profile_id, product_code, subject_name,
         subject_document_masked, state, created_by)
     select d.id, d.bureau_id, case when $3::uuid is null then 'counter' else 'online' end, $3::uuid, $4,
            'Titular seed', '***.000.000-**', 'awaiting_authorization', h.created_by
       from dossiers d join holders h on h.bureau_id = d.bureau_id and h.id = d.holder_id
      where d.id = $1 and d.bureau_id = $2
     on conflict do nothing`,
		[input.orderRef, input.bureauId, input.clientProfileId, input.productCode ?? "dossie_pf"],
	);
	if (input.members) {
		await owner.query(
			`insert into consultations (bureau_id, type, document, product, holder_id, dossier_id, created_by)
       select d.bureau_id, 'PF', lpad((random() * 99999999999)::bigint::text, 11, '0'), 'smart_pf', d.holder_id, d.id, d.created_by
         from dossiers d, generate_series(1, $3::int)
        where d.id = $1 and d.bureau_id = $2`,
			[input.orderRef, input.bureauId, input.members],
		);
	}
}

// Como seedOrderDossier, com o Bureau lido do contexto da transação `session` (a que vai chamar reserve_order).
export async function seedOrderDossierForSession(
	owner: Pool,
	session: PoolClient,
	input: { orderRef: string; clientProfileId: string | null; productCode?: string; members?: number },
): Promise<void> {
	const { rows } = await session.query<{ id: string | null }>(
		"select nullif(current_setting('app.bureau_id', true), '') as id",
	);
	if (rows[0].id) await seedOrderDossier(owner, { ...input, bureauId: rows[0].id });
}

// reserve_order confere preço e custo no catálogo do Bureau da sessão (a que vai chamar reserve_order): põe o produto
// do seed `productCode` à venda por `price` (+ `pricePerPartner`), com custo efetivo `cost` (+ `costPerPartner`), e
// devolve a cotação que o aponta. Valores que reserve_order recusa antes do catálogo (preço <= 0, custo negativo,
// preço abaixo do custo, mais de duas casas) não mexem no catálogo: a cotação volta vazia.
export async function seedOrderCatalog(
	owner: Pool,
	session: PoolClient,
	input: { productCode: string; price: string; cost: string; pricePerPartner?: string; costPerPartner?: string },
): Promise<{ lines: { code: string }[] }> {
	const pricePerPartner = input.pricePerPartner ?? "0.00";
	const costPerPartner = input.costPerPartner ?? "0.00";
	const twoDecimals = (v: string) => /^\d+(\.\d{1,2})?$/.test(v);
	const values = [input.price, input.cost, pricePerPartner, costPerPartner];
	if (
		!values.every(twoDecimals) ||
		Number(input.price) <= 0 ||
		Number(input.price) < Number(input.cost) ||
		Number(pricePerPartner) < Number(costPerPartner) ||
		values.some((v) => Number(v) > 99999999.99)
	) {
		return { lines: [] };
	}
	const { rows } = await session.query<{ bureau_id: string; user_id: string }>(
		"select nullif(current_setting('app.bureau_id', true), '') as bureau_id, current_setting('app.user_id', true) as user_id",
	);
	if (!rows[0].bureau_id) return { lines: [] };
	const product = await owner.query<{ id: string }>("select id from products where code = $1", [input.productCode]);
	const productId = product.rows[0].id;
	// O catálogo semeia o produto inativo; o trigger do item exige produto ativo.
	await owner.query("update products set active = true where id = $1", [productId]);
	await seedBureauCost(owner, {
		bureauId: rows[0].bureau_id,
		productId,
		cost: input.cost,
		costPerPartner,
		setBy: rows[0].user_id,
	});
	// O custo entra antes do preço: a trigger do item confere o preço contra o custo vigente.
	await owner.query(
		`insert into bureau_catalog_items (bureau_id, product_id, active, sale_price, sale_price_per_partner, updated_by)
     values ($1, $2, true, $3, $4, $5)
     on conflict (bureau_id, product_id)
     do update set active = true, sale_price = $3, sale_price_per_partner = $4, updated_by = $5`,
		[rows[0].bureau_id, productId, input.price, pricePerPartner, rows[0].user_id],
	);
	return { lines: [{ code: input.productCode }] };
}

// Lançamento de valor a repassar já assinado (acréscimo +, estorno −). O acréscimo exige order_ref (FK para
// order_settlements): cria a liquidação mínima, de balcão e já capturada, e liga o lançamento a ela.
export async function seedPayableEntry(
	owner: Pool,
	input: {
		bureauId: string;
		kind: "accrual" | "reversal";
		amount: string;
		createdAt?: string;
	},
): Promise<string> {
	let orderRef: string | null = null;
	if (input.kind === "accrual") {
		orderRef = randomUUID();
		await owner.query(
			`insert into order_settlements (order_ref, bureau_id, mode, price, cost, status, closed_at)
       values ($1, $2, 'counter', 1, 0, 'captured', now())`,
			[orderRef, input.bureauId],
		);
	}
	const { rows } = await owner.query<{ id: string }>(
		`insert into bureau_payable_entries (bureau_id, kind, amount, order_ref, created_at)
     values ($1, $2, $3, $4, coalesce($5::timestamptz, now())) returning id`,
		[input.bureauId, input.kind, input.amount, orderRef, input.createdAt ?? null],
	);
	return rows[0].id;
}

// Retenção LGPD: linhas técnicas com data escolhida pelo teste (o app nunca grava no passado).
export async function seedExpiredChallenge(
	owner: Pool,
	input: { profileId: string; expiresAt: Date },
): Promise<string> {
	const { rows } = await owner.query<{ id: string }>(
		`insert into verification_challenges (profile_id, kind, target, code_hash, expires_at)
     values ($1, 'email', 'seed@example.test', $2, $3) returning id`,
		[input.profileId, randomBytes(32).toString("hex"), input.expiresAt],
	);
	return rows[0].id;
}

export async function seedRegisterAttempt(
	owner: Pool,
	input: { createdAt: Date },
): Promise<number> {
	const { rows } = await owner.query<{ id: string }>(
		"insert into client_register_attempts (ip, created_at) values ('203.0.113.7', $1) returning id",
		[input.createdAt],
	);
	return Number(rows[0].id);
}

export async function seedExpiredSession(
	owner: Pool,
	input: { userId: string; expiresAt: Date },
): Promise<string> {
	const { rows } = await owner.query<{ id: string }>(
		`insert into "session" (expires_at, token, updated_at, user_id)
     values ($1, $2, now(), $3) returning id`,
		[input.expiresAt, randomBytes(24).toString("hex"), input.userId],
	);
	return rows[0].id;
}
