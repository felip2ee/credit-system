// % de afiliados do Bureau (048) sob RLS contra um Postgres real: só o superadmin escreve; trava de 100%; auditoria.
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
import { seedClientProfile, seedSuperadmin, seedTenant, type SeededTenant, type SeedIdentity, type SeedSuperadmin } from "@/test/seed";

import { affiliateLink, getBureauDefaultPct, listBureauAffiliates, setBureauDefaultPct } from "./rates";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let A: SeededTenant;
let B: SeededTenant;
let second: SeedIdentity;
let SA: SeedSuperadmin;

beforeAll(async () => {
	[A, B, SA] = await Promise.all([seedTenant(owner, "Rates A"), seedTenant(owner, "Rates B"), seedSuperadmin(owner)]);
	second = await seedClientProfile(owner, A.bureau.id);
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const stored = async (bureauId: string) =>
	(await owner.query<{ default_pct: string }>("select default_pct from bureau_affiliate_settings where bureau_id = $1", [bureauId]))
		.rows[0]?.default_pct;

const setOverride = (bureauId: string, pct: string | null) =>
	owner.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, $2, $3)", [bureauId, pct, SA.userId]);

const auditRows = async (bureauId: string) =>
	(
		await owner.query<{ user_id: string; record_id: string; metadata: Record<string, string> }>(
			"select user_id, record_id, metadata from audit_logs where action = 'affiliate.rate' and bureau_id = $1",
			[bureauId],
		)
	).rows;

describe("affiliateLink", () => {
	it("builds the registration link with the code", () => {
		expect(affiliateLink("meu-bureau", "ab12cd34")).toBe("http://localhost:3000/b/meu-bureau/cadastro?ref=ab12cd34");
	});
});

describe("getBureauDefaultPct", () => {
	it("is 0.00 without a stored setting; the superadmin and the Bureau team read it, another Bureau does not", async () => {
		const T = await seedTenant(owner, "Default pct");
		expect(await getBureauDefaultPct(T.bureauAdmin)).toBe("0.00");
		await expect(setBureauDefaultPct(SA, T.bureau.id, "12.50")).resolves.toEqual({ ok: true });
		expect(await getBureauDefaultPct(T.bureauAdmin)).toBe("12.50");
		expect(await getBureauDefaultPct(SA, T.bureau.id)).toBe("12.50");
		expect(await getBureauDefaultPct(B.bureauAdmin, T.bureau.id)).toBe("0.00"); // RLS: não vê outro Bureau
	});
});

describe("setBureauDefaultPct", () => {
	it("upserts one % per Bureau and audits from/to with the target bureau_id, actor = superadmin", async () => {
		const T = await seedTenant(owner, "Upsert");
		await setBureauDefaultPct(SA, T.bureau.id, "5");
		await setBureauDefaultPct(SA, T.bureau.id, "6.5");
		expect(await stored(T.bureau.id)).toBe("6.50");
		const rows = await auditRows(T.bureau.id);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.user_id)).toEqual([SA.userId, SA.userId]);
		const first = rows.find((r) => r.metadata.to === "5");
		const last = rows.find((r) => r.metadata.to === "6.5");
		expect(last?.record_id).toBe(T.bureau.id);
		expect(last?.metadata).toEqual({ scope: "default", bureau_id: T.bureau.id, from: "5.00", to: "6.5" });
		expect(first?.metadata.from).toBe("0.00");
	});

	it("refuses the Bureau admin, the operator and the client; nothing is stored", async () => {
		const T = await seedTenant(owner, "Writers");
		for (const who of [T.bureauAdmin, T.operator, T.client]) {
			await expect(setBureauDefaultPct(who, T.bureau.id, "5")).rejects.toThrow();
		}
		expect(await stored(T.bureau.id)).toBeUndefined();
		expect(await auditRows(T.bureau.id)).toHaveLength(0);
	});

	it("refuses a % above 100 (check) and reports an unknown Bureau as not_found", async () => {
		await expect(setBureauDefaultPct(SA, A.bureau.id, "101")).rejects.toThrow();
		await expect(setBureauDefaultPct(SA, randomUUID(), "5")).resolves.toEqual({ ok: false, reason: "not_found" });
	});

	it("blocks bureau_pct + affiliate_pct > 100 with the Bureau override; rolls back the write and the audit", async () => {
		const T = await seedTenant(owner, "Split override");
		await setOverride(T.bureau.id, "80");
		await expect(setBureauDefaultPct(SA, T.bureau.id, "20")).resolves.toEqual({ ok: true }); // exatamente 100
		await expect(setBureauDefaultPct(SA, T.bureau.id, "20.01")).resolves.toEqual({ ok: false, reason: "split_over_100" });
		expect(await stored(T.bureau.id)).toBe("20.00");
		expect(await auditRows(T.bureau.id)).toHaveLength(1);
	});

	it("uses the global % when the Bureau has no override (null override falls back to global)", async () => {
		const T = await seedTenant(owner, "Split global");
		const previous = (await owner.query("select value from settings where key = 'bureau_commission_pct'")).rows[0]?.value;
		await owner.query(
			`insert into settings (key, value) values ('bureau_commission_pct', '70'::jsonb)
			 on conflict (key) do update set value = excluded.value`,
		);
		try {
			await expect(setBureauDefaultPct(SA, T.bureau.id, "30.01")).resolves.toEqual({ ok: false, reason: "split_over_100" });
			await setOverride(T.bureau.id, null);
			await expect(setBureauDefaultPct(SA, T.bureau.id, "30.01")).resolves.toEqual({ ok: false, reason: "split_over_100" });
			await setOverride(T.bureau.id, "10");
			await expect(setBureauDefaultPct(SA, T.bureau.id, "30.01")).resolves.toEqual({ ok: true });
		} finally {
			if (previous === undefined) await owner.query("delete from settings where key = 'bureau_commission_pct'");
			else await owner.query("update settings set value = $1::jsonb where key = 'bureau_commission_pct'", [JSON.stringify(previous)]);
		}
	});
});

describe("listBureauAffiliates", () => {
	it("lists only this Bureau's affiliates with referrals and net commission total (no per-affiliate %)", async () => {
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
		expect(mine).toMatchObject({ referrals: 1, totalCommission: "4.00" });
		expect(mine?.name).toBeTruthy();
		expect(list.find((a) => a.profileId === second.userId)).toMatchObject({ referrals: 0, totalCommission: "0.00" });
		expect(list.every((a) => a.profileId !== B.client.userId)).toBe(true);
	});
});
