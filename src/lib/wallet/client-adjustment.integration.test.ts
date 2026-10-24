// Ajuste de saldo do cliente pelo Bureau (029) contra um Postgres real, sob RLS. Cada teste usa um Bureau novo.

import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system_test",
		BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
		BETTER_AUTH_URL: "http://localhost:3000",
		DOCUMENT_ROOT: "/tmp/reino-test-documents",
		CLAMAV_HOST: "localhost",
		CLAMAV_PORT: "3310",
		SMTP_HOST: "smtp.example.test",
		SMTP_PORT: "465",
		SMTP_SECURE: "true",
		SMTP_USER: "credit-system",
		SMTP_PASS: "test-password",
	});
});

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { randomCpf, seedClientWalletTopup, seedSuperadmin, seedSupportSession, seedTenant, seedWalletTopup } from "@/test/seed";

import { adjustClientBalance, getClientAdjustmentLimits, listClientAdjustments } from "./client-adjustment";
import { listClientLedger } from "./client-queries";
import { listLedger } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const REASON = "Correção de cobrança em duplicidade";

type Tenant = Awaited<ReturnType<typeof seedTenant>>;

async function setup(bureauBalance: string, client?: { available?: string; reserved?: string }) {
	const t = await seedTenant(owner, "Adjust");
	if (bureauBalance !== "0.00") await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: bureauBalance, createdBy: t.bureauAdmin.userId });
	if (client?.available || client?.reserved) {
		const total = (Number(client.available ?? 0) + Number(client.reserved ?? 0)).toFixed(2);
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: total, createdBy: t.client.userId });
		if (client.reserved) {
			await owner.query("select * from client_wallet_post_entry($1, 'reserve', $2, $3, 'seed', null, $1)", [
				t.client.userId,
				client.reserved,
				`seed-${randomBytes(6).toString("hex")}`,
			]);
		}
	}
	return t;
}

const balances = async (t: Tenant) => {
	const c = await owner.query("select available::text, reserved::text from client_wallets where client_profile_id = $1", [t.client.userId]);
	const b = await owner.query("select available::text, reserved::text from wallets where bureau_id = $1", [t.bureau.id]);
	return { client: c.rows[0], bureau: b.rows[0] };
};

const adjust = (identity: DbIdentity, t: Tenant, direction: "credit" | "debit", amount: string, reason = REASON, requestId = randomUUID()) =>
	adjustClientBalance(identity, { holderId: t.holder.id, requestId, direction, amount, reason });

describe("adjustClientBalance credit", () => {
	it("moves 100.00 from the Bureau wallet to the client available balance", async () => {
		const t = await setup("150.00");
		const result = await adjust({ ...t.bureauAdmin }, t, "credit", "100.00");
		expect(result.ok).toBe(true);
		expect(await balances(t)).toEqual({
			client: { available: "100.00", reserved: "0.00" },
			bureau: { available: "50.00", reserved: "0.00" },
		});
	});

	it("refuses with insufficient_bureau_funds and changes nothing when the Bureau has 50.00", async () => {
		const t = await setup("50.00");
		const result = await adjust({ ...t.bureauAdmin }, t, "credit", "100.00");
		expect(result).toEqual({ ok: false, reason: "insufficient_bureau_funds" });
		expect(await balances(t)).toEqual({
			client: { available: "0.00", reserved: "0.00" },
			bureau: { available: "50.00", reserved: "0.00" },
		});
		const rows = await owner.query("select (select count(*)::text from client_balance_adjustments where bureau_id = $1) as a, (select count(*)::text from audit_logs where bureau_id = $1 and action = 'client_wallet.adjust') as l", [t.bureau.id]);
		expect(rows.rows[0]).toEqual({ a: "0", l: "0" });
	});

	it("allows the exact Bureau balance and leaves it at zero", async () => {
		const t = await setup("100.00");
		expect((await adjust({ ...t.bureauAdmin }, t, "credit", "100.00")).ok).toBe(true);
		expect((await balances(t)).bureau).toEqual({ available: "0.00", reserved: "0.00" });
	});
});

