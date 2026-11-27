// Schema do split na entrada (065) contra um Postgres real: sócios, indicação entre bureaus, modo de repasse e charge_splits.
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
import { withUserTransaction } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedPixCharge, seedSuperadmin, seedTenant, type SeededTenant, type SeedSuperadmin } from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let A: SeededTenant;
let B: SeededTenant;
let C: SeededTenant;
let SA: SeedSuperadmin;

beforeAll(async () => {
	[A, B, C, SA] = await Promise.all([
		seedTenant(owner, "Split A"),
		seedTenant(owner, "Split B"),
		seedTenant(owner, "Split C"),
		seedSuperadmin(owner),
	]);
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const referral = (referrer: string, referred: string, pct = 5) =>
	owner.query("insert into bureau_referrals (referrer_bureau_id, referred_bureau_id, pct) values ($1, $2, $3)", [
		referrer,
		referred,
		pct,
	]);

const partner = (pct: string) =>
	owner.query("insert into platform_partners (name, asaas_wallet_id, pct) values ('Sócio', $1, $2)", [randomUUID(), pct]);

describe("bureau_referrals", () => {
	it("refuses self-referral", async () => {
		await expect(referral(A.bureau.id, A.bureau.id)).rejects.toThrow(/bureau_referrals_no_self_check/);
	});

	it("allows one referrer per referred bureau only", async () => {
		await referral(A.bureau.id, B.bureau.id);
		await expect(referral(C.bureau.id, B.bureau.id)).rejects.toThrow(/bureau_referrals_referred_bureau_id_key/);
	});

	it("refuses a direct and an indirect cycle", async () => {
		await expect(referral(B.bureau.id, A.bureau.id)).rejects.toThrow(/ciclo/);
		await referral(B.bureau.id, C.bureau.id);
		await expect(referral(C.bureau.id, A.bureau.id)).rejects.toThrow(/ciclo/);
	});

	it("keeps the default pct at 5", async () => {
		const { rows } = await owner.query<{ pct: string }>(
			"select pct from bureau_referrals where referred_bureau_id = $1",
			[B.bureau.id],
		);
		expect(rows[0].pct).toBe("5.00");
	});
});

describe("affiliate_wallets", () => {
	it("defaults to pix and refuses an unknown payout_method", async () => {
		const { rows } = await owner.query<{ payout_method: string; asaas_wallet_id: string | null }>(
			"select payout_method, asaas_wallet_id from affiliate_wallets where profile_id = $1",
			[A.client.userId],
		);
		expect(rows[0]).toEqual({ payout_method: "pix", asaas_wallet_id: null });
		await expect(
			owner.query("update affiliate_wallets set payout_method = 'ted' where profile_id = $1", [A.client.userId]),
		).rejects.toThrow(/payout_method/);
	});

	it("requires a walletId in asaas mode", async () => {
		await expect(
			owner.query("update affiliate_wallets set payout_method = 'asaas' where profile_id = $1", [A.client.userId]),
		).rejects.toThrow(/affiliate_wallets_asaas_wallet_check/);
	});
});

describe("bureau_affiliate_settings", () => {
	it("starts with the affiliate program disabled", async () => {
		await owner.query("insert into bureau_affiliate_settings (bureau_id) values ($1)", [A.bureau.id]);
		const { rows } = await owner.query<{ affiliate_enabled: boolean }>(
			"select affiliate_enabled from bureau_affiliate_settings where bureau_id = $1",
			[A.bureau.id],
		);
		expect(rows[0].affiliate_enabled).toBe(false);
	});
});

describe("platform_partners", () => {
	it("refuses a pct outside (0, 100]", async () => {
		await expect(partner("0")).rejects.toThrow(/platform_partners_pct_check/);
		await expect(partner("100.01")).rejects.toThrow(/platform_partners_pct_check/);
		await partner("100");
		await owner.query("delete from platform_partners");
	});

	it("hides partners from the bureau_admin and shows them to the superadmin", async () => {
		await partner("10");
		const asAdmin = await withUserTransaction(
			{ userId: A.bureauAdmin.userId, role: "bureau_admin", bureauId: A.bureau.id },
			(c) => c.query("select id from platform_partners"),
		);
		expect(asAdmin.rowCount).toBe(0);
		const asSuper = await withUserTransaction({ userId: SA.userId, role: "superadmin", bureauId: null }, (c) =>
			c.query("select id from platform_partners"),
		);
		expect(asSuper.rowCount).toBe(1);
		await owner.query("delete from platform_partners");
	});
});

describe("charge_splits", () => {
	const split = (chargeId: string, bureauId: string, kind: string, beneficiaryId: string, extra = "'pix', null") =>
		owner.query(
			`insert into charge_splits (pix_charge_id, bureau_id, beneficiary_kind, beneficiary_id, payout_method, asaas_wallet_id, pct, amount_cents)
       values ($1, $2, $3, $4, ${extra}, 10, 1000)`,
			[chargeId, bureauId, kind, beneficiaryId],
		);

	it("refuses a duplicated beneficiary on the same charge", async () => {
		const charge = await seedPixCharge(owner, { bureauId: A.bureau.id, requestedBy: A.client.userId });
		const beneficiary = randomUUID();
		await split(charge.id, A.bureau.id, "affiliate", beneficiary);
		await expect(split(charge.id, A.bureau.id, "affiliate", beneficiary)).rejects.toThrow(
			/charge_splits_beneficiary_key/,
		);
	});

	it("refuses an unknown kind, status and payout_method", async () => {
		const charge = await seedPixCharge(owner, { bureauId: A.bureau.id, requestedBy: A.client.userId });
		await expect(split(charge.id, A.bureau.id, "other", randomUUID())).rejects.toThrow(/beneficiary_kind/);
		await expect(split(charge.id, A.bureau.id, "bureau", randomUUID(), "'ted', null")).rejects.toThrow(/payout_method/);
		await split(charge.id, A.bureau.id, "bureau", randomUUID());
		await expect(
			owner.query("update charge_splits set status = 'lost' where pix_charge_id = $1", [charge.id]),
		).rejects.toThrow(/charge_splits_status_check/);
	});

	it("keeps the charge and the split in the same bureau", async () => {
		const charge = await seedPixCharge(owner, { bureauId: A.bureau.id, requestedBy: A.client.userId });
		await expect(split(charge.id, B.bureau.id, "bureau", randomUUID())).rejects.toThrow(/foreign key/);
	});

	it("shows bureau lines to the owner bureau, partner lines only to the superadmin", async () => {
		const charge = await seedPixCharge(owner, { bureauId: A.bureau.id, requestedBy: A.client.userId });
		await split(charge.id, A.bureau.id, "bureau", A.bureau.id);
		await split(charge.id, A.bureau.id, "partner", randomUUID(), `'asaas', '${randomUUID()}'`);
		const read = (identity: Parameters<typeof withUserTransaction>[0]) =>
			withUserTransaction(identity, (c) =>
				c.query<{ beneficiary_kind: string }>("select beneficiary_kind from charge_splits where pix_charge_id = $1", [
					charge.id,
				]),
			);
		const asAdmin = await read({ userId: A.bureauAdmin.userId, role: "bureau_admin", bureauId: A.bureau.id });
		expect(asAdmin.rows.map((r) => r.beneficiary_kind)).toEqual(["bureau"]);
		const asOther = await read({ userId: B.bureauAdmin.userId, role: "bureau_admin", bureauId: B.bureau.id });
		expect(asOther.rowCount).toBe(0);
		const asSuper = await read({ userId: SA.userId, role: "superadmin", bureauId: null });
		expect(asSuper.rowCount).toBe(2);
	});
});

describe("bureau_asaas_wallets", () => {
	it("is hidden from the client and visible to the bureau staff", async () => {
		await owner.query("insert into bureau_asaas_wallets (bureau_id, asaas_wallet_id) values ($1, $2)", [
			A.bureau.id,
			randomUUID(),
		]);
		const read = (identity: Parameters<typeof withUserTransaction>[0]) =>
			withUserTransaction(identity, (c) => c.query("select bureau_id from bureau_asaas_wallets"));
		expect((await read({ userId: A.client.userId, role: "client", bureauId: A.bureau.id })).rowCount).toBe(0);
		expect((await read({ userId: A.bureauAdmin.userId, role: "bureau_admin", bureauId: A.bureau.id })).rowCount).toBe(1);
		expect((await read({ userId: B.bureauAdmin.userId, role: "bureau_admin", bureauId: B.bureau.id })).rowCount).toBe(0);
	});
});
