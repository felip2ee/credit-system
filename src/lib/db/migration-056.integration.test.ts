// Migration 056: app do admin do bureau (visitas, histórico de slug, link de pagamento).
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL, TEST_DATABASE_WEBHOOK_URL } from "@/test/db-env";
import { seedOrderDossier, seedSuperadmin, seedTenant, withDbContext, type SeededTenant } from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
const webhook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 2 });

const hashOf = () => createHash("sha256").update(randomBytes(32)).digest("hex");
const IN_7_DAYS = () => new Date(Date.now() + 7 * 24 * 3600 * 1000);

let a: SeededTenant;
let b: SeededTenant;
let orderA: string;
let orderB: string;

// Comita (withDbContext sempre faz rollback) para a função pública e o webhook enxergarem o link.
async function insertLink(t: SeededTenant, orderId: string, tokenHash = hashOf()) {
	const c = await app.connect();
	try {
		await c.query("begin");
		await c.query(
			"select set_config('app.user_id', $1, true), set_config('app.user_role', 'bureau_admin', true), set_config('app.bureau_id', $2, true)",
			[t.bureauAdmin.userId, t.bureau.id],
		);
		const { rows } = await c.query<{ id: string }>(
			`insert into payment_links (bureau_id, order_id, token_hash, expires_at, created_by)
       values ($1, $2, $3, $4, $5) returning id`,
			[t.bureau.id, orderId, tokenHash, IN_7_DAYS(), t.bureauAdmin.userId],
		);
		await c.query("commit");
		return { ok: true as const, id: rows[0].id };
	} catch (error) {
		await c.query("rollback");
		return { ok: false as const, code: (error as { code?: string }).code };
	} finally {
		c.release();
	}
}

beforeAll(async () => {
	a = await seedTenant(owner, "Admin app A");
	b = await seedTenant(owner, "Admin app B");
	orderA = randomUUID();
	orderB = randomUUID();
	await seedOrderDossier(owner, { orderRef: orderA, bureauId: a.bureau.id, clientProfileId: null });
	await seedOrderDossier(owner, { orderRef: orderB, bureauId: b.bureau.id, clientProfileId: null });
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), webhook.end()]);
});

describe("payment_links", () => {
	it("blocks a second active link for the same order and allows one after the first is cancelled", async () => {
		const first = await insertLink(a, orderA);
		expect(first.ok).toBe(true);
		const second = await insertLink(a, orderA);
		expect(second).toEqual({ ok: false, code: "23505" });

		// withDbContext sempre faz rollback: cancela pelo dono para testar o índice parcial.
		await owner.query("update payment_links set status = 'cancelled' where order_id = $1", [orderA]);
		expect((await insertLink(a, orderA)).ok).toBe(true);
	});

	it("isolates bureaus: B cannot read, insert or update links of A", async () => {
		const own = await insertLink(b, orderB);
		expect(own.ok).toBe(true);

		const seen = await withDbContext(app, b.bureauAdmin, (c) =>
			c.query("select bureau_id from payment_links"),
		);
		expect(seen.rows.length).toBeGreaterThan(0);
		expect(seen.rows.every((r: { bureau_id: string }) => r.bureau_id === b.bureau.id)).toBe(true);

		// B tenta criar link no bureau de A (RLS) e apontar o pedido de A em nome de B (FK composta).
		const intoA = await withDbContext(app, b.bureauAdmin, async (c) => {
			try {
				await c.query(
					`insert into payment_links (bureau_id, order_id, token_hash, expires_at, created_by)
           values ($1, $2, $3, $4, $5)`,
					[a.bureau.id, orderA, hashOf(), IN_7_DAYS(), b.bureauAdmin.userId],
				);
				return null;
			} catch (error) {
				return (error as { code?: string }).code;
			}
		});
		expect(intoA).not.toBeNull();
		const freeOrderA = await newOrder(a);
		const crossOrder = await withDbContext(app, b.bureauAdmin, async (c) => {
			try {
				await c.query(
					`insert into payment_links (bureau_id, order_id, token_hash, expires_at, created_by)
           values ($1, $2, $3, $4, $5)`,
					[b.bureau.id, freeOrderA, hashOf(), IN_7_DAYS(), b.bureauAdmin.userId],
				);
				return null;
			} catch (error) {
				return (error as { code?: string }).code;
			}
		});
		expect(crossOrder).toBe("23503");

		const upd = await withDbContext(app, b.bureauAdmin, (c) =>
			c.query("update payment_links set status = 'cancelled' where bureau_id = $1", [a.bureau.id]),
		);
		expect(upd.rowCount).toBe(0);
	});

	it("does not let the app mark a link as paid", async () => {
		const hash = hashOf();
		await insertLink(a, await newOrder(a), hash);
		const code = await withDbContext(app, a.bureauAdmin, async (c) => {
			try {
				await c.query("update payment_links set status = 'paid' where token_hash = $1", [hash]);
				return null;
			} catch (error) {
				return (error as { code?: string }).code;
			}
		});
		expect(code).not.toBeNull();
	});

	it("resolves the link by hash without a session and reveals only the page fields", async () => {
		const order = await newOrder(a);
		const hash = hashOf();
		expect((await insertLink(a, order, hash)).ok).toBe(true);
		const { rows } = await app.query("select * from public_payment_link_by_hash($1)", [hash]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			bureau_id: a.bureau.id,
			order_id: order,
			status: "active",
			bureau_name: a.bureau.name,
			product_code: "dossie_pf",
		});
		expect(Object.keys(rows[0]).sort()).toEqual(
			["amount", "bureau_id", "bureau_name", "expires_at", "link_id", "order_id", "product_code", "status", "subject_document_masked"].sort(),
		);
		const none = await app.query("select * from public_payment_link_by_hash($1)", [hashOf()]);
		expect(none.rows).toHaveLength(0);
	});

	it("lets app_webhook mark the order's link paid through payment_link_mark_paid only", async () => {
		const order = await newOrder(a);
		const hash = hashOf();
		await insertLink(a, order, hash);
		await expect(webhook.query("select * from payment_links")).rejects.toThrow(/permission denied/);
		const first = await webhook.query("select payment_link_mark_paid($1) as n", [order]);
		expect(first.rows[0].n).toBe(1);
		const again = await webhook.query("select payment_link_mark_paid($1) as n", [order]);
		expect(again.rows[0].n).toBe(0);
		const { rows } = await app.query("select status from public_payment_link_by_hash($1)", [hash]);
		expect(rows[0].status).toBe("paid");
		await expect(app.query("select payment_link_mark_paid($1)", [order])).rejects.toThrow(/permission denied/);
	});
});

