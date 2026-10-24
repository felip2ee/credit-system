// Carteira e extrato do cliente contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ??
			"postgres://app_runtime:test@localhost:54329/credit_system_test",
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
import { seedClientWalletTopup, seedTenant } from "@/test/seed";

import { getClientWallet, listClientLedger } from "./client-queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

describe("getClientWallet", () => {
	it("returns the balance, zero for a new client, and null for a client the caller cannot see", async () => {
		const a = await seedTenant(owner, "ClientWallet A");
		const b = await seedTenant(owner, "ClientWallet B");
		const clientA: DbIdentity = { ...a.client };
		const clientB: DbIdentity = { ...b.client };

		expect(await withUserTransaction(clientA, (c) => getClientWallet(c, clientA.userId))).toEqual({
			available: "0.00",
			reserved: "0.00",
		});
		await seedClientWalletTopup(owner, { clientProfileId: clientA.userId, amount: "12.34", createdBy: clientA.userId });
		expect(await withUserTransaction(clientA, (c) => getClientWallet(c, clientA.userId))).toEqual({
			available: "12.34",
			reserved: "0.00",
		});
		expect(await withUserTransaction(clientB, (c) => getClientWallet(c, clientA.userId))).toBeNull();
		expect(await withUserTransaction({ ...a.operator }, (c) => getClientWallet(c, clientA.userId))).toEqual({
			available: "12.34",
			reserved: "0.00",
		});
	});
});

describe("listClientLedger", () => {
	// seq 1..105 explícito (OVERRIDING SYSTEM VALUE, como dono): cruza 9->10 e 99->100 com o extrato consistente.
	async function seedLedger(client: DbIdentity, count: number) {
		await owner.query(
			`insert into client_ledger_entries
			   (seq, bureau_id, client_profile_id, kind, amount, available_after, reserved_after, idempotency_key, created_by)
			 overriding system value
			 select g, $1, $2, 'topup', 0.01, g * 0.01, 0, 'seq-' || g, $2 from generate_series(1, $3::int) g`,
			[client.bureauId, client.userId, count],
		);
		await owner.query("update client_wallets set available = $2 where client_profile_id = $1", [
			client.userId,
			(count / 100).toFixed(2),
		]);
	}

	it("orders by numeric seq across 9->10 and 99->100 with a cursor and no duplicates", async () => {
		const tenant = await seedTenant(owner, "ClientLedger N");
		const client: DbIdentity = { ...tenant.client };
		await seedLedger(client, 105);

		const seqs: string[] = [];
		let cursor: string | null = null;
		do {
			const page: Awaited<ReturnType<typeof listClientLedger>> = await withUserTransaction(client, (c) =>
				listClientLedger(c, client.userId, { limit: 7, cursor }),
			);
			seqs.push(...page.rows.map((r) => r.seq));
			cursor = page.nextCursor;
		} while (cursor !== null);

		expect(seqs).toEqual(Array.from({ length: 105 }, (_, i) => String(105 - i)));
	});

	it("caps limit at 100 and defaults to a page of 20", async () => {
		const tenant = await seedTenant(owner, "ClientLedger L");
		const client: DbIdentity = { ...tenant.client };
		await seedLedger(client, 105);

		const capped = await withUserTransaction(client, (c) => listClientLedger(c, client.userId, { limit: 1000 }));
		expect(capped.rows).toHaveLength(100);
		expect(capped.nextCursor).toBe("6");
		const floor = await withUserTransaction(client, (c) => listClientLedger(c, client.userId, { limit: 0 }));
		expect(floor.rows).toHaveLength(1);
		const byDefault = await withUserTransaction(client, (c) => listClientLedger(c, client.userId));
		expect(byDefault.rows).toHaveLength(20);
	});

	it("maps the columns and rejects a malformed cursor", async () => {
		const tenant = await seedTenant(owner, "ClientLedger M");
		const client: DbIdentity = { ...tenant.client };
		await seedClientWalletTopup(owner, { clientProfileId: client.userId, amount: "20.00", createdBy: client.userId });

		const page = await withUserTransaction(client, (c) => listClientLedger(c, client.userId));
		expect(page.rows[0]).toMatchObject({
			kind: "topup",
			amount: "20.00",
			availableAfter: "20.00",
			reservedAfter: "0.00",
			reference: "seed",
			createdBy: client.userId,
		});
		await expect(
			withUserTransaction(client, (c) => listClientLedger(c, client.userId, { cursor: "1; drop" })),
		).rejects.toThrow(RangeError);
	});

	it("does not show the ledger of another client", async () => {
		const a = await seedTenant(owner, "ClientLedger A");
		const b = await seedTenant(owner, "ClientLedger B");
		await seedClientWalletTopup(owner, { clientProfileId: a.client.userId, amount: "20.00", createdBy: a.client.userId });

		const page = await withUserTransaction({ ...b.client }, (c) => listClientLedger(c, a.client.userId));
		expect(page.rows).toEqual([]);
		const fromOtherBureau = await withUserTransaction({ ...b.bureauAdmin }, (c) => listClientLedger(c, a.client.userId));
		expect(fromOtherBureau.rows).toEqual([]);
	});
});
