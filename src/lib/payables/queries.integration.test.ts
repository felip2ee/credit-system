// Valor a repassar contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

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
import { captureOrder, reserveOrder } from "@/lib/settlement/queries";
import type { OrderQuote } from "@/lib/settlement/types";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedClientWalletTopup, seedSuperadmin, seedTenant, type SeededTenant } from "@/test/seed";

import { getPayableBalance, listPayableEntries } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const quoteOf = (priceCents: number, costCents: number): OrderQuote => ({
	ok: true,
	lines: [{ productVersionId: randomUUID(), code: "smart_pf", costCents, priceCents }],
	totalCostCents: costCents,
	totalPriceCents: priceCents,
});

// Vende online e captura: grava o acréscimo price - cost. Devolve o order_ref.
async function sell(tenant: SeededTenant, priceCents: number, costCents: number): Promise<string> {
	const client: DbIdentity = { ...tenant.client };
	const orderRef = randomUUID();
	await withUserTransaction(client, (c) =>
		reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote: quoteOf(priceCents, costCents) }),
	);
	await withUserTransaction({ ...tenant.operator }, (c) => captureOrder(c, orderRef));
	return orderRef;
}

async function tenantWithClientFunds(label: string): Promise<SeededTenant> {
	const tenant = await seedTenant(owner, label);
	await seedClientWalletTopup(owner, { clientProfileId: tenant.client.userId, amount: "1000.00", createdBy: tenant.client.userId });
	return tenant;
}

describe("getPayableBalance", () => {
	it("is zero with no entries", async () => {
		const tenant = await seedTenant(owner, "Payable Z");
		const admin: DbIdentity = { ...tenant.bureauAdmin };
		expect(await withUserTransaction(admin, (c) => getPayableBalance(c, tenant.bureau.id))).toBe("0.00");
	});

	it("sums accruals and reversals", async () => {
		const tenant = await tenantWithClientFunds("Payable S");
		const admin: DbIdentity = { ...tenant.bureauAdmin };
		const first = await sell(tenant, 5000, 3000); // +20.00
		await sell(tenant, 1010, 1000); // +0.10
		// O estorno de venda online é do M3c; aqui o dono grava o lançamento para conferir a soma.
		await owner.query(
			"insert into bureau_payable_entries (bureau_id, kind, amount, order_ref) values ($1, 'reversal', -7.25, $2)",
			[tenant.bureau.id, first],
		);

		expect(await withUserTransaction(admin, (c) => getPayableBalance(c, tenant.bureau.id))).toBe("12.85");
	});

	it("does not show Bureau B to the admin of Bureau A", async () => {
		const a = await tenantWithClientFunds("Payable A");
		const b = await tenantWithClientFunds("Payable B");
		await sell(a, 5000, 3000);
		await sell(b, 9000, 3000);
		const adminA: DbIdentity = { ...a.bureauAdmin };

		expect(await withUserTransaction(adminA, (c) => getPayableBalance(c, a.bureau.id))).toBe("20.00");
		expect(await withUserTransaction(adminA, (c) => getPayableBalance(c, b.bureau.id))).toBe("0.00");
		expect((await withUserTransaction(adminA, (c) => listPayableEntries(c, b.bureau.id))).rows).toEqual([]);
	});

	it("lets a superadmin outside support read any Bureau", async () => {
		const tenant = await tenantWithClientFunds("Payable SA");
		await sell(tenant, 5000, 3000);
		const sa = await seedSuperadmin(owner);
		const identity: DbIdentity = { ...sa };

		expect(await withUserTransaction(identity, (c) => getPayableBalance(c, tenant.bureau.id))).toBe("20.00");
	});
});

describe("listPayableEntries", () => {
	it("pages newest first without repeating rows, even with the same created_at", async () => {
		const tenant = await tenantWithClientFunds("Payable P");
		const admin: DbIdentity = { ...tenant.bureauAdmin };
		const client: DbIdentity = { ...tenant.client };
		const refs = Array.from({ length: 5 }, () => randomUUID());
		for (const orderRef of refs) {
			await withUserTransaction(client, (c) =>
				reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote: quoteOf(2000, 1000) }),
			);
		}
		// Uma transação só: os cinco acréscimos têm o mesmo created_at e o id desempata.
		await withUserTransaction({ ...tenant.operator }, async (c) => {
			for (const orderRef of refs) await captureOrder(c, orderRef);
		});

		const expected = await owner.query<{ id: string }>(
			"select id from bureau_payable_entries where bureau_id = $1 order by created_at desc, id desc",
			[tenant.bureau.id],
		);
		const ids: string[] = [];
		let cursor: string | null = null;
		do {
			const page: Awaited<ReturnType<typeof listPayableEntries>> = await withUserTransaction(admin, (c) =>
				listPayableEntries(c, tenant.bureau.id, { limit: 2, cursor }),
			);
			ids.push(...page.rows.map((r) => r.id));
			cursor = page.nextCursor;
		} while (cursor !== null);

		expect(ids).toEqual(expected.rows.map((r) => r.id));
		expect(ids).toHaveLength(5);
	});

	it("maps the columns, caps the limit and rejects a malformed cursor", async () => {
		const tenant = await tenantWithClientFunds("Payable M");
		const admin: DbIdentity = { ...tenant.bureauAdmin };
		const orderRef = await sell(tenant, 5000, 3000);

		const page = await withUserTransaction(admin, (c) => listPayableEntries(c, tenant.bureau.id, { limit: 1000 }));
		expect(page.rows).toHaveLength(1);
		expect(page.rows[0]).toMatchObject({ kind: "accrual", amount: "20.00", orderRef });
		expect(page.rows[0].createdAt).toBeInstanceOf(Date);
		expect(page.nextCursor).toBeNull();
		await expect(
			withUserTransaction(admin, (c) => listPayableEntries(c, tenant.bureau.id, { cursor: "x; drop" })),
		).rejects.toThrow(RangeError);
	});
});
