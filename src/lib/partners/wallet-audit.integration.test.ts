// Troca de walletId de sócio: a auditoria guarda o antigo e o novo, os dois mascarados.
import { randomUUID } from "node:crypto";

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
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSuperadmin } from "@/test/seed";

import { maskWalletId, upsertPartner } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 2 });
afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

describe("upsertPartner audit", () => {
	it("records the old masked walletId on a change, and null on creation", async () => {
		const SA = await seedSuperadmin(owner);
		const [first, second] = [randomUUID(), randomUUID()];
		const partner = { name: "Sócio Auditado", pct: "0.01", active: false };
		const created = await upsertPartner(SA, { ...partner, asaasWalletId: first });
		try {
			await upsertPartner(SA, { ...partner, id: created.id, asaasWalletId: second });

			const { rows } = await owner.query<{ metadata: { wallet_before: string | null; wallet: string } }>(
				"select metadata from audit_logs where action = 'partner.upsert' and record_id = $1 order by created_at",
				[created.id],
			);
			expect(rows.map((r) => [r.metadata.wallet_before, r.metadata.wallet])).toEqual([
				[null, maskWalletId(first)],
				[maskWalletId(first), maskWalletId(second)],
			]);
			expect(JSON.stringify(rows)).not.toContain(first);
		} finally {
			await owner.query("delete from platform_partners where id = $1", [created.id]);
		}
	});
});
