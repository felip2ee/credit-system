// NFS-e sob RLS e na role app_webhook contra um Postgres real. A nota nunca muda a carteira.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system",
		DATABASE_WEBHOOK_URL:
			process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system",
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
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedPixCharge, seedSuperadmin, seedTenant, seedWalletTopup } from "@/test/seed";

import { listNfseFailures, requestNfseRetry, setNfseStatus } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

async function setup() {
	const superadmin = await seedSuperadmin(owner);
	const tenant = await seedTenant(owner, "nfse");
	await seedWalletTopup(owner, { bureauId: tenant.bureau.id, amount: "100.00", createdBy: tenant.bureauAdmin.userId });
	const charge = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId, status: "paid" });
	return { superadmin, tenant, charge };
}

const nfse = async (chargeId: string) =>
	(
		await owner.query<{ nfse_status: string; nfse_number: string | null; nfse_url: string | null; nfse_attempts: number }>(
			"select nfse_status, nfse_number, nfse_url, nfse_attempts from pix_charges where id = $1",
			[chargeId],
		)
	).rows[0];
const balance = async (bureauId: string) =>
	(await owner.query<{ available: string }>("select available from wallets where bureau_id = $1", [bureauId])).rows[0].available;

describe("listNfseFailures", () => {
	it("lists failed invoices for the superadmin only, without the Asaas payment id", async () => {
		const { superadmin, tenant, charge } = await setup();
		await setNfseStatus(charge.id, "failed");

		const asSuper = await withUserTransaction(superadmin, (c) => listNfseFailures(c));
		const asAdmin = await withUserTransaction(tenant.bureauAdmin, (c) => listNfseFailures(c));

		const row = asSuper.find((r) => r.chargeId === charge.id);
		expect(row).toMatchObject({ bureauId: tenant.bureau.id, amount: "100.00", attempts: 0 });
		expect(JSON.stringify(row)).not.toContain(charge.asaasPaymentId);
		expect(asAdmin).toEqual([]);
	});
});

describe("requestNfseRetry", () => {
	it("moves failed to pending, counts the attempt and audits it", async () => {
		const { superadmin, charge } = await setup();
		await setNfseStatus(charge.id, "failed");

		const result = await requestNfseRetry(superadmin, charge.id);

		expect(result).toEqual({ ok: true });
		expect(await nfse(charge.id)).toMatchObject({ nfse_status: "pending", nfse_attempts: 1 });
		const audit = await owner.query("select user_id from audit_logs where action = 'nfse.retry' and record_id = $1", [charge.id]);
		expect(audit.rows).toEqual([{ user_id: superadmin.userId }]);
	});

	it("refuses a charge that is not failed, an unknown charge and a bureau_admin", async () => {
		const { superadmin, tenant, charge } = await setup();

		expect(await requestNfseRetry(superadmin, charge.id)).toEqual({ ok: false, reason: "invalid_state" });
		expect(await requestNfseRetry(superadmin, randomUUID())).toEqual({ ok: false, reason: "not_found" });
		expect(await requestNfseRetry(tenant.bureauAdmin, charge.id)).toEqual({ ok: false, reason: "not_allowed" });
		const audit = await owner.query("select 1 from audit_logs where action = 'nfse.retry' and record_id = $1", [charge.id]);
		expect(audit.rows).toEqual([]);
	});
});

describe("setNfseStatus (app_webhook)", () => {
	it("records issued with number and url; a duplicate changes nothing; issued never regresses", async () => {
		const { charge } = await setup();
		await setNfseStatus(charge.id, "pending");

		const first = await setNfseStatus(charge.id, "issued", { number: "123", url: "https://nfse.example/123.pdf" });
		const duplicate = await setNfseStatus(charge.id, "issued", { number: "999", url: "https://nfse.example/other.pdf" });
		const regress = await setNfseStatus(charge.id, "failed");
		const back = await setNfseStatus(charge.id, "pending");

		expect(first).toEqual({ ok: true, status: "issued", changed: true });
		expect(duplicate).toEqual({ ok: true, status: "issued", changed: false });
		expect(regress).toEqual({ ok: true, status: "issued", changed: false });
		expect(back).toEqual({ ok: true, status: "issued", changed: false });
		expect(await nfse(charge.id)).toMatchObject({
			nfse_status: "issued",
			nfse_number: "123",
			nfse_url: "https://nfse.example/123.pdf",
		});
	});

	it("never changes the wallet, whatever the invoice does", async () => {
		const { tenant, charge } = await setup();
		const before = await balance(tenant.bureau.id);

		await setNfseStatus(charge.id, "pending");
		await setNfseStatus(charge.id, "failed");
		await setNfseStatus(charge.id, "issued", { number: "1" });
		await setNfseStatus(charge.id, "issued", { number: "1" });

		expect(await balance(tenant.bureau.id)).toBe(before);
	});

	it("refuses an unpaid charge, an unknown charge and bad values", async () => {
		const { tenant, charge } = await setup();
		const pending = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });

		expect(await setNfseStatus(pending.id, "pending")).toMatchObject({ ok: false, reason: "invalid_state" });
		expect(await setNfseStatus(randomUUID(), "pending")).toEqual({ ok: false, reason: "not_found" });
		expect(await setNfseStatus(charge.id, "issued", { url: "http://insecure.example/x" })).toEqual({
			ok: false,
			reason: "invalid_url",
		});
	});
});
