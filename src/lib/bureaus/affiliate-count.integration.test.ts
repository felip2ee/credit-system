import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as unknown }));

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

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
	auth: { api: { requestPasswordReset: vi.fn() } },
}));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: async () => session.current,
}));

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSuperadmin, seedTenant } from "@/test/seed";

import { listBureauMetrics } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });

afterAll(async () => {
	try {
		await owner.end();
	} finally {
		await pool.end();
	}
});

async function seedAffiliateCodes(profileIds: string[], bureauId: string) {
	for (const id of profileIds) {
		await owner.query(
			`insert into affiliate_codes (profile_id, bureau_id, code)
			 values ($1, $2, substr(md5(random()::text), 1, 8))
			 on conflict (profile_id) do nothing`,
			[id, bureauId],
		);
	}
}

describe("affiliateCount em listBureauMetrics", () => {
	it("superadmin fora de suporte vê o total de afiliados de cada Bureau", async () => {
		const [a, b, superadmin] = await Promise.all([
			seedTenant(owner, "affcount-a"),
			seedTenant(owner, "affcount-b"),
			seedSuperadmin(owner),
		]);
		await seedAffiliateCodes([a.client.userId, a.operator.userId], a.bureau.id);
		await seedAffiliateCodes([b.client.userId], b.bureau.id);

		const rows = await listBureauMetrics(superadmin);
		const countOf = (id: string) => rows.find((r) => r.bureauId === id)?.affiliateCount;
		expect(countOf(a.bureau.id)).toBe(2);
		expect(countOf(b.bureau.id)).toBe(1);
	});

	it("bureau_admin de outro Bureau não lê a contagem por esse caminho", async () => {
		const [a, b] = await Promise.all([seedTenant(owner, "affcount-c"), seedTenant(owner, "affcount-d")]);
		await seedAffiliateCodes([a.client.userId], a.bureau.id);

		await expect(listBureauMetrics(b.bureauAdmin)).rejects.toMatchObject({ code: "42501" });
		await expect(listBureauMetrics(a.bureauAdmin)).rejects.toMatchObject({ code: "42501" });
	});
});
