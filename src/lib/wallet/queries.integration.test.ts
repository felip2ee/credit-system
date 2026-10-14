// Queries da carteira contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ??
			"postgres://app_runtime:test@localhost:54329/credit_system",
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

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedSuperadmin,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

import {
	adjust,
	adjustWalletWithAudit,
	capture,
	getWallet,
	listLedger,
	release,
	reserve,
} from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let superadmin: SeedSuperadmin;
let sa: DbIdentity;

beforeAll(async () => {
	superadmin = await seedSuperadmin(owner);
	sa = { userId: superadmin.userId, role: "superadmin", bureauId: null };
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

async function fundedTenant(
	label: string,
	amount = "100.00",
): Promise<{ tenant: SeededTenant; admin: DbIdentity }> {
	const tenant = await seedTenant(owner, label);
	await seedWalletTopup(owner, {
		bureauId: tenant.bureau.id,
		amount,
		createdBy: tenant.bureauAdmin.userId,
	});
	return { tenant, admin: { ...tenant.bureauAdmin } };
}

const key = () => randomUUID();

describe("reserve / capture / release", () => {
	it("moves money between available and reserved and replays by key", async () => {
		const { tenant, admin } = await fundedTenant("Wallet Q1");
		const bureauId = tenant.bureau.id;
		const k = key();

		const first = await withUserTransaction(admin, (c) =>
			reserve(c, { bureauId, amount: "30.00", idempotencyKey: k, reference: "consulta-1" }),
		);
		expect(first).toMatchObject({ ok: true, available: "70.00", reserved: "30.00", replayed: false });

		const again = await withUserTransaction(admin, (c) =>
			reserve(c, { bureauId, amount: "30.00", idempotencyKey: k, reference: "consulta-1" }),
		);
		expect(again).toMatchObject({ ok: true, available: "70.00", reserved: "30.00", replayed: true });

		const cap = await withUserTransaction(admin, (c) =>
			capture(c, { bureauId, amount: "20.00", idempotencyKey: key(), reference: "consulta-1" }),
		);
		expect(cap).toMatchObject({ ok: true, available: "70.00", reserved: "10.00" });

		const rel = await withUserTransaction(admin, (c) =>
			release(c, { bureauId, amount: "10.00", idempotencyKey: key(), reference: "consulta-1" }),
		);
		expect(rel).toMatchObject({ ok: true, available: "80.00", reserved: "0.00" });
		expect(await withUserTransaction(admin, (c) => getWallet(c, bureauId))).toEqual({
			available: "80.00",
			reserved: "0.00",
		});
	});

	it("returns reasons instead of throwing", async () => {
		const { tenant, admin } = await fundedTenant("Wallet Q2", "10.00");
		const bureauId = tenant.bureau.id;
		const run = (amount: string, idempotencyKey: string, fn = reserve) =>
			withUserTransaction(admin, (c) => fn(c, { bureauId, amount, idempotencyKey, reference: null }));

		expect(await run("10.01", key())).toEqual({ ok: false, reason: "insufficient_balance" });
		expect(await run("1.00", key(), capture)).toEqual({ ok: false, reason: "reservation_exceeded" });
		expect(await run("1.005", key())).toEqual({ ok: false, reason: "invalid_amount" });
		expect(await run("1.00", " ")).toEqual({ ok: false, reason: "invalid_key" });
	});

	it("idempotency key reuse with different amount is rejected", async () => {
		const { tenant, admin } = await fundedTenant("Wallet Q3");
		const bureauId = tenant.bureau.id;
		const k = key();

		await withUserTransaction(admin, (c) =>
			reserve(c, { bureauId, amount: "5.00", idempotencyKey: k, reference: null }),
		);
		const conflict = await withUserTransaction(admin, (c) =>
			reserve(c, { bureauId, amount: "6.00", idempotencyKey: k, reference: null }),
		);

		expect(conflict).toEqual({ ok: false, reason: "idempotency_conflict" });
		expect((await withUserTransaction(admin, (c) => getWallet(c, bureauId)))?.reserved).toBe("5.00");
	});

	it("refuses another bureau for a non-superadmin", async () => {
		const { admin } = await fundedTenant("Wallet Q4");
		const { tenant: other } = await fundedTenant("Wallet Q4b");

		expect(
			await withUserTransaction(admin, (c) =>
				reserve(c, { bureauId: other.bureau.id, amount: "1.00", idempotencyKey: key(), reference: null }),
			),
		).toEqual({ ok: false, reason: "not_allowed" });
	});
});

describe("adjust", () => {
	it("is superadmin only and needs a reason", async () => {
		const { tenant, admin } = await fundedTenant("Wallet Q5");
		const bureauId = tenant.bureau.id;
		const asSuper = (amount: string, reason: string, target = bureauId) =>
			withUserTransaction(sa, (c) =>
				adjust(c, { bureauId: target, amount, reason, idempotencyKey: key() }),
			);

		expect(
			await withUserTransaction(admin, (c) =>
				adjust(c, { bureauId, amount: "1.00", reason: "x", idempotencyKey: key() }),
			),
		).toEqual({ ok: false, reason: "not_allowed" });
		expect(await asSuper("1.00", " ")).toEqual({ ok: false, reason: "reason_required" });
		expect(await asSuper("-100.01", "x")).toEqual({ ok: false, reason: "insufficient_balance" });
		expect(await asSuper("0", "x")).toEqual({ ok: false, reason: "invalid_amount" });
		expect(await asSuper("1.00", "x", randomUUID())).toEqual({ ok: false, reason: "not_found" });
	});

	it("audits with the target bureau and does not audit a replay twice", async () => {
		const { tenant } = await fundedTenant("Wallet Q6");
		const bureauId = tenant.bureau.id;
		const input = { bureauId, amount: "-12.50", reason: "Estorno", idempotencyKey: key() };

		const first = await adjustWalletWithAudit(sa, input);
		expect(first).toMatchObject({ ok: true, available: "87.50", replayed: false });
		const replay = await adjustWalletWithAudit(sa, input);
		expect(replay).toMatchObject({ ok: true, available: "87.50", replayed: true });

		const { rows } = await owner.query(
			"select user_id, bureau_id, record_id, table_name, metadata from audit_logs where bureau_id = $1 and action = 'wallet.adjust'",
			[bureauId],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			user_id: superadmin.userId,
			bureau_id: bureauId,
			table_name: "ledger_entries",
			record_id: first.ok ? first.entryId : null,
		});
		expect(rows[0].metadata).toMatchObject({
			amount: "-12.50",
			reason: "Estorno",
			available_after: "87.50",
		});
	});

	it("writes no ledger entry when the adjustment fails", async () => {
		const { tenant } = await fundedTenant("Wallet Q7", "10.00");
		const bureauId = tenant.bureau.id;

		const result = await adjustWalletWithAudit(sa, {
			bureauId,
			amount: "-10.01",
			reason: "x",
			idempotencyKey: key(),
		});

		expect(result).toEqual({ ok: false, reason: "insufficient_balance" });
		const { rows } = await owner.query(
			"select count(*)::int as n from audit_logs where bureau_id = $1 and action = 'wallet.adjust'",
			[bureauId],
		);
		expect(rows[0].n).toBe(0);
	});
});

describe("listLedger", () => {
	it("pages newest first by seq without repeating rows and caps limit at 100", async () => {
		const { tenant, admin } = await fundedTenant("Wallet Q8");
		const bureauId = tenant.bureau.id;
		// Os lançamentos da mesma transação compartilham created_at: seq desempata.
		await withUserTransaction(admin, async (c) => {
			for (let i = 0; i < 5; i++) {
				await reserve(c, { bureauId, amount: "1.00", idempotencyKey: key(), reference: `r${i}` });
			}
		});

		const page1 = await withUserTransaction(admin, (c) => listLedger(c, bureauId, { limit: 4 }));
		expect(page1.rows.map((r) => r.reference)).toEqual(["r4", "r3", "r2", "r1"]);
		expect(page1.nextCursor).not.toBeNull();

		const page2 = await withUserTransaction(admin, (c) =>
			listLedger(c, bureauId, { limit: 4, cursor: page1.nextCursor }),
		);
		expect(page2.rows.map((r) => r.reference)).toEqual(["r0", "seed"]);
		expect(page2.nextCursor).toBeNull();

		const capped = await withUserTransaction(admin, (c) => listLedger(c, bureauId, { limit: 1000 }));
		expect(capped.rows).toHaveLength(6);
		await expect(
			withUserTransaction(admin, (c) => listLedger(c, bureauId, { limit: 4, cursor: "1; drop" })),
		).rejects.toThrow(RangeError);
	});

	it("orders numerically across a seq digit boundary with no duplicates or gaps", async () => {
		const { tenant, admin } = await fundedTenant("Wallet Q8n");
		const bureauId = tenant.bureau.id;
		// seq é uma identity global: avança-a para 55 antes da próxima potência de 10, para o teste cruzar 9..9 -> 10..0.
		await owner.query(
			`select setval(s, (power(10, length(greatest((select last_value from ledger_entries_seq_seq), 10)::text))::bigint) - 55)
			   from (select pg_get_serial_sequence('ledger_entries', 'seq') as s) x`,
		);
		await withUserTransaction(admin, async (c) => {
			for (let i = 0; i < 110; i++) {
				await reserve(c, { bureauId, amount: "0.01", idempotencyKey: key(), reference: `n${i}` });
			}
		});

		const expected = await owner.query<{ seq: string }>(
			"select seq::text as seq from ledger_entries where bureau_id = $1 order by ledger_entries.seq desc",
			[bureauId],
		);
		const seqs: string[] = [];
		let cursor: string | null = null;
		do {
			const page: Awaited<ReturnType<typeof listLedger>> = await withUserTransaction(admin, (c) =>
				listLedger(c, bureauId, { limit: 7, cursor }),
			);
			seqs.push(...page.rows.map((r) => r.seq));
			cursor = page.nextCursor;
		} while (cursor !== null);

		expect(seqs).toHaveLength(111);
		expect(seqs).toEqual(expected.rows.map((r) => r.seq));
	});

	it("does not show another bureau's entries to a bureau identity", async () => {
		const { admin } = await fundedTenant("Wallet Q9");
		const { tenant: other } = await fundedTenant("Wallet Q9b");

		const page = await withUserTransaction(admin, (c) => listLedger(c, other.bureau.id, { limit: 10 }));
		expect(page.rows).toEqual([]);
	});
});
