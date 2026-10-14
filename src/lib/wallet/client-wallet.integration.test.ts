// M3b / migration 015: carteira do cliente (client_wallets, client_ledger_entries, client_wallet_*),
// cobrança PIX do cliente e apply_asaas_payment para cliente.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	TEST_DATABASE_OWNER_URL,
	TEST_DATABASE_URL,
	TEST_DATABASE_WEBHOOK_URL,
} from "@/test/db-env";
import {
	seedClientProfile,
	seedClientWalletTopup,
	seedPixCharge,
	seedSuperadmin,
	seedTenant,
	seedWalletTopup,
	withDbContext,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 6 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 4 });

let superadmin: SeedSuperadmin;

beforeAll(async () => {
	superadmin = await seedSuperadmin(owner);
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), hook.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string | null };
const ctxOf = (id: {
	userId: string;
	role: string;
	bureauId: string | null;
}): Ctx => ({
	userId: id.userId,
	role: id.role,
	bureauId: id.bureauId,
});
const superadminCtx = (): Ctx => ({
	userId: superadmin.userId,
	role: "superadmin",
	bureauId: null,
});

const newKey = () => `k-${randomBytes(6).toString("hex")}`;

type PostRow = {
	ok: boolean;
	reason: string | null;
	entry_id: string | null;
	available: string | null;
	reserved: string | null;
	replayed: boolean;
};

async function clientBalance(clientId: string) {
	const { rows } = await owner.query<{ available: string; reserved: string }>(
		"select available, reserved from client_wallets where client_profile_id = $1",
		[clientId],
	);
	return rows[0];
}

async function bureauBalance(bureauId: string) {
	const { rows } = await owner.query<{ available: string; reserved: string }>(
		"select available, reserved from wallets where bureau_id = $1",
		[bureauId],
	);
	return rows[0];
}

const ZERO = { available: "0.00", reserved: "0.00" };

async function fundedClient(amount = "100.00") {
	const tenant = await seedTenant(owner, "CarteiraCliente");
	await seedClientWalletTopup(owner, {
		clientProfileId: tenant.client.userId,
		amount,
		createdBy: tenant.client.userId,
	});
	return tenant;
}

describe("carteira do cliente nasce com a conta", () => {
	it("creates an empty wallet for each client profile and none for staff", async () => {
		const tenant = await seedTenant(owner, "NasceCarteira");
		expect(await clientBalance(tenant.client.userId)).toEqual(ZERO);
		const { rows } = await owner.query(
			"select client_profile_id, bureau_id from client_wallets where bureau_id = $1",
			[tenant.bureau.id],
		);
		expect(rows).toEqual([
			{ client_profile_id: tenant.client.userId, bureau_id: tenant.bureau.id },
		]);

		const second = await seedClientProfile(owner, tenant.bureau.id);
		expect(await clientBalance(second.userId)).toEqual(ZERO);
	});

	it("rejects a wallet whose bureau does not match the profile bureau", async () => {
		const a = await seedTenant(owner, "FkA");
		const b = await seedTenant(owner, "FkB");
		await owner.query(
			"delete from client_wallets where client_profile_id = $1",
			[a.client.userId],
		);
		await expect(
			owner.query(
				"insert into client_wallets (client_profile_id, bureau_id) values ($1, $2)",
				[a.client.userId, b.bureau.id],
			),
		).rejects.toThrow(/foreign key/);
	});

	it("never accepts a negative balance", async () => {
		const tenant = await seedTenant(owner, "Negativo");
		await expect(
			owner.query(
				"update client_wallets set available = -1 where client_profile_id = $1",
				[tenant.client.userId],
			),
		).rejects.toThrow(/check constraint/);
		await expect(
			owner.query(
				"update client_wallets set reserved = -1 where client_profile_id = $1",
				[tenant.client.userId],
			),
		).rejects.toThrow(/check constraint/);
	});
});

