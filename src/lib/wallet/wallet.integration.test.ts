import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL, TEST_DATABASE_WEBHOOK_URL } from "@/test/db-env";
import { leaks } from "@/test/leaks";
import {
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
const adminOf = (t: SeededTenant): Ctx => ({
	userId: t.bureauAdmin.userId,
	role: "bureau_admin",
	bureauId: t.bureau.id,
});
const operatorOf = (t: SeededTenant): Ctx => ({
	userId: t.operator.userId,
	role: "operator",
	bureauId: t.bureau.id,
});
const superadminCtx = (): Ctx => ({
	userId: superadmin.userId,
	role: "superadmin",
	bureauId: null,
});

// Como withDbContext, mas faz commit: as chamadas concorrentes precisam de transações reais.
async function committed<T>(
	ctx: Ctx,
	work: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true),
              set_config('app.user_role', $2, true),
              set_config('app.bureau_id', $3, true),
              set_config('app.support_session_id', '', true)`,
			[ctx.userId, ctx.role, ctx.bureauId ?? ""],
		);
		const result = await work(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

type ApplyRow = {
	ok: boolean;
	reason: string | null;
	entry_id: string | null;
	available: string | null;
	reserved: string | null;
	replayed: boolean;
};

async function apply(
	client: PoolClient,
	bureauId: string,
	kind: string,
	amount: string,
	key: string,
	reason: string | null = null,
): Promise<ApplyRow> {
	const { rows } = await client.query<ApplyRow>(
		"select * from wallet_apply($1, $2, $3, $4, null, $5)",
		[bureauId, kind, amount, key, reason],
	);
	return rows[0];
}

const newKey = () => `k-${randomBytes(6).toString("hex")}`;

async function balance(bureauId: string) {
	const { rows } = await owner.query<{ available: string; reserved: string }>(
		"select available, reserved from wallets where bureau_id = $1",
		[bureauId],
	);
	return rows[0];
}

async function fundedTenant(amount = "100.00") {
	const tenant = await seedTenant(owner, "Carteira");
	await seedWalletTopup(owner, {
		bureauId: tenant.bureau.id,
		amount,
		createdBy: tenant.bureauAdmin.userId,
	});
	return tenant;
}

describe("wallet_apply (saldo)", () => {
	it("creates an empty wallet with every bureau", async () => {
		const tenant = await seedTenant(owner, "Carteira vazia");
		expect(await balance(tenant.bureau.id)).toEqual({
			available: "0.00",
			reserved: "0.00",
		});
	});

	it("moves available and reserved as each kind requires", async () => {
		const tenant = await fundedTenant("100.00");
		const id = tenant.bureau.id;

		await committed(adminOf(tenant), async (c) => {
			const reserve = await apply(c, id, "reserve", "30.00", newKey());
			expect(reserve).toMatchObject({
				ok: true,
				available: "70.00",
				reserved: "30.00",
				replayed: false,
			});
			const capture = await apply(c, id, "capture", "10.00", newKey());
			expect(capture).toMatchObject({ available: "70.00", reserved: "20.00" });
			const release = await apply(c, id, "release", "5.00", newKey());
			expect(release).toMatchObject({ available: "75.00", reserved: "15.00" });
		});

		await committed(superadminCtx(), async (c) => {
			const credit = await apply(
				c,
				id,
				"adjustment",
				"10.00",
				newKey(),
				"bônus",
			);
			expect(credit).toMatchObject({ ok: true, available: "85.00" });
			const debit = await apply(
				c,
				id,
				"adjustment",
				"-20.00",
				newKey(),
				"estorno",
			);
			expect(debit).toMatchObject({
				ok: true,
				available: "65.00",
				reserved: "15.00",
			});
		});

		expect(await balance(id)).toEqual({
			available: "65.00",
			reserved: "15.00",
		});
	});

	it("concurrent reserves never overdraw", async () => {
		const tenant = await fundedTenant("100.00");
		const id = tenant.bureau.id;

		const results = await Promise.all(
			[0, 1].map(() =>
				committed(adminOf(tenant), (c) =>
					apply(c, id, "reserve", "60.00", newKey()),
				),
			),
		);

		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => !r.ok).map((r) => r.reason)).toEqual([
			"insufficient_balance",
		]);
		expect(await balance(id)).toEqual({
			available: "40.00",
			reserved: "60.00",
		});
	});

	it("rejects reserve without balance and capture or release above the reservation", async () => {
		const tenant = await fundedTenant("50.00");
		const id = tenant.bureau.id;

		await withDbContext(app, adminOf(tenant), async (c) => {
			expect(await apply(c, id, "reserve", "50.01", newKey())).toMatchObject({
				ok: false,
				reason: "insufficient_balance",
				entry_id: null,
			});
			await apply(c, id, "reserve", "20.00", newKey());
			expect(await apply(c, id, "capture", "20.01", newKey())).toMatchObject({
				ok: false,
				reason: "reservation_exceeded",
			});
			expect(await apply(c, id, "release", "20.01", newKey())).toMatchObject({
				ok: false,
				reason: "reservation_exceeded",
			});
		});
		await withDbContext(app, superadminCtx(), async (c) => {
			expect(
				await apply(c, id, "adjustment", "-50.01", newKey(), "excede"),
			).toMatchObject({ ok: false, reason: "insufficient_balance" });
		});
		expect(await balance(id)).toEqual({ available: "50.00", reserved: "0.00" });
	});

	it("rejects out-of-range amounts and a blank key", async () => {
		const tenant = await fundedTenant("50.00");
		const id = tenant.bureau.id;
		await withDbContext(app, adminOf(tenant), async (c) => {
			for (const amount of ["0", "-1.00", "100000000.00", "1.005"]) {
				expect(await apply(c, id, "reserve", amount, newKey())).toMatchObject({
					ok: false,
					reason: "invalid_amount",
				});
			}
			expect(await apply(c, id, "reserve", "1.00", "  ")).toMatchObject({
				ok: false,
				reason: "invalid_key",
			});
		});
	});

	it("rejects a key with the pix: prefix, which the webhook credit owns", async () => {
		const tenant = await fundedTenant("50.00");
		const id = tenant.bureau.id;
		await withDbContext(app, adminOf(tenant), async (c) => {
			expect(
				await apply(
					c,
					id,
					"reserve",
					"1.00",
					`pix:${randomBytes(4).toString("hex")}`,
				),
			).toMatchObject({
				ok: false,
				reason: "invalid_key",
			});
		});
		expect(await balance(id)).toEqual({ available: "50.00", reserved: "0.00" });
	});

	it("replays the same key without changing the balance and rejects a changed request", async () => {
		const tenant = await fundedTenant("100.00");
		const id = tenant.bureau.id;
		const key = newKey();

		await withDbContext(app, adminOf(tenant), async (c) => {
			const first = await apply(c, id, "reserve", "30.00", key);
			const again = await apply(c, id, "reserve", "30.00", key);
			expect(again).toMatchObject({
				ok: true,
				replayed: true,
				entry_id: first.entry_id,
				available: "70.00",
				reserved: "30.00",
			});
			expect(await apply(c, id, "reserve", "31.00", key)).toMatchObject({
				ok: false,
				reason: "idempotency_conflict",
			});
			expect(await apply(c, id, "release", "30.00", key)).toMatchObject({
				ok: false,
				reason: "idempotency_conflict",
			});
			const count = await c.query(
				"select 1 from ledger_entries where bureau_id = $1 and idempotency_key = $2",
				[id, key],
			);
			expect(count.rowCount).toBe(1);
			const wallet = await c.query(
				"select available, reserved from wallets where bureau_id = $1",
				[id],
			);
			expect(wallet.rows[0]).toEqual({ available: "70.00", reserved: "30.00" });
		});
	});

	it("allows the same key in different bureaus", async () => {
		const a = await fundedTenant("10.00");
		const b = await fundedTenant("10.00");
		const key = newKey();
		const first = await withDbContext(app, adminOf(a), (c) =>
			apply(c, a.bureau.id, "reserve", "1.00", key),
		);
		const second = await withDbContext(app, adminOf(b), (c) =>
			apply(c, b.bureau.id, "reserve", "1.00", key),
		);
		expect(first).toMatchObject({ ok: true, replayed: false });
		expect(second).toMatchObject({ ok: true, replayed: false });
	});
});

describe("wallet_apply (autorização)", () => {
	it("refuses topup, adjustment by a bureau admin, foreign bureaus and missing context", async () => {
		const a = await fundedTenant("100.00");
		const b = await fundedTenant("100.00");

		await withDbContext(app, adminOf(a), async (c) => {
			expect(
				await apply(c, a.bureau.id, "topup", "10.00", newKey()),
			).toMatchObject({
				ok: false,
				reason: "not_allowed",
			});
			expect(
				await apply(c, a.bureau.id, "adjustment", "10.00", newKey(), "x"),
			).toMatchObject({ ok: false, reason: "not_allowed" });
			expect(
				await apply(c, b.bureau.id, "reserve", "10.00", newKey()),
			).toMatchObject({
				ok: false,
				reason: "not_allowed",
			});
		});
		await withDbContext(app, superadminCtx(), async (c) => {
			expect(
				await apply(c, a.bureau.id, "topup", "10.00", newKey()),
			).toMatchObject({
				ok: false,
				reason: "not_allowed",
			});
			// Superadmin sem suporte não tem Bureau no contexto: só o ajuste é permitido.
			expect(
				await apply(c, a.bureau.id, "reserve", "10.00", newKey()),
			).toMatchObject({
				ok: false,
				reason: "not_allowed",
			});
		});
		const noContext = await app.query<ApplyRow>(
			"select * from wallet_apply($1, 'reserve', 1, $2, null, null)",
			[a.bureau.id, newKey()],
		);
		expect(noContext.rows[0]).toMatchObject({
			ok: false,
			reason: "not_allowed",
		});
		expect(await balance(a.bureau.id)).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
		expect(await balance(b.bureau.id)).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
	});

	it("requires a reason for adjustment", async () => {
		const tenant = await fundedTenant("10.00");
		await withDbContext(app, superadminCtx(), async (c) => {
			for (const reason of [null, "", "   "]) {
				expect(
					await apply(
						c,
						tenant.bureau.id,
						"adjustment",
						"5.00",
						newKey(),
						reason,
					),
				).toMatchObject({ ok: false, reason: "reason_required" });
			}
		});
	});

	it("keeps wallet_post_entry and direct writes away from the runtime role", async () => {
		const tenant = await fundedTenant("10.00");
		await expect(
			withDbContext(app, adminOf(tenant), (c) =>
				c.query(
					"select * from wallet_post_entry($1, 'topup', 5, 'x', null, null, $2)",
					[tenant.bureau.id, tenant.bureauAdmin.userId],
				),
			),
		).rejects.toThrow(/permission denied/);
		await expect(
			withDbContext(app, adminOf(tenant), (c) =>
				c.query("update wallets set available = 999 where bureau_id = $1", [
					tenant.bureau.id,
				]),
			),
		).rejects.toThrow(/permission denied/);
		await expect(
			withDbContext(app, adminOf(tenant), (c) =>
				c.query(
					`insert into ledger_entries (bureau_id, kind, amount, available_after, reserved_after, idempotency_key, created_by)
           values ($1, 'topup', 5, 5, 0, 'direto', $2)`,
					[tenant.bureau.id, tenant.bureauAdmin.userId],
				),
			),
		).rejects.toThrow(/permission denied/);
	});
});

describe("ledger_entries (imutabilidade e conciliação)", () => {
	it("blocks UPDATE and DELETE for the app role and for the owner", async () => {
		const tenant = await fundedTenant("10.00");
		const id = tenant.bureau.id;

		for (const sql of [
			"update ledger_entries set amount = 1 where bureau_id = $1",
			"delete from ledger_entries where bureau_id = $1",
		]) {
			await expect(
				withDbContext(app, adminOf(tenant), (c) => c.query(sql, [id])),
			).rejects.toThrow(/permission denied/);
			await expect(owner.query(sql, [id])).rejects.toThrow(/immutable/);
		}
		await expect(owner.query("truncate ledger_entries")).rejects.toThrow(
			/immutable/,
		);
	});

	it("keeps the sum of entries equal to available plus reserved", async () => {
		const tenant = await fundedTenant("200.00");
		const id = tenant.bureau.id;

		await committed(adminOf(tenant), async (c) => {
			await apply(c, id, "reserve", "80.00", newKey());
			await apply(c, id, "capture", "30.00", newKey());
			await apply(c, id, "release", "10.00", newKey());
		});
		await committed(superadminCtx(), async (c) => {
			await apply(c, id, "adjustment", "-15.50", newKey(), "correção");
			await apply(c, id, "adjustment", "4.25", newKey(), "correção");
		});

		const { rows } = await owner.query<{
			net: string;
			total: string;
			last_total: string;
		}>(
			`select
         (select sum(case kind when 'topup' then amount when 'capture' then -amount
                                when 'reversal' then -amount
                                when 'adjustment' then amount else 0 end)
            from ledger_entries where bureau_id = $1) as net,
         w.available + w.reserved as total,
         (select available_after + reserved_after from ledger_entries
           where bureau_id = $1 order by seq desc limit 1) as last_total
       from wallets w where w.bureau_id = $1`,
			[id],
		);
		expect(rows[0].net).toBe(rows[0].total);
		expect(rows[0].net).toBe("158.75");
		expect(rows[0].last_total).toBe("158.75");
	});
});

describe("RLS da carteira", () => {
	it("isolates wallets, ledger, charges and webhook events between bureaus", async () => {
		const a = await fundedTenant("10.00");
		const b = await fundedTenant("20.00");
		const chargeB = await seedPixCharge(owner, {
			bureauId: b.bureau.id,
			requestedBy: b.bureauAdmin.userId,
		});
		await owner.query(
			`insert into asaas_webhook_events (bureau_id, event_id, event_type, asaas_payment_id, payload, result)
       values ($1, $2, 'PAYMENT_RECEIVED', $3, '{}'::jsonb, 'credited')`,
			[b.bureau.id, newKey(), chargeB.asaasPaymentId],
		);

		await withDbContext(app, adminOf(a), async (c) => {
			const wallets = await c.query("select bureau_id from wallets");
			expect(wallets.rows.map((r) => r.bureau_id)).toEqual([a.bureau.id]);
			const ledger = await c.query(
				"select distinct bureau_id from ledger_entries",
			);
			expect(ledger.rows.map((r) => r.bureau_id)).toEqual([a.bureau.id]);
			expect((await c.query("select 1 from pix_charges")).rowCount).toBe(0);
			expect(
				(await c.query("select 1 from asaas_webhook_events")).rowCount,
			).toBe(0);
		});
		await withDbContext(app, adminOf(b), async (c) => {
			expect((await c.query("select 1 from pix_charges")).rowCount).toBe(1);
			expect(
				(await c.query("select 1 from asaas_webhook_events")).rowCount,
			).toBe(1);
			await expect(
				c.query("select payload from asaas_webhook_events"),
			).rejects.toThrow(/permission denied/);
		});

		const insertCharge = (ctx: Ctx, bureauId: string, requestedBy: string) =>
			withDbContext(app, ctx, (c) =>
				c.query(
					`insert into pix_charges (bureau_id, asaas_payment_id, amount, pix_payload, expires_at, requested_by)
           values ($1, $2, '50.00', 'x', now() + interval '30 minutes', $3)`,
					[bureauId, newKey(), requestedBy],
				),
			);
		await expect(
			insertCharge(adminOf(a), b.bureau.id, b.bureauAdmin.userId),
		).rejects.toThrow(/row-level security|violates/);
		await expect(
			insertCharge(operatorOf(a), a.bureau.id, a.operator.userId),
		).rejects.toThrow(/row-level security/);
		await expect(
			insertCharge(adminOf(a), a.bureau.id, a.bureauAdmin.userId),
		).resolves.toBeDefined();
	});

	it("lets the operator read the wallet but hides it from the client", async () => {
		const tenant = await fundedTenant("10.00");
		await withDbContext(app, operatorOf(tenant), async (c) => {
			expect((await c.query("select 1 from wallets")).rowCount).toBe(1);
		});
		await withDbContext(
			app,
			{
				userId: tenant.client.userId,
				role: "client",
				bureauId: tenant.bureau.id,
			},
			async (c) => {
				expect((await c.query("select 1 from wallets")).rowCount).toBe(0);
				expect((await c.query("select 1 from ledger_entries")).rowCount).toBe(
					0,
				);
			},
		);
	});

	it("lets the superadmin without support read wallets and ledger only", async () => {
		const a = await fundedTenant("10.00");
		const b = await fundedTenant("20.00");
		await seedPixCharge(owner, {
			bureauId: a.bureau.id,
			requestedBy: a.bureauAdmin.userId,
		});

		await withDbContext(app, superadminCtx(), async (c) => {
			const wallets = await c.query(
				"select bureau_id from wallets where bureau_id = any($1)",
				[[a.bureau.id, b.bureau.id]],
			);
			expect(wallets.rowCount).toBe(2);
			const ledger = await c.query(
				"select distinct bureau_id from ledger_entries where bureau_id = any($1)",
				[[a.bureau.id, b.bureau.id]],
			);
			expect(ledger.rowCount).toBe(2);
			for (const table of [
				"holders",
				"bureau_catalog_items",
				"asaas_webhook_events",
			]) {
				expect((await c.query(`select 1 from ${table}`)).rowCount).toBe(0);
			}
			// Só as cobranças com estorno não recuperado (pix_charges_select_shortfall) são visíveis.
			expect(
				(await c.query("select 1 from pix_charges where refund_shortfall = 0")).rowCount,
			).toBe(0);
		});
	});
});

describe("apply_asaas_payment", () => {
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

	async function chargeState(id: string) {
		const { rows } = await owner.query<{ status: string }>(
			"select status from pix_charges where id = $1",
			[id],
		);
		return rows[0].status;
	}

	it("credits a pending charge once and records the audit event", async () => {
		const tenant = await seedTenant(owner, "Webhook");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			amount: "123.45",
		});
		const eventId = newKey();

		// O valor do corpo do webhook é ignorado: vale pix_charges.amount.
		expect(
			await callPayment(eventId, charge.asaasPaymentId, "PAYMENT_RECEIVED", {
				value: 9999,
			}),
		).toBe("credited");
		expect(await balance(tenant.bureau.id)).toEqual({
			available: "123.45",
			reserved: "0.00",
		});
		expect(await chargeState(charge.id)).toBe("paid");

		const entry = await owner.query(
			"select id, kind, amount, created_by, reference from ledger_entries where bureau_id = $1",
			[tenant.bureau.id],
		);
		expect(entry.rows).toEqual([
			expect.objectContaining({
				kind: "topup",
				amount: "123.45",
				created_by: tenant.bureauAdmin.userId,
				reference: `pix_charge:${charge.id}`,
			}),
		]);
		const audit = await owner.query(
			"select user_id, bureau_id, table_name, record_id, metadata from audit_logs where action = 'wallet.topup' and bureau_id = $1",
			[tenant.bureau.id],
		);
		expect(audit.rows).toHaveLength(1);
		expect(audit.rows[0]).toMatchObject({
			user_id: tenant.bureauAdmin.userId,
			table_name: "ledger_entries",
			record_id: entry.rows[0].id,
		});
		expect(audit.rows[0].metadata).toMatchObject({ source: "asaas_webhook" });
		expect(leaks(JSON.stringify(audit.rows[0].metadata), "9999")).toBe(false);

		const stored = await owner.query(
			"select result from asaas_webhook_events where event_id = $1",
			[eventId],
		);
		expect(stored.rows).toEqual([{ result: "credited" }]);

		// Mesmo evento outra vez, e outro evento da mesma cobrança já paga.
		expect(await callPayment(eventId, charge.asaasPaymentId)).toBe("duplicate");
		expect(
			await callPayment(newKey(), charge.asaasPaymentId, "PAYMENT_CONFIRMED"),
		).toBe("duplicate");
		expect(await balance(tenant.bureau.id)).toEqual({
			available: "123.45",
			reserved: "0.00",
		});
	});

	it("parallel duplicate events credit once", async () => {
		const tenant = await seedTenant(owner, "Webhook paralelo");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			amount: "50.00",
		});
		const eventId = newKey();
		const sameEvent = await Promise.all([
			callPayment(eventId, charge.asaasPaymentId),
			callPayment(eventId, charge.asaasPaymentId),
		]);
		expect([...sameEvent].sort()).toEqual(["credited", "duplicate"]);

		const other = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			amount: "20.00",
		});
		const twoEvents = await Promise.all([
			callPayment(newKey(), other.asaasPaymentId, "PAYMENT_RECEIVED"),
			callPayment(newKey(), other.asaasPaymentId, "PAYMENT_CONFIRMED"),
		]);
		expect([...twoEvents].sort()).toEqual(["credited", "duplicate"]);
		expect(await balance(tenant.bureau.id)).toEqual({
			available: "70.00",
			reserved: "0.00",
		});
	});

	it("credits a charge that expired and ignores cancelled, unknown and non-payment events", async () => {
		const tenant = await seedTenant(owner, "Webhook estados");
		const base = {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
		};
		const expired = await seedPixCharge(owner, {
			...base,
			amount: "30.00",
			status: "expired",
		});
		const lapsed = await seedPixCharge(owner, {
			...base,
			amount: "15.00",
			expiresAt: new Date(Date.now() - 60_000),
		});
		const cancelled = await seedPixCharge(owner, {
			...base,
			amount: "40.00",
			status: "cancelled",
		});
		const pending = await seedPixCharge(owner, { ...base, amount: "25.00" });

		expect(await callPayment(newKey(), expired.asaasPaymentId)).toBe(
			"credited",
		);
		expect(await callPayment(newKey(), lapsed.asaasPaymentId)).toBe("credited");
		expect(await callPayment(newKey(), cancelled.asaasPaymentId)).toBe(
			"ignored",
		);
		expect(
			await callPayment(newKey(), pending.asaasPaymentId, "PAYMENT_CREATED"),
		).toBe("ignored");
		expect(await callPayment(newKey(), "pay_desconhecido")).toBe(
			"unknown_charge",
		);

		expect(await chargeState(cancelled.id)).toBe("cancelled");
		expect(await chargeState(pending.id)).toBe("pending");
		expect(await balance(tenant.bureau.id)).toEqual({
			available: "45.00",
			reserved: "0.00",
		});

		const unknown = await owner.query(
			"select bureau_id, result from asaas_webhook_events where asaas_payment_id = 'pay_desconhecido'",
		);
		expect(unknown.rows[0]).toEqual({
			bureau_id: null,
			result: "unknown_charge",
		});
	});

	it("rejects charges outside the allowed amount range", async () => {
		const tenant = await seedTenant(owner, "Faixa");
		for (const amount of ["9.99", "5000.01"]) {
			await expect(
				seedPixCharge(owner, {
					bureauId: tenant.bureau.id,
					requestedBy: tenant.bureauAdmin.userId,
					amount,
				}),
			).rejects.toThrow(/check constraint/);
		}
		await expect(
			seedPixCharge(owner, {
				bureauId: tenant.bureau.id,
				requestedBy: tenant.bureauAdmin.userId,
				amount: "10.00",
			}),
		).resolves.toBeDefined();
	});
});

const payHook = (eventId: string, paymentId: string, type: string) =>
	hook
		.query<{ apply_asaas_payment: string }>(
			"select apply_asaas_payment($1, $2, $3, '{}'::jsonb)",
			[eventId, type, paymentId],
		)
		.then((r) => r.rows[0].apply_asaas_payment);

describe("apply_asaas_payment (estorno)", () => {
	async function paidCharge(tenant: SeededTenant, amount = "100.00") {
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			amount,
		});
		expect(await payHook(newKey(), charge.asaasPaymentId, "PAYMENT_RECEIVED")).toBe("credited");
		return charge;
	}
	const refund = (paymentId: string, eventId = newKey()) => payHook(eventId, paymentId, "PAYMENT_REFUNDED");
	async function charge(id: string) {
		const { rows } = await owner.query<{ status: string; refund_shortfall: string }>(
			"select status, refund_shortfall from pix_charges where id = $1",
			[id],
		);
		return rows[0];
	}
	const reversals = async (bureauId: string) =>
		(
			await owner.query(
				"select amount, idempotency_key, reference, created_by, available_after, reserved_after from ledger_entries where bureau_id = $1 and kind = 'reversal'",
				[bureauId],
			)
		).rows;

	it("reverses the whole amount when the balance covers it", async () => {
		const tenant = await seedTenant(owner, "Estorno cheio");
		const c = await paidCharge(tenant, "100.00");
		const eventId = newKey();

		expect(await refund(c.asaasPaymentId, eventId)).toBe("refunded");

		expect(await balance(tenant.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
		expect(await charge(c.id)).toEqual({ status: "refunded", refund_shortfall: "0.00" });
		expect(await reversals(tenant.bureau.id)).toEqual([
			{
				amount: "100.00",
				idempotency_key: `pixrefund:${c.id}`,
				reference: `pix_charge:${c.id}`,
				created_by: tenant.bureauAdmin.userId,
				available_after: "0.00",
				reserved_after: "0.00",
			},
		]);
		const entry = await owner.query("select id from ledger_entries where bureau_id = $1 and kind = 'reversal'", [tenant.bureau.id]);
		const audit = await owner.query(
			"select user_id, table_name, record_id, metadata from audit_logs where action = 'wallet.reversal' and bureau_id = $1",
			[tenant.bureau.id],
		);
		expect(audit.rows).toHaveLength(1);
		expect(audit.rows[0]).toMatchObject({
			user_id: tenant.bureauAdmin.userId,
			table_name: "ledger_entries",
			record_id: entry.rows[0].id,
		});
		expect(audit.rows[0].metadata).toMatchObject({ source: "asaas_webhook", amount: "100.00", shortfall: "0.00" });
		const stored = await owner.query("select result from asaas_webhook_events where event_id = $1", [eventId]);
		expect(stored.rows).toEqual([{ result: "refunded" }]);
	});

	it("reverses only what is available and records the shortfall", async () => {
		const tenant = await seedTenant(owner, "Estorno parcial");
		const c = await paidCharge(tenant, "100.00");
		await committed(superadminCtx(), (cl) => apply(cl, tenant.bureau.id, "adjustment", "-30.00", newKey(), "saque"));

		expect(await refund(c.asaasPaymentId)).toBe("refunded");

		expect(await balance(tenant.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
		expect(await charge(c.id)).toEqual({ status: "refunded", refund_shortfall: "30.00" });
		expect((await reversals(tenant.bureau.id)).map((r) => r.amount)).toEqual(["70.00"]);
	});

	it("takes the reservation for what the available balance does not cover", async () => {
		const tenant = await seedTenant(owner, "Estorno reservado");
		const c = await paidCharge(tenant, "100.00");
		await committed(adminOf(tenant), (cl) => apply(cl, tenant.bureau.id, "reserve", "60.00", newKey()));

		expect(await refund(c.asaasPaymentId)).toBe("refunded");

		expect(await balance(tenant.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
		expect(await charge(c.id)).toEqual({ status: "refunded", refund_shortfall: "0.00" });
		expect(await reversals(tenant.bureau.id)).toEqual([
			expect.objectContaining({ amount: "100.00", available_after: "0.00", reserved_after: "0.00" }),
		]);
	});

	it("writes no ledger row when nothing is held, only the shortfall and an audit on the charge", async () => {
		const tenant = await seedTenant(owner, "Estorno zero");
		const c = await paidCharge(tenant, "100.00");
		await committed(adminOf(tenant), async (cl) => {
			await apply(cl, tenant.bureau.id, "reserve", "100.00", newKey());
			await apply(cl, tenant.bureau.id, "capture", "100.00", newKey());
		});

		expect(await refund(c.asaasPaymentId)).toBe("refunded");

		expect(await balance(tenant.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
		expect(await charge(c.id)).toEqual({ status: "refunded", refund_shortfall: "100.00" });
		expect(await reversals(tenant.bureau.id)).toEqual([]);
		const audit = await owner.query(
			"select table_name, record_id, metadata from audit_logs where action = 'wallet.reversal' and bureau_id = $1",
			[tenant.bureau.id],
		);
		expect(audit.rows).toHaveLength(1);
		expect(audit.rows[0]).toMatchObject({ table_name: "pix_charges", record_id: c.id });
		expect(audit.rows[0].metadata).toMatchObject({ amount: "0.00", shortfall: "100.00" });
	});

	it("applies a refund once: same event, other event and a late payment event are duplicates", async () => {
		const tenant = await seedTenant(owner, "Estorno duplicado");
		const c = await paidCharge(tenant, "100.00");
		const eventId = newKey();

		expect(await refund(c.asaasPaymentId, eventId)).toBe("refunded");
		expect(await refund(c.asaasPaymentId, eventId)).toBe("duplicate");
		expect(await refund(c.asaasPaymentId)).toBe("duplicate");
		// Um PAYMENT_RECEIVED atrasado não pode creditar de novo uma cobrança estornada.
		expect(await payHook(newKey(), c.asaasPaymentId, "PAYMENT_RECEIVED")).toBe("duplicate");

		expect(await balance(tenant.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
		expect(await reversals(tenant.bureau.id)).toHaveLength(1);
	});

	it("parallel refund events reverse once", async () => {
		const tenant = await seedTenant(owner, "Estorno paralelo");
		const c = await paidCharge(tenant, "100.00");

		const results = await Promise.all([refund(c.asaasPaymentId), refund(c.asaasPaymentId)]);

		expect([...results].sort()).toEqual(["duplicate", "refunded"]);
		expect(await reversals(tenant.bureau.id)).toHaveLength(1);
		expect(await balance(tenant.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
	});

	it("ignores a refund for an expired or cancelled charge, and unknown charges", async () => {
		const tenant = await seedTenant(owner, "Estorno sem pagamento");
		const base = { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId };
		const expired = await seedPixCharge(owner, { ...base, status: "expired" });
		const cancelled = await seedPixCharge(owner, { ...base, status: "cancelled" });

		for (const c of [expired, cancelled]) {
			expect(await refund(c.asaasPaymentId)).toBe("ignored");
		}
		expect(await refund("pay_desconhecido_estorno")).toBe("unknown_charge");

		expect((await charge(expired.id)).status).toBe("expired");
		expect((await charge(cancelled.id)).status).toBe("cancelled");
		expect(await reversals(tenant.bureau.id)).toEqual([]);
	});

	it("marks a pending charge refunded without moving money, so a late payment event does not credit it", async () => {
		const tenant = await seedTenant(owner, "Estorno antes do pagamento");
		const pending = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
		});

		expect(await refund(pending.asaasPaymentId)).toBe("ignored");
		expect(await charge(pending.id)).toEqual({ status: "refunded", refund_shortfall: "0.00" });

		// O pagamento chega depois do estorno (eventos fora de ordem): não credita o PIX estornado.
		expect(await payHook(newKey(), pending.asaasPaymentId, "PAYMENT_RECEIVED")).toBe("duplicate");
		expect(await balance(tenant.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
		expect(await reversals(tenant.bureau.id)).toEqual([]);
		expect((await charge(pending.id)).status).toBe("refunded");
		// Repetição do estorno com outro id de evento.
		expect(await refund(pending.asaasPaymentId)).toBe("duplicate");
	});

	it("ignores PAYMENT_DELETED and PAYMENT_REFUND_IN_PROGRESS on a paid charge", async () => {
		const tenant = await seedTenant(owner, "Estorno outros eventos");
		const c = await paidCharge(tenant, "100.00");

		for (const type of ["PAYMENT_DELETED", "PAYMENT_REFUND_IN_PROGRESS"]) {
			expect(await payHook(newKey(), c.asaasPaymentId, type)).toBe("ignored");
		}

		expect((await charge(c.id)).status).toBe("paid");
		expect(await balance(tenant.bureau.id)).toEqual({ available: "100.00", reserved: "0.00" });
	});

	it("records PAYMENT_PARTIALLY_REFUNDED as partial_refund_ignored and moves no money", async () => {
		const tenant = await seedTenant(owner, "Estorno parcial");
		const c = await paidCharge(tenant, "100.00");
		const key = newKey();

		expect(await payHook(key, c.asaasPaymentId, "PAYMENT_PARTIALLY_REFUNDED")).toBe("partial_refund_ignored");

		const { rows } = await owner.query<{ result: string; payload: unknown }>(
			"select result, payload from asaas_webhook_events where event_id = $1",
			[key],
		);
		expect(rows).toEqual([{ result: "partial_refund_ignored", payload: expect.anything() }]);
		expect((await charge(c.id)).status).toBe("paid");
		expect(await balance(tenant.bureau.id)).toEqual({ available: "100.00", reserved: "0.00" });
		expect(await reversals(tenant.bureau.id)).toEqual([]);
		// Repetir o mesmo evento segue idempotente.
		expect(await payHook(key, c.asaasPaymentId, "PAYMENT_PARTIALLY_REFUNDED")).toBe("duplicate");
	});

	it("keeps entries equal to available plus reserved after a reversal", async () => {
		const tenant = await seedTenant(owner, "Estorno conciliação");
		const c = await paidCharge(tenant, "100.00");
		await paidCharge(tenant, "50.00");
		await committed(adminOf(tenant), (cl) => apply(cl, tenant.bureau.id, "reserve", "20.00", newKey()));
		await refund(c.asaasPaymentId);

		const { rows } = await owner.query<{ net: string; total: string }>(
			`select
         (select sum(case kind when 'topup' then amount when 'capture' then -amount
                                when 'reversal' then -amount
                                when 'adjustment' then amount else 0 end)
            from ledger_entries where bureau_id = $1) as net,
         w.available + w.reserved as total
       from wallets w where w.bureau_id = $1`,
			[tenant.bureau.id],
		);
		expect(rows[0].net).toBe(rows[0].total);
		expect(rows[0].net).toBe("50.00");
	});

	it("blocks the pixrefund: key from the session path", async () => {
		const tenant = await fundedTenant("50.00");
		await withDbContext(app, adminOf(tenant), async (c) => {
			expect(await apply(c, tenant.bureau.id, "reserve", "1.00", `pixrefund:${randomBytes(4).toString("hex")}`)).toMatchObject({
				ok: false,
				reason: "invalid_key",
			});
		});
	});

	it("refuses a reversal through wallet_apply", async () => {
		const tenant = await fundedTenant("50.00");
		await withDbContext(app, adminOf(tenant), async (c) => {
			expect(await apply(c, tenant.bureau.id, "reversal", "1.00", newKey())).toMatchObject({
				ok: false,
				reason: "not_allowed",
			});
		});
	});
});

describe("webhook event storage", () => {
	it("keeps the payload for a known charge and drops it for an unknown one", async () => {
		const tenant = await seedTenant(owner, "Payload");
		const c = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });
		const known = newKey();
		const unknown = newKey();
		const body = JSON.stringify({ hello: "world" });
		await hook.query("select apply_asaas_payment($1, 'PAYMENT_CREATED', $2, $3::jsonb)", [known, c.asaasPaymentId, body]);
		await hook.query("select apply_asaas_payment($1, 'PAYMENT_RECEIVED', 'pay_sem_cobranca', $2::jsonb)", [unknown, body]);

		const { rows } = await owner.query<{ event_id: string; payload: unknown; result: string }>(
			"select event_id, payload, result from asaas_webhook_events where event_id = any($1)",
			[[known, unknown]],
		);
		const byId = Object.fromEntries(rows.map((r) => [r.event_id, r]));
		expect(byId[known]).toMatchObject({ payload: { hello: "world" }, result: "ignored" });
		expect(byId[unknown]).toMatchObject({ payload: null, result: "unknown_charge" });
	});
});

describe("role app_webhook", () => {
	it("is the only role that executes apply_asaas_payment", async () => {
		const sig = "public.apply_asaas_payment(text, text, text, jsonb)";
		const { rows } = await owner.query<Record<string, boolean>>(
			`select has_function_privilege('app_runtime', $1, 'execute') as runtime,
              has_function_privilege('app_webhook', $1, 'execute') as webhook,
              has_function_privilege('public', $1, 'execute') as public_role`,
			[sig],
		);
		expect(rows[0]).toEqual({ runtime: false, webhook: true, public_role: false });

		await expect(
			app.query("select apply_asaas_payment($1, 'PAYMENT_RECEIVED', 'pay_x', '{}'::jsonb)", [newKey()]),
		).rejects.toThrow(/permission denied/);
	});

	it("has no table or column privilege and no other function", async () => {
		const { rows } = await owner.query<{ relname: string }>(
			`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S')
          and (has_table_privilege('app_webhook', c.oid, 'select, insert, update, delete, truncate, references, trigger')
               or has_any_column_privilege('app_webhook', c.oid, 'select, insert, update, references'))`,
		);
		expect(rows).toEqual([]);

		await expect(hook.query("select 1 from pix_charges")).rejects.toThrow(/permission denied/);
		await expect(hook.query("select 1 from wallets")).rejects.toThrow(/permission denied/);
		await expect(
			hook.query(
				`insert into pix_charges (bureau_id, asaas_payment_id, amount, pix_payload, expires_at, requested_by)
         values (gen_random_uuid(), 'pay_fake', 50, 'x', now(), gen_random_uuid())`,
			),
		).rejects.toThrow(/permission denied/);
		await expect(
			hook.query("select * from wallet_post_entry(gen_random_uuid(), 'topup', 5, 'x', null, null, gen_random_uuid())"),
		).rejects.toThrow(/permission denied/);
		await expect(
			hook.query("select * from wallet_apply(gen_random_uuid(), 'reserve', 5, 'x', null, null)"),
		).rejects.toThrow(/permission denied/);
	});

	it("is a plain login role without superuser or RLS bypass", async () => {
		const { rows } = await owner.query(
			"select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin from pg_roles where rolname = 'app_webhook'",
		);
		expect(rows[0]).toEqual({
			rolsuper: false,
			rolbypassrls: false,
			rolcreaterole: false,
			rolcreatedb: false,
			rolcanlogin: true,
		});
	});

	it("keeps the app role from forging a charge and crediting it", async () => {
		const tenant = await seedTenant(owner, "Fraude");
		const paymentId = `pay_forged_${randomBytes(4).toString("hex")}`;
		await withDbContext(app, adminOf(tenant), (c) =>
			c.query(
				`insert into pix_charges (bureau_id, asaas_payment_id, amount, pix_payload, expires_at, requested_by)
         values ($1, $2, 5000, 'x', now() + interval '30 minutes', $3)`,
				[tenant.bureau.id, paymentId, tenant.bureauAdmin.userId],
			),
		);
		await expect(
			app.query("select apply_asaas_payment($1, 'PAYMENT_RECEIVED', $2, '{}'::jsonb)", [newKey(), paymentId]),
		).rejects.toThrow(/permission denied/);
		expect(await balance(tenant.bureau.id)).toEqual({ available: "0.00", reserved: "0.00" });
	});
});

describe("auditoria do estorno", () => {
	const insertReversalAudit = (
		client: Pick<PoolClient, "query">,
		input: { bureauId: string | null; userId: string; table: string; recordId: string | null },
	) =>
		client.query(
			`insert into audit_logs (user_id, action, table_name, record_id, bureau_id)
       values ($1, 'wallet.reversal', $2, $3, $4)`,
			[input.userId, input.table, input.recordId, input.bureauId],
		);

	it("keeps wallet.reversal out of reach of the app role", async () => {
		const tenant = await fundedTenant("10.00");
		const charge = await seedPixCharge(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.bureauAdmin.userId,
			status: "paid",
		});
		const input = {
			bureauId: tenant.bureau.id,
			userId: tenant.bureauAdmin.userId,
			table: "pix_charges",
			recordId: charge.id,
		};
		// Sem contexto de usuário (como o webhook): só o dono da função tem política.
		await expect(insertReversalAudit(app, input)).rejects.toThrow(/permission denied|row-level security/);
		await withDbContext(app, superadminCtx(), async (c) => {
			await expect(insertReversalAudit(c, { ...input, userId: superadmin.userId })).rejects.toThrow(
				/row-level security/,
			);
		});
	});

	it("lets the function owner audit a reversal only next to its own ledger entry or refunded charge", async () => {
		const a = await fundedTenant("50.00");
		const b = await fundedTenant("50.00");
		const chargeA = await seedPixCharge(owner, {
			bureauId: a.bureau.id,
			requestedBy: a.bureauAdmin.userId,
		});
		const topup = await owner.query<{ id: string }>("select id from ledger_entries where bureau_id = $1", [a.bureau.id]);

		// Como o dono das funções (com RLS), depois de preparar o estado como superusuário; sempre com rollback.
		const asDefiner = async (markRefunded: boolean, work: (c: PoolClient) => Promise<unknown>) => {
			const client = await owner.connect();
			try {
				await client.query("begin");
				if (markRefunded) await client.query("update pix_charges set status = 'refunded' where id = $1", [chargeA.id]);
				await client.query("set local role auth_profile_lookup");
				await work(client);
			} finally {
				await client.query("rollback");
				client.release();
			}
		};
		const base = { bureauId: a.bureau.id, userId: a.bureauAdmin.userId };
		const chargeAudit = { ...base, table: "pix_charges", recordId: chargeA.id };

		// Cobrança refunded do mesmo Bureau e autor: passa.
		await expect(asDefiner(true, (c) => insertReversalAudit(c, chargeAudit))).resolves.toBeUndefined();

		const denied: Array<[string, boolean, Parameters<typeof insertReversalAudit>[1]]> = [
			["charge still pending", false, chargeAudit],
			["other author", true, { ...chargeAudit, userId: a.operator.userId }],
			["other bureau", true, { ...chargeAudit, bureauId: b.bureau.id }],
			["no bureau", true, { ...chargeAudit, bureauId: null }],
			["topup entry is not a reversal", true, { ...base, table: "ledger_entries", recordId: topup.rows[0].id }],
			["no record", true, { ...base, table: "ledger_entries", recordId: null }],
			["foreign table", true, { ...chargeAudit, table: "wallets" }],
		];
		for (const [label, markRefunded, input] of denied) {
			await expect(asDefiner(markRefunded, (c) => insertReversalAudit(c, input)), label).rejects.toThrow(/row-level security/);
		}
	});
});

describe("auditoria da carteira", () => {
	const insertAudit = (
		client: PoolClient,
		input: {
			action: string;
			bureauId: string | null;
			userId: string;
			recordId: string | null;
		},
	) =>
		client.query(
			`insert into audit_logs (user_id, action, table_name, record_id, bureau_id)
       values ($1, $2, 'ledger_entries', $3, $4)`,
			[input.userId, input.action, input.recordId, input.bureauId],
		);

	it("lets the superadmin audit a wallet adjustment only next to its own ledger entry", async () => {
		const a = await fundedTenant("10.00");
		const b = await fundedTenant("10.00");

		await committed(superadminCtx(), async (c) => {
			const entry = await apply(
				c,
				a.bureau.id,
				"adjustment",
				"5.00",
				newKey(),
				"bônus",
			);
			await insertAudit(c, {
				action: "wallet.adjust",
				bureauId: a.bureau.id,
				userId: superadmin.userId,
				recordId: entry.entry_id,
			});
			const read = await c.query(
				"select 1 from audit_logs where action = 'wallet.adjust' and bureau_id = $1",
				[a.bureau.id],
			);
			expect(read.rowCount).toBe(1);
		});

		await withDbContext(app, superadminCtx(), async (c) => {
			// Sem lançamento na transação.
			await expect(
				insertAudit(c, {
					action: "wallet.adjust",
					bureauId: a.bureau.id,
					userId: superadmin.userId,
					recordId: null,
				}),
			).rejects.toThrow(/row-level security/);
		});
		await withDbContext(app, superadminCtx(), async (c) => {
			// Lançamento de outro Bureau.
			const entry = await apply(
				c,
				a.bureau.id,
				"adjustment",
				"5.00",
				newKey(),
				"bônus",
			);
			await expect(
				insertAudit(c, {
					action: "wallet.adjust",
					bureauId: b.bureau.id,
					userId: superadmin.userId,
					recordId: entry.entry_id,
				}),
			).rejects.toThrow(/row-level security/);
		});
		await withDbContext(app, superadminCtx(), async (c) => {
			// O ramo vale só para wallet.adjust.
			const entry = await apply(
				c,
				a.bureau.id,
				"adjustment",
				"5.00",
				newKey(),
				"bônus",
			);
			await expect(
				insertAudit(c, {
					action: "wallet.other",
					bureauId: a.bureau.id,
					userId: superadmin.userId,
					recordId: entry.entry_id,
				}),
			).rejects.toThrow(/row-level security/);
		});
	});

	it("keeps the wallet.topup branch out of reach of the app role", async () => {
		const tenant = await fundedTenant("10.00");
		const entry = await owner.query<{ id: string }>(
			"select id from ledger_entries where bureau_id = $1 and kind = 'topup'",
			[tenant.bureau.id],
		);
		const topupAudit = {
			action: "wallet.topup",
			bureauId: tenant.bureau.id,
			userId: tenant.bureauAdmin.userId,
			recordId: entry.rows[0].id,
		};

		// Sem contexto de usuário (como o webhook): só o dono da função tem política.
		const noContext = await app.connect();
		try {
			await expect(insertAudit(noContext, topupAudit)).rejects.toThrow(
				/permission denied|row-level security/,
			);
		} finally {
			noContext.release();
		}
		// O superadmin não grava wallet.topup para um Bureau.
		await withDbContext(app, superadminCtx(), async (c) => {
			await expect(
				insertAudit(c, { ...topupAudit, userId: superadmin.userId }),
			).rejects.toThrow(/row-level security/);
		});

		// O dono da função só grava com um topup do mesmo autor e Bureau, na mesma transação.
		const asDefiner = async (input: typeof topupAudit) => {
			const client = await owner.connect();
			try {
				await client.query("begin");
				await client.query("set local role auth_profile_lookup");
				await insertAudit(client, input);
			} finally {
				await client.query("rollback");
				client.release();
			}
		};
		const tx = await owner.connect();
		try {
			await tx.query("begin");
			const { rows } = await tx.query<{ entry_id: string }>(
				"select entry_id from wallet_post_entry($1, 'topup', 5, $2, null, null, $3)",
				[tenant.bureau.id, newKey(), tenant.bureauAdmin.userId],
			);
			await tx.query("set local role auth_profile_lookup");
			await insertAudit(tx, { ...topupAudit, recordId: rows[0].entry_id });
			await expect(
				insertAudit(tx, {
					...topupAudit,
					userId: tenant.operator.userId,
					recordId: rows[0].entry_id,
				}),
			).rejects.toThrow(/row-level security/);
		} finally {
			await tx.query("rollback");
			tx.release();
		}
		await expect(asDefiner(topupAudit)).rejects.toThrow(/row-level security/);
		await expect(
			asDefiner({ ...topupAudit, recordId: null as unknown as string }),
		).rejects.toThrow(/row-level security/);
	});
});

// Executa o trecho de backfill da 013 como ela roda: o dono (schema_owner) tem RLS forçado em bureaus.
describe("013 wallet backfill", () => {
	const migration = readFileSync(
		resolve(process.cwd(), "db/migrations/013_wallet_fixes.sql"),
		"utf8",
	);
	const backfill =
		migration.split("-- backfill:start")[1]?.split("-- backfill:end")[0] ?? "";

	it("lets schema_owner switch to the gateway role", async () => {
		const { rows } = await owner.query<{ ok: boolean }>(
			"select pg_has_role('schema_owner', 'auth_profile_lookup', 'set') as ok",
		);
		expect(rows[0].ok).toBe(true);
	});

	it("restores the wallet of a Bureau that existed before the migration", async () => {
		const tenant = await seedTenant(owner, "Backfill");
		const id = tenant.bureau.id;
		await owner.query("delete from wallets where bureau_id = $1", [id]);

		const client = await owner.connect();
		try {
			await client.query("begin");
			await client.query("set local role schema_owner");
			// Prova do defeito da 012: sem a troca de role, o dono forçado pelo RLS não vê nenhum Bureau.
			const blind = await client.query(
				"insert into wallets (bureau_id) select id from bureaus",
			);
			expect(blind.rowCount).toBe(0);
			await client.query(backfill);
			await client.query("commit");
		} catch (error) {
			await client.query("rollback");
			throw error;
		} finally {
			client.release();
		}

		expect(await balance(id)).toEqual({ available: "0.00", reserved: "0.00" });
	});

	it("keeps an existing wallet untouched", async () => {
		const tenant = await fundedTenant("40.00");

		await owner.query(backfill);

		expect(await balance(tenant.bureau.id)).toEqual({
			available: "40.00",
			reserved: "0.00",
		});
	});
});
