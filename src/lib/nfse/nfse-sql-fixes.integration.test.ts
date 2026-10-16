// NFS-e na camada SQL (016, 017): nova tentativa só de cobrança paga, id da nota do Asaas e nota presa em pending.
// Chama as funções direto, pelas roles reais (app_webhook, app_runtime), contra um Postgres real.
import { randomBytes } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL, TEST_DATABASE_WEBHOOK_URL } from "@/test/db-env";
import { seedPixCharge, seedSuperadmin, seedTenant } from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), hook.end()]);
});

type StatusRow = { ok: boolean; reason: string | null; status: string | null; changed: boolean };

const setStatus = (chargeId: string, status: string, invoiceId: string | null = null) =>
	hook
		.query<StatusRow>("select * from set_nfse_status($1, $2, null, null, $3)", [chargeId, status, invoiceId])
		.then((r) => r.rows[0]);
const byInvoice = (invoiceId: string) =>
	hook
		.query<{ charge_id: string; amount: string }>("select * from nfse_charge_by_invoice($1)", [invoiceId])
		.then((r) => r.rows);
const row = async (chargeId: string) =>
	(
		await owner.query<{
			nfse_status: string;
			nfse_attempts: number;
			asaas_invoice_id: string | null;
			nfse_updated_at: Date | null;
		}>("select nfse_status, nfse_attempts, asaas_invoice_id, nfse_updated_at from pix_charges where id = $1", [chargeId])
	).rows[0];
const makeStale = (chargeId: string, minutes: number) =>
	owner.query("update pix_charges set nfse_updated_at = now() - make_interval(mins => $2) where id = $1", [
		chargeId,
		minutes,
	]);

