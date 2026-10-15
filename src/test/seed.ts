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
	const startedAt = input.startedAt ?? new Date();
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
		kind?: "main" | "addon";
		addonFor?: string[];
		baseCost?: string;
		depsProduct?: string | null;
	} = {},
): Promise<SeededProduct> {
	const kind = input.kind ?? "main";
	const code = `${kind}_${randomBytes(6).toString("hex")}`;
	const client = await owner.connect();
	try {
		await client.query("begin");
		const product = await client.query<{ id: string }>(
			`insert into products (code, name, kind, addon_for)
       values ($1, $2, $3, $4) returning id`,
			[code, `Produto ${code}`, kind, kind === "addon" ? input.addonFor : null],
		);
		const version = await client.query<{ id: string }>(
			`insert into product_versions (product_id, version, deps_product, base_cost)
       values ($1, 1, $2, $3) returning id`,
			[product.rows[0].id, input.depsProduct ?? null, input.baseCost ?? "0.00"],
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
	input: { productId: string; version: number; baseCost: string },
): Promise<string> {
	const { rows } = await owner.query<{ id: string }>(
		`insert into product_versions (product_id, version, base_cost)
     values ($1, $2, $3) returning id`,
		[input.productId, input.version, input.baseCost],
	);
	return rows[0].id;
}

export async function seedBureauCost(
	owner: Pool,
	input: { bureauId: string; productId: string; cost: string; setBy: string },
): Promise<void> {
	await owner.query(
		`insert into bureau_product_costs (bureau_id, product_id, cost, set_by)
     values ($1, $2, $3, $4)`,
		[input.bureauId, input.productId, input.cost, input.setBy],
	);
}

export async function seedCatalogItem(
	owner: Pool,
	input: {
		bureauId: string;
		productId: string;
		salePrice: string;
		updatedBy: string;
		active?: boolean;
	},
): Promise<void> {
	await owner.query(
		`insert into bureau_catalog_items (bureau_id, product_id, active, sale_price, updated_by)
     values ($1, $2, $3, $4, $5)`,
		[
			input.bureauId,
			input.productId,
			input.active ?? true,
			input.salePrice,
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

// reserve_order exige que order_ref seja um Dossiê do Bureau. Cria o Dossiê com esse id sobre o titular do cliente
// (ou sobre qualquer titular do Bureau, no balcão). Repetir não faz nada; sem titular elegível não cria nada.
export async function seedOrderDossier(
	owner: Pool,
	input: { orderRef: string; bureauId: string; clientProfileId: string | null },
): Promise<void> {
	await owner.query(
		`insert into dossiers (id, bureau_id, kind, holder_id, product, created_by)
     select $1, $2, 'PF', h.id, 'smart_pf', h.created_by from holders h
      where h.bureau_id = $2 and ($3::uuid is null or h.client_profile_id = $3)
      order by h.created_at limit 1
     on conflict do nothing`,
		[input.orderRef, input.bureauId, input.clientProfileId],
	);
}

// Como seedOrderDossier, com o Bureau lido do contexto da transação `session` (a que vai chamar reserve_order).
export async function seedOrderDossierForSession(
	owner: Pool,
	session: PoolClient,
	input: { orderRef: string; clientProfileId: string | null },
): Promise<void> {
	const { rows } = await session.query<{ id: string | null }>(
		"select nullif(current_setting('app.bureau_id', true), '') as id",
	);
	if (rows[0].id) await seedOrderDossier(owner, { ...input, bureauId: rows[0].id });
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
