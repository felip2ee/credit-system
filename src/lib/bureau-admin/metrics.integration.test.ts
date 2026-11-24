import { randomUUID } from "node:crypto";

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

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedClientProfile, seedTenant, type SeededTenant } from "@/test/seed";

import { getBureauAdminMetrics, recordBureauVisit, recordBureauVisitBySlug } from "./metrics";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });

afterAll(async () => {
	try {
		await owner.end();
	} finally {
		await pool.end();
	}
});

const views = async (bureauId: string) =>
	Number(
		(await owner.query<{ n: string }>("select coalesce(sum(count), 0) as n from bureau_page_views where bureau_id = $1", [
			bureauId,
		])).rows[0].n,
	);

async function settle(t: SeededTenant, clientId: string, price: string, daysAgo: number) {
	const { rows } = await owner.query<{ order_ref: string }>(
		`insert into order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost, status, closed_at, created_at)
		 values ($1, $2, 'online', $3, $4, 0, 'captured', now() - make_interval(days => $5), now() - make_interval(days => $5))
		 returning order_ref`,
		[randomUUID(), t.bureau.id, clientId, price, daysAgo],
	);
	return rows[0].order_ref;
}

// Todo cliente já nasce com código de afiliado (trigger); aqui só liga um indicado.
async function affiliateWith(t: SeededTenant) {
	const affiliate = await seedClientProfile(owner, t.bureau.id);
	const referred = await seedClientProfile(owner, t.bureau.id);
	await owner.query("update profiles set full_name = $2 where id = $1", [affiliate.userId, `Afiliado ${affiliate.userId.slice(0, 6)}`]);
	await owner.query("insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)", [
		referred.userId,
		affiliate.userId,
		t.bureau.id,
	]);
	return { affiliate, referred };
}

describe("recordBureauVisit", () => {
	it("counts one visit per call for an active bureau", async () => {
		const t = await seedTenant(owner, "visit");
		await recordBureauVisit(t.bureau.id);
		await recordBureauVisitBySlug(t.bureau.slug);
		expect(await views(t.bureau.id)).toBe(2);
	});

	it("records nothing for a missing slug, an unknown id or an inactive bureau, and never throws", async () => {
		const t = await seedTenant(owner, "visit-off");
		await owner.query("update bureaus set status = 'inactive' where id = $1", [t.bureau.id]);
		await recordBureauVisitBySlug(t.bureau.slug);
		await recordBureauVisit(t.bureau.id);
		await recordBureauVisitBySlug("nao-existe-xyz");
		await expect(recordBureauVisit("not-a-uuid")).resolves.toBeUndefined();
		expect(await views(t.bureau.id)).toBe(0);
	});
});

describe("getBureauAdminMetrics", () => {
	it("sums visits, signups, sales and revenue by period", async () => {
		const t = await seedTenant(owner, "metrics");
		await recordBureauVisit(t.bureau.id);
		await owner.query("insert into bureau_page_views (bureau_id, day, count) values ($1, current_date - 40, 7)", [t.bureau.id]);
		await settle(t, t.client.userId, "100.00", 0);
		await settle(t, t.client.userId, "50.50", 0);
		await settle(t, t.client.userId, "30.00", 40);
		await seedClientProfile(owner, t.bureau.id);

		const hoje = await getBureauAdminMetrics(t.bureauAdmin, "hoje");
		expect(hoje).toMatchObject({ visits: 1, signups: 2, sales: 2, revenue: 150.5, affiliates: 2, ranking: [] });
		const ontem = await getBureauAdminMetrics(t.bureauAdmin, "ontem");
		expect(ontem).toMatchObject({ visits: 0, signups: 0, sales: 0, revenue: 0 });
		const nove = await getBureauAdminMetrics(t.bureauAdmin, "9m");
		expect(nove).toMatchObject({ visits: 8, signups: 2, sales: 3, revenue: 180.5 });
	});

	it("returns revenue null without the payout permission but keeps sales", async () => {
		const t = await seedTenant(owner, "metrics-op");
		await settle(t, t.client.userId, "80.00", 0);
		const m = await getBureauAdminMetrics(t.operator, "hoje");
		expect(m.revenue).toBeNull();
		expect(m.sales).toBe(1);
	});

	it("ranks the top 5 affiliates by sales without sensitive data", async () => {
		const t = await seedTenant(owner, "metrics-rank");
		const plan = [1, 3, 2, 0, 5, 4]; // 6 afiliados; o de 0 vendas fica de fora
		for (const n of plan) {
			const a = await affiliateWith(t);
			for (let i = 0; i < n; i++) {
				const ref = await settle(t, a.referred.userId, "10.00", 0);
				await owner.query(
					`insert into affiliate_commissions (order_ref, bureau_id, affiliate_profile_id, referred_profile_id, pct, margin, amount, release_at)
					 values ($1, $2, $3, $4, 10, 10, 1.50, now())`,
					[ref, t.bureau.id, a.affiliate.userId, a.referred.userId],
				);
			}
		}
		const m = await getBureauAdminMetrics(t.bureauAdmin, "hoje");
		expect(m.affiliates).toBe(13); // todo cliente tem código: t.client + 6 afiliados + 6 indicados
		expect(m.ranking.map((r) => r.sales)).toEqual([5, 4, 3, 2, 1]);
		expect(m.ranking[0]).toEqual({ name: expect.stringContaining("Afiliado"), sales: 5, commission: 7.5 });
		expect(Object.keys(m.ranking[0]).sort()).toEqual(["commission", "name", "sales"]);
	});

	it("does not mix data between bureaus", async () => {
		const a = await seedTenant(owner, "iso-a");
		const b = await seedTenant(owner, "iso-b");
		await recordBureauVisit(a.bureau.id);
		await settle(a, a.client.userId, "99.00", 0);
		await affiliateWith(a);

		const mb = await getBureauAdminMetrics(b.bureauAdmin, "9m");
		expect(mb).toMatchObject({ visits: 0, sales: 0, revenue: 0, affiliates: 1, ranking: [] });
		expect(mb.signups).toBe(1); // só o cliente do próprio b
	});
});