// Os mesmos casos nas duas funções-núcleo (spec, risco "Duplicação"): evita divergência entre elas.
describe.each([
	{
		name: "wallet_post_entry (Bureau)",
		fresh: async () => {
			const tenant = await seedTenant(owner, "NucleoB");
			await seedWalletTopup(owner, {
				bureauId: tenant.bureau.id,
				amount: "100.00",
				createdBy: tenant.bureauAdmin.userId,
			});
			return {
				call: async (kind: string, amount: string, key: string) =>
					(
						await owner.query<PostRow>(
							"select * from wallet_post_entry($1, $2, $3, $4, null, null, $5)",
							[tenant.bureau.id, kind, amount, key, tenant.bureauAdmin.userId],
						)
					).rows[0],
				balance: () => bureauBalance(tenant.bureau.id),
			};
		},
	},
	{
		name: "client_wallet_post_entry (cliente)",
		fresh: async () => {
			const tenant = await fundedClient("100.00");
			return {
				call: async (kind: string, amount: string, key: string) =>
					(
						await owner.query<PostRow>(
							"select * from client_wallet_post_entry($1, $2, $3, $4, null, null, $5)",
							[tenant.client.userId, kind, amount, key, tenant.client.userId],
						)
					).rows[0],
				balance: () => clientBalance(tenant.client.userId),
			};
		},
	},
])("núcleo de saldo: $name", ({ fresh }) => {
	it("moves available and reserved as each kind requires", async () => {
		const t = await fresh();
		expect(await t.call("reserve", "30.00", newKey())).toMatchObject({
			ok: true,
			available: "70.00",
			reserved: "30.00",
			replayed: false,
		});
		expect(await t.call("capture", "10.00", newKey())).toMatchObject({
			ok: true,
			available: "70.00",
			reserved: "20.00",
		});
		expect(await t.call("release", "5.00", newKey())).toMatchObject({
			ok: true,
			available: "75.00",
			reserved: "15.00",
		});
		expect(await t.call("reversal", "25.00", newKey())).toMatchObject({
			ok: true,
			available: "50.00",
			reserved: "15.00",
		});
		expect(await t.call("topup", "0.01", newKey())).toMatchObject({
			ok: true,
			available: "50.01",
		});
	});

	it("refuses to overdraw or to capture more than reserved, leaving the balance untouched", async () => {
		const t = await fresh();
		expect(await t.call("reserve", "100.01", newKey())).toMatchObject({
			ok: false,
			reason: "insufficient_balance",
		});
		// O estorno também pode tirar da reserva; acima de disponível mais reservado, não há de onde tirar.
		expect(await t.call("reversal", "100.01", newKey())).toMatchObject({
			ok: false,
			reason: "reservation_exceeded",
		});
		expect(await t.call("capture", "1.00", newKey())).toMatchObject({
			ok: false,
			reason: "reservation_exceeded",
		});
		expect(await t.call("release", "1.00", newKey())).toMatchObject({
			ok: false,
			reason: "reservation_exceeded",
		});
		expect(await t.balance()).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
	});

	it("validates kind, amount and key", async () => {
		const t = await fresh();
		expect(await t.call("bogus", "1.00", newKey())).toMatchObject({
			ok: false,
			reason: "not_allowed",
		});
		for (const amount of ["0", "-1.00", "1.234", "100000000.00"]) {
			expect(await t.call("topup", amount, newKey()), amount).toMatchObject({
				ok: false,
				reason: "invalid_amount",
			});
		}
		for (const key of ["", "   ", "x".repeat(201)]) {
			expect(await t.call("topup", "1.00", key), key).toMatchObject({
				ok: false,
				reason: "invalid_key",
			});
		}
		expect(await t.balance()).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
	});

	it("replays a repeated key without moving the balance and flags a conflicting reuse", async () => {
		const t = await fresh();
		const key = newKey();
		const first = await t.call("reserve", "40.00", key);
		const replay = await t.call("reserve", "40.00", key);
		expect(replay).toMatchObject({
			ok: true,
			replayed: true,
			entry_id: first.entry_id,
			available: "60.00",
		});
		expect(await t.call("reserve", "41.00", key)).toMatchObject({
			ok: false,
			reason: "idempotency_conflict",
		});
		expect(await t.call("capture", "40.00", key)).toMatchObject({
			ok: false,
			reason: "idempotency_conflict",
		});
		expect(await t.balance()).toEqual({
			available: "60.00",
			reserved: "40.00",
		});
	});
});

describe("client_ledger_entries (imutabilidade e conciliação)", () => {
	it("blocks UPDATE, DELETE and TRUNCATE for the app role and for the owner", async () => {
		const tenant = await fundedClient("10.00");
		const id = tenant.client.userId;
		for (const sql of [
			"update client_ledger_entries set amount = 1 where client_profile_id = $1",
			"delete from client_ledger_entries where client_profile_id = $1",
		]) {
			await expect(
				withDbContext(app, ctxOf(tenant.bureauAdmin), (c) =>
					c.query(sql, [id]),
				),
			).rejects.toThrow(/permission denied/);
			await expect(owner.query(sql, [id])).rejects.toThrow(/immutable/);
		}
		await expect(owner.query("truncate client_ledger_entries")).rejects.toThrow(
			/immutable/,
		);
	});

	it("keeps a key unique per client but reusable by another client", async () => {
		const a = await fundedClient("10.00");
		const other = await seedClientProfile(owner, a.bureau.id);
		const key = newKey();
		const call = (clientId: string) =>
			owner.query<PostRow>(
				"select * from client_wallet_post_entry($1, 'topup', 5, $2, null, null, $1)",
				[clientId, key],
			);
		expect((await call(a.client.userId)).rows[0].replayed).toBe(false);
		expect((await call(a.client.userId)).rows[0].replayed).toBe(true);
		expect((await call(other.userId)).rows[0]).toMatchObject({
			ok: true,
			replayed: false,
		});
	});

	it("keeps the sum of entries equal to available plus reserved", async () => {
		const tenant = await fundedClient("200.00");
		const id = tenant.client.userId;
		const call = (kind: string, amount: string) =>
			owner.query(
				"select * from client_wallet_post_entry($1, $2, $3, $4, null, null, $1)",
				[id, kind, amount, newKey()],
			);
		await call("reserve", "80.00");
		await call("capture", "30.00");
		await call("release", "10.00");
		await call("reversal", "15.50");

		const { rows } = await owner.query<{
			net: string;
			total: string;
			last_total: string;
		}>(
			`select
         (select sum(case kind when 'topup' then amount when 'capture' then -amount
                                when 'reversal' then -amount else 0 end)
            from client_ledger_entries where client_profile_id = $1) as net,
         w.available + w.reserved as total,
         (select available_after + reserved_after from client_ledger_entries
           where client_profile_id = $1 order by client_ledger_entries.seq desc limit 1) as last_total
       from client_wallets w where w.client_profile_id = $1`,
			[id],
		);
		expect(rows[0]).toEqual({
			net: "154.50",
			total: "154.50",
			last_total: "154.50",
		});
	});
});

