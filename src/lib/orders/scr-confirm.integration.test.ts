// Item 18 da #72: a autorização SCR do Titular tira a consulta de "Aguardando SCR" na mesma transação, sem esperar o tick.
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

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { quoteOrder } from "@/lib/catalog/quote";
import { pool } from "@/lib/db/pool";
import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { randomCpf, seedBureauCost, seedCatalogItem, seedClientWalletTopup, seedTenant, seedWalletTopup, type SeededTenant } from "@/test/seed";

import { placeOrder } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const onlyDigits = (value: string) => value.replace(/\D/g, "");
const CODE = "ABC123";

let tenant: SeededTenant;

beforeAll(async () => {
	await acquireClaimLock();
	tenant = await seedTenant(owner, "scr confirm");
	// O seed do catálogo deixa o produto inativo.
	await owner.query("update products set active = true where code = 'dossie_pf'");
	const { rows } = await owner.query<{ id: string }>("select id from products where code = 'dossie_pf'");
	await seedBureauCost(owner, { bureauId: tenant.bureau.id, productId: rows[0].id, cost: "1.00", setBy: tenant.bureauAdmin.userId });
	await seedCatalogItem(owner, { bureauId: tenant.bureau.id, productId: rows[0].id, salePrice: "50.00", updatedBy: tenant.bureauAdmin.userId });
	await seedWalletTopup(owner, { bureauId: tenant.bureau.id, amount: "200.00", createdBy: tenant.bureauAdmin.userId });
}, 120_000);

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
	await releaseClaimLock();
});

// Pedido de balcão com 1 membro: a consulta nasce 'pending_authorization' com a autorização SCR pendente.
async function counterOrder() {
	const operator = { ...tenant.operator };
	const input = {
		productCode: "dossie_pf" as const,
		self: false,
		subject: { type: "PF" as const, name: "Fulano de Tal", documentDigits: onlyDigits(randomCpf()) },
		partners: [],
		contact: { email: `titular-${crypto.randomUUID()}@example.com`, phoneE164: null },
		buyerProfileId: null,
	};
	const quote = await quoteOrder(operator, input.productCode, { partnerCount: 0 });
	if (!quote.ok) throw new Error(`quote failed: ${quote.reason}`);
	const placed = await placeOrder(operator, input, quote);
	if (!placed.ok) throw new Error(`placeOrder failed: ${placed.reason}`);
	const { rows } = await owner.query<{ id: string; public_token: string }>(
		`select s.id, s.public_token::text from scr_authorizations s
		  where s.id in (select scr_authorization_id from consultations where dossier_id = $1)`,
		[placed.dossierId],
	);
	await owner.query("update scr_authorizations set auth_code = $2 where id = $1", [rows[0].id, CODE]);
	return { dossierId: placed.dossierId, token: rows[0].public_token };
}

const confirm = (token: string, decision: "authorize" | "refuse") =>
	pool
		.query<{ r: string }>("select confirm_public_scr_authorization($1, 'internal', $2, $3, '203.0.113.9') as r", [token, CODE, decision])
		.then((result) => result.rows[0].r);

const consultationStatus = async (dossierId: string) =>
	(await owner.query<{ status: string }>("select status from consultations where dossier_id = $1", [dossierId])).rows.map((row) => row.status);

describe("confirm_public_scr_authorization e o estado da consulta", () => {
	it("autorização SCR muda a consulta para processing antes do tick", async () => {
		const order = await counterOrder();
		expect(await consultationStatus(order.dossierId)).toEqual(["pending_authorization"]);
		expect(await confirm(order.token, "authorize")).toBe("authorized");
		expect(await consultationStatus(order.dossierId)).toEqual(["processing"]);
	});

	it("recusa do Titular mantém a consulta em pending_authorization", async () => {
		const order = await counterOrder();
		expect(await confirm(order.token, "refuse")).toBe("refused");
		expect(await consultationStatus(order.dossierId)).toEqual(["pending_authorization"]);
	});
});

describe("confirm_public_scr_authorization: trilha com self_member", () => {
	async function onlineOrder(input: Record<string, unknown>) {
		const buyer = { ...tenant.client };
		const quote = await quoteOrder({ ...tenant.operator }, "dossie_pf", { partnerCount: 0 });
		if (!quote.ok) throw new Error(`quote failed: ${quote.reason}`);
		const placed = await placeOrder(buyer, { productCode: "dossie_pf", self: false, subject: null, partners: [], contact: { email: null, phoneE164: null }, buyerProfileId: null, ...input }, quote);
		if (!placed.ok) throw new Error(`placeOrder failed: ${placed.reason}`);
		const { rows } = await owner.query<{ id: string; public_token: string; holder_id: string }>(
			`select s.id, s.public_token::text, s.holder_id from scr_authorizations s
			  where s.id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[placed.dossierId],
		);
		await owner.query("update scr_authorizations set auth_code = $2 where id = $1", [rows[0].id, CODE]);
		return rows[0];
	}
	const metadataOf = async (holderId: string, eventType: string) =>
		(await owner.query<{ metadata: Record<string, unknown> }>("select metadata from timeline_events where entity_id = $1 and event_type = $2", [holderId, eventType]))
			.rows.map((r) => r.metadata);

	it("marks self_member when the authorization e-mail is the buyer's account e-mail", async () => {
		await seedClientWalletTopup(owner, { clientProfileId: tenant.client.userId, amount: "100.00", createdBy: tenant.bureauAdmin.userId });
		const own = await onlineOrder({ self: true });
		expect(await confirm(own.public_token, "authorize")).toBe("authorized");
		expect(await metadataOf(own.holder_id, "scr.self_authorized")).toEqual([{ self_member: true }]);
	});

	it("does not mark self_member when the order has no buyer (counter) or the member is another person", async () => {
		const counter = await counterOrder();
		const { rows } = await owner.query<{ holder_id: string }>("select holder_id from scr_authorizations where public_token = $1", [counter.token]);
		expect(await confirm(counter.token, "refuse")).toBe("refused");
		expect(await metadataOf(rows[0].holder_id, "scr.self_refused")).toEqual([{ self_member: false }]);
	});
});
