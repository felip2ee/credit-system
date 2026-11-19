// Limite de tentativas de código de cupom (052, vagas em 054): 10 por hora por cliente, serializado por cliente.
// Postgres real, sob RLS, com concorrência de verdade.
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
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
	});
});

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import { seedClientProfile, seedOrderDossier, seedTenant, type SeededTenant } from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });

afterAll(async () => {
	await Promise.all([owner.end(), app.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string };
const clientCtx = (t: SeededTenant, userId = t.client.userId): Ctx => ({ userId, role: "client", bureauId: t.bureau.id });

async function begin(ctx: Ctx): Promise<PoolClient> {
	const client = await app.connect();
	await client.query("begin");
	await client.query(
		`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
		        set_config('app.bureau_id', $3, true), set_config('app.support_session_id', '', true)`,
		[ctx.userId, ctx.role, ctx.bureauId],
	);
	return client;
}
async function committed<T>(ctx: Ctx, work: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await begin(ctx);
	try {
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

type PreviewRow = { coupon_id: string; eligible_product_codes: string[] };
const preview = (ctx: Ctx, code: string, products: string[] = ["dossie_pf"]) =>
	committed(ctx, (c) =>
		c.query<PreviewRow>("select * from coupon_preview($1, $2::text[])", [code, products]).then((r) => r.rows),
	);
const missCount = async (userId: string) =>
	Number((await owner.query("select count(*) from coupon_attempt_misses where profile_id = $1", [userId])).rows[0].count);
const missUntilBlocked = async (ctx: Ctx, times = 10) => {
	for (let i = 0; i < times; i++) expect(await preview(ctx, `NOPE${i}`)).toHaveLength(0);
};

async function seedCoupon(t: SeededTenant, productsAll = true): Promise<string> {
	const code = `L${randomBytes(4).toString("hex").toUpperCase()}`;
	await owner.query(
		`insert into coupons (bureau_id, code, kind, value, all_products, valid_from, active, created_by)
		 values ($1, $2, 'percent', '10', $3, now() - interval '1 hour', true, $4)`,
		[t.bureau.id, code, productsAll, t.bureauAdmin.userId],
	);
	return code;
}

describe("coupon attempt limit (052/054)", () => {
	it("allows 10 misses, then blocks the 11th even for a valid code", async () => {
		const t = await seedTenant(owner, "lim 10");
		const code = await seedCoupon(t);
		const ctx = clientCtx(t);
		await missUntilBlocked(ctx);
		expect(await missCount(t.client.userId)).toBe(10);
		expect(await preview(ctx, code)).toHaveLength(0);
		// Bloqueado não grava mais erro e não avalia o código.
		expect(await missCount(t.client.userId)).toBe(10);
	});

	it("a valid code still works with 9 misses", async () => {
		const t = await seedTenant(owner, "lim 9");
		const code = await seedCoupon(t);
		const ctx = clientCtx(t);
		await missUntilBlocked(ctx, 9);
		expect(await preview(ctx, code)).toHaveLength(1);
	});

	it("another client is not affected", async () => {
		const t = await seedTenant(owner, "lim other");
		const code = await seedCoupon(t);
		await missUntilBlocked(clientCtx(t));
		const other = await seedClientProfile(owner, t.bureau.id);
		expect(await preview(clientCtx(t, other.userId), code)).toHaveLength(1);
	});

	it("misses older than 1 hour do not count", async () => {
		const t = await seedTenant(owner, "lim old");
		const code = await seedCoupon(t);
		const ctx = clientCtx(t);
		await missUntilBlocked(ctx);
		await owner.query("update coupon_attempt_misses set at = now() - interval '61 minutes' where profile_id = $1", [t.client.userId]);
		expect(await preview(ctx, code)).toHaveLength(1);
	});

	it("misses older than 1 day are pruned", async () => {
		const t = await seedTenant(owner, "lim prune");
		const ctx = clientCtx(t);
		await missUntilBlocked(ctx, 2);
		await owner.query("update coupon_attempt_misses set at = now() - interval '2 days' where profile_id = $1", [t.client.userId]);
		await preview(ctx, "NOPEX");
		expect(await missCount(t.client.userId)).toBe(1);
	});

	it("a valid code with an empty eligible list is not a miss", async () => {
		const t = await seedTenant(owner, "lim empty");
		const code = await seedCoupon(t, false);
		const ctx = clientCtx(t);
		for (let i = 0; i < 12; i++) {
			const rowsOut = await preview(ctx, code);
			expect(rowsOut).toHaveLength(1);
			expect(rowsOut[0].eligible_product_codes).toEqual([]);
		}
		expect(await missCount(t.client.userId)).toBe(0);
	});

	it("reserve_order refuses a valid code at the limit with coupon_invalid", async () => {
		const t = await seedTenant(owner, "lim reserve");
		const code = await seedCoupon(t);
		const ctx = clientCtx(t);
		const orderRef = randomUUID();
		await seedOrderDossier(owner, { orderRef, bureauId: t.bureau.id, clientProfileId: t.client.userId });
		const reserve = () =>
			committed(ctx, (c) =>
				c
					.query<{ ok: boolean; reason: string | null }>(
						"select ok, reason from reserve_order($1, 'online', $2, '10.00', '5.00', $3::jsonb, $4)",
						[orderRef, t.client.userId, JSON.stringify({ lines: [] }), code],
					)
					.then((r) => r.rows[0]),
			);
		await missUntilBlocked(ctx);
		expect(await reserve()).toMatchObject({ ok: false, reason: "coupon_invalid" });
		// reserve_order só confere o limite: não grava erro.
		expect(await missCount(t.client.userId)).toBe(10);
	});
});

describe("attempt slots (054)", () => {
	const begin_ = (ctx: Ctx) =>
		committed(ctx, (c) => c.query<{ id: string | null }>("select coupon_attempt_begin() as id").then((r) => r.rows[0].id));
	const clear = (ctx: Ctx, id: string) => committed(ctx, (c) => c.query("select coupon_attempt_clear($1)", [id]));

	it("30 parallel previews with invalid codes record exactly 10 attempts", async () => {
		const t = await seedTenant(owner, "slot par preview");
		const ctx = clientCtx(t);
		const results = await Promise.all(Array.from({ length: 30 }, (_, i) => preview(ctx, `PAR${i}`)));
		expect(results.every((rowsOut) => rowsOut.length === 0)).toBe(true);
		expect(await missCount(t.client.userId)).toBe(10);
	});

	it("30 parallel begins give exactly 10 slots; the rest are blocked", async () => {
		const t = await seedTenant(owner, "slot par begin");
		const ctx = clientCtx(t);
		const ids = await Promise.all(Array.from({ length: 30 }, () => begin_(ctx)));
		expect(ids.filter((id) => id !== null)).toHaveLength(10);
		expect(ids.filter((id) => id === null)).toHaveLength(20);
		expect(await missCount(t.client.userId)).toBe(10);
	});

	it("a valid code at attempt 11 is refused, and a cleared slot frees one attempt", async () => {
		const t = await seedTenant(owner, "slot clear");
		const code = await seedCoupon(t);
		const ctx = clientCtx(t);
		const ids: string[] = [];
		for (let i = 0; i < 10; i++) ids.push((await begin_(ctx)) as string);
		expect(await begin_(ctx)).toBeNull();
		expect(await preview(ctx, code)).toHaveLength(0);
		await clear(ctx, ids[0]);
		expect(await missCount(t.client.userId)).toBe(9);
		expect(await preview(ctx, code)).toHaveLength(1);
	});

	it("a client cannot clear another client's slot, and another client is unaffected", async () => {
		const t = await seedTenant(owner, "slot other");
		const other = await seedClientProfile(owner, t.bureau.id);
		const id = (await begin_(clientCtx(t))) as string;
		await clear(clientCtx(t, other.userId), id);
		expect(await missCount(t.client.userId)).toBe(1);
		for (let i = 0; i < 10; i++) await begin_(clientCtx(t));
		expect(await begin_(clientCtx(t, other.userId))).not.toBeNull();
	});

	it("slots older than 1 hour do not count", async () => {
		const t = await seedTenant(owner, "slot old");
		const ctx = clientCtx(t);
		for (let i = 0; i < 10; i++) await begin_(ctx);
		expect(await begin_(ctx)).toBeNull();
		await owner.query("update coupon_attempt_misses set at = now() - interval '61 minutes' where profile_id = $1", [t.client.userId]);
		expect(await begin_(ctx)).not.toBeNull();
	});

	it("a held slot lets the order path evaluate without the limit and without recording", async () => {
		const t = await seedTenant(owner, "slot held");
		const code = await seedCoupon(t);
		const ctx = clientCtx(t);
		const id = (await begin_(ctx)) as string;
		await owner.query("insert into coupon_attempt_misses (profile_id, bureau_id) select $1, $2 from generate_series(1, 9)", [t.client.userId, t.bureau.id]);
		const held = await committed(ctx, async (c) => {
			await c.query("select set_config('app.coupon_slot', $1, true)", [id]);
			return (await c.query("select * from coupon_preview($1, $2::text[])", [code, ["dossie_pf"]])).rows;
		});
		expect(held).toHaveLength(1);
		const none = await committed(ctx, async (c) => {
			await c.query("select set_config('app.coupon_slot', $1, true)", [randomUUID()]);
			return (await c.query("select * from coupon_preview($1, $2::text[])", [code, ["dossie_pf"]])).rows;
		});
		expect(none).toHaveLength(0);
		expect(await missCount(t.client.userId)).toBe(10);
	});

	it("staff cannot open or clear a slot", async () => {
		const t = await seedTenant(owner, "slot staff");
		const staffCtx: Ctx = { userId: t.operator.userId, role: t.operator.role, bureauId: t.bureau.id };
		await expect(begin_(staffCtx)).rejects.toMatchObject({ code: "42501" });
		await expect(clear(staffCtx, randomUUID())).rejects.toMatchObject({ code: "42501" });
	});
});