describe("RLS da carteira do cliente", () => {
	it("lets a client read only their own wallet and ledger, never the Bureau wallet", async () => {
		const a = await fundedClient("10.00");
		const other = await seedClientProfile(owner, a.bureau.id);
		await seedClientWalletTopup(owner, {
			clientProfileId: other.userId,
			amount: "7.00",
			createdBy: other.userId,
		});
		await seedWalletTopup(owner, {
			bureauId: a.bureau.id,
			amount: "50.00",
			createdBy: a.bureauAdmin.userId,
		});

		await withDbContext(app, ctxOf(a.client), async (c) => {
			const wallets = await c.query(
				"select client_profile_id from client_wallets",
			);
			expect(wallets.rows.map((r) => r.client_profile_id)).toEqual([
				a.client.userId,
			]);
			const ledger = await c.query(
				"select distinct client_profile_id from client_ledger_entries",
			);
			expect(ledger.rows.map((r) => r.client_profile_id)).toEqual([
				a.client.userId,
			]);
			expect((await c.query("select 1 from wallets")).rowCount).toBe(0);
			expect((await c.query("select 1 from ledger_entries")).rowCount).toBe(0);
		});
		await withDbContext(app, ctxOf(other), async (c) => {
			const wallets = await c.query(
				"select client_profile_id from client_wallets",
			);
			expect(wallets.rows.map((r) => r.client_profile_id)).toEqual([
				other.userId,
			]);
		});
	});

	it("lets staff read the client wallets of their own Bureau only, and hides them from the superadmin", async () => {
		const a = await fundedClient("10.00");
		const b = await fundedClient("20.00");
		for (const staff of [a.bureauAdmin, a.operator]) {
			await withDbContext(app, ctxOf(staff), async (c) => {
				const wallets = await c.query("select bureau_id from client_wallets");
				expect(new Set(wallets.rows.map((r) => r.bureau_id))).toEqual(
					new Set([a.bureau.id]),
				);
				const ledger = await c.query(
					"select distinct bureau_id from client_ledger_entries",
				);
				expect(ledger.rows.map((r) => r.bureau_id)).toEqual([a.bureau.id]);
			});
		}
		await withDbContext(app, superadminCtx(), async (c) => {
			expect(
				(
					await c.query(
						"select 1 from client_wallets where bureau_id = any($1)",
						[[a.bureau.id, b.bureau.id]],
					)
				).rowCount,
			).toBe(0);
			expect(
				(await c.query("select 1 from client_ledger_entries")).rowCount,
			).toBe(0);
		});
	});

	it("keeps the app role from writing wallets or ledger directly and from calling the internal functions", async () => {
		const tenant = await fundedClient("10.00");
		const id = tenant.client.userId;
		const attempts = [
			"insert into client_wallets (client_profile_id, bureau_id) values (gen_random_uuid(), gen_random_uuid())",
			`update client_wallets set available = 1000 where client_profile_id = '${id}'`,
			`delete from client_wallets where client_profile_id = '${id}'`,
			`insert into client_ledger_entries (bureau_id, client_profile_id, kind, amount, available_after, reserved_after, idempotency_key, created_by)
         values ('${tenant.bureau.id}', '${id}', 'topup', 1, 1, 0, 'forged', '${id}')`,
		];
		for (const sql of attempts) {
			await expect(
				withDbContext(app, ctxOf(tenant.client), (c) => c.query(sql)),
				sql,
			).rejects.toThrow(/permission denied/);
			await expect(
				withDbContext(app, ctxOf(tenant.bureauAdmin), (c) => c.query(sql)),
				sql,
			).rejects.toThrow(/permission denied/);
		}
		for (const sql of [
			"select * from client_wallet_post_entry(gen_random_uuid(), 'topup', 5, 'x', null, null, gen_random_uuid())",
		]) {
			await expect(
				withDbContext(app, ctxOf(tenant.client), (c) => c.query(sql)),
				sql,
			).rejects.toThrow(/permission denied/);
		}
		expect(await clientBalance(id)).toEqual({
			available: "10.00",
			reserved: "0.00",
		});
	});

	it("keeps the internal functions away from every role but their owner", async () => {
		const { rows } = await owner.query<Record<string, boolean>>(
			`select has_function_privilege('app_runtime', 'public.client_wallet_post_entry(uuid, text, numeric, text, text, text, uuid)', 'execute') as runtime_post,
              has_function_privilege('app_webhook', 'public.client_wallet_post_entry(uuid, text, numeric, text, text, text, uuid)', 'execute') as webhook_post,
              has_function_privilege('public', 'public.client_wallet_post_entry(uuid, text, numeric, text, text, text, uuid)', 'execute') as public_post`,
		);
		expect(Object.values(rows[0]).every((v) => v === false)).toBe(true);
	});

	it("has no client_wallet_apply: the client session moves funds only through the settlement functions", async () => {
		const { rows } = await owner.query(
			"select 1 from pg_proc where proname = 'client_wallet_apply'",
		);
		expect(rows).toHaveLength(0);
	});
});

