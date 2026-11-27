// Valor a repassar contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { randomUUID } from "node:crypto";

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



import { fromCents } from "@/lib/catalog/money";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { captureOrder } from "@/lib/settlement/queries";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedCashInAccrual,
	seedClientWalletTopup,
	seedLegacyOnlineOrder,
	seedPayableEntry,
	seedSuperadmin,
	seedSupportSession,
	seedTenant,
	type SeededTenant,
} from "@/test/seed";

import { createPayout, markPayoutPaid } from "@/lib/payouts/queries";

import {
	getPayableBalance,
	getPayableBalances,
	getPayableBuckets,
	getPayableRetentionDays,
	listPayableEntries,
	PayableBucketsRefusedError,
} from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

// Vende online e captura um pedido reservado antes da 077 (o acréscimo antigo, price - cost, que ainda nasce na captura
// desses pedidos). Pedido novo não gera acréscimo na captura. Devolve o order_ref.
async function sell(tenant: SeededTenant, priceCents: number, costCents: number): Promise<string> {
	const orderRef = await seedLegacyOnlineOrder(owner, {
		bureauId: tenant.bureau.id,
		clientProfileId: tenant.client.userId,
		price: fromCents(priceCents),
		cost: fromCents(costCents),
	});
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

describe("getPayableBalances", () => {
	it("returns each Bureau's sum in one grouped query and omits Bureaus without entries", async () => {
		const a = await tenantWithClientFunds("Payable GA");
		const b = await tenantWithClientFunds("Payable GB");
		const empty = await seedTenant(owner, "Payable GE");
		const first = await sell(a, 5000, 3000); // +20.00
		await sell(a, 1010, 1000); // +0.10
		await sell(b, 9000, 3000); // +60.00
		await owner.query(
			"insert into bureau_payable_entries (bureau_id, kind, amount, order_ref) values ($1, 'reversal', -7.25, $2)",
			[a.bureau.id, first],
		);
		const sa: DbIdentity = { ...(await seedSuperadmin(owner)) };

		const balances = await withUserTransaction(sa, (c) => getPayableBalances(c));

		expect(balances.get(a.bureau.id)).toBe("12.85");
		expect(balances.get(b.bureau.id)).toBe("60.00");
		expect(balances.has(empty.bureau.id)).toBe(false);
	});

	it("shows a bureau_admin only its own Bureau", async () => {
		const a = await tenantWithClientFunds("Payable GO");
		const b = await tenantWithClientFunds("Payable GP");
		await sell(a, 5000, 3000);
		await sell(b, 9000, 3000);
		const adminA: DbIdentity = { ...a.bureauAdmin };

		const balances = await withUserTransaction(adminA, (c) => getPayableBalances(c));

		expect(Array.from(balances.keys())).toEqual([a.bureau.id]);
	});
});

describe("listPayableEntries", () => {
	it("pages newest first without repeating rows, even with the same created_at", async () => {
		const tenant = await tenantWithClientFunds("Payable P");
		const admin: DbIdentity = { ...tenant.bureauAdmin };
		const refs: string[] = [];
		for (let i = 0; i < 5; i++) {
			refs.push(
				await seedLegacyOnlineOrder(owner, {
					bureauId: tenant.bureau.id,
					clientProfileId: tenant.client.userId,
					price: "20.00",
					cost: "10.00",
				}),
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

	it("lists a cash-in accrual (charge link, no order_ref) next to the order accruals", async () => {
		const tenant = await tenantWithClientFunds("Payable CI");
		const admin: DbIdentity = { ...tenant.bureauAdmin };
		const orderRef = await sell(tenant, 5000, 3000);
		await seedCashInAccrual(owner, {
			bureauId: tenant.bureau.id,
			requestedBy: tenant.client.userId,
			clientProfileId: tenant.client.userId,
			chargeAmount: "100.00",
			amount: "12.34",
		});

		const page = await withUserTransaction(admin, (c) => listPayableEntries(c, tenant.bureau.id));
		expect(page.rows.map((r) => ({ kind: r.kind, amount: r.amount, orderRef: r.orderRef })).sort((x, y) => x.amount.localeCompare(y.amount))).toEqual([
			{ kind: "accrual", amount: "12.34", orderRef: null },
			{ kind: "accrual", amount: "20.00", orderRef },
		]);
		expect(await withUserTransaction(admin, (c) => getPayableBalance(c, tenant.bureau.id))).toBe("32.34");
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
		for (const limit of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const fallback = await withUserTransaction(admin, (c) => listPayableEntries(c, tenant.bureau.id, { limit }));
			expect(fallback.rows).toHaveLength(1);
		}
	});
});

// Retenção padrão de 30 dias. Idades longe da fronteira (40 e 5 dias) não dependem do relógio entre app e banco.
const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const entry = (bureauId: string, kind: "accrual" | "reversal", amount: string, ageDays: number) =>
	seedPayableEntry(owner, {
		bureauId,
		kind,
		amount: kind === "accrual" ? amount : `-${amount}`,
		createdAt: daysAgo(ageDays).toISOString(),
	});
const receipt = () => ({ objectKey: `ab/${randomUUID()}`, mime: "application/pdf" as const, sha256: "a".repeat(64) });

describe("getPayableBuckets", () => {
	it("is zero, with no release date, for a Bureau without entries (not a refusal)", async () => {
		const tenant = await seedTenant(owner, "Buckets vazio");

		const buckets = await withUserTransaction({ ...tenant.bureauAdmin }, (c) => getPayableBuckets(c, tenant.bureau.id));

		expect(buckets).toEqual({
			released: "0.00",
			retained: "0.00",
			debt: "0.00",
			inPayout: "0.00",
			nextReleaseAt: null,
			paid: "0.00",
		});
	});

	it("splits released from retained and dates the next release at created_at + retention", async () => {
		const tenant = await seedTenant(owner, "Buckets split");
		await entry(tenant.bureau.id, "accrual", "100.00", 40);
		await entry(tenant.bureau.id, "accrual", "25.00", 5);
		await entry(tenant.bureau.id, "reversal", "10.00", 3);

		const buckets = await withUserTransaction({ ...tenant.operator }, (c) => getPayableBuckets(c, tenant.bureau.id));

		// O estorno de 3 dias conta na hora (abate o liberado) e nunca entra em retained.
		expect(buckets).toMatchObject({ released: "90.00", retained: "25.00", debt: "0.00", paid: "0.00" });
		const expected = daysAgo(5).getTime() + 30 * DAY_MS;
		expect(Math.abs((buckets.nextReleaseAt as Date).getTime() - expected)).toBeLessThan(60_000);
	});

	it("never shows a negative bucket: a net-negative released shows 0 and the rest is debt", async () => {
		const tenant = await seedTenant(owner, "Buckets estorno");
		await entry(tenant.bureau.id, "accrual", "20.00", 40);
		await entry(tenant.bureau.id, "reversal", "50.00", 40);
		await entry(tenant.bureau.id, "reversal", "30.00", 2);

		const buckets = await withUserTransaction({ ...tenant.bureauAdmin }, (c) => getPayableBuckets(c, tenant.bureau.id));

		expect(buckets).toMatchObject({ released: "0.00", retained: "0.00", debt: "60.00" });
	});

	it("matches what create_payout accepts, and counts the paid amount only after the payout is paid", async () => {
		const tenant = await seedTenant(owner, "Buckets payout");
		const sa = await seedSuperadmin(owner);
		await entry(tenant.bureau.id, "accrual", "100.00", 40);
		await entry(tenant.bureau.id, "reversal", "30.00", 35);
		await entry(tenant.bureau.id, "accrual", "25.00", 5);
		const admin: DbIdentity = { ...tenant.bureauAdmin };
		const before = await withUserTransaction(admin, (c) => getPayableBuckets(c, tenant.bureau.id));
		expect(before).toMatchObject({ released: "70.00", retained: "25.00", debt: "0.00", inPayout: "0.00", paid: "0.00" });

		// Um corte dentro da retenção é recusado e não muda os números; o corte liberado paga exatamente "released".
		const within = await createPayout({ userId: sa.userId, role: "superadmin", bureauId: null }, { bureauId: tenant.bureau.id, cutoffAt: daysAgo(10) });
		expect(within).toEqual({ ok: false, reason: "cutoff_within_retention" });
		const made = await createPayout({ userId: sa.userId, role: "superadmin", bureauId: null }, { bureauId: tenant.bureau.id, cutoffAt: daysAgo(31) });
		expect(made).toMatchObject({ ok: true, amount: before.released });

		const open = await withUserTransaction(admin, (c) => getPayableBuckets(c, tenant.bureau.id));
		expect(open).toMatchObject({ released: "0.00", retained: "25.00", inPayout: "70.00", paid: "0.00" });
		if (!made.ok) throw new Error("payout not created");
		await markPayoutPaid({ userId: sa.userId, role: "superadmin", bureauId: null }, { payoutId: made.payoutId, receipt: receipt() });
		const paid = await withUserTransaction(admin, (c) => getPayableBuckets(c, tenant.bureau.id));
		expect(paid).toMatchObject({ released: "0.00", retained: "25.00", inPayout: "0.00", paid: "70.00" });
	});

	it("refuses (never returns zeros) for a client, another Bureau and a superadmin in support", async () => {
		const a = await seedTenant(owner, "Buckets A");
		const b = await seedTenant(owner, "Buckets B");
		const sa = await seedSuperadmin(owner);
		await entry(a.bureau.id, "accrual", "50.00", 40);
		const supportSessionId = await seedSupportSession(owner, { superadminId: sa.userId, bureauId: a.bureau.id });

		const attempts: [DbIdentity, string][] = [
			[{ ...a.client }, a.bureau.id],
			[{ ...b.bureauAdmin }, a.bureau.id],
			[{ userId: sa.userId, role: "superadmin", bureauId: a.bureau.id, supportSessionId }, a.bureau.id],
		];
		for (const [identity, bureauId] of attempts) {
			await expect(withUserTransaction(identity, (c) => getPayableBuckets(c, bureauId))).rejects.toBeInstanceOf(
				PayableBucketsRefusedError,
			);
		}
		const ok = await withUserTransaction({ userId: sa.userId, role: "superadmin", bureauId: null }, (c) =>
			getPayableBuckets(c, a.bureau.id),
		);
		expect(ok.released).toBe("50.00");
	});
});

describe("getPayableRetentionDays", () => {
	it("reads the retention in days", async () => {
		const sa = await seedSuperadmin(owner);

		expect(await getPayableRetentionDays({ userId: sa.userId, role: "superadmin", bureauId: null })).toBe(30);
	});
});
