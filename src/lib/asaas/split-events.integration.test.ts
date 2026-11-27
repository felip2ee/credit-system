// Webhook de split do Asaas contra um Postgres real: charge_splits muda de status, idempotente por splitId, com auditoria mascarada.
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
		ASAAS_DRIVER: "fake",
		ASAAS_WEBHOOK_TOKEN: "s".repeat(32),
		DATABASE_WEBHOOK_URL:
			process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system_test",
	});
});

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST } from "@/app/api/webhooks/asaas/route";
import { ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";
import { pool } from "@/lib/db/pool";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedPixCharge, seedTenant } from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

function webhook(payload: unknown) {
	return POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers: { "content-type": "application/json", [ASAAS_WEBHOOK_TOKEN_HEADER]: "s".repeat(32) },
			body: JSON.stringify(payload),
		}),
	);
}

const WALLET = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";

async function seedSplit(kind: "partner" | "bureau" = "bureau") {
	const tenant = await seedTenant(owner, "Split T2");
	const charge = await seedPixCharge(owner, { bureauId: tenant.bureau.id, requestedBy: tenant.bureauAdmin.userId });
	const { rows } = await owner.query<{ id: string }>(
		`insert into charge_splits (pix_charge_id, bureau_id, beneficiary_kind, beneficiary_id, payout_method, asaas_wallet_id, pct, amount_cents)
		 values ($1, $2, $3, $4, 'asaas', $5, 10, 1000) returning id`,
		[charge.id, tenant.bureau.id, kind, randomUUID(), WALLET],
	);
	return { tenant, charge, splitRowId: rows[0].id };
}

const splitEvent = (paymentId: string, event: string, splitId: string, status: string) => ({
	id: `evt_${randomUUID()}`,
	event,
	payment: { object: "payment", id: paymentId, split: [{ id: splitId, walletId: WALLET, status }] },
});

const row = async (id: string) =>
	(await owner.query<{ status: string; asaas_split_id: string | null }>("select status, asaas_split_id from charge_splits where id = $1", [id]))
		.rows[0];
const audits = async (id: string) =>
	(await owner.query<{ action: string; bureau_id: string | null; metadata: Record<string, unknown> }>(
		"select action, bureau_id, metadata from audit_logs where table_name = 'charge_splits' and record_id = $1",
		[id],
	)).rows;

describe("webhook de split", () => {
	it("PAYMENT_SPLIT_DONE marca done, guarda o splitId e é idempotente", async () => {
		const { charge, splitRowId } = await seedSplit();
		const splitId = `spl_${randomUUID()}`;

		expect((await webhook(splitEvent(charge.asaasPaymentId, "PAYMENT_SPLIT_DONE", splitId, "DONE"))).status).toBe(200);
		expect((await webhook(splitEvent(charge.asaasPaymentId, "PAYMENT_SPLIT_DONE", splitId, "DONE"))).status).toBe(200);

		expect(await row(splitRowId)).toEqual({ status: "done", asaas_split_id: splitId });
		expect(await audits(splitRowId)).toHaveLength(1);
	});

	it("split recusado vira refused com auditoria sem o walletId inteiro", async () => {
		const { tenant, charge, splitRowId } = await seedSplit();
		const splitId = `spl_${randomUUID()}`;

		await webhook(splitEvent(charge.asaasPaymentId, "PAYMENT_SPLIT_CANCELLED", splitId, "REFUSED"));

		expect((await row(splitRowId)).status).toBe("refused");
		const [audit] = await audits(splitRowId);
		expect(audit).toMatchObject({ action: "charge_split.refused", bureau_id: tenant.bureau.id });
		expect(audit.metadata.wallet).toBe("***6789");
		expect(JSON.stringify(audit)).not.toContain(WALLET);
	});

	it("estorno depois de done vira refunded; evento atrasado de done não volta o status", async () => {
		const { charge, splitRowId } = await seedSplit();
		const splitId = `spl_${randomUUID()}`;
		await webhook(splitEvent(charge.asaasPaymentId, "PAYMENT_SPLIT_DONE", splitId, "DONE"));
		await webhook(splitEvent(charge.asaasPaymentId, "PAYMENT_REFUNDED", splitId, "REFUNDED"));
		await webhook(splitEvent(charge.asaasPaymentId, "PAYMENT_SPLIT_DONE", splitId, "DONE"));

		expect((await row(splitRowId)).status).toBe("refunded");
		expect((await audits(splitRowId)).map((a) => a.action)).toEqual(["charge_split.done", "charge_split.refunded"]);
	});

	it("chargeback com o split estornado muda a linha", async () => {
		const { charge, splitRowId } = await seedSplit();
		const splitId = `spl_${randomUUID()}`;
		await webhook(splitEvent(charge.asaasPaymentId, "PAYMENT_SPLIT_DONE", splitId, "DONE"));
		await webhook(splitEvent(charge.asaasPaymentId, "PAYMENT_CHARGEBACK_REQUESTED", splitId, "REFUNDED"));

		expect((await row(splitRowId)).status).toBe("refunded");
	});

	it("linha de sócio: auditoria sem bureau_id", async () => {
		const { charge, splitRowId } = await seedSplit("partner");
		await webhook(splitEvent(charge.asaasPaymentId, "PAYMENT_SPLIT_DONE", `spl_${randomUUID()}`, "DONE"));

		expect((await audits(splitRowId))[0].bureau_id).toBeNull();
	});

	it("cobrança sem split, walletId desconhecido e cobrança desconhecida: 200 e nada muda", async () => {
		const { charge, splitRowId } = await seedSplit();
		const unknownWallet = { ...splitEvent(charge.asaasPaymentId, "PAYMENT_SPLIT_DONE", "spl_x", "DONE") };
		unknownWallet.payment.split[0].walletId = randomUUID();

		expect((await webhook(unknownWallet)).status).toBe(200);
		expect((await webhook(splitEvent("pay_inexistente", "PAYMENT_SPLIT_DONE", "spl_y", "DONE"))).status).toBe(200);
		expect((await webhook({ id: "evt_n", event: "PAYMENT_SPLIT_DONE", payment: { id: charge.asaasPaymentId } })).status).toBe(200);

		expect((await row(splitRowId)).status).toBe("pending");
	});
});