describe("adjustClientBalance debit", () => {
	const admin = (t: Tenant): DbIdentity => ({ ...t.bureauAdmin });

	it("debits 30.00 from the available balance only, after the Bureau credited 50.00, and returns it to the Bureau", async () => {
		const t = await setup("150.00", { available: "100.00", reserved: "50.00" });
		expect((await adjust(admin(t), t, "credit", "50.00")).ok).toBe(true);
		expect((await balances(t)).client).toEqual({ available: "150.00", reserved: "50.00" });
		expect((await adjust(admin(t), t, "debit", "30.00")).ok).toBe(true);
		expect(await balances(t)).toEqual({
			client: { available: "120.00", reserved: "50.00" },
			bureau: { available: "130.00", reserved: "0.00" },
		});
	});

	it("refuses to remove a PIX top-up the client paid: 100.00 of PIX and no adjustments, debit 10.00", async () => {
		const t = await setup("0.00", { available: "100.00" });
		expect(await adjust(admin(t), t, "debit", "10.00")).toEqual({ ok: false, reason: "exceeds_bureau_credit", maxDebit: "0.00" });
		expect(await balances(t)).toEqual({
			client: { available: "100.00", reserved: "0.00" },
			bureau: { available: "0.00", reserved: "0.00" },
		});
	});

	it("limits debits to credits minus debits: credit 50, debit 30 ok, debit 30 refused with 20.00 left, debit 20 ok", async () => {
		const t = await setup("100.00", { available: "100.00" });
		expect((await adjust(admin(t), t, "credit", "50.00")).ok).toBe(true);
		expect((await adjust(admin(t), t, "debit", "30.00")).ok).toBe(true);
		expect(await adjust(admin(t), t, "debit", "30.00")).toEqual({ ok: false, reason: "exceeds_bureau_credit", maxDebit: "20.00" });
		expect(await withUserTransaction(admin(t), (c) => getClientAdjustmentLimits(c, t.client.userId))).toEqual({
			bureauCredit: "20.00",
			maxDebit: "20.00",
		});
		expect((await adjust(admin(t), t, "debit", "20.00")).ok).toBe(true);
		expect(await adjust(admin(t), t, "debit", "0.01")).toMatchObject({ ok: false, reason: "exceeds_bureau_credit" });
		expect(await balances(t)).toEqual({
			client: { available: "100.00", reserved: "0.00" },
			bureau: { available: "100.00", reserved: "0.00" },
		});
	});

	it("consumes the Bureau credit first: credit 50, the client spends 50, then PIX 100 cannot be removed", async () => {
		const t = await setup("100.00");
		expect((await adjust(admin(t), t, "credit", "50.00")).ok).toBe(true);
		await owner.query("select * from client_wallet_post_entry($1, 'reserve', 50, $2, 'seed', null, $1)", [t.client.userId, randomUUID()]);
		await owner.query("select * from client_wallet_post_entry($1, 'capture', 50, $2, 'seed', null, $1)", [t.client.userId, randomUUID()]);
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "100.00", createdBy: t.client.userId });
		expect((await balances(t)).client).toEqual({ available: "100.00", reserved: "0.00" });
		expect(await adjust(admin(t), t, "debit", "10.00")).toEqual({ ok: false, reason: "exceeds_bureau_credit", maxDebit: "0.00" });
		expect(await withUserTransaction(admin(t), (c) => getClientAdjustmentLimits(c, t.client.userId))).toEqual({
			bureauCredit: "0.00",
			maxDebit: "0.00",
		});
		expect((await balances(t)).client).toEqual({ available: "100.00", reserved: "0.00" });
	});

	it("credit 50, the client spends 20: the Bureau can remove 30 and then nothing", async () => {
		const t = await setup("100.00");
		expect((await adjust(admin(t), t, "credit", "50.00")).ok).toBe(true);
		await owner.query("select * from client_wallet_post_entry($1, 'reserve', 20, $2, 'seed', null, $1)", [t.client.userId, randomUUID()]);
		await owner.query("select * from client_wallet_post_entry($1, 'capture', 20, $2, 'seed', null, $1)", [t.client.userId, randomUUID()]);
		expect((await adjust(admin(t), t, "debit", "30.00")).ok).toBe(true);
		expect(await adjust(admin(t), t, "debit", "1.00")).toEqual({ ok: false, reason: "exceeds_bureau_credit", maxDebit: "0.00" });
		expect((await balances(t)).client).toEqual({ available: "0.00", reserved: "0.00" });
	});

	it("keeps the remaining credit on reserve, release, topup and reversal, and caps it at zero on capture", async () => {
		const t = await setup("100.00");
		await adjust(admin(t), t, "credit", "50.00");
		const remaining = async () => (await owner.query("select bureau_credit_remaining::text as r from client_wallets where client_profile_id = $1", [t.client.userId])).rows[0].r;
		const post = (kind: string, amount: string) =>
			owner.query("select * from client_wallet_post_entry($1, $2, $3, $4, 'seed', null, $1)", [t.client.userId, kind, amount, randomUUID()]);
		await post("reserve", "30.00");
		await post("release", "30.00");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "10.00", createdBy: t.client.userId });
		expect(await remaining()).toBe("50.00");
		await post("reserve", "60.00");
		await post("capture", "60.00");
		expect(await remaining()).toBe("0.00");
	});

	it("is also limited by the client available balance, never touching the reserved one", async () => {
		const t = await setup("100.00");
		expect((await adjust(admin(t), t, "credit", "50.00")).ok).toBe(true);
		await owner.query("select * from client_wallet_post_entry($1, 'reserve', 40, $2, 'seed', null, $1)", [t.client.userId, randomUUID()]);
		expect((await balances(t)).client).toEqual({ available: "10.00", reserved: "40.00" });
		expect(await adjust(admin(t), t, "debit", "20.00")).toEqual({ ok: false, reason: "insufficient_client_funds" });
		expect(await withUserTransaction(admin(t), (c) => getClientAdjustmentLimits(c, t.client.userId))).toEqual({
			bureauCredit: "50.00",
			maxDebit: "10.00",
		});
		expect((await adjust(admin(t), t, "debit", "10.00")).ok).toBe(true);
		expect((await balances(t)).client).toEqual({ available: "0.00", reserved: "40.00" });
	});

	it("reports the limits as zero to the admin of another Bureau", async () => {
		const t = await setup("100.00");
		const other = await seedTenant(owner, "Adjust limits other");
		await adjust(admin(t), t, "credit", "50.00");
		expect(await withUserTransaction({ ...other.bureauAdmin }, (c) => getClientAdjustmentLimits(c, t.client.userId))).toEqual({
			bureauCredit: "0.00",
			maxDebit: "0.00",
		});
	});
});

