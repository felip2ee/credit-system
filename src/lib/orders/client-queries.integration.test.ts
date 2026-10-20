// Leitura do pedido pelo cliente (M6) contra um Postgres real, sob RLS.
import { createHash } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system",
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
import { loadLatestPayload } from "@/lib/consultations/canonical-store";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	randomCpf,
	seedBureauCost,
	seedCatalogItem,
	seedClientProfile,
	seedClientWalletTopup,
	seedTenant,
	type SeededTenant,
} from "@/test/seed";

import { getMyDelivery, getMyOrder, listMyOrders } from "./client-queries";
import { claimOrders, completeOrder, placeOrder, refreshOrderState, releaseDelivery, revokeDelivery } from "./queries";
import { setAiStatus } from "./tick-queries";
import type { OpenOrderInput } from "./types";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

beforeAll(acquireClaimLock, 120_000);

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
	await releaseClaimLock();
});

const onlyDigits = (value: string) => value.replace(/\D/g, "");
const maskCpf = (digits: string) => `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;

async function newTenant(label: string): Promise<SeededTenant> {
	const t = await seedTenant(owner, label);
	for (const [code, price] of [["consulta_pf", "50.00"], ["parecer_ia", "20.00"]]) {
		const { rows } = await owner.query<{ id: string }>("select id from products where code = $1", [code]);
		await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: "1.00", setBy: t.bureauAdmin.userId });
		await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: rows[0].id, salePrice: price, updatedBy: t.bureauAdmin.userId });
	}
	await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "300.00", createdBy: t.bureauAdmin.userId });
	return t;
}

const staff = (t: SeededTenant): DbIdentity => ({ ...t.operator });

const ownInput: OpenOrderInput = {
	productCode: "consulta_pf",
	withAi: false,
	self: true,
	subject: null,
	partners: [],
	contact: { email: null, phoneE164: null },
	buyerProfileId: null,
};

async function place(t: SeededTenant, buyer: DbIdentity, input: OpenOrderInput): Promise<string> {
	// O cliente não lê o custo do catálogo: a cotação sai com a identidade da equipe.
	const q = await quoteOrder(staff(t), input.productCode, { withAi: input.withAi });
	if (!q.ok) throw new Error(q.reason);
	const result = await placeOrder(buyer, input, q);
	if (!result.ok) throw new Error(result.reason);
	return result.dossierId;
}

async function release(t: SeededTenant, id: string, withAi = false) {
	await owner.query(
		`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days'
		  where id in (select scr_authorization_id from consultations where dossier_id = $1) and status = 'pending'`,
		[id],
	);
	await withUserTransaction(staff(t), async (c) => {
		await refreshOrderState(c, id);
		await claimOrders(c, 10, id);
		expect(await completeOrder(c, staff(t), id)).toBe("completed");
		if (withAi) await setAiStatus(c, staff(t), id, "done", 1);
		expect(await releaseDelivery(c, staff(t), id, "https://app.example.test")).toEqual({ ok: true });
	});
}

// Resultado canônico e parecer da consulta, como o tick os grava.
async function seedResult(t: SeededTenant, dossierId: string) {
	const { rows } = await owner.query<{ id: string; holder_id: string }>(
		"select id, holder_id from consultations where dossier_id = $1",
		[dossierId],
	);
	const consultation = rows[0];
	await owner.query("update consultations set status = 'completed' where id = $1", [consultation.id]);
	const payload = await owner.query<{ id: string }>(
		`insert into bureau_payloads (bureau_id, consultation_id, provider, product, received_at, http_status, payload, payload_sha256, validation_status)
		 values ($1, $2, 'deps', 'smart_pf', now(), 200, '{}'::jsonb, $3, 'valid') returning id`,
		[t.bureau.id, consultation.id, createHash("sha256").update(consultation.id).digest("hex")],
	);
	await owner.query(
		`insert into bureau_results (bureau_id, consultation_id, payload_id, adapter_version, canonical_result, document)
		 values ($1, $2, $3, 1, '{"marker":"canonical"}'::jsonb, $4)`,
		[t.bureau.id, consultation.id, payload.rows[0].id, onlyDigits(t.holder.document)],
	);
	await owner.query(
		`insert into ai_reports (bureau_id, consultation_id, holder_id, full_report, status)
		 values ($1, $2, $3, '{"apto":"apto"}'::jsonb, 'completed')`,
		[t.bureau.id, consultation.id, consultation.holder_id],
	);
}

describe("listMyOrders", () => {
	it("listMyOrders returns only own orders with the subject snapshot and price", async () => {
		const t = await newTenant("cq list");
		const other = await seedClientProfile(owner, t.bureau.id);
		await seedClientWalletTopup(owner, { clientProfileId: other.userId, amount: "100.00", createdBy: t.bureauAdmin.userId });

		const mine = await place(t, t.client, ownInput);
		const third = await place(t, t.client, {
			...ownInput,
			self: false,
			subject: { type: "PF", name: "Maria Souza", documentDigits: onlyDigits(randomCpf()) },
			contact: { email: "maria@example.com", phoneE164: null },
		});
		const theirs = await place(t, other, {
			...ownInput,
			self: false,
			subject: { type: "PF", name: "João Lima", documentDigits: onlyDigits(randomCpf()) },
			contact: { email: "joao@example.com", phoneE164: null },
		});

		const list = await withUserTransaction(t.client, (c) => listMyOrders(c));
		expect(list.map((o) => o.dossierId)).toEqual([third, mine]);
		expect(list[1]).toEqual({
			dossierId: mine,
			mode: "online",
			productCode: "consulta_pf",
			withAi: false,
			selfResearch: true,
			subjectName: expect.stringContaining("Titular"),
			subjectDocumentMasked: maskCpf(onlyDigits(t.holder.document)),
			state: "awaiting_authorization",
			reason: null,
			price: "50.00",
			createdAt: expect.any(Date),
			releasedAt: null,
		});
		expect(list[0]).toMatchObject({ subjectName: "Maria Souza", price: "50.00" });
		expect(JSON.stringify(list)).not.toContain("cost");
		expect(await withUserTransaction(t.client, (c) => listMyOrders(c, 1))).toHaveLength(1);

		const others = await withUserTransaction(other, (c) => listMyOrders(c));
		expect(others.map((o) => o.dossierId)).toEqual([theirs]);
		expect(others[0].subjectName).toBe("João Lima");
	});

	it("hides the price of a counter order the client did not settle", async () => {
		const t = await newTenant("cq counter");
		await place(t, t.client, ownInput);
		await owner.query("select * from wallet_post_entry($1, 'topup', 100, $2, 'seed', null, $3)", [t.bureau.id, `seed-${t.bureau.id}`, t.bureauAdmin.userId]);
		const id = await place(t, staff(t), {
			...ownInput,
			self: false,
			subject: { type: "PF", name: "Pedro Alves", documentDigits: onlyDigits(randomCpf()) },
			contact: { email: "pedro@example.com", phoneE164: null },
			buyerProfileId: t.client.userId,
		});

		const list = await withUserTransaction(t.client, (c) => listMyOrders(c));
		expect(list.find((o) => o.dossierId === id)).toMatchObject({ price: null, state: "awaiting_payment" });
	});
});

describe("getMyOrder", () => {
	it("getMyOrder finds an own order and returns null for another client's", async () => {
		const t = await newTenant("cq one");
		const other = await seedClientProfile(owner, t.bureau.id);
		const id = await place(t, t.client, ownInput);

		expect(await withUserTransaction(t.client, (c) => getMyOrder(c, id))).toMatchObject({ dossierId: id, mode: "online", state: "awaiting_authorization" });
		expect(await withUserTransaction(other, (c) => getMyOrder(c, id))).toBeNull();
		expect(await withUserTransaction(t.client, (c) => getMyOrder(c, crypto.randomUUID()))).toBeNull();
	});
});

describe("getMyDelivery", () => {
	it("getMyDelivery is null before release and after revoke", async () => {
		const t = await newTenant("cq delivery");
		const other = await seedClientProfile(owner, t.bureau.id);
		const id = await place(t, t.client, ownInput);
		const mine = (identity: DbIdentity = t.client) => withUserTransaction(identity, (c) => getMyDelivery(c, id));

		expect(await mine()).toBeNull();
		await release(t, id);
		await seedResult(t, id);

		const delivery = await mine();
		expect(delivery).toMatchObject({
			kind: "PF",
			order: { dossierId: id, state: "released", price: "50.00" },
			dossierOpinion: null,
			members: [{ type: "PF", status: "completed", canonical: { marker: "canonical" }, payload: {}, opinion: null }],
		});
		expect(delivery?.members).toHaveLength(1);
		expect(await mine(other)).toBeNull();

		await withUserTransaction(staff(t), (c) => revokeDelivery(c, staff(t), id, "Resultado em revisão"));
		expect(await mine()).toBeNull();
	});

	it("uses the payload referenced by the result, not the newest row", async () => {
		const t = await newTenant("cq payload pick");
		const id = await place(t, t.client, ownInput);
		await release(t, id);
		await seedResult(t, id);
		await owner.query(
			`insert into bureau_payloads (bureau_id, consultation_id, provider, product, received_at, http_status, payload, payload_sha256, validation_status)
			 select bureau_id, consultation_id, provider, product, now() + interval '1 hour', http_status, '{"newer":true}'::jsonb, repeat('b', 64), 'incompatible'
			   from bureau_payloads where bureau_id = $1`,
			[t.bureau.id],
		);

		const delivery = await withUserTransaction(t.client, (c) => getMyDelivery(c, id));
		expect(delivery?.members[0].payload).toEqual({});
		const { rows } = await owner.query<{ id: string }>("select id from consultations where dossier_id = $1", [id]);
		expect(await loadLatestPayload(staff(t), rows[0].id)).toEqual({});
	});

	it("exposes the opinion only for an order with the AI add-on", async () => {
		const t = await newTenant("cq ai scope");
		const without = await place(t, t.client, ownInput);
		const withAi = await place(t, t.client, { ...ownInput, withAi: true });
		await release(t, without);
		await release(t, withAi, true);
		await seedResult(t, without);
		await seedResult(t, withAi);

		const plain = await withUserTransaction(t.client, (c) => getMyDelivery(c, without));
		const paid = await withUserTransaction(t.client, (c) => getMyDelivery(c, withAi));

		expect(plain?.members[0].opinion).toBeNull();
		expect(paid?.members[0].opinion).toEqual({ apto: "apto" });
	});
});
