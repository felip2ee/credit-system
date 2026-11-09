// payableOwed contra getPayableBalance com os mesmos lançamentos, sob RLS.
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system_test",
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
import { withUserTransaction } from "@/lib/db/transaction";
import { getPayableBalance, getPayableBuckets } from "@/lib/payables/queries";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedPayableEntry, seedTenant } from "@/test/seed";

import { payableOwed } from "./payable-summary";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const DAY_MS = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString();

async function compare(entries: Array<{ kind: "accrual" | "reversal"; amount: string; days: number }>) {
	const t = await seedTenant(owner, "Owed");
	for (const e of entries) {
		await seedPayableEntry(owner, { bureauId: t.bureau.id, kind: e.kind, amount: e.amount, createdAt: daysAgo(e.days) });
	}
	return withUserTransaction(t.bureauAdmin, async (c) => ({
		buckets: await getPayableBuckets(c, t.bureau.id),
		balance: await getPayableBalance(c, t.bureau.id),
	}));
}

describe("payableOwed vs getPayableBalance", () => {
	it("matches with released, retained and a reversal", async () => {
		const { buckets, balance } = await compare([
			{ kind: "accrual", amount: "50.00", days: 400 },
			{ kind: "accrual", amount: "30.00", days: 0 },
			{ kind: "reversal", amount: "-10.00", days: 0 },
		]);
		expect(payableOwed(buckets)).toBe(balance);
	});

	it("matches when the reversal is larger than the released amount (debt)", async () => {
		const { buckets, balance } = await compare([
			{ kind: "accrual", amount: "10.00", days: 400 },
			{ kind: "reversal", amount: "-25.00", days: 0 },
		]);
		expect(Number(buckets.debt)).toBeGreaterThan(0);
		expect(payableOwed(buckets)).toBe(balance);
	});
});