describe("adjustClientBalance records", () => {
	it("writes both ledger rows, the adjustment row and the audit event, linked by the adjustment id", async () => {
		const t = await setup("150.00");
		const result = await adjust({ ...t.bureauAdmin }, t, "credit", "40.25", `  ${REASON}  `);
		if (!result.ok) throw new Error(result.reason);
		const id = result.adjustmentId;

		const adj = await owner.query("select * from client_balance_adjustments where id = $1", [id]);
		expect(adj.rows[0]).toMatchObject({
			bureau_id: t.bureau.id,
			client_profile_id: t.client.userId,
			direction: "credit",
			amount: "40.25",
			reason: REASON,
			created_by: t.bureauAdmin.userId,
		});
		const client = await owner.query("select kind, amount::text, reference, reason, idempotency_key from client_ledger_entries where client_profile_id = $1", [t.client.userId]);
		expect(client.rows).toEqual([
			{ kind: "adjustment_credit", amount: "40.25", reference: `adjustment:${id}`, reason: REASON, idempotency_key: `adjustment:${id}:client` },
		]);
		const bureau = await owner.query("select kind, amount::text, reference, reason, idempotency_key, created_by from ledger_entries where bureau_id = $1 and kind <> 'topup'", [t.bureau.id]);
		expect(bureau.rows).toEqual([
			{ kind: "client_adjustment_out", amount: "40.25", reference: `adjustment:${id}`, reason: REASON, idempotency_key: `adjustment:${id}:bureau`, created_by: t.bureauAdmin.userId },
		]);
		const audit = await owner.query("select user_id, bureau_id, table_name, record_id, metadata from audit_logs where action = 'client_wallet.adjust' and bureau_id = $1", [t.bureau.id]);
		expect(audit.rows).toHaveLength(1);
		expect(audit.rows[0]).toMatchObject({ user_id: t.bureauAdmin.userId, table_name: "client_balance_adjustments", record_id: id });
		expect(audit.rows[0].metadata).toEqual({ client_profile_id: t.client.userId, direction: "credit", amount: "40.25", reason: REASON });
	});

	it("debit writes adjustment_debit on the client ledger and client_adjustment_in on the Bureau ledger", async () => {
		const t = await setup("20.00");
		await adjust({ ...t.bureauAdmin }, t, "credit", "20.00");
		const result = await adjust({ ...t.bureauAdmin }, t, "debit", "5.50");
		expect(result.ok).toBe(true);
		const client = await owner.query("select kind from client_ledger_entries where client_profile_id = $1 order by seq desc limit 1", [t.client.userId]);
		expect(client.rows[0].kind).toBe("adjustment_debit");
		const bureau = await owner.query("select kind, available_after::text from ledger_entries where bureau_id = $1 and kind = 'client_adjustment_in'", [t.bureau.id]);
		expect(bureau.rows).toEqual([{ kind: "client_adjustment_in", available_after: "5.50" }]);
	});

	it("lists the client ledger with the reason and the staff history with the author name", async () => {
		const t = await setup("150.00");
		await adjust({ ...t.bureauAdmin }, t, "credit", "10.00");
		const page = await withUserTransaction({ ...t.client }, (c) => listClientLedger(c, t.client.userId));
		expect(page.rows[0]).toMatchObject({ kind: "adjustment_credit", amount: "10.00", reason: REASON });
		const bureauPage = await withUserTransaction({ ...t.bureauAdmin }, (c) => listLedger(c, t.bureau.id));
		expect(bureauPage.rows[0]).toMatchObject({ kind: "client_adjustment_out", reason: REASON });
		const history = await withUserTransaction({ ...t.operator }, (c) => listClientAdjustments(c, t.client.userId));
		expect(history).toHaveLength(1);
		expect(history[0]).toMatchObject({ direction: "credit", amount: "10.00", reason: REASON });
		expect(history[0].authorName).toEqual(expect.any(String));
		const asClient = await withUserTransaction({ ...t.client }, (c) => listClientAdjustments(c, t.client.userId));
		expect(asClient).toEqual([]);
	});

	it("does not expose the staff id to the client: the client ledger row is authored by the client", async () => {
		const t = await setup("150.00");
		await adjust({ ...t.bureauAdmin }, t, "credit", "10.00");
		const { rows } = await owner.query("select created_by from client_ledger_entries where client_profile_id = $1", [t.client.userId]);
		expect(rows[0].created_by).toBe(t.client.userId);
	});
});

