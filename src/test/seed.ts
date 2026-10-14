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
		status?: "pending" | "paid" | "expired" | "cancelled";
		expiresAt?: Date;
	},
): Promise<SeededPixCharge> {
	const asaasPaymentId = `pay_${randomBytes(8).toString("hex")}`;
	const { rows } = await owner.query<{ id: string }>(
		`insert into pix_charges (bureau_id, asaas_payment_id, amount, status, pix_payload, expires_at, requested_by)
     values ($1, $2, $3, $4, 'pix-copia-e-cola-teste', $5, $6) returning id`,
		[
			input.bureauId,
			asaasPaymentId,
			input.amount ?? "100.00",
			input.status ?? "pending",
			input.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000),
			input.requestedBy,
		],
	);
	return { id: rows[0].id, asaasPaymentId };
}