describe("chaves reservadas", () => {
	it("makes wallet_apply refuse caller keys with the order: and pix prefixes", async () => {
		const tenant = await seedTenant(owner, "ChavesB");
		await seedWalletTopup(owner, {
			bureauId: tenant.bureau.id,
			amount: "50.00",
			createdBy: tenant.bureauAdmin.userId,
		});
		for (const key of [
			"order:reserve:x",
			"order:",
			"pix:abc",
			"pixrefund:abc",
			"pixel",
		]) {
			const row = await withDbContext(
				app,
				ctxOf(tenant.bureauAdmin),
				async (c) =>
					(
						await c.query<PostRow>(
							"select * from wallet_apply($1, 'reserve', 1, $2, null, null)",
							[tenant.bureau.id, key],
						)
					).rows[0],
			);
			expect(row, key).toMatchObject({ ok: false, reason: "invalid_key" });
		}
		const ok = await withDbContext(
			app,
			ctxOf(tenant.bureauAdmin),
			async (c) =>
				(
					await c.query<PostRow>(
						"select * from wallet_apply($1, 'reserve', 1, 'myorder:1', null, null)",
						[tenant.bureau.id],
					)
				).rows[0],
		);
		expect(ok.ok).toBe(true);
	});
});

describe("pix_charges do cliente", () => {
	const insertCharge = (
		ctx: Ctx,
		input: {
			bureauId: string;
			requestedBy: string;
			clientProfileId: string | null;
		},
	) =>
		withDbContext(app, ctx, (c) =>
			c.query(
				`insert into pix_charges (bureau_id, asaas_payment_id, amount, pix_payload, expires_at, requested_by, client_profile_id)
         values ($1, $2, '50.00', 'x', now() + interval '30 minutes', $3, $4) returning id`,
				[input.bureauId, newKey(), input.requestedBy, input.clientProfileId],
			),
		);

	it("lets a client create a charge only for themselves", async () => {
		const a = await seedTenant(owner, "CobCliente");
		const other = await seedClientProfile(owner, a.bureau.id);
		const mine = {
			bureauId: a.bureau.id,
			requestedBy: a.client.userId,
			clientProfileId: a.client.userId,
		};

		await expect(insertCharge(ctxOf(a.client), mine)).resolves.toBeDefined();
		// Em nome de outro cliente, como cobrança do Bureau, ou com outro autor.
		await expect(
			insertCharge(ctxOf(a.client), { ...mine, clientProfileId: other.userId }),
		).rejects.toThrow(/row-level security|violates/);
		await expect(
			insertCharge(ctxOf(a.client), { ...mine, clientProfileId: null }),
		).rejects.toThrow(/row-level security/);
		await expect(
			insertCharge(ctxOf(a.client), { ...mine, requestedBy: other.userId }),
		).rejects.toThrow(/row-level security|violates/);
	});

	it("keeps staff from creating a charge on behalf of a client", async () => {
		const a = await seedTenant(owner, "CobStaff");
		const forClient = {
			bureauId: a.bureau.id,
			requestedBy: a.bureauAdmin.userId,
			clientProfileId: a.client.userId,
		};
		await expect(insertCharge(ctxOf(a.bureauAdmin), forClient)).rejects.toThrow(
			/row-level security|violates/,
		);
		await expect(
			insertCharge(ctxOf(a.operator), {
				...forClient,
				requestedBy: a.operator.userId,
			}),
		).rejects.toThrow(/row-level security|violates/);
		// A cobrança do Bureau continua como antes.
		await expect(
			insertCharge(ctxOf(a.bureauAdmin), {
				...forClient,
				clientProfileId: null,
			}),
		).resolves.toBeDefined();
	});

	it("requires the client to own a wallet in the same Bureau and to be the requester (owner-level constraints)", async () => {
		const a = await seedTenant(owner, "CobCheck");
		const b = await seedTenant(owner, "CobCheckB");
		await expect(
			seedPixCharge(owner, {
				bureauId: a.bureau.id,
				requestedBy: a.bureauAdmin.userId,
				clientProfileId: a.client.userId,
			}),
		).rejects.toThrow(/check constraint/);
		await expect(
			seedPixCharge(owner, {
				bureauId: a.bureau.id,
				requestedBy: b.client.userId,
				clientProfileId: b.client.userId,
			}),
		).rejects.toThrow(/foreign key/);
	});

	it("lets a client read only their own charges; staff read the whole Bureau", async () => {
		const a = await seedTenant(owner, "CobLeitura");
		const other = await seedClientProfile(owner, a.bureau.id);
		const mine = await seedPixCharge(owner, {
			bureauId: a.bureau.id,
			requestedBy: a.client.userId,
			clientProfileId: a.client.userId,
		});
		await seedPixCharge(owner, {
			bureauId: a.bureau.id,
			requestedBy: other.userId,
			clientProfileId: other.userId,
		});
		await seedPixCharge(owner, {
			bureauId: a.bureau.id,
			requestedBy: a.bureauAdmin.userId,
		});

		await withDbContext(app, ctxOf(a.client), async (c) => {
			expect((await c.query("select id from pix_charges")).rows).toEqual([
				{ id: mine.id },
			]);
		});
		await withDbContext(app, ctxOf(a.bureauAdmin), async (c) => {
			expect((await c.query("select 1 from pix_charges")).rowCount).toBe(3);
		});
		await withDbContext(app, ctxOf(a.operator), async (c) => {
			expect((await c.query("select 1 from pix_charges")).rowCount).toBe(3);
		});
	});
});

