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
		salePrice?: string | null;
		salePricePerPartner?: string;
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
			`insert into product_versions (product_id, version, deps_product, base_cost, base_cost_per_partner, sale_price, sale_price_per_partner)
       values ($1, 1, $2, $3, $4, $5, $6) returning id`,
			[
				product.rows[0].id,
				input.depsProduct ?? null,
				input.baseCost ?? "0.00",
				input.baseCostPerPartner ?? "0.00",
				input.salePrice ?? null,
				input.salePricePerPartner ?? "0.00",
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
	input: {
		productId: string;
		version: number;
		baseCost: string;
		baseCostPerPartner?: string;
		salePrice?: string | null;
		salePricePerPartner?: string;
	},
): Promise<string> {
	const { rows } = await owner.query<{ id: string }>(
		`insert into product_versions (product_id, version, base_cost, base_cost_per_partner, sale_price, sale_price_per_partner)
     values ($1, $2, $3, $4, $5, $6) returning id`,
		[
			input.productId,
			input.version,
			input.baseCost,
			input.baseCostPerPartner ?? "0.00",
			input.salePrice ?? null,
			input.salePricePerPartner ?? "0.00",
		],
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

// Modelo da 055: o preço é do produto (versão do superadmin) e o Bureau ganha uma % sobre o preço bruto. Põe o produto
// à venda a `salePrice` (+ `salePricePerPartner`) com uma versão nova só se o preço vigente for outro, grava a % do
// Bureau (override) que deixa o custo (parte da plataforma) em `cost` e aplica o bloqueio. O preço é global: testes de
// arquivos diferentes que usam o mesmo produto com preços diferentes não podem rodar ao mesmo tempo (ver vitest.config).
export async function setPlatformSale(
	owner: Pool,
	input: {
		bureauId: string;
		productId: string;
		salePrice: string;
		salePricePerPartner?: string;
		cost?: string;
		setBy: string;
		active?: boolean;
	},
): Promise<void> {
	const perPartner = input.salePricePerPartner ?? "0.00";
	for (let attempt = 0; ; attempt += 1) {
		try {
			await owner.query(
				`insert into product_versions
           (product_id, version, deps_product, base_cost, base_cost_per_partner, sale_price, sale_price_per_partner)
         select l.product_id, l.version + 1, l.deps_product, l.base_cost, l.base_cost_per_partner, $2::numeric, $3::numeric
           from (select * from product_versions where product_id = $1 order by version desc limit 1) l
          where l.sale_price is distinct from $2::numeric or l.sale_price_per_partner is distinct from $3::numeric`,
				[input.productId, input.salePrice, perPartner],
			);
			break;
		} catch (error) {
			if ((error as { code?: string }).code !== "23505" || attempt >= 5) throw error;
		}
	}
	const cost =
		input.cost ??
		(
			await owner.query<{ cost: string }>(
				"select cost from bureau_product_costs where bureau_id = $1 and product_id = $2 order by id desc limit 1",
				[input.bureauId, input.productId],
			)
		).rows[0]?.cost ??
		input.salePrice;
	await owner.query(
		`insert into bureau_commission_rates (bureau_id, pct, set_by)
     select $1::uuid, least(round(($2::numeric - $3::numeric) * 100 / $2::numeric, 2), 99.99), $4::uuid
      where least(round(($2::numeric - $3::numeric) * 100 / $2::numeric, 2), 99.99)
            is distinct from (select r.pct from bureau_commission_rates r where r.bureau_id = $1 order by r.id desc limit 1)`,
		[input.bureauId, input.salePrice, cost, input.setBy],
	);
	const blocked = input.active === false;
	await owner.query(
		`insert into bureau_product_blocks (bureau_id, product_id, blocked, set_by)
     select $1::uuid, $2::uuid, $3::boolean, $4::uuid
      where $3::boolean is distinct from coalesce((select b.blocked from bureau_product_blocks b
                          where b.bureau_id = $1 and b.product_id = $2 order by b.id desc limit 1), false)`,
		[input.bureauId, input.productId, blocked, input.setBy],
	);
}

// Compatível com o catálogo antigo: o custo vem do último seedBureauCost do par (nenhum = custo igual ao preço).
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
	await setPlatformSale(owner, {
		bureauId: input.bureauId,
		productId: input.productId,
		salePrice: input.salePrice,
		salePricePerPartner: input.salePricePerPartner,
		setBy: input.updatedBy,
		active: input.active,
	});
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

// reserve_order confere preço e custo contra o produto e a % do Bureau da sessão (a que vai chamar reserve_order): põe o
// produto do seed `productCode` à venda por `price` (+ `pricePerPartner`) e fixa a % do Bureau para que o custo (parte da
// plataforma) seja `cost`, e devolve a cotação que o aponta. `costPerPartner` só vale para a validação dos valores. Valores que reserve_order recusa antes do catálogo (preço <= 0, custo negativo,
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
	// O catálogo semeia o produto inativo: a venda exige produto ativo.
	await owner.query("update products set active = true where id = $1", [productId]);
	await setPlatformSale(owner, {
		bureauId: rows[0].bureau_id,
		productId,
		salePrice: input.price,
		salePricePerPartner: pricePerPartner,
		cost: input.cost,
		setBy: rows[0].user_id,
	});
	return { lines: [{ code: input.productCode }] };
}

// Pedido online reservado antes da migração 077 (commission_on_cash_in falso): preço e custo gravados direto, sem
// commission_pct (formato anterior à 055) ou, com `commissionPct`, no formato da 055 (custo = preço + desconto - comissão
// do Bureau). A reserva do preço pago sai da carteira do cliente (que o teste abasteceu); capture_order segue o ramo
// antigo. Com `coupon`, grava a redenção e o que o Bureau cobriu da falta: `fundedWallet` reserva da carteira do Bureau
// (motivo "cupom") e `fundedPayable` lança coupon_cost no valor a repassar.
export async function seedLegacyOnlineOrder(
	owner: Pool,
	input: {
		bureauId: string;
		clientProfileId: string;
		price: string;
		cost?: string;
		commissionPct?: string;
		orderRef?: string;
		coupon?: { couponId: string; discount: string; fundedWallet?: string; fundedPayable?: string };
	},
): Promise<string> {
	const orderRef = input.orderRef ?? randomUUID();
	const discount = input.coupon?.discount ?? "0.00";
	await seedOrderDossier(owner, { orderRef, bureauId: input.bureauId, clientProfileId: input.clientProfileId });
	if (input.commissionPct !== undefined) {
		await owner.query(
			`insert into order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost, commission_pct, bureau_commission,
                                      coupon_id, discount)
       values ($1, $2, 'online', $3, $4::numeric, $4::numeric + $6::numeric - round(($4::numeric + $6::numeric) * $5::numeric / 100, 2),
               $5::numeric, round(($4::numeric + $6::numeric) * $5::numeric / 100, 2), $7, $6::numeric)`,
			[orderRef, input.bureauId, input.clientProfileId, input.price, input.commissionPct, discount, input.coupon?.couponId ?? null],
		);
	} else {
		await owner.query(
			`insert into order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost, coupon_id, discount)
       values ($1, $2, 'online', $3, $4, $5, $6, $7)`,
			[orderRef, input.bureauId, input.clientProfileId, input.price, input.cost ?? "0.00", input.coupon?.couponId ?? null, discount],
		);
	}
	if (Number(input.price) > 0) {
		const { rows } = await owner.query<{ ok: boolean; reason: string | null }>(
			"select ok, reason from client_wallet_post_entry($1, 'reserve', $2::numeric, $3, $4, null, $1)",
			[input.clientProfileId, input.price, `order:reserve:${orderRef}`, `order:${orderRef}`],
		);
		if (!rows[0].ok) throw new Error(`seedLegacyOnlineOrder: client reserve refused (${rows[0].reason})`);
	}
	if (input.coupon) {
		const fundedWallet = input.coupon.fundedWallet ?? "0.00";
		const fundedPayable = input.coupon.fundedPayable ?? "0.00";
		await owner.query(
			`insert into coupon_redemptions (coupon_id, bureau_id, client_profile_id, order_ref, discount, funded_wallet, funded_payable)
       values ($1, $2, $3, $4, $5, $6, $7)`,
			[input.coupon.couponId, input.bureauId, input.clientProfileId, orderRef, discount, fundedWallet, fundedPayable],
		);
		if (Number(fundedWallet) > 0) {
			const { rows } = await owner.query<{ ok: boolean; reason: string | null }>(
				"select ok, reason from wallet_post_entry($1, 'reserve', $2::numeric, $3, $4, 'cupom', $5)",
				[input.bureauId, fundedWallet, `coupon:${orderRef}:wallet`, `order:${orderRef}`, input.clientProfileId],
			);
			if (!rows[0].ok) throw new Error(`seedLegacyOnlineOrder: Bureau reserve refused (${rows[0].reason})`);
		}
		if (Number(fundedPayable) > 0) {
			await owner.query(
				"insert into bureau_payable_entries (bureau_id, kind, amount, order_ref) values ($1, 'coupon_cost', -$2::numeric, $3)",
				[input.bureauId, fundedPayable, orderRef],
			);
		}
	}
	return orderRef;
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

// Entrada de dinheiro paga cuja parte do Bureau virou lançamento a repassar (bureau sem walletId, 074): cobrança paga,
// linha de charge_splits `accrual` já feita e o acréscimo com pix_charge_id e sem order_ref.
export async function seedCashInAccrual(
	owner: Pool,
	input: { bureauId: string; requestedBy: string; clientProfileId?: string; chargeAmount: string; amount: string; pct?: string },
): Promise<{ chargeId: string; entryId: string }> {
	const charge = await seedPixCharge(owner, {
		bureauId: input.bureauId,
		requestedBy: input.requestedBy,
		amount: input.chargeAmount,
		status: "paid",
		clientProfileId: input.clientProfileId,
	});
	await owner.query(
		`insert into charge_splits (pix_charge_id, bureau_id, beneficiary_kind, beneficiary_id, payout_method, pct, amount_cents, status)
     values ($1, $2, 'bureau', $2, 'accrual', $3, round($4::numeric * 100), 'done')`,
		[charge.id, input.bureauId, input.pct ?? "0.00", input.amount],
	);
	const { rows } = await owner.query<{ id: string }>(
		`insert into bureau_payable_entries (bureau_id, kind, amount, pix_charge_id) values ($1, 'accrual', $2, $3) returning id`,
		[input.bureauId, input.amount, charge.id],
	);
	return { chargeId: charge.id, entryId: rows[0].id };
}

// Envelhece os lançamentos a repassar do Bureau: a tabela é só de inserção e o repasse só paga o que passou da retenção.
// Os lançamentos vêm do fluxo real (capture_order, estorno) com created_at = now(). Troca o gatilho só nesta transação.
export async function ageBureauPayableEntries(owner: Pool, bureauId: string, days = 40): Promise<void> {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		const aged = await client.query(
			"update bureau_payable_entries set created_at = created_at - make_interval(days => $2) where bureau_id = $1",
			[bureauId, days],
		);
		if (!aged.rowCount) throw new Error(`ageBureauPayableEntries: bureau ${bureauId} has no payable entries to age`);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
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
