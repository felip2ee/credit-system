// Escritas da comissão contra um Postgres real: trava de concorrência da soma <= 100 e RLS em sessão de suporte.
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

import { setBureauDefaultPct } from "@/lib/affiliates/rates";
import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSupportSession, seedSuperadmin, seedTenant, type SeedSuperadmin } from "@/test/seed";

import { setBureauCommissionOverride, setProductBlock } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
let SA: SeedSuperadmin;

beforeAll(async () => {
	SA = await seedSuperadmin(owner);
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

describe("trava da soma bureau% + afiliados% <= 100", () => {
	it("duas escritas concorrentes cuja soma passa de 100: exatamente uma falha", async () => {
		for (let round = 0; round < 5; round++) {
			const T = await seedTenant(owner, `Race ${round}`);
			const results = await Promise.all([
				setBureauCommissionOverride(SA, T.bureau.id, 60),
				setBureauDefaultPct(SA, T.bureau.id, "50"),
			]);
			expect(results.filter((r) => r.ok)).toHaveLength(1);
			expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "split_over_100" }]);
		}
	});
});

describe("sessão de suporte barrada no RLS", () => {
	it("override, bloqueio e % de afiliados falham no banco com a sessão de suporte no contexto", async () => {
		const T = await seedTenant(owner, "Support write");
		const product = (await owner.query<{ id: string }>("select id from products limit 1")).rows[0];
		const session = await seedSupportSession(owner, { superadminId: SA.userId, bureauId: T.bureau.id });
		const inSupport = { ...SA, bureauId: T.bureau.id, supportSessionId: session };

		await expect(setBureauCommissionOverride(inSupport, T.bureau.id, 10)).rejects.toThrow(/row-level security|permission denied/);
		await expect(setProductBlock(inSupport, T.bureau.id, product.id, true)).rejects.toThrow(/row-level security|permission denied/);
		await expect(setBureauDefaultPct(inSupport, T.bureau.id, "5")).rejects.toThrow(/row-level security|permission denied/);
		const { rows } = await owner.query("select 1 from bureau_commission_rates where bureau_id = $1", [T.bureau.id]);
		expect(rows).toHaveLength(0);

		// Fora de suporte as mesmas escritas passam (o audit do ramo novo acha a linha de negócio da transação).
		await expect(setBureauCommissionOverride(SA, T.bureau.id, 10)).resolves.toEqual({ ok: true });
		await expect(setProductBlock(SA, T.bureau.id, product.id, true)).resolves.toEqual({ ok: true });
		await expect(setBureauDefaultPct(SA, T.bureau.id, "5")).resolves.toEqual({ ok: true });
	});
});