describe("apply_asaas_payment (cliente)", () => {
	const callPayment = (
		eventId: string,
		paymentId: string,
		type = "PAYMENT_RECEIVED",
		payload = {},
	) =>
		hook
			.query<{ apply_asaas_payment: string }>(
				"select apply_asaas_payment($1, $2, $3, $4::jsonb)",
				[eventId, type, paymentId, JSON.stringify(payload)],
			)
			.then((r) => r.rows[0].apply_asaas_payment);

	const clientCharge = (
		t: SeededTenant,
		amount = "123.45",
		status?: "pending" | "paid" | "expired" | "cancelled",
	) =>
		seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.client.userId,
			clientProfileId: t.client.userId,
			amount,
			status,
		});

	const chargeRow = async (id: string) =>
		(
			await owner.query<{ status: string; refund_shortfall: string }>(
				"select status, refund_shortfall from pix_charges where id = $1",
				[id],
			)
		).rows[0];

	it("credits the client wallet, not the Bureau wallet, and audits it", async () => {
		const t = await seedTenant(owner, "WebCliente");
		const charge = await clientCharge(t);

		expect(
			await callPayment(newKey(), charge.asaasPaymentId, "PAYMENT_RECEIVED", {
				value: 9999,
			}),
		).toBe("credited");
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "123.45",
			reserved: "0.00",
		});
		expect(await bureauBalance(t.bureau.id)).toEqual(ZERO);
		expect((await chargeRow(charge.id)).status).toBe("paid");

		const entry = await owner.query(
			"select id, kind, amount, created_by, reference, idempotency_key, bureau_id from client_ledger_entries where client_profile_id = $1",
			[t.client.userId],
		);
		expect(entry.rows).toEqual([
			expect.objectContaining({
				kind: "topup",
				amount: "123.45",
				created_by: t.client.userId,
				reference: `pix_charge:${charge.id}`,
				idempotency_key: `pix:${charge.id}`,
				bureau_id: t.bureau.id,
			}),
		]);
		expect(
			(
				await owner.query("select 1 from ledger_entries where bureau_id = $1", [
					t.bureau.id,
				])
			).rowCount,
		).toBe(0);

		const audit = await owner.query(
			"select user_id, bureau_id, table_name, record_id, metadata from audit_logs where action = 'wallet.topup' and bureau_id = $1",
			[t.bureau.id],
		);
		expect(audit.rows).toEqual([
			expect.objectContaining({
				user_id: t.client.userId,
				table_name: "client_ledger_entries",
				record_id: entry.rows[0].id,
				metadata: expect.objectContaining({
					source: "asaas_webhook",
					amount: "123.45",
					pix_charge_id: charge.id,
				}),
			}),
		]);
	});

	it("treats a repeated event and a second payment event as duplicates", async () => {
		const t = await seedTenant(owner, "WebDup");
		const charge = await clientCharge(t, "50.00");
		const eventId = newKey();
		expect(await callPayment(eventId, charge.asaasPaymentId)).toBe("credited");
		expect(await callPayment(eventId, charge.asaasPaymentId)).toBe("duplicate");
		expect(
			await callPayment(newKey(), charge.asaasPaymentId, "PAYMENT_CONFIRMED"),
		).toBe("duplicate");
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "50.00",
			reserved: "0.00",
		});
	});

	it("credits a late payment of an expired charge, ignores a cancelled one", async () => {
		const t = await seedTenant(owner, "WebTarde");
		const late = await clientCharge(t, "30.00", "expired");
		const cancelled = await clientCharge(t, "40.00", "cancelled");
		expect(await callPayment(newKey(), late.asaasPaymentId)).toBe("credited");
		expect(await callPayment(newKey(), cancelled.asaasPaymentId)).toBe(
			"ignored",
		);
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "30.00",
			reserved: "0.00",
		});
	});

	it("keeps the Bureau charge path unchanged", async () => {
		const t = await seedTenant(owner, "WebBureau");
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.bureauAdmin.userId,
			amount: "77.00",
		});
		expect(await callPayment(newKey(), charge.asaasPaymentId)).toBe("credited");
		expect(await bureauBalance(t.bureau.id)).toEqual({
			available: "77.00",
			reserved: "0.00",
		});
		expect(await clientBalance(t.client.userId)).toEqual(ZERO);
	});

	describe("estorno de recarga do cliente", () => {
		async function paidCharge(amount: string) {
			const t = await seedTenant(owner, "EstornoCliente");
			const charge = await clientCharge(t, amount);
			await callPayment(newKey(), charge.asaasPaymentId);
			return { t, charge };
		}

		it("reverses the whole charge when the balance covers it", async () => {
			const { t, charge } = await paidCharge("100.00");
			expect(
				await callPayment(newKey(), charge.asaasPaymentId, "PAYMENT_REFUNDED"),
			).toBe("refunded");
			expect(await clientBalance(t.client.userId)).toEqual(ZERO);
			expect(await chargeRow(charge.id)).toEqual({
				status: "refunded",
				refund_shortfall: "0.00",
			});
			const reversal = await owner.query(
				"select kind, amount, idempotency_key from client_ledger_entries where client_profile_id = $1 and kind = 'reversal'",
				[t.client.userId],
			);
			expect(reversal.rows).toEqual([
				{
					kind: "reversal",
					amount: "100.00",
					idempotency_key: `pixrefund:${charge.id}`,
				},
			]);
			const audit = await owner.query(
				"select table_name, metadata from audit_logs where action = 'wallet.reversal' and bureau_id = $1",
				[t.bureau.id],
			);
			expect(audit.rows).toEqual([
				{
					table_name: "client_ledger_entries",
					metadata: expect.objectContaining({
						amount: "100.00",
						shortfall: "0.00",
					}),
				},
			]);
		});

		it("takes the reservation for what the available balance does not cover", async () => {
			const { t, charge } = await paidCharge("100.00");
			// O cliente já reservou 70: só 30 estão disponíveis e os outros 70 saem da reserva.
			await owner.query(
				"select * from client_wallet_post_entry($1, 'reserve', 70, $2, null, null, $1)",
				[t.client.userId, newKey()],
			);
			expect(
				await callPayment(newKey(), charge.asaasPaymentId, "PAYMENT_REFUNDED"),
			).toBe("refunded");
			expect(await clientBalance(t.client.userId)).toEqual(ZERO);
			expect(await chargeRow(charge.id)).toEqual({
				status: "refunded",
				refund_shortfall: "0.00",
			});
		});

		it("reverses only what the wallet holds and records the shortfall", async () => {
			const { t, charge } = await paidCharge("100.00");
			// O cliente gastou 70 (reserva e captura): sobram 30.
			for (const kind of ["reserve", "capture"]) {
				await owner.query(
					"select * from client_wallet_post_entry($1, $2, 70, $3, null, null, $1)",
					[t.client.userId, kind, newKey()],
				);
			}
			expect(
				await callPayment(newKey(), charge.asaasPaymentId, "PAYMENT_REFUNDED"),
			).toBe("refunded");
			expect(await clientBalance(t.client.userId)).toEqual(ZERO);
			expect(await chargeRow(charge.id)).toEqual({
				status: "refunded",
				refund_shortfall: "70.00",
			});
		});

		it("records the whole amount as shortfall when the wallet is empty, without a ledger entry", async () => {
			const { t, charge } = await paidCharge("100.00");
			for (const kind of ["reserve", "capture"]) {
				await owner.query(
					"select * from client_wallet_post_entry($1, $2, 100, $3, null, null, $1)",
					[t.client.userId, kind, newKey()],
				);
			}
			expect(
				await callPayment(newKey(), charge.asaasPaymentId, "PAYMENT_REFUNDED"),
			).toBe("refunded");
			expect(await clientBalance(t.client.userId)).toEqual(ZERO);
			expect(await chargeRow(charge.id)).toEqual({
				status: "refunded",
				refund_shortfall: "100.00",
			});
			expect(
				(
					await owner.query(
						"select 1 from client_ledger_entries where client_profile_id = $1 and kind = 'reversal'",
						[t.client.userId],
					)
				).rowCount,
			).toBe(0);
			const audit = await owner.query(
				"select table_name, record_id from audit_logs where action = 'wallet.reversal' and bureau_id = $1",
				[t.bureau.id],
			);
			expect(audit.rows).toEqual([
				{ table_name: "pix_charges", record_id: charge.id },
			]);
		});

		it("handles a duplicated refund event and a refund of an unpaid charge", async () => {
			const { t, charge } = await paidCharge("100.00");
			const eventId = newKey();
			expect(
				await callPayment(eventId, charge.asaasPaymentId, "PAYMENT_REFUNDED"),
			).toBe("refunded");
			expect(
				await callPayment(eventId, charge.asaasPaymentId, "PAYMENT_REFUNDED"),
			).toBe("duplicate");
			expect(
				await callPayment(newKey(), charge.asaasPaymentId, "PAYMENT_REFUNDED"),
			).toBe("duplicate");
			expect(await clientBalance(t.client.userId)).toEqual(ZERO);

			const pending = await clientCharge(t, "20.00");
			expect(
				await callPayment(newKey(), pending.asaasPaymentId, "PAYMENT_REFUNDED"),
			).toBe("ignored");
			expect((await chargeRow(pending.id)).status).toBe("pending");
		});

		it("lets the superadmin see a client charge with an unrecovered refund, and nothing else", async () => {
			const { t, charge } = await paidCharge("100.00");
			for (const kind of ["reserve", "capture"]) {
				await owner.query(
					"select * from client_wallet_post_entry($1, $2, 100, $3, null, null, $1)",
					[t.client.userId, kind, newKey()],
				);
			}
			await callPayment(newKey(), charge.asaasPaymentId, "PAYMENT_REFUNDED");
			await withDbContext(app, superadminCtx(), async (c) => {
				const rows = await c.query(
					"select id from pix_charges where bureau_id = $1",
					[t.bureau.id],
				);
				expect(rows.rows).toEqual([{ id: charge.id }]);
			});
		});
	});
});