async function superadminSession<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
	const superadmin = await seedSuperadmin(owner);
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true), set_config('app.user_role', 'superadmin', true),
              set_config('app.bureau_id', '', true), set_config('app.support_session_id', '', true)`,
			[superadmin.userId],
		);
		const result = await work(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

async function paidCharge() {
	const tenant = await seedTenant(owner, "nfse sql");
	return seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId, status: "paid" });
}
const newInvoiceId = () => `inv_${randomBytes(8).toString("hex")}`;

describe("A4: nova tentativa só de cobrança paga", () => {
	it("refuses the retry and hides the failed note when the charge was refunded", async () => {
		const paid = await paidCharge();
		const refunded = await paidCharge();
		for (const c of [paid, refunded]) await owner.query("update pix_charges set nfse_status = 'failed' where id = $1", [c.id]);
		await owner.query("update pix_charges set status = 'refunded' where id = $1", [refunded.id]);

		const seen = await superadminSession(async (c) => {
			const list = await c.query<{ charge_id: string }>("select charge_id from list_failed_nfse(500)");
			const target = await c.query("select * from nfse_charge_payment($1)", [refunded.id]);
			const retry = await c.query<{ ok: boolean; reason: string }>("select * from request_nfse_retry($1)", [refunded.id]);
			return { ids: list.rows.map((r) => r.charge_id), target: target.rows, retry: retry.rows[0] };
		});

		expect(seen.ids).toContain(paid.id);
		expect(seen.ids).not.toContain(refunded.id);
		expect(seen.target).toEqual([]);
		expect(seen.retry).toMatchObject({ ok: false, reason: "invalid_state" });
		expect(await row(refunded.id)).toMatchObject({ nfse_status: "failed", nfse_attempts: 0 });
	});

	it("still retries a paid failed note", async () => {
		const paid = await paidCharge();
		await owner.query("update pix_charges set nfse_status = 'failed' where id = $1", [paid.id]);
		const retry = await superadminSession((c) =>
			c.query<{ ok: boolean }>("select * from request_nfse_retry($1)", [paid.id]).then((r) => r.rows[0]),
		);
		expect(retry.ok).toBe(true);
		expect(await row(paid.id)).toMatchObject({ nfse_status: "pending", nfse_attempts: 1 });
	});
});

describe("A7: id da nota do Asaas", () => {
	it("keeps the 4-argument call working and records the invoice id while the note stays pending", async () => {
		const charge = await paidCharge();
		const invoiceId = newInvoiceId();

		const claim = await hook
			.query<StatusRow>("select * from set_nfse_status($1, 'pending', null, null)", [charge.id])
			.then((r) => r.rows[0]);
		expect(claim).toMatchObject({ ok: true, status: "pending", changed: true });
		expect((await row(charge.id)).asaas_invoice_id).toBeNull();

		// O Asaas devolveu o id: grava sem mudar o status e sem passar a mudança adiante.
		expect(await setStatus(charge.id, "pending", invoiceId)).toMatchObject({ ok: true, status: "pending", changed: false });
		expect((await row(charge.id)).asaas_invoice_id).toBe(invoiceId);
		expect(await byInvoice(invoiceId)).toEqual([{ charge_id: charge.id, amount: "100.00" }]);

		// O id já gravado não é trocado por outro.
		await setStatus(charge.id, "pending", newInvoiceId());
		expect((await row(charge.id)).asaas_invoice_id).toBe(invoiceId);

		// O evento da nota fecha a nota; o id fica.
		expect(await setStatus(charge.id, "issued")).toMatchObject({ ok: true, status: "issued", changed: true });
		expect((await row(charge.id)).asaas_invoice_id).toBe(invoiceId);
	});

	it("finds a note by invoice id even after the charge was refunded, and finds nothing for unknown ids", async () => {
		const charge = await paidCharge();
		const invoiceId = newInvoiceId();
		await setStatus(charge.id, "pending", invoiceId);
		await owner.query("update pix_charges set status = 'refunded' where id = $1", [charge.id]);

		expect(await byInvoice(invoiceId)).toHaveLength(1);
		expect(await byInvoice(newInvoiceId())).toEqual([]);
	});

	it("refuses a bad invoice id, a duplicated one, and is not executable by app_runtime", async () => {
		const a = await paidCharge();
		const b = await paidCharge();
		expect(await setStatus(a.id, "pending", "  ")).toMatchObject({ ok: false, reason: "invalid_invoice_id" });
		expect(await setStatus(a.id, "pending", "x".repeat(101))).toMatchObject({ ok: false, reason: "invalid_invoice_id" });

		const invoiceId = newInvoiceId();
		await setStatus(a.id, "pending", invoiceId);
		await expect(setStatus(b.id, "pending", invoiceId)).rejects.toThrow(/duplicate key|unique/);

		await expect(app.query("select * from nfse_charge_by_invoice($1)", [invoiceId])).rejects.toThrow(/permission denied/);
		await expect(app.query("select * from set_nfse_status($1, 'pending', null, null, null)", [a.id])).rejects.toThrow(
			/permission denied/,
		);
	});

	it("drops the old invoice id when a manual retry starts a new attempt", async () => {
		const charge = await paidCharge();
		const invoiceId = newInvoiceId();
		await setStatus(charge.id, "pending", invoiceId);
		await setStatus(charge.id, "failed");
		await superadminSession((c) => c.query("select * from request_nfse_retry($1)", [charge.id]));

		expect(await row(charge.id)).toMatchObject({ nfse_status: "pending", nfse_attempts: 1, asaas_invoice_id: null });
		expect(await byInvoice(invoiceId)).toEqual([]);
	});
});

describe("A7: nota presa em pending", () => {
	it("lets a note stuck for more than 10 minutes be claimed again, once, and clears its old invoice id", async () => {
		const charge = await paidCharge();
		await setStatus(charge.id, "pending", newInvoiceId());
		await makeStale(charge.id, 11);
		const before = (await row(charge.id)).nfse_updated_at as Date;

		const reclaim = await setStatus(charge.id, "pending");
		expect(reclaim).toMatchObject({ ok: true, status: "pending", changed: true });
		const after = await row(charge.id);
		expect(after.asaas_invoice_id).toBeNull();
		expect((after.nfse_updated_at as Date).getTime()).toBeGreaterThan(before.getTime());
		expect(after.nfse_attempts).toBe(0);

		// Quem chegou depois não reserva de novo: a nota acabou de ser renovada.
		expect(await setStatus(charge.id, "pending")).toMatchObject({ ok: true, status: "pending", changed: false });
	});

	it("does not reclaim a recent pending note", async () => {
		const charge = await paidCharge();
		await setStatus(charge.id, "pending");
		await makeStale(charge.id, 9);
		expect(await setStatus(charge.id, "pending")).toMatchObject({ ok: true, status: "pending", changed: false });
	});

	it("does not reclaim a failed or issued note", async () => {
		const failed = await paidCharge();
		const issued = await paidCharge();
		await setStatus(failed.id, "pending");
		await setStatus(failed.id, "failed");
		await setStatus(issued.id, "pending");
		await setStatus(issued.id, "issued");
		for (const c of [failed, issued]) await makeStale(c.id, 60);

		expect(await setStatus(failed.id, "pending")).toMatchObject({ changed: false, status: "failed" });
		expect(await setStatus(issued.id, "pending")).toMatchObject({ changed: false, status: "issued" });
	});

	it("reclaims a pending note whose timestamp is missing", async () => {
		const charge = await paidCharge();
		await owner.query("update pix_charges set nfse_status = 'pending', nfse_updated_at = null where id = $1", [charge.id]);
		expect(await setStatus(charge.id, "pending")).toMatchObject({ changed: true, status: "pending" });
	});
});