async function newOrder(t: SeededTenant): Promise<string> {
	const id = randomUUID();
	await seedOrderDossier(owner, { orderRef: id, bureauId: t.bureau.id, clientProfileId: null });
	return id;
}

describe("bureau_page_views", () => {
	it("counts visits per day, ignores unknown bureaus and isolates bureaus", async () => {
		const call = (id: string) => app.query("select record_bureau_page_view($1) as ok", [id]);
		expect((await call(a.bureau.id)).rows[0].ok).toBe(true);
		expect((await call(a.bureau.id)).rows[0].ok).toBe(true);
		expect((await call(randomUUID())).rows[0].ok).toBe(false);

		const own = await withDbContext(app, a.bureauAdmin, (c) =>
			c.query("select bureau_id, count from bureau_page_views"),
		);
		expect(own.rows).toEqual([{ bureau_id: a.bureau.id, count: 2 }]);
		const other = await withDbContext(app, b.bureauAdmin, (c) =>
			c.query("select 1 from bureau_page_views where bureau_id = $1", [a.bureau.id]),
		);
		expect(other.rowCount).toBe(0);
		await expect(
			withDbContext(app, a.bureauAdmin, (c) => c.query("update bureau_page_views set count = 99")),
		).rejects.toThrow(/permission denied/);
	});
});

describe("bureau_slug_history", () => {
	it("lets only the superadmin write, resolves the redirect by function and isolates reads", async () => {
		const sa = await seedSuperadmin(owner);
		const oldSlug = `old-${randomBytes(4).toString("hex")}`;
		await withDbContext(app, { userId: sa.userId, role: "superadmin", bureauId: null }, async (c) => {
			await c.query("insert into bureau_slug_history (old_slug, bureau_id) values ($1, $2)", [oldSlug, a.bureau.id]);
			const { rowCount } = await c.query("select 1 from bureau_slug_history where old_slug = $1", [oldSlug]);
			expect(rowCount).toBe(1);
		});
		// O superadmin acima faz rollback: grava pelo dono para a função pública enxergar a linha.
		await owner.query("insert into bureau_slug_history (old_slug, bureau_id) values ($1, $2)", [oldSlug, a.bureau.id]);

		const redirect = await app.query("select slug from public_bureau_slug_redirect($1)", [oldSlug]);
		expect(redirect.rows).toEqual([{ slug: a.bureau.slug }]);
		expect((await app.query("select slug from public_bureau_slug_redirect($1)", ["nao-existe"])).rowCount).toBe(0);

		const seenByB = await withDbContext(app, b.bureauAdmin, (c) =>
			c.query("select 1 from bureau_slug_history where old_slug = $1", [oldSlug]),
		);
		expect(seenByB.rowCount).toBe(0);
		await expect(
			withDbContext(app, a.bureauAdmin, (c) =>
				c.query("insert into bureau_slug_history (old_slug, bureau_id) values ($1, $2)", [`x-${oldSlug}`, a.bureau.id]),
			),
		).rejects.toThrow(/row-level security/);
		await expect(
			owner.query("insert into bureau_slug_history (old_slug, bureau_id) values ($1, $2)", [oldSlug, b.bureau.id]),
		).rejects.toThrow(/duplicate key/);
	});
});