describe("role app_webhook (cliente)", () => {
	it("has no access to the new tables or to the client wallet functions", async () => {
		const { rows } = await owner.query<{ relname: string }>(
			`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
          and (has_table_privilege('app_webhook', c.oid, 'select, insert, update, delete, truncate, references, trigger')
               or has_any_column_privilege('app_webhook', c.oid, 'select, insert, update, references'))`,
		);
		expect(rows).toEqual([]);
		await expect(hook.query("select 1 from client_wallets")).rejects.toThrow(
			/permission denied/,
		);
		for (const sql of [
			"select * from client_wallet_post_entry(gen_random_uuid(), 'topup', 5, 'x', null, null, gen_random_uuid())",
			"select * from reserve_order(gen_random_uuid(), 'counter', null, 5, 1, '{}'::jsonb)",
			"select * from capture_order(gen_random_uuid())",
			"select * from release_order(gen_random_uuid())",
			"select * from void_counter_payment(gen_random_uuid(), 'x')",
		]) {
			await expect(hook.query(sql), sql).rejects.toThrow(/permission denied/);
		}
	});

	it("keeps apply_asaas_payment executable only by app_webhook", async () => {
		const sig = "public.apply_asaas_payment(text, text, text, jsonb)";
		const { rows } = await owner.query<Record<string, boolean>>(
			`select has_function_privilege('app_runtime', $1, 'execute') as runtime,
              has_function_privilege('app_webhook', $1, 'execute') as webhook,
              has_function_privilege('public', $1, 'execute') as public_role`,
			[sig],
		);
		expect(rows[0]).toEqual({
			runtime: false,
			webhook: true,
			public_role: false,
		});
	});

	it("keeps the app role from forging a client charge and crediting it", async () => {
		const t = await seedTenant(owner, "FraudeCliente");
		const paymentId = `pay_forged_${randomBytes(4).toString("hex")}`;
		await withDbContext(app, ctxOf(t.client), (c) =>
			c.query(
				`insert into pix_charges (bureau_id, asaas_payment_id, amount, pix_payload, expires_at, requested_by, client_profile_id)
         values ($1, $2, 5000, 'x', now() + interval '30 minutes', $3, $3)`,
				[t.bureau.id, paymentId, t.client.userId],
			),
		);
		await expect(
			app.query(
				"select apply_asaas_payment($1, 'PAYMENT_RECEIVED', $2, '{}'::jsonb)",
				[newKey(), paymentId],
			),
		).rejects.toThrow(/permission denied/);
		expect(await clientBalance(t.client.userId)).toEqual(ZERO);
	});
});

