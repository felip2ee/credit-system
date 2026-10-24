// % de comissão do Bureau sob RLS contra um Postgres real: padrão, % própria, isolamento entre Bureaus e auditoria.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedClientProfile, seedTenant, type SeededTenant, type SeedIdentity } from "@/test/seed";

import { affiliateLink, getBureauDefaultPct, listBureauAffiliates, setAffiliatePct, setBureauDefaultPct } from "./rates";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let A: SeededTenant;
let B: SeededTenant;
let second: SeedIdentity;

beforeAll(async () => {
	[A, B] = await Promise.all([seedTenant(owner, "Rates A"), seedTenant(owner, "Rates B")]);
	second = await seedClientProfile(owner, A.bureau.id);
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const codeOf = async (profileId: string) =>
	(await owner.query<{ code: string }>("select code from affiliate_codes where profile_id = $1", [profileId])).rows[0].code;

const defaultPct = async (bureauId: string) =>
	(await owner.query<{ default_pct: string }>("select default_pct from bureau_affiliate_settings where bureau_id = $1", [bureauId]))
		.rows[0]?.default_pct;

describe("getBureauDefaultPct", () => {
	it("is 0.00 without a stored setting and returns the stored value after it is set", async () => {
		const T = await seedTenant(owner, "Default pct");
		const admin = { ...T.bureauAdmin };

		expect(await getBureauDefaultPct(admin)).toBe("0.00");
		await setBureauDefaultPct(admin, "12.50");
		expect(await getBureauDefaultPct(admin)).toBe("12.50");
	});
});

describe("affiliateLink", () => {
	it("builds the registration link with the code", () => {
		expect(affiliateLink("meu-bureau", "ab12cd34")).toBe("http://localhost:3000/b/meu-bureau/cadastro?ref=ab12cd34");
	});
});

describe("% do Bureau", () => {
	it("sets the default and a own % for one affiliate; the others keep null (use default)", async () => {
		await setBureauDefaultPct(A.bureauAdmin, "5");
		expect(await defaultPct(A.bureau.id)).toBe("5.00");
		await setBureauDefaultPct(A.bureauAdmin, "6.5"); // upsert
		expect(await defaultPct(A.bureau.id)).toBe("6.50");

		await expect(setAffiliatePct(A.bureauAdmin, A.client.userId, "10")).resolves.toEqual({ ok: true });

		// Cria uma comissão para conferir o total e a contagem de indicados.
		await owner.query(
			`insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)`,
			[second.userId, A.client.userId, A.bureau.id],
		);
		await owner.query(
			`insert into affiliate_commissions (order_ref, bureau_id, affiliate_profile_id, referred_profile_id, pct, margin, amount,
			   reversed_amount, release_at)
			 values ($1, $2, $3, $4, 10, 50, 5, 1, now())`,
			[randomUUID(), A.bureau.id, A.client.userId, second.userId],
		);

		const list = await listBureauAffiliates(A.bureauAdmin);
		const mine = list.find((a) => a.profileId === A.client.userId);
		expect(mine).toMatchObject({ pct: "10.00", code: await codeOf(A.client.userId), referrals: 1, totalCommission: "4.00" });
		expect(mine?.name).toBeTruthy();
		const other = list.find((a) => a.profileId === second.userId);
		expect(other).toMatchObject({ pct: null, referrals: 0, totalCommission: "0.00" });
		expect(list.every((a) => a.profileId !== B.client.userId)).toBe(true);
	});

	it("removes the own % with null", async () => {
		await setAffiliatePct(A.bureauAdmin, second.userId, "3");
		await expect(setAffiliatePct(A.bureauAdmin, second.userId, null)).resolves.toEqual({ ok: true });
		const list = await listBureauAffiliates(A.bureauAdmin);
		expect(list.find((a) => a.profileId === second.userId)?.pct).toBeNull();
	});

	it("does not let another Bureau change the affiliate of this one", async () => {
		await expect(setAffiliatePct(B.bureauAdmin, A.client.userId, "50")).resolves.toEqual({ ok: false, reason: "not_found" });
		const { rows } = await owner.query<{ pct: string }>(
			"select pct from affiliate_rates where affiliate_profile_id = $1",
			[A.client.userId],
		);
		expect(rows).toEqual([{ pct: "10.00" }]);
	});

	it("refuses a % above 100 and a non-admin writer", async () => {
		await expect(setBureauDefaultPct(A.bureauAdmin, "101")).rejects.toThrow();
		await expect(setAffiliatePct(A.bureauAdmin, A.client.userId, "101")).rejects.toThrow();
		await expect(setBureauDefaultPct(A.operator, "5")).rejects.toThrow();
		expect(await defaultPct(A.bureau.id)).toBe("6.50");
	});

	it("audits each write in the same transaction", async () => {
		const { rows } = await owner.query<{ n: number }>(
			"select count(*)::int as n from audit_logs where action = 'affiliate.rate' and bureau_id = $1 and user_id = $2",
			[A.bureau.id, A.bureauAdmin.userId],
		);
		expect(rows[0].n).toBeGreaterThanOrEqual(4);
	});
});