describe("adjustClientBalance access", () => {
	it("refuses operator, client, superadmin and superadmin in support; the admin of another Bureau finds no such client", async () => {
		const t = await setup("150.00");
		const other = await seedTenant(owner, "Adjust other");
		const sa = await seedSuperadmin(owner);
		const support = await seedSupportSession(owner, { superadminId: sa.userId, bureauId: t.bureau.id });
		const actors: DbIdentity[] = [
			{ ...t.operator },
			{ ...t.client },
			{ ...sa },
			{ ...sa, bureauId: t.bureau.id, supportSessionId: support },
		];
		for (const actor of actors) {
			// Quem não enxerga o titular recebe not_found; quem enxerga e não é bureau_admin, not_allowed.
			expect((await adjust(actor, t, "credit", "10.00")).ok).toBe(false);
			const direct = await withUserTransaction(actor, async (c) =>
				(await c.query("select ok, reason from adjust_client_balance($1, 'credit', 10, $2, $3)", [t.client.userId, REASON, randomUUID()])).rows[0],
			);
			expect(direct).toEqual({ ok: false, reason: "not_allowed" });
		}
		expect(await adjust({ ...other.bureauAdmin }, t, "credit", "10.00")).toEqual({ ok: false, reason: "not_found" });
		expect(await balances(t)).toEqual({
			client: { available: "0.00", reserved: "0.00" },
			bureau: { available: "150.00", reserved: "0.00" },
		});
	});

	it("answers not_found for a client of another Bureau and for an unknown id", async () => {
		const t = await setup("150.00");
		const other = await seedTenant(owner, "Adjust foreign client");
		expect(await adjust({ ...t.bureauAdmin }, other, "credit", "1.00")).toEqual({ ok: false, reason: "not_found" });
		const noClient = await owner.query<{ id: string }>(
			"insert into holders (bureau_id, type, name, document, created_by) values ($1, 'PF', 'Sem conta', $2, $3) returning id",
			[t.bureau.id, randomCpf(), t.bureauAdmin.userId],
		);
		const withoutClient = { ...t, holder: { ...t.holder, id: noClient.rows[0].id } };
		expect(await adjust({ ...t.bureauAdmin }, withoutClient, "credit", "1.00")).toEqual({ ok: false, reason: "not_found" });
		// A função recusa um cliente de outro Bureau mesmo com o id certo.
		const direct = await withUserTransaction({ ...t.bureauAdmin }, async (c) =>
			(await c.query("select ok, reason from adjust_client_balance($1, 'credit', 1, $2, $3)", [other.client.userId, REASON, randomUUID()])).rows[0],
		);
		expect(direct).toEqual({ ok: false, reason: "not_found" });
	});

	it("rejects a short or blank reason and bad amounts in the database", async () => {
		const t = await setup("150.00");
		const call = (direction: string, amount: string, reason: string) =>
			withUserTransaction({ ...t.bureauAdmin }, async (c) => {
				const { rows } = await c.query("select ok, reason from adjust_client_balance($1, $2, $3, $4, $5)", [t.client.userId, direction, amount, reason, randomUUID()]);
				return rows[0];
			});
		expect(await call("credit", "1.00", "")).toEqual({ ok: false, reason: "invalid_reason" });
		expect(await call("credit", "1.00", "abc")).toEqual({ ok: false, reason: "invalid_reason" });
		expect(await call("credit", "1.00", "    ab   ")).toEqual({ ok: false, reason: "invalid_reason" });
		expect(await call("credit", "1.00", "x".repeat(501))).toEqual({ ok: false, reason: "invalid_reason" });
		expect(await call("credit", "0", REASON)).toEqual({ ok: false, reason: "invalid_amount" });
		expect(await call("credit", "-5.00", REASON)).toEqual({ ok: false, reason: "invalid_amount" });
		expect(await call("credit", "1.001", REASON)).toEqual({ ok: false, reason: "invalid_amount" });
		expect(await call("credit", "100000000.00", REASON)).toEqual({ ok: false, reason: "invalid_amount" });
		expect(await call("transfer", "1.00", REASON)).toEqual({ ok: false, reason: "invalid_direction" });
		const noRequest = await withUserTransaction({ ...t.bureauAdmin }, async (c) =>
			(await c.query("select ok, reason from adjust_client_balance($1, 'credit', 1, $2, null)", [t.client.userId, REASON])).rows[0],
		);
		expect(noRequest).toEqual({ ok: false, reason: "invalid_request" });
		expect((await balances(t)).bureau.available).toBe("150.00");
	});

	it.each([
		["11 digits in a row", "Cliente 12345678901 pediu ajuste"],
		["a formatted CPF", "Cliente 123.456.789-01 pediu ajuste"],
		["a formatted CNPJ", "Empresa 12.345.678/0001-95 pediu ajuste"],
	])("rejects a reason with %s, and accepts a short number", async (_name, reason) => {
		const t = await setup("150.00");
		expect(await adjust({ ...t.bureauAdmin }, t, "credit", "1.00", reason)).toEqual({ ok: false, reason: "invalid_reason" });
		expect((await adjust({ ...t.bureauAdmin }, t, "credit", "1.00", "Pedido 1234567890 conferido")).ok).toBe(true);
	});

	it("refuses an inactive admin, an inactive Bureau, an inactive client and an anonymized client", async () => {
		const t = await setup("150.00");
		const run = () => adjust({ ...t.bureauAdmin }, t, "credit", "1.00");
		// O trigger de perfil só deixa um administrador mudar campos de segurança: o teste o desliga nesta conexão.
		const ownerUpdate = async (sql: string, params: unknown[]) => {
			const c = await owner.connect();
			try {
				await c.query("set session_replication_role = replica");
				await c.query(sql, params);
			} finally {
				await c.query("reset session_replication_role");
				c.release();
			}
		};
		expect((await run()).ok).toBe(true);
		await ownerUpdate("update profiles set is_active = false where id = $1", [t.client.userId]);
		expect(await run()).toEqual({ ok: false, reason: "not_found" });
		await ownerUpdate("update profiles set is_active = true where id = $1", [t.client.userId]);
		await ownerUpdate("update profiles set is_active = false where id = $1", [t.bureauAdmin.userId]);
		expect(await run()).toEqual({ ok: false, reason: "not_allowed" });
		await ownerUpdate("update profiles set is_active = true where id = $1", [t.bureauAdmin.userId]);
		await owner.query("update bureaus set status = 'inactive' where id = $1", [t.bureau.id]);
		expect(await run()).toEqual({ ok: false, reason: "not_allowed" });
		await owner.query("update bureaus set status = 'active' where id = $1", [t.bureau.id]);
		expect((await run()).ok).toBe(true);
		await ownerUpdate("update profiles set anonymized_at = now() where id = $1", [t.client.userId]);
		expect(await run()).toEqual({ ok: false, reason: "not_found" });
		expect((await balances(t)).bureau.available).toBe("148.00");
	});

	it("waits for an anonymization in progress and then refuses the anonymized client", async () => {
		const t = await setup("150.00");
		const anonymizer = await pool.connect();
		try {
			await anonymizer.query("begin");
			await anonymizer.query(
				"select set_config('app.user_id', $1, true), set_config('app.user_role', 'bureau_admin', true), set_config('app.bureau_id', $2, true), set_config('app.support_session_id', '', true)",
				[t.bureauAdmin.userId, t.bureau.id],
			);
			const done = await anonymizer.query("select lgpd_anonymize_client_account($1) as result", [t.client.userId]);
			expect(done.rows[0].result).toBe("ok");

			let settled = false;
			const pending = adjust({ ...t.bureauAdmin }, t, "credit", "1.00").finally(() => {
				settled = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(settled).toBe(false);
			await anonymizer.query("commit");
			expect(await pending).toEqual({ ok: false, reason: "not_found" });
		} finally {
			anonymizer.release();
		}
		expect((await balances(t)).bureau.available).toBe("150.00");
	});

	it("does not let wallet_apply use the reserved adjustment: key prefix", async () => {
		const t = await setup("150.00");
		const viaApply = await withUserTransaction({ ...t.bureauAdmin }, (c) =>
			c.query("select ok, reason from wallet_apply($1, 'reserve', 1, 'adjustment:abc:bureau', null, null)", [t.bureau.id]),
		);
		expect(viaApply.rows[0]).toEqual({ ok: false, reason: "invalid_key" });
		const normal = await withUserTransaction({ ...t.bureauAdmin }, (c) =>
			c.query("select ok from wallet_apply($1, 'reserve', 1, 'order-key-1', null, null)", [t.bureau.id]),
		);
		expect(normal.rows[0].ok).toBe(true);
	});

	it("does not let the ledger kinds be posted by any app role or through wallet_apply", async () => {
		const t = await setup("150.00");
		await expect(
			withUserTransaction({ ...t.bureauAdmin }, (c) =>
				c.query("select * from wallet_post_entry($1, 'client_adjustment_in', 1, 'x', null, 'motivo valido', $2)", [t.bureau.id, t.bureauAdmin.userId]),
			),
		).rejects.toMatchObject({ code: "42501" });
		const viaApply = await withUserTransaction({ ...t.bureauAdmin }, (c) =>
			c.query("select ok from wallet_apply($1, 'client_adjustment_out', 1, 'y', null, 'motivo valido')", [t.bureau.id]),
		);
		expect(viaApply.rows[0].ok).toBe(false);
		expect((await balances(t)).bureau.available).toBe("150.00");
	});
});

describe("adjustClientBalance request id", () => {
	it("a repeated request id returns the same adjustment and moves the balances once", async () => {
		const t = await setup("150.00");
		const requestId = randomUUID();
		const first = await adjust({ ...t.bureauAdmin }, t, "credit", "100.00", REASON, requestId);
		const second = await adjust({ ...t.bureauAdmin }, t, "credit", "100.00", REASON, requestId);
		expect(first).toMatchObject({ ok: true, adjustmentId: requestId });
		expect(second).toEqual(first);
		expect(await balances(t)).toEqual({
			client: { available: "100.00", reserved: "0.00" },
			bureau: { available: "50.00", reserved: "0.00" },
		});
		const counts = await owner.query(
			"select (select count(*)::text from client_balance_adjustments where bureau_id = $1) as a, (select count(*)::text from ledger_entries where bureau_id = $1 and kind = 'client_adjustment_out') as b, (select count(*)::text from client_ledger_entries where client_profile_id = $2 and kind = 'adjustment_credit') as c, (select count(*)::text from audit_logs where bureau_id = $1 and action = 'client_wallet.adjust') as d",
			[t.bureau.id, t.client.userId],
		);
		expect(counts.rows[0]).toEqual({ a: "1", b: "1", c: "1", d: "1" });
	});

	it("a double click in parallel creates one adjustment", async () => {
		const t = await setup("150.00");
		const requestId = randomUUID();
		const results = await Promise.all([
			adjust({ ...t.bureauAdmin }, t, "credit", "100.00", REASON, requestId),
			adjust({ ...t.bureauAdmin }, t, "credit", "100.00", REASON, requestId),
		]);
		expect(results.every((r) => r.ok)).toBe(true);
		expect((await balances(t)).bureau.available).toBe("50.00");
	});

	it("a replay still succeeds after the Bureau balance dropped, and the same id with other data is a conflict", async () => {
		const t = await setup("100.00");
		const requestId = randomUUID();
		expect((await adjust({ ...t.bureauAdmin }, t, "credit", "100.00", REASON, requestId)).ok).toBe(true);
		expect((await adjust({ ...t.bureauAdmin }, t, "credit", "100.00", REASON, requestId)).ok).toBe(true);
		expect(await adjust({ ...t.bureauAdmin }, t, "credit", "99.00", REASON, requestId)).toEqual({ ok: false, reason: "request_conflict" });
		expect(await adjust({ ...t.bureauAdmin }, t, "debit", "100.00", REASON, requestId)).toEqual({ ok: false, reason: "request_conflict" });
		const other = await setup("100.00");
		expect(await adjust({ ...other.bureauAdmin }, other, "credit", "100.00", REASON, requestId)).toEqual({ ok: false, reason: "request_conflict" });
		expect(await balances(t)).toEqual({
			client: { available: "100.00", reserved: "0.00" },
			bureau: { available: "0.00", reserved: "0.00" },
		});
	});

	it("a failed request does not burn its id: it can be retried after the Bureau is topped up", async () => {
		const t = await setup("50.00");
		const requestId = randomUUID();
		expect(await adjust({ ...t.bureauAdmin }, t, "credit", "100.00", REASON, requestId)).toEqual({ ok: false, reason: "insufficient_bureau_funds" });
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "50.00", createdBy: t.bureauAdmin.userId });
		expect(await adjust({ ...t.bureauAdmin }, t, "credit", "100.00", REASON, requestId)).toMatchObject({ ok: true, adjustmentId: requestId });
	});
});

describe("adjustClientBalance concurrency", () => {
	it("two concurrent credits and a debit never overdraw the Bureau and keep the sum exact", async () => {
		const t = await setup("100.00");
		const results = await Promise.all([
			adjust({ ...t.bureauAdmin }, t, "credit", "60.00"),
			adjust({ ...t.bureauAdmin }, t, "credit", "60.00"),
		]);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "insufficient_bureau_funds" }]);
		expect(await balances(t)).toEqual({
			client: { available: "60.00", reserved: "0.00" },
			bureau: { available: "40.00", reserved: "0.00" },
		});
	});
});