describe("auditoria do ledger do cliente", () => {
	const insertAudit = (
		client: Pick<PoolClient, "query">,
		input: {
			action: string;
			table: string;
			bureauId: string | null;
			userId: string;
			recordId: string | null;
		},
	) =>
		client.query(
			`insert into audit_logs (user_id, action, table_name, record_id, bureau_id)
       values ($1, $2, $3, $4, $5)`,
			[input.userId, input.action, input.table, input.recordId, input.bureauId],
		);

	// Como o dono das funções (com RLS) depois de preparar o estado como superusuário; sempre com rollback.
	async function asDefiner(
		prepare: (c: PoolClient) => Promise<void>,
		work: (c: PoolClient) => Promise<unknown>,
	) {
		const client = await owner.connect();
		try {
			await client.query("begin");
			await prepare(client);
			await client.query("set local role auth_profile_lookup");
			await work(client);
		} finally {
			await client.query("rollback");
			client.release();
		}
	}

	it("keeps wallet.topup and wallet.reversal for the ledger out of reach of the app role", async () => {
		const t = await fundedClient("10.00");
		const entry = await owner.query<{ id: string }>(
			"select id from client_ledger_entries where client_profile_id = $1",
			[t.client.userId],
		);
		for (const action of ["wallet.topup", "wallet.reversal"]) {
			const input = {
				action,
				table: "client_ledger_entries",
				bureauId: t.bureau.id,
				userId: t.client.userId,
				recordId: entry.rows[0].id,
			};
			await expect(insertAudit(app, input), action).rejects.toThrow(
				/permission denied|row-level security/,
			);
			// O superadmin não grava wallet.* para um Bureau; ninguém grava em nome de outro autor.
			await withDbContext(app, superadminCtx(), async (c) => {
				await expect(
					insertAudit(c, { ...input, userId: superadmin.userId }),
					`${action} superadmin`,
				).rejects.toThrow(/row-level security/);
			});
			await withDbContext(app, ctxOf(t.operator), async (c) => {
				await expect(
					insertAudit(c, { ...input, userId: t.client.userId }),
					`${action} other author`,
				).rejects.toThrow(/row-level security/);
			});
		}
	});

	it("lets the function owner audit a client topup only next to its own entry", async () => {
		const a = await seedTenant(owner, "AudTopA");
		const b = await seedTenant(owner, "AudTopB");
		const base = {
			action: "wallet.topup",
			table: "client_ledger_entries",
			bureauId: a.bureau.id,
			userId: a.client.userId,
		};
		let entryId = "";
		const prepare = async (c: PoolClient) => {
			const { rows } = await c.query<{ entry_id: string }>(
				"select entry_id from client_wallet_post_entry($1, 'topup', 5, $2, null, null, $1)",
				[a.client.userId, newKey()],
			);
			entryId = rows[0].entry_id;
		};

		await expect(
			asDefiner(prepare, (c) => insertAudit(c, { ...base, recordId: entryId })),
		).resolves.toBeUndefined();

		const denied: Array<
			[string, Partial<typeof base> & { recordId?: string | null }]
		> = [
			["other author", { userId: a.operator.userId }],
			["other bureau", { bureauId: b.bureau.id }],
			["no bureau", { bureauId: null as unknown as string }],
			["no record", { recordId: null }],
			["foreign table", { table: "client_wallets" }],
			["other action", { action: "wallet.adjust" }],
			["unknown record", { recordId: "00000000-0000-4000-8000-000000000000" }],
		];
		for (const [label, override] of denied) {
			await expect(
				asDefiner(prepare, (c) =>
					insertAudit(c, { ...base, recordId: entryId, ...override }),
				),
				label,
			).rejects.toThrow(/row-level security/);
		}
		// Lançamento que não é topup.
		await expect(
			asDefiner(
				async (c) => {
					await prepare(c);
					const { rows } = await c.query<{ entry_id: string }>(
						"select entry_id from client_wallet_post_entry($1, 'reserve', 1, $2, null, null, $1)",
						[a.client.userId, newKey()],
					);
					entryId = rows[0].entry_id;
				},
				(c) => insertAudit(c, { ...base, recordId: entryId }),
			),
		).rejects.toThrow(/row-level security/);
	});

	it("lets the function owner audit a client reversal only next to its own entry or refunded charge", async () => {
		const a = await fundedClient("50.00");
		const charge = await seedPixCharge(owner, {
			bureauId: a.bureau.id,
			requestedBy: a.client.userId,
			clientProfileId: a.client.userId,
		});
		const base = {
			action: "wallet.reversal",
			bureauId: a.bureau.id,
			userId: a.client.userId,
		};
		let entryId = "";
		const prepare = async (c: PoolClient) => {
			const { rows } = await c.query<{ entry_id: string }>(
				"select entry_id from client_wallet_post_entry($1, 'reversal', 5, $2, null, null, $1)",
				[a.client.userId, newKey()],
			);
			entryId = rows[0].entry_id;
		};

		await expect(
			asDefiner(prepare, (c) =>
				insertAudit(c, {
					...base,
					table: "client_ledger_entries",
					recordId: entryId,
				}),
			),
		).resolves.toBeUndefined();
		await expect(
			asDefiner(
				(c) =>
					c
						.query("update pix_charges set status = 'refunded' where id = $1", [
							charge.id,
						])
						.then(() => undefined),
				(c) =>
					insertAudit(c, {
						...base,
						table: "pix_charges",
						recordId: charge.id,
					}),
			),
		).resolves.toBeUndefined();

		// Cobrança ainda pendente, autor errado e lançamento que não é reversal.
		await expect(
			asDefiner(prepare, (c) =>
				insertAudit(c, { ...base, table: "pix_charges", recordId: charge.id }),
			),
		).rejects.toThrow(/row-level security/);
		await expect(
			asDefiner(prepare, (c) =>
				insertAudit(c, {
					...base,
					userId: a.operator.userId,
					table: "client_ledger_entries",
					recordId: entryId,
				}),
			),
		).rejects.toThrow(/row-level security/);
		await expect(
			asDefiner(
				async (c) => {
					const { rows } = await c.query<{ entry_id: string }>(
						"select entry_id from client_wallet_post_entry($1, 'topup', 5, $2, null, null, $1)",
						[a.client.userId, newKey()],
					);
					entryId = rows[0].entry_id;
				},
				(c) =>
					insertAudit(c, {
						...base,
						table: "client_ledger_entries",
						recordId: entryId,
					}),
			),
		).rejects.toThrow(/row-level security/);
	});
});

