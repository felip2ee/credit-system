// NFS-e sem nota duplicada, contra um Postgres real e o driver fake do Asaas: timeout no POST, adoção da nota que já
// existe, reivindicação de pending antigo, evento casado pelo id da nota e nota cancelada.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const asaas = vi.hoisted(() => ({ posts: 0, timeoutNextPost: false }));

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
		ASAAS_DRIVER: "fake",
		ASAAS_WEBHOOK_TOKEN: "i".repeat(32),
	});
});

// O fake de verdade, com um POST que grava a nota no Asaas e depois "estoura o tempo" quando o teste pede.
vi.mock("@/lib/asaas", async () => {
	const { createFakeAsaasClient } = await vi.importActual<typeof import("@/lib/asaas/fake")>("@/lib/asaas/fake");
	const { AsaasOutcomeUnknownError } = await vi.importActual<typeof import("@/lib/asaas/client")>("@/lib/asaas/client");
	const base = createFakeAsaasClient();
	return {
		getAsaasClient: () => ({
			...base,
			async scheduleInvoice(input: Parameters<typeof base.scheduleInvoice>[0]) {
				asaas.posts += 1;
				const result = await base.scheduleInvoice(input);
				if (asaas.timeoutNextPost) {
					asaas.timeoutNextPost = false;
					throw new AsaasOutcomeUnknownError("Sem resposta do Asaas em POST /v3/invoices (TimeoutError)");
				}
				return result;
			},
		}),
	};
});

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { POST } from "@/app/api/webhooks/asaas/route";
import {
	ASAAS_EVENT_INVOICE_AUTHORIZED,
	ASAAS_EVENT_INVOICE_CANCELED,
	ASAAS_WEBHOOK_TOKEN_HEADER,
} from "@/lib/asaas/client";
import { buildFakeInvoiceEvent, resetFakeInvoices, setFakeInvoiceStatus } from "@/lib/asaas/fake";
import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedPixCharge, seedSuperadmin, seedTenant } from "@/test/seed";

import { repairInvoiceForPayment, requestInvoiceForPayment, rescheduleInvoice } from "./invoice";
import { listNfseFailures, requestNfseRetry } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

beforeEach(() => {
	asaas.posts = 0;
	asaas.timeoutNextPost = false;
	resetFakeInvoices();
	vi.stubEnv("NFSE_MUNICIPAL_SERVICE_ID", "svc-1");
	vi.stubEnv("NFSE_MUNICIPAL_SERVICE_NAME", "Consultoria");
	vi.stubEnv("NFSE_SERVICE_DESCRIPTION", "Recarga de créditos");
	vi.stubEnv("NFSE_ISS_RATE", "2");
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function paidCharge() {
	const tenant = await seedTenant(owner, "nfse-dup");
	const charge = await seedPixCharge(owner, {
		bureauId: tenant.bureau.id,
		requestedBy: tenant.bureauAdmin.userId,
		status: "paid",
	});
	return { tenant, charge };
}

const row = async (chargeId: string) =>
	(
		await owner.query<{
			nfse_status: string;
			nfse_number: string | null;
			nfse_url: string | null;
			asaas_invoice_id: string | null;
		}>("select nfse_status, nfse_number, nfse_url, asaas_invoice_id from pix_charges where id = $1", [chargeId])
	).rows[0];

const makeStale = (chargeId: string) =>
	owner.query("update pix_charges set nfse_updated_at = now() - interval '11 minutes' where id = $1", [chargeId]);

const postEvent = (payload: unknown) =>
	POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers: new Headers({ "content-type": "application/json", [ASAAS_WEBHOOK_TOKEN_HEADER]: "i".repeat(32) }),
			body: JSON.stringify(payload),
		}),
	);

