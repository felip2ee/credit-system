// Vendas da Carteira contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ??
			"postgres://app_runtime:test@localhost:54329/credit_system_test",
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

import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedClientWalletTopup,
	seedOrderCatalog,
	seedOrderDossier,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
} from "@/test/seed";

import { listSales } from "./sales";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const WIDE = { start: "2000-01-01T00:00:00Z", end: "2100-01-01T00:00:00Z" };

async function setup(label: string) {
	const tenant = await seedTenant(owner, label);
	await seedWalletTopup(owner, { bureauId: tenant.bureau.id, amount: "500.00", createdBy: tenant.bureauAdmin.userId });
	await seedClientWalletTopup(owner, { clientProfileId: tenant.client.userId, amount: "500.00", createdBy: tenant.bureauAdmin.userId });
	const admin: DbIdentity = { ...tenant.bureauAdmin };
	return { tenant, admin };
}

// Reserva o pedido: online na sessão do cliente (dono do saldo), balcão na da equipe.
async function place(t: SeededTenant, mode: "online" | "counter", price: string, cost: string): Promise<string> {
	const orderRef = randomUUID();
	const identity: DbIdentity = mode === "online" ? { ...t.client } : { ...t.operator };
	const clientProfileId = mode === "online" ? t.client.userId : null;
	await withUserTransaction(identity, async (c) => {
		await seedOrderDossier(owner, { orderRef, bureauId: t.bureau.id, clientProfileId });
		const { lines } = await seedOrderCatalog(owner, c, { productCode: "dossie_pf", price, cost });
		const quote = JSON.stringify({ lines });
		const { rows } = await c.query<{ ok: boolean; reason: string | null }>(
			"select ok, reason from reserve_order($1, $2, $3, $4, $5, $6::jsonb)",
			[orderRef, mode, clientProfileId, price, cost, quote],
		);
		expect(rows[0]).toMatchObject({ ok: true });
	});
	return orderRef;
}

const capture = (admin: DbIdentity, orderRef: string) =>
	withUserTransaction(admin, (c) => c.query("select * from capture_order($1)", [orderRef]));

const payCounter = (t: SeededTenant, dossierId: string, amount: string) =>
	owner
		.query(
			`insert into counter_payments (bureau_id, dossier_id, method, amount, registered_by)
			 values ($1, $2, 'cash', $3, $4) returning id`,
			[t.bureau.id, dossierId, amount, t.operator.userId],
		)
		.then((r) => r.rows[0].id as string);

