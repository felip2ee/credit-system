// Migration 036: retenção do valor a receber (payable_retention_days, payable_buckets, create_payout).
// O prazo é uma configuração global: cada teste que o muda devolve o padrão (30) no fim.
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import {
	seedPayableEntry,
	seedSuperadmin,
	seedTenant,
	type SeedSuperadmin,
	type SeededTenant,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 8 });

let superadmin: SeedSuperadmin;

type Ctx = { userId: string; role: string; bureauId: string | null };
const superadminCtx = (): Ctx => ({
	userId: superadmin.userId,
	role: "superadmin",
	bureauId: null,
});
const ctxOf = (id: Ctx): Ctx => ({
	userId: id.userId,
	role: id.role,
	bureauId: id.bureauId,
});

// Faz commit: as chamadas concorrentes e a mudança do prazo precisam de transações reais.
async function committed<T>(
	ctx: Ctx,
	work: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true),
              set_config('app.user_role', $2, true),
              set_config('app.bureau_id', $3, true),
              set_config('app.support_session_id', '', true)`,
			[ctx.userId, ctx.role, ctx.bureauId ?? ""],
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

const asSuperadmin = <T>(work: (c: PoolClient) => Promise<T>) =>
	committed(superadminCtx(), work);

// Só o superadmin escreve em settings (política settings_superadmin_write).
const setRetention = (value: string) =>
	asSuperadmin((c) =>
		c.query(
			"update settings set value = $1::jsonb where key = 'payable_retention_days'",
			[value],
		),
	);

beforeAll(async () => {
	superadmin = await seedSuperadmin(owner);
});

afterEach(async () => {
	await setRetention("30");
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end()]);
});

const DAY_MS = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();

type CreateRow = {
	ok: boolean;
	reason: string | null;
	payout_id: string | null;
	amount: string | null;
};
type BucketRow = {
	released: string;
	retained: string;
	next_release_at: Date | null;
};

// O corte sai do now() da própria transação: now() − prazo é a fronteira exata, sem corrida de relógio.
const createPayoutAt = (c: PoolClient, bureauId: string, cutoffSql: string) =>
	c
		.query<CreateRow>(
			`select * from create_payout($1, ${cutoffSql})`,
			[bureauId],
		)
		.then((r) => r.rows[0]);
const BOUNDARY = "now() - make_interval(days => payable_retention_days())";

const buckets = (c: PoolClient, bureauId: string) =>
	c
		.query<BucketRow>(
			"select released::text, retained::text, next_release_at from payable_buckets($1)",
			[bureauId],
		)
		.then((r) => r.rows);

const seed = (
	bureauId: string,
	kind: "accrual" | "reversal",
	amount: string,
	ageDays: number,
) =>
	seedPayableEntry(owner, {
		bureauId,
		kind,
		amount: kind === "accrual" ? amount : `-${amount}`,
		// Idade 0: a data vem do relógio do banco, sem diferença entre o host e o contêiner.
		createdAt: ageDays === 0 ? undefined : daysAgo(ageDays),
	});

const newTenant = () => seedTenant(owner, "retention");
const payoutCount = async (bureauId: string) =>
	Number(
		(
			await owner.query<{ n: string }>(
				"select count(*)::text as n from payouts where bureau_id = $1",
				[bureauId],
			)
		).rows[0].n,
	);

describe("payable_retention_days", () => {
	it("defaults to 30 and follows the setting", async () => {
		const read = () =>
			asSuperadmin((c) =>
				c
					.query<{ d: number }>("select payable_retention_days() as d")
					.then((r) => r.rows[0].d),
			);
		expect(await read()).toBe(30);
		await setRetention("7");
		expect(await read()).toBe(7);
	});

	it("falls back to 30 when the setting row is missing", async () => {
		// delete dentro de uma transação que volta atrás: o padrão do banco não muda.
		const d = await committed(superadminCtx(), async (c) => {
			await c.query("savepoint s");
			await c.query("delete from settings where key = 'payable_retention_days'");
			const { rows } = await c.query<{ d: number }>(
				"select payable_retention_days() as d",
			);
			await c.query("rollback to savepoint s");
			return rows[0].d;
		});
		expect(d).toBe(30);
	});

	it.each(["-1", "1.5", '"30"', "3651", "null"])(
		"refuses the invalid value %s in the setting",
		async (value) => {
			await expect(setRetention(value)).rejects.toThrow(/settings_payable_retention_days_check/);
		},
	);
});

describe("create_payout retention", () => {
	it("refuses a cutoff inside the retention window", async () => {
		const t = await newTenant();
		await seed(t.bureau.id, "accrual", "100.00", 40);
		const res = await asSuperadmin((c) => createPayoutAt(c, t.bureau.id, "now()"));
		expect(res).toMatchObject({ ok: false, reason: "cutoff_within_retention" });
		expect(await payoutCount(t.bureau.id)).toBe(0);
	});

	it("refuses a cutoff one second after the boundary", async () => {
		const t = await newTenant();
		await seed(t.bureau.id, "accrual", "100.00", 40);
		const res = await asSuperadmin((c) =>
			createPayoutAt(c, t.bureau.id, `${BOUNDARY} + interval '1 second'`),
		);
		expect(res).toMatchObject({ ok: false, reason: "cutoff_within_retention" });
	});

	it("accepts a cutoff exactly at now() minus the retention", async () => {
		const t = await newTenant();
		await seed(t.bureau.id, "accrual", "100.00", 40);
		await seed(t.bureau.id, "accrual", "25.00", 5);
		const res = await asSuperadmin((c) => createPayoutAt(c, t.bureau.id, BOUNDARY));
		expect(res).toMatchObject({ ok: true, reason: null, amount: "100.00" });
	});

	it("keeps the other refusals: nothing to pay inside the window of released entries", async () => {
		const t = await newTenant();
		await seed(t.bureau.id, "accrual", "100.00", 5);
		const res = await asSuperadmin((c) => createPayoutAt(c, t.bureau.id, BOUNDARY));
		expect(res).toMatchObject({ ok: false, reason: "nothing_to_pay" });
	});

	it("releases everything at once when the retention is 0", async () => {
		const t = await newTenant();
		await seed(t.bureau.id, "accrual", "80.00", 0);
		await setRetention("0");
		const res = await asSuperadmin((c) => createPayoutAt(c, t.bureau.id, "now()"));
		expect(res).toMatchObject({ ok: true, amount: "80.00" });
	});

	it("never pays the same entry twice for two simultaneous calls", async () => {
		const t = await newTenant();
		await seed(t.bureau.id, "accrual", "60.00", 40);
		await seed(t.bureau.id, "accrual", "40.00", 35);
		const results = await Promise.all(
			[0, 1].map(() => asSuperadmin((c) => createPayoutAt(c, t.bureau.id, BOUNDARY))),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect(results.find((r) => !r.ok)).toMatchObject({ reason: "nothing_to_pay" });
		const { rows } = await owner.query<{ n: string; distinct_n: string }>(
			`select count(*)::text as n, count(distinct entry_id)::text as distinct_n
         from payout_items where bureau_id = $1`,
			[t.bureau.id],
		);
		expect(rows[0]).toEqual({ n: "2", distinct_n: "2" });
		expect(await payoutCount(t.bureau.id)).toBe(1);
	});
});

describe("payable_buckets", () => {
	it("splits released and retained and finds the next release", async () => {
		const t = await newTenant();
		await seed(t.bureau.id, "accrual", "100.00", 40);
		await seed(t.bureau.id, "reversal", "30.00", 35);
		await seed(t.bureau.id, "accrual", "50.00", 5);
		await seed(t.bureau.id, "accrual", "20.00", 10);
		const rows = await asSuperadmin((c) => buckets(c, t.bureau.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].released).toBe("70.00");
		expect(rows[0].retained).toBe("70.00");
		// Liberação mais próxima: o lançamento retido mais antigo (10 dias) + 30 dias.
		const expected = Date.now() + 20 * DAY_MS;
		expect(Math.abs(rows[0].next_release_at!.getTime() - expected)).toBeLessThan(60_000);
	});

	it("never returns a negative amount", async () => {
		const t = await newTenant();
		await seed(t.bureau.id, "accrual", "10.00", 5);
		await seed(t.bureau.id, "reversal", "25.00", 40);
		await seed(t.bureau.id, "reversal", "4.00", 2);
		const [row] = await asSuperadmin((c) => buckets(c, t.bureau.id));
		expect(row.released).toBe("0.00");
		expect(row.retained).toBe("6.00");
		const [onlyReversal] = await (async () => {
			const u = await newTenant();
			await seed(u.bureau.id, "accrual", "5.00", 50);
			await seed(u.bureau.id, "reversal", "9.00", 3);
			return asSuperadmin((c) => buckets(c, u.bureau.id));
		})();
		expect(onlyReversal.retained).toBe("0.00");
		expect(onlyReversal.released).toBe("5.00");
	});

	it("ignores entries that a payout already took", async () => {
		const t = await newTenant();
		await seed(t.bureau.id, "accrual", "90.00", 40);
		await asSuperadmin((c) => createPayoutAt(c, t.bureau.id, BOUNDARY));
		await seed(t.bureau.id, "accrual", "15.00", 35);
		const [row] = await asSuperadmin((c) => buckets(c, t.bureau.id));
		expect(row).toMatchObject({ released: "15.00", retained: "0.00", next_release_at: null });
	});

	it("returns zeros and no date for a Bureau without entries", async () => {
		const t = await newTenant();
		const rows = await asSuperadmin((c) => buckets(c, t.bureau.id));
		expect(rows).toEqual([{ released: "0.00", retained: "0.00", next_release_at: null }]);
	});

	it("follows the retention setting", async () => {
		const t = await newTenant();
		await seed(t.bureau.id, "accrual", "10.00", 10);
		await setRetention("5");
		const [short] = await asSuperadmin((c) => buckets(c, t.bureau.id));
		expect(short).toMatchObject({ released: "10.00", retained: "0.00" });
		await setRetention("20");
		const [long] = await asSuperadmin((c) => buckets(c, t.bureau.id));
		expect(long).toMatchObject({ released: "0.00", retained: "10.00" });
	});

	describe("access", () => {
		let a: SeededTenant;
		let b: SeededTenant;
		beforeAll(async () => {
			a = await newTenant();
			b = await newTenant();
			await seed(a.bureau.id, "accrual", "11.00", 40);
			await seed(b.bureau.id, "accrual", "22.00", 40);
		});

		it("lets the admin and the operator read only their own Bureau", async () => {
			for (const who of [a.bureauAdmin, a.operator]) {
				const own = await committed(ctxOf(who), (c) => buckets(c, a.bureau.id));
				expect(own).toHaveLength(1);
				expect(own[0].released).toBe("11.00");
				const other = await committed(ctxOf(who), (c) => buckets(c, b.bureau.id));
				expect(other).toEqual([]);
			}
		});

		it("gives a client nothing", async () => {
			const rows = await committed(ctxOf(a.client), (c) => buckets(c, a.bureau.id));
			expect(rows).toEqual([]);
		});

		it("lets the superadmin read any Bureau", async () => {
			const [rowA] = await asSuperadmin((c) => buckets(c, a.bureau.id));
			const [rowB] = await asSuperadmin((c) => buckets(c, b.bureau.id));
			expect(rowA.released).toBe("11.00");
			expect(rowB.released).toBe("22.00");
		});

		it("gives nothing without a database context", async () => {
			const c = await app.connect();
			try {
				const { rows } = await c.query("select * from payable_buckets($1)", [a.bureau.id]);
				expect(rows).toEqual([]);
			} finally {
				c.release();
			}
		});
	});
});
