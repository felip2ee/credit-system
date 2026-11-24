// Link de pagamento contra um Postgres real, sob RLS.
import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system_test",
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
import { seedOrderDossier, seedTenant, type SeededTenant } from "@/test/seed";

import { createPaymentLink, listPaymentLinks, resolvePaymentLink } from "./queries";
import { generateToken } from "./token";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let a: SeededTenant;
let b: SeededTenant;

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

// Pedido de balcão aguardando pagamento, com liquidação (preço 300, custo 120).
async function counterOrder(t: SeededTenant, { settle = true, state = "awaiting_payment" } = {}): Promise<string> {
	const id = randomUUID();
	await seedOrderDossier(owner, { orderRef: id, bureauId: t.bureau.id, clientProfileId: null });
	if (settle) {
		await owner.query(
			"insert into order_settlements (order_ref, bureau_id, mode, price, cost) values ($1, $2, 'counter', 300, 120)",
			[id, t.bureau.id],
		);
	}
	await owner.query("update dossier_orders set state = $2 where dossier_id = $1", [id, state]);
	return id;
}

const activeCount = async (orderId: string) =>
	Number(
		(await owner.query("select count(*) from payment_links where order_id = $1 and status = 'active'", [orderId]))
			.rows[0].count,
	);

beforeAll(async () => {
	a = await seedTenant(owner, "Link A");
	b = await seedTenant(owner, "Link B");
});

describe("createPaymentLink", () => {
	it("stores only the token hash and audits without token or document", async () => {
		const orderId = await counterOrder(a);
		const result = await createPaymentLink(a.bureauAdmin, orderId);
		if (!result.ok) throw new Error("expected ok");

		const row = (await owner.query("select token_hash, expires_at from payment_links where id = $1", [result.id])).rows[0];
		expect(row.token_hash).toBe(generateTokenHash(result.token));
		expect(row.token_hash).not.toBe(result.token);
		const days = (row.expires_at.getTime() - Date.now()) / 86_400_000;
		expect(days).toBeGreaterThan(6.9);
		expect(days).toBeLessThanOrEqual(7);

		const audit = JSON.stringify(
			(await owner.query("select * from audit_logs where record_id = $1", [result.id])).rows,
		);
		expect(audit).toContain("payment_link.create");
		expect(audit).not.toContain(result.token);
	});

	it("keeps ONE active link per order: a second call replaces the first, in parallel too", async () => {
		const orderId = await counterOrder(a);
		const first = await createPaymentLink(a.bureauAdmin, orderId);
		const [second, third] = await Promise.all([
			createPaymentLink(a.bureauAdmin, orderId),
			createPaymentLink(a.bureauAdmin, orderId),
		]);
		if (!first.ok || !second.ok || !third.ok) throw new Error("expected ok");
		expect(await activeCount(orderId)).toBe(1);
		// O link antigo não abre mais; o mais novo abre.
		expect(await resolvePaymentLink(first.token)).toEqual({ ok: false, reason: "expired" });
		const live = await Promise.all([second, third].map((r) => resolvePaymentLink(r.token)));
		expect(live.filter((r) => r.ok)).toHaveLength(1);
	});

	it("replaces a link that expired by the clock (still 'active' in the table) without a 23505", async () => {
		const orderId = await counterOrder(a);
		const first = await createPaymentLink(a.bureauAdmin, orderId);
		if (!first.ok) throw new Error("expected ok");
		await owner.query("update payment_links set expires_at = now() - interval '1 hour' where id = $1", [first.id]);
		expect(await resolvePaymentLink(first.token)).toEqual({ ok: false, reason: "expired" });
		const second = await createPaymentLink(a.bureauAdmin, orderId);
		expect(second.ok).toBe(true);
		expect(await activeCount(orderId)).toBe(1);
	});

	it("refuses another bureau's order, online-style or not-awaiting-payment orders and paid orders", async () => {
		const orderA = await counterOrder(a);
		expect(await createPaymentLink(b.bureauAdmin, orderA)).toEqual({ ok: false, reason: "not_found" });
		expect(await createPaymentLink(a.bureauAdmin, randomUUID())).toEqual({ ok: false, reason: "not_found" });

		const ready = await counterOrder(a, { state: "ready" });
		expect(await createPaymentLink(a.bureauAdmin, ready)).toEqual({ ok: false, reason: "not_payable" });

		const link = await createPaymentLink(a.bureauAdmin, orderA);
		if (!link.ok) throw new Error("expected ok");
		await owner.query("select payment_link_mark_paid($1)", [orderA]);
		expect(await createPaymentLink(a.bureauAdmin, orderA)).toEqual({ ok: false, reason: "already_paid" });
	});
});

