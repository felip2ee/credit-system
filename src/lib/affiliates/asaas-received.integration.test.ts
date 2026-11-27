// "Recebido pelo Asaas" (modo conta Asaas): total do afiliado e do Bureau contra um Postgres real. Mesma regra nos dois:
// pending, done e reversal_failed entram; refused e refunded, e pending de cobrança não paga, ficam fora. reversal_failed é mostrado à parte.
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
import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import { seedClientProfile, seedPixCharge, seedTenant, withDbContext, type SeededTenant } from "@/test/seed";

import { getMyAffiliateSummary } from "./queries";
import { listBureauAffiliates } from "./rates";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

let T: SeededTenant;

beforeAll(async () => {
	T = await seedTenant(owner, "Asaas received");
	const referred = await seedClientProfile(owner, T.bureau.id);
	await owner.query(
		"insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)",
		[referred.userId, T.client.userId, T.bureau.id],
	);
	await owner.query("insert into bureau_affiliate_settings (bureau_id, default_pct, affiliate_enabled) values ($1, 10, true)", [T.bureau.id]);
	await owner.query("update affiliate_wallets set payout_method = 'asaas', asaas_wallet_id = 'wallet-x' where profile_id = $1", [T.client.userId]);
	const split = async (cents: number, status: string, chargeStatus: "paid" | "pending" = "paid") => {
		const c = await seedPixCharge(owner, { bureauId: T.bureau.id, requestedBy: referred.userId, amount: "100.00", status: chargeStatus, clientProfileId: referred.userId });
		await owner.query(
			`insert into charge_splits (pix_charge_id, bureau_id, beneficiary_kind, beneficiary_id, payout_method, asaas_wallet_id, pct, amount_cents, status)
			 values ($1, $2, 'affiliate', $3, 'asaas', 'wallet-x', 10, $4, $5)`,
			[c.id, T.bureau.id, T.client.userId, cents, status],
		);
	};
	await split(1000, "done");
	await split(333, "pending");
	await split(250, "reversal_failed");
	await split(700, "refused");
	await split(900, "refunded");
	// Split pending de cobrança ainda não paga: fora dos dois totais.
	await split(444, "pending", "pending");
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), pool.end()]);
});

describe("Recebido pelo Asaas", () => {
	it("affiliate summary: total = pending + done + reversal_failed, in cents; reversal_failed reported apart", async () => {
		const summary = await withDbContext(app, { userId: T.client.userId, role: "client", bureauId: T.bureau.id }, getMyAffiliateSummary);
		expect(summary?.asaasReceived).toEqual({ cents: 1583, reversalFailedCents: 250 });
	});

	it("Bureau list: same total and the same reversal_failed amount per affiliate", async () => {
		const mine = (await listBureauAffiliates(T.bureauAdmin)).find((a) => a.profileId === T.client.userId);
		expect(mine).toMatchObject({ totalCommission: "15.83", reversalFailed: "2.50" });
	});
});