// Executa o trecho de backfill da 015 como ela roda: o dono (schema_owner) tem RLS forçado em profiles.
describe("015 client wallet backfill", () => {
	const migration = readFileSync(
		resolve(process.cwd(), "db/migrations/015_client_wallet_settlement.sql"),
		"utf8",
	);
	const backfill =
		migration.split("-- backfill:start")[1]?.split("-- backfill:end")[0] ?? "";

	it("has a backfill block that switches to the gateway role", () => {
		expect(backfill).toContain("set local role auth_profile_lookup");
		expect(backfill).toContain("reset role");
	});

	it("restores the wallet of a client that existed before the migration, proving the RLS blind spot", async () => {
		const tenant = await seedTenant(owner, "BackfillCliente");
		const id = tenant.client.userId;
		await owner.query(
			"delete from client_wallets where client_profile_id = $1",
			[id],
		);

		const client = await owner.connect();
		try {
			await client.query("begin");
			await client.query("set local role schema_owner");
			// Sem a troca de role, o dono forçado pelo RLS não vê nenhum profile.
			await client.query("savepoint blind");
			let seen = 0;
			try {
				const blind = await client.query(
					"insert into client_wallets (client_profile_id, bureau_id) select id, bureau_id from profiles where role = 'client'",
				);
				seen = blind.rowCount ?? 0;
			} catch (error) {
				// profiles avalia políticas que chamam funções que o dono não executa: também é cegueira.
				expect(String(error)).toMatch(/permission denied|row-level security/);
				await client.query("rollback to savepoint blind");
			}
			expect(seen).toBe(0);
			await client.query(backfill);
			await client.query("commit");
		} catch (error) {
			await client.query("rollback");
			throw error;
		} finally {
			client.release();
		}
		expect(await clientBalance(id)).toEqual(ZERO);
	});

	it("keeps an existing wallet untouched and skips staff profiles", async () => {
		const tenant = await fundedClient("40.00");
		await owner.query(backfill);
		expect(await clientBalance(tenant.client.userId)).toEqual({
			available: "40.00",
			reserved: "0.00",
		});
		const staff = await owner.query(
			"select 1 from client_wallets where client_profile_id = any($1)",
			[[tenant.bureauAdmin.userId, tenant.operator.userId]],
		);
		expect(staff.rowCount).toBe(0);
	});
});