describe("resolvePaymentLink", () => {
	it("returns a summary with the masked document only", async () => {
		const orderId = await counterOrder(a);
		const link = await createPaymentLink(a.bureauAdmin, orderId);
		if (!link.ok) throw new Error("expected ok");
		const resolved = await resolvePaymentLink(link.token);
		if (!resolved.ok) throw new Error("expected ok");
		expect(resolved.summary).toEqual({
			bureauName: a.bureau.name,
			productName: "Dossiê Pessoa Física",
			amount: "300.00",
			maskedDocument: "***.000.000-**",
		});
		expect(JSON.stringify(resolved)).not.toMatch(/\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11}/);
	});

	it("is neutral for malformed, unknown, expired, cancelled and paid tokens", async () => {
		expect(await resolvePaymentLink("x")).toEqual({ ok: false, reason: "invalid" });
		expect(await resolvePaymentLink("' or 1=1 --")).toEqual({ ok: false, reason: "invalid" });
		expect(await resolvePaymentLink(generateToken().token)).toEqual({ ok: false, reason: "invalid" });

		const orderId = await counterOrder(a);
		const link = await createPaymentLink(a.bureauAdmin, orderId);
		if (!link.ok) throw new Error("expected ok");
		await owner.query("update payment_links set expires_at = now() - interval '1 second' where id = $1", [link.id]);
		expect(await resolvePaymentLink(link.token)).toEqual({ ok: false, reason: "expired" });

		await owner.query("update payment_links set expires_at = now() + interval '1 day', status = 'cancelled' where id = $1", [link.id]);
		expect(await resolvePaymentLink(link.token)).toEqual({ ok: false, reason: "expired" });

		await owner.query("update payment_links set status = 'active' where id = $1", [link.id]);
		await owner.query("select payment_link_mark_paid($1)", [orderId]);
		expect(await resolvePaymentLink(link.token)).toEqual({ ok: false, reason: "paid" });
	});

	it("is invalid when the order has no settlement price", async () => {
		const orderId = await counterOrder(a, { settle: false });
		const link = await createPaymentLink(a.bureauAdmin, orderId);
		if (!link.ok) throw new Error("expected ok");
		expect(await resolvePaymentLink(link.token)).toEqual({ ok: false, reason: "invalid" });
	});
});

// Mesma regra do módulo, recalculada fora dele: o teste não confia no que testa.
const generateTokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

describe("listPaymentLinks", () => {
	it("lists only the caller's bureau, newest first, without token or hash", async () => {
		const mine = await counterOrder(a);
		const other = await counterOrder(b);
		const first = await createPaymentLink(a.bureauAdmin, mine);
		const second = await createPaymentLink(a.bureauAdmin, mine);
		await createPaymentLink(b.bureauAdmin, other);
		if (!first.ok || !second.ok) throw new Error("expected ok");

		const list = await listPaymentLinks(a.bureauAdmin);
		expect(list.every((l) => l.orderId !== other)).toBe(true);
		const ids = list.map((l) => l.id);
		expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
		expect(list.find((l) => l.id === first.id)).toMatchObject({ status: "cancelled", orderId: mine, amount: "300.00" });
		expect(list.find((l) => l.id === second.id)?.status).toBe("active");
		expect(list.find((l) => l.id === first.id)?.paidAt).toBeNull();
		await owner.query("select payment_link_mark_paid($1)", [mine]);
		const paid = (await listPaymentLinks(a.bureauAdmin)).find((l) => l.id === second.id);
		expect(paid?.status).toBe("paid");
		expect(paid?.paidAt).toBeInstanceOf(Date);
		const json = JSON.stringify(list);
		expect(json).not.toContain(first.token);
		expect(json).not.toContain(second.token);
		expect(json).not.toContain("token_hash");
	});
});