describe("NFS-e sem duplicidade", () => {
	it("timeout on POST leaves the note pending (not failed); the reclaim adopts the invoice Asaas already made, with no second POST", async () => {
		const { charge } = await paidCharge();
		asaas.timeoutNextPost = true;

		expect(await requestInvoiceForPayment(charge.asaasPaymentId)).toBe("pending");
		expect(asaas.posts).toBe(1);
		expect(await row(charge.id)).toMatchObject({ nfse_status: "pending", asaas_invoice_id: null });

		// Pending recente: ninguém reivindica e ninguém chama o Asaas.
		expect(await repairInvoiceForPayment(charge.asaasPaymentId)).toBe("not_requested");
		expect(asaas.posts).toBe(1);

		// Pending com mais de 10 min é reivindicada: consulta primeiro, adota, não faz POST.
		await makeStale(charge.id);
		expect(await repairInvoiceForPayment(charge.asaasPaymentId)).toBe("pending");
		expect(asaas.posts).toBe(1);
		expect(await row(charge.id)).toMatchObject({
			nfse_status: "pending",
			asaas_invoice_id: `inv_fake_${charge.id}`,
		});
	});

	it("a manual retry adopts a live invoice instead of making a second note", async () => {
		const { charge } = await paidCharge();
		const superadmin = await seedSuperadmin(owner);
		asaas.timeoutNextPost = true;
		await requestInvoiceForPayment(charge.asaasPaymentId);
		// Alguém marca a nota como failed mesmo com a nota viva no Asaas (a reparação manual do superadmin).
		await owner.query("update pix_charges set nfse_status = 'failed' where id = $1", [charge.id]);

		expect(await requestNfseRetry(superadmin, charge.id)).toEqual({ ok: true });
		expect(await rescheduleInvoice(superadmin, charge.id)).toBe("pending");

		expect(asaas.posts).toBe(1);
		expect(await row(charge.id)).toMatchObject({ nfse_status: "pending", asaas_invoice_id: `inv_fake_${charge.id}` });
	});

	it("an invoice event is matched by invoice id even when the payment in the body is unknown", async () => {
		const { charge } = await paidCharge();
		await requestInvoiceForPayment(charge.asaasPaymentId);
		expect((await row(charge.id)).asaas_invoice_id).toBe(`inv_fake_${charge.id}`);

		const response = await postEvent(
			buildFakeInvoiceEvent({
				eventId: `evt_${randomUUID()}`,
				event: ASAAS_EVENT_INVOICE_AUTHORIZED,
				asaasPaymentId: `pay_${randomUUID()}`,
				invoiceId: `inv_fake_${charge.id}`,
				number: "88",
				pdfUrl: "https://nfse.example/88.pdf",
			}),
		);

		expect(response.status).toBe(200);
		expect(await row(charge.id)).toMatchObject({ nfse_status: "issued", nfse_number: "88", nfse_url: "https://nfse.example/88.pdf" });
	});

	it("INVOICE_CANCELED turns an issued note into failed without number and url, so the receipt link disappears; a retry makes a new note", async () => {
		const { charge } = await paidCharge();
		const superadmin = await seedSuperadmin(owner);
		await requestInvoiceForPayment(charge.asaasPaymentId);
		await postEvent(
			buildFakeInvoiceEvent({
				eventId: `evt_${randomUUID()}`,
				event: ASAAS_EVENT_INVOICE_AUTHORIZED,
				asaasPaymentId: charge.asaasPaymentId,
				number: "5",
				pdfUrl: "https://nfse.example/5.pdf",
			}),
		);
		expect(await row(charge.id)).toMatchObject({ nfse_status: "issued", nfse_number: "5" });

		const canceled = await postEvent(
			buildFakeInvoiceEvent({
				eventId: `evt_${randomUUID()}`,
				event: ASAAS_EVENT_INVOICE_CANCELED,
				asaasPaymentId: charge.asaasPaymentId,
			}),
		);

		expect(canceled.status).toBe(200);
		expect(await row(charge.id)).toMatchObject({ nfse_status: "failed", nfse_number: null, nfse_url: null });
		const failures = await withUserTransaction(superadmin, (client) => listNfseFailures(client));
		expect(failures.map((f) => f.chargeId)).toContain(charge.id);

		setFakeInvoiceStatus(charge.asaasPaymentId, "CANCELED");
		expect(await requestNfseRetry(superadmin, charge.id)).toEqual({ ok: true });
		expect(await rescheduleInvoice(superadmin, charge.id)).toBe("pending");
		expect(asaas.posts).toBe(2);
	});

	it("INVOICE_CANCELED on a note that is not issued changes nothing", async () => {
		const { charge } = await paidCharge();
		await requestInvoiceForPayment(charge.asaasPaymentId);

		await postEvent(
			buildFakeInvoiceEvent({
				eventId: `evt_${randomUUID()}`,
				event: ASAAS_EVENT_INVOICE_CANCELED,
				asaasPaymentId: charge.asaasPaymentId,
			}),
		);

		expect(await row(charge.id)).toMatchObject({ nfse_status: "pending" });
	});
});