describe("listSales", () => {
	it("returns each order only in its own tab, with paid, cost and Bureau share", async () => {
		const { tenant, admin } = await setup("Sales A");
		const onlineRef = await place(tenant, "online", "50.00", "30.00");
		await capture(admin, onlineRef);
		const counterRef = await place(tenant, "counter", "50.00", "30.00");
		await payCounter(tenant, counterRef, "50.00");

		const online = await withUserTransaction(admin, (c) => listSales(c, { mode: "online", range: WIDE }));
		expect(online.rows).toHaveLength(1);
		expect(online.rows[0]).toMatchObject({
			orderRef: onlineRef,
			mode: "online",
			paid: "50.00",
			cost: "30.00",
			bureauShare: "20.00",
			status: "paid",
			productName: expect.any(String),
		});
		expect(online.totals).toEqual({ paid: "50.00", cost: "30.00", bureauShare: "20.00" });

		const counter = await withUserTransaction(admin, (c) => listSales(c, { mode: "counter", range: WIDE }));
		expect(counter.rows.map((r) => r.orderRef)).toEqual([counterRef]);
		expect(counter.rows[0]).toMatchObject({ paid: "50.00", cost: "30.00", bureauShare: "20.00", status: "paid" });
		expect(counter.nextCursor).toBeNull();
	});

	it("does not show the full document, only the order subject name", async () => {
		const { tenant, admin } = await setup("Sales Doc");
		await place(tenant, "online", "50.00", "30.00");
		const { rows } = await withUserTransaction(admin, (c) => listSales(c, { mode: "online", range: WIDE }));
		const digits = tenant.holder.document.replace(/\D/g, "");
		expect(JSON.stringify(rows)).not.toContain(digits);
		expect(JSON.stringify(rows)).not.toContain(tenant.holder.document);
	});

	it("counter: partial payment is awaiting without share; a voided payment does not count", async () => {
		const { tenant, admin } = await setup("Sales B");
		const ref = await place(tenant, "counter", "50.00", "30.00");
		await payCounter(tenant, ref, "20.00");
		const voided = await payCounter(tenant, ref, "30.00");
		await withUserTransaction(admin, (c) => c.query("select * from void_counter_payment($1, $2)", [voided, "erro de digitação"]));

		const { rows, totals } = await withUserTransaction(admin, (c) => listSales(c, { mode: "counter", range: WIDE }));
		expect(rows[0]).toMatchObject({ paid: "20.00", status: "awaiting", bureauShare: "0.00" });
		expect(totals).toEqual({ paid: "20.00", cost: "30.00", bureauShare: "0.00" });
	});

	it("keeps a refunded online order in the list and out of the totals", async () => {
		const { tenant, admin } = await setup("Sales C");
		const kept = await place(tenant, "online", "50.00", "30.00");
		await capture(admin, kept);
		const refunded = await place(tenant, "online", "50.00", "30.00");
		await withUserTransaction({ ...tenant.client }, (c) => c.query("select * from release_order($1)", [refunded]));

		const { rows, totals } = await withUserTransaction(admin, (c) => listSales(c, { mode: "online", range: WIDE }));
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.orderRef === refunded)).toMatchObject({ status: "refunded", bureauShare: "0.00" });
		expect(totals).toEqual({ paid: "50.00", cost: "30.00", bureauShare: "20.00" });
	});

	it("filters by period", async () => {
		const { tenant, admin } = await setup("Sales D");
		await place(tenant, "online", "50.00", "30.00");
		const past = { start: "2000-01-01T00:00:00Z", end: "2000-02-01T00:00:00Z" };
		const { rows, totals } = await withUserTransaction(admin, (c) => listSales(c, { mode: "online", range: past }));
		expect(rows).toEqual([]);
		expect(totals).toEqual({ paid: "0.00", cost: "0.00", bureauShare: "0.00" });
	});

	it("paginates without repeating or losing rows", async () => {
		const { tenant, admin } = await setup("Sales E");
		const refs = [randomUUID(), randomUUID(), randomUUID()];
		for (const orderRef of refs) {
			await seedOrderDossier(owner, { orderRef, bureauId: tenant.bureau.id, clientProfileId: null });
		}
		const first = await withUserTransaction(admin, (c) => listSales(c, { mode: "counter", range: WIDE, limit: 2 }));
		expect(first.rows).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();
		const second = await withUserTransaction(admin, (c) =>
			listSales(c, { mode: "counter", range: WIDE, limit: 2, cursor: first.nextCursor }),
		);
		expect(second.rows).toHaveLength(1);
		expect(second.nextCursor).toBeNull();
		const seen = [...first.rows, ...second.rows].map((r) => r.orderRef);
		expect(new Set(seen).size).toBe(3);
		expect([...seen].sort()).toEqual([...refs].sort());
	});

	it("does not list orders of another Bureau", async () => {
		const a = await setup("Sales F1");
		const b = await setup("Sales F2");
		await place(a.tenant, "online", "50.00", "30.00");
		const { rows, totals } = await withUserTransaction(b.admin, (c) => listSales(c, { mode: "online", range: WIDE }));
		expect(rows).toEqual([]);
		expect(totals.paid).toBe("0.00");
	});

	it("returns empty lists for a Bureau without orders", async () => {
		const { admin } = await setup("Sales G");
		const page = await withUserTransaction(admin, (c) => listSales(c, { mode: "counter", range: WIDE }));
		expect(page).toEqual({ rows: [], totals: { paid: "0.00", cost: "0.00", bureauShare: "0.00" }, nextCursor: null });
	});
});
