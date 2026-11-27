// Indicação entre bureaus contra um Postgres real: self, ciclo, já indicado, teto de 100%, auditoria, RLS e permissão.
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
import { hasPermission } from "@/lib/db/permissions";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSupportSession, seedSuperadmin, seedTenant, type SeedSuperadmin } from "@/test/seed";

import { clearBureauReferrer, getBureauReferrer, setBureauReferrer } from "./referrals";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
let SA: SeedSuperadmin;

beforeAll(async () => {
	SA = await seedSuperadmin(owner);
});

afterEach(async () => {
	await owner.query("delete from bureau_referrals");
	await owner.query("delete from platform_partners");
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const setup = async () => {
	const [A, B, C] = await Promise.all([seedTenant(owner, "Ref A"), seedTenant(owner, "Ref B"), seedTenant(owner, "Ref C")]);
	return { A: A.bureau.id, B: B.bureau.id, C: C.bureau.id, tenants: { A, B, C } };
};

describe("setBureauReferrer", () => {
	it("grava com pct padrão 5 e audita sem expor nada além de ids e pct", async () => {
		const { A, B } = await setup();
		await expect(setBureauReferrer(SA, { referredBureauId: B, referrerBureauId: A, pct: "5" })).resolves.toEqual({ ok: true });
		await expect(getBureauReferrer(SA, B)).resolves.toEqual({ referrerBureauId: A, referrerName: expect.any(String), pct: "5.00" });
		const audit = await owner.query<{ action: string; metadata: Record<string, unknown> }>(
			"select action, metadata from audit_logs where record_id = $1",
			[B],
		);
		expect(audit.rows).toHaveLength(1);
		expect(audit.rows[0].action).toBe("bureau_referral.set");
		expect(audit.rows[0].metadata).toMatchObject({ referred_bureau_id: B, referrer_bureau_id: A, pct: "5" });
	});

	it("self: recusa", async () => {
		const { A } = await setup();
		await expect(setBureauReferrer(SA, { referredBureauId: A, referrerBureauId: A, pct: "5" })).resolves.toEqual({ ok: false, reason: "self" });
	});

	it("ciclo A->B->A e A->B->C->A: recusa", async () => {
		const { A, B, C } = await setup();
		await setBureauReferrer(SA, { referredBureauId: B, referrerBureauId: A, pct: "5" });
		await expect(setBureauReferrer(SA, { referredBureauId: A, referrerBureauId: B, pct: "5" })).resolves.toEqual({ ok: false, reason: "cycle" });
		await setBureauReferrer(SA, { referredBureauId: C, referrerBureauId: B, pct: "5" });
		await expect(setBureauReferrer(SA, { referredBureauId: A, referrerBureauId: C, pct: "5" })).resolves.toEqual({ ok: false, reason: "cycle" });
	});

	it("já indicado: recusa, sem alterar a linha; depois de remover, aceita outro", async () => {
		const { A, B, C } = await setup();
		await setBureauReferrer(SA, { referredBureauId: B, referrerBureauId: A, pct: "5" });
		await expect(setBureauReferrer(SA, { referredBureauId: B, referrerBureauId: C, pct: "7" })).resolves.toEqual({ ok: false, reason: "already_referred" });
		expect((await getBureauReferrer(SA, B))?.referrerBureauId).toBe(A);
		await clearBureauReferrer(SA, { referredBureauId: B });
		await expect(setBureauReferrer(SA, { referredBureauId: B, referrerBureauId: C, pct: "7" })).resolves.toEqual({ ok: true });
	});

	it("bureau inexistente: not_found", async () => {
		const { A } = await setup();
		await expect(
			setBureauReferrer(SA, { referredBureauId: A, referrerBureauId: "99999999-9999-4999-8999-999999999999", pct: "5" }),
		).resolves.toEqual({ ok: false, reason: "not_found" });
	});

	it("soma acima de 100% (sócios + indicador): recusa e não grava", async () => {
		const { A, B } = await setup();
		await owner.query("insert into platform_partners (name, asaas_wallet_id, pct, active) values ('S', 'wallet-12345678', 98, true)");
		await expect(setBureauReferrer(SA, { referredBureauId: B, referrerBureauId: A, pct: "5" })).resolves.toEqual({ ok: false, reason: "split_over_100" });
		await expect(getBureauReferrer(SA, B)).resolves.toBeNull();
	});
});

describe("clearBureauReferrer", () => {
	it("remove e audita; sem linha, não audita", async () => {
		const { A, B } = await setup();
		await expect(clearBureauReferrer(SA, { referredBureauId: B })).resolves.toEqual({ ok: true, removed: false });
		await setBureauReferrer(SA, { referredBureauId: B, referrerBureauId: A, pct: "5" });
		await expect(clearBureauReferrer(SA, { referredBureauId: B })).resolves.toEqual({ ok: true, removed: true });
		await expect(getBureauReferrer(SA, B)).resolves.toBeNull();
		const audit = await owner.query<{ action: string }>("select action from audit_logs where record_id = $1 order by created_at", [B]);
		expect(audit.rows.map((r) => r.action)).toEqual(["bureau_referral.set", "bureau_referral.clear"]);
	});
});

describe("acesso", () => {
	it("bureau_admin não grava nem remove (RLS) e não tem a permissão", async () => {
		const { A, B, tenants } = await setup();
		expect(hasPermission(tenants.A.bureauAdmin, "bureau_referral:manage")).toBe(false);
		await expect(setBureauReferrer(tenants.A.bureauAdmin, { referredBureauId: B, referrerBureauId: A, pct: "5" })).rejects.toThrow(
			/row-level security|permission denied/,
		);
		await setBureauReferrer(SA, { referredBureauId: B, referrerBureauId: A, pct: "5" });
		// A equipe do bureau indicado não vê a linha (só o superadmin e o bureau indicador veem).
		await expect(getBureauReferrer(tenants.B.bureauAdmin, B)).resolves.toBeNull();
		await clearBureauReferrer(tenants.B.bureauAdmin, { referredBureauId: B });
		expect((await owner.query("select 1 from bureau_referrals")).rowCount).toBe(1);
	});

	it("sessão de suporte não grava", async () => {
		const { A, B, tenants } = await setup();
		const session = await seedSupportSession(owner, { superadminId: SA.userId, bureauId: tenants.A.bureau.id });
		const inSupport = { ...SA, bureauId: tenants.A.bureau.id, supportSessionId: session };
		await expect(setBureauReferrer(inSupport, { referredBureauId: B, referrerBureauId: A, pct: "5" })).rejects.toThrow(
			/row-level security|permission denied/,
		);
	});
});
