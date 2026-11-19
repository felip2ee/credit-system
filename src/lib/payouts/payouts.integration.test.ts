// M3b / migration 016: repasse ao Bureau (payouts, payout_items, create_payout, mark_payout_paid,
// cancel_payout) e colunas de NFS-e em pix_charges (set_nfse_status, request_nfse_retry).
import { createHash, randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	TEST_DATABASE_OWNER_URL,
	TEST_DATABASE_URL,
	TEST_DATABASE_WEBHOOK_URL,
} from "@/test/db-env";
import {
	ageBureauPayableEntries,
	seedClientWalletTopup,
	seedOrderCatalog,
	seedOrderDossier,
	seedPayableEntry,
	seedPixCharge,
	seedSuperadmin,
	seedSupportSession,
	seedTenant,
	seedWalletTopup,
	withDbContext,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 12 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 4 });

let superadmin: SeedSuperadmin;

beforeAll(async () => {
	superadmin = await seedSuperadmin(owner);
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), hook.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string | null };
const ctxOf = (id: Ctx): Ctx => ({
	userId: id.userId,
	role: id.role,
	bureauId: id.bureauId,
});
const superadminCtx = (): Ctx => ({
	userId: superadmin.userId,
	role: "superadmin",
	bureauId: null,
});

// Como withDbContext, mas faz commit: as chamadas concorrentes precisam de transações reais.
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

// Corte fora da retenção (30 dias): os lançamentos do teste têm datas fixas de 2026-01 e 2026-02, bem mais antigas.
const RELEASED_CUTOFF = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString();
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type CreateRow = {
	ok: boolean;
	reason: string | null;
	payout_id: string | null;
	amount: string | null;
};
type StatusRow = { ok: boolean; reason: string | null; status: string | null };

const createPayout = (c: PoolClient, bureauId: string, cutoff: string) =>
	c
		.query<CreateRow>("select * from create_payout($1, $2::timestamptz)", [
			bureauId,
			cutoff,
		])
		.then((r) => r.rows[0]);
const markPaid = (
	c: PoolClient,
	payoutId: string,
	receipt: {
		key?: string | null;
		mime?: string | null;
		sha?: string | null;
	} = {},
) =>
	c
		.query<StatusRow>("select * from mark_payout_paid($1, $2, $3, $4)", [
			payoutId,
			receipt.key === undefined ? `receipts/${randomUUID()}.pdf` : receipt.key,
			receipt.mime === undefined ? "application/pdf" : receipt.mime,
			receipt.sha === undefined ? sha(randomUUID()) : receipt.sha,
		])
		.then((r) => r.rows[0]);
const cancelPayout = (c: PoolClient, payoutId: string) =>
	c
		.query<StatusRow>("select * from cancel_payout($1)", [payoutId])
		.then((r) => r.rows[0]);

const asSuperadmin = <T>(work: (c: PoolClient) => Promise<T>) =>
	committed(superadminCtx(), work);

// Lançamento com liquidação mínima: o repasse só olha bureau, tipo, valor e data.
async function seedEntry(
	bureauId: string,
	kind: "accrual" | "reversal",
	amount: string,
	createdAt = "2026-01-10T12:00:00Z",
): Promise<string> {
	const signed = kind === "accrual" ? amount : `-${amount}`;
	return seedPayableEntry(owner, { bureauId, kind, amount: signed, createdAt });
}

async function payableBalance(bureauId: string): Promise<string> {
	const { rows } = await owner.query<{ total: string }>(
		"select coalesce(sum(amount), 0)::text as total from bureau_payable_entries where bureau_id = $1",
		[bureauId],
	);
	return rows[0].total;
}

async function payoutRow(payoutId: string) {
	const { rows } = await owner.query<{
		status: string;
		amount: string;
		paid_by: string | null;
		paid_at: Date | null;
		receipt_sha256: string | null;
	}>(
		"select status, amount, paid_by, paid_at, receipt_sha256 from payouts where id = $1",
		[payoutId],
	);
	return rows[0];
}

async function itemIds(payoutId: string): Promise<string[]> {
	const { rows } = await owner.query<{ entry_id: string }>(
		"select entry_id from payout_items where payout_id = $1 order by entry_id",
		[payoutId],
	);
	return rows.map((r) => r.entry_id);
}

const newTenant = (label = "payout") => seedTenant(owner, label);

describe("create_payout", () => {
	it("gathers only unpaid accruals and reversals up to the cutoff", async () => {
		const t = await newTenant();
		const a = await seedEntry(
			t.bureau.id,
			"accrual",
			"40.00",
			"2026-01-10T12:00:00Z",
		);
		const r = await seedEntry(
			t.bureau.id,
			"reversal",
			"5.50",
			"2026-01-20T12:00:00Z",
		);
		await seedEntry(t.bureau.id, "accrual", "99.00", "2026-02-10T12:00:00Z");
		const other = await newTenant("other");
		await seedEntry(
			other.bureau.id,
			"accrual",
			"77.00",
			"2026-01-05T12:00:00Z",
		);

		const res = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, "2026-01-31T00:00:00Z"),
		);

		expect(res).toMatchObject({ ok: true, reason: null, amount: "34.50" });
		expect(await itemIds(res.payout_id!)).toEqual([a, r].sort());
		expect(await payoutRow(res.payout_id!)).toMatchObject({
			status: "open",
			amount: "34.50",
		});
		const { rows } = await owner.query<{
			created_by: string;
			bureau_id: string;
		}>("select created_by, bureau_id from payouts where id = $1", [
			res.payout_id,
		]);
		expect(rows[0]).toEqual({
			created_by: superadmin.userId,
			bureau_id: t.bureau.id,
		});
		// Aberto não mexe no valor a repassar: ele só cai quando o repasse é pago.
		expect(await payableBalance(t.bureau.id)).toBe("133.50");
	});

	it("skips entries already in a payout and picks the rest on the next one", async () => {
		const t = await newTenant();
		await seedEntry(t.bureau.id, "accrual", "10.00");
		const first = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);
		const later = await seedEntry(t.bureau.id, "accrual", "25.00");

		const second = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);

		expect(first.amount).toBe("10.00");
		expect(second).toMatchObject({ ok: true, amount: "25.00" });
		expect(await itemIds(second.payout_id!)).toEqual([later]);
	});

	it("refuses nothing_to_pay when the sum is zero, negative or the list is empty", async () => {
		const empty = await newTenant();
		expect(
			await asSuperadmin((c) => createPayout(c, empty.bureau.id, RELEASED_CUTOFF)),
		).toMatchObject({ ok: false, reason: "nothing_to_pay", payout_id: null });

		const zero = await newTenant();
		await seedEntry(zero.bureau.id, "accrual", "10.00");
		await seedEntry(zero.bureau.id, "reversal", "10.00");
		expect(
			await asSuperadmin((c) => createPayout(c, zero.bureau.id, RELEASED_CUTOFF)),
		).toMatchObject({ ok: false, reason: "nothing_to_pay" });

		const negative = await newTenant();
		await seedEntry(negative.bureau.id, "accrual", "10.00");
		await seedEntry(negative.bureau.id, "reversal", "30.00");
		expect(
			await asSuperadmin((c) =>
				createPayout(c, negative.bureau.id, RELEASED_CUTOFF),
			),
		).toMatchObject({ ok: false, reason: "nothing_to_pay" });

		// Recusado não deixa repasse nem item.
		const { rows } = await owner.query(
			"select 1 from payouts where bureau_id = any($1)",
			[[empty.bureau.id, zero.bureau.id, negative.bureau.id]],
		);
		expect(rows).toHaveLength(0);
	});

	it("carries a negative leftover into the next payout", async () => {
		const t = await newTenant();
		await seedEntry(t.bureau.id, "reversal", "30.00", "2026-01-05T00:00:00Z");
		const refused = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, "2026-01-31T00:00:00Z"),
		);
		await seedEntry(t.bureau.id, "accrual", "100.00", "2026-02-05T00:00:00Z");
		const next = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);

		expect(refused.reason).toBe("nothing_to_pay");
		expect(next).toMatchObject({ ok: true, amount: "70.00" });
	});

	it("rejects a missing bureau and a null cutoff", async () => {
		expect(
			await asSuperadmin((c) => createPayout(c, randomUUID(), RELEASED_CUTOFF)),
		).toMatchObject({ ok: false, reason: "not_found" });
		const t = await newTenant();
		const res = await asSuperadmin((c) =>
			c
				.query<CreateRow>("select * from create_payout($1, null)", [
					t.bureau.id,
				])
				.then((r) => r.rows[0]),
		);
		expect(res).toMatchObject({ ok: false, reason: "invalid_cutoff" });
	});

	it("concurrent create_payout never shares an accrual", async () => {
		const t = await newTenant();
		const allEntries: string[] = [];
		for (let round = 0; round < 5; round++) {
			const ids = await Promise.all(
				["10.00", "20.00", "30.00"].map((amount) =>
					seedEntry(t.bureau.id, "accrual", amount),
				),
			);
			allEntries.push(...ids);

			const results = await Promise.all(
				Array.from({ length: 4 }, () =>
					asSuperadmin((c) => createPayout(c, t.bureau.id, RELEASED_CUTOFF)),
				),
			);

			const winners = results.filter((r) => r.ok);
			expect(winners, `round ${round}`).toHaveLength(1);
			expect(winners[0].amount).toBe("60.00");
			expect(
				results
					.filter((r) => !r.ok)
					.every((r) => r.reason === "nothing_to_pay"),
			).toBe(true);
		}
		const { rows } = await owner.query<{ entry_id: string; n: string }>(
			`select entry_id, count(*)::text as n from payout_items
        where entry_id = any($1) group by entry_id`,
			[allEntries],
		);
		expect(rows).toHaveLength(allEntries.length);
		expect(rows.every((r) => r.n === "1")).toBe(true);
	});

	it("concurrent payouts with different cutoffs put each entry in at most one payout", async () => {
		const t = await newTenant();
		const early = await seedEntry(
			t.bureau.id,
			"accrual",
			"10.00",
			"2026-01-05T00:00:00Z",
		);
		const mid = await seedEntry(
			t.bureau.id,
			"accrual",
			"20.00",
			"2026-01-15T00:00:00Z",
		);
		const late = await seedEntry(
			t.bureau.id,
			"accrual",
			"40.00",
			"2026-01-25T00:00:00Z",
		);

		const results = await Promise.all([
			asSuperadmin((c) => createPayout(c, t.bureau.id, "2026-01-10T00:00:00Z")),
			asSuperadmin((c) => createPayout(c, t.bureau.id, "2026-01-20T00:00:00Z")),
			asSuperadmin((c) => createPayout(c, t.bureau.id, "2026-01-30T00:00:00Z")),
		]);

		const paid = results.filter((r) => r.ok);
		const sum = paid.reduce((total, r) => total + Number(r.amount), 0);
		expect(sum).toBe(70);
		const items = (
			await Promise.all(paid.map((r) => itemIds(r.payout_id!)))
		).flat();
		expect(items.sort()).toEqual([early, mid, late].sort());
	});
});

describe("mark_payout_paid", () => {
	async function openPayout(t: SeededTenant, amount = "50.00") {
		await seedEntry(t.bureau.id, "accrual", amount);
		const res = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);
		return res.payout_id!;
	}

	it("stores the receipt, writes the payout entry and lowers the balance", async () => {
		const t = await newTenant();
		const payoutId = await openPayout(t);
		const before = await payableBalance(t.bureau.id);
		const receiptSha = sha("comprovante");

		const res = await asSuperadmin((c) =>
			markPaid(c, payoutId, {
				key: "receipts/x.pdf",
				mime: "application/pdf",
				sha: receiptSha,
			}),
		);

		expect(res).toEqual({ ok: true, reason: null, status: "paid" });
		expect(before).toBe("50.00");
		expect(await payableBalance(t.bureau.id)).toBe("0.00");
		const row = await payoutRow(payoutId);
		expect(row.status).toBe("paid");
		expect(row.paid_by).toBe(superadmin.userId);
		expect(row.paid_at).not.toBeNull();
		expect(row.receipt_sha256).toBe(receiptSha);
		const { rows } = await owner.query<{
			kind: string;
			amount: string;
			payout_id: string;
		}>(
			"select kind, amount, payout_id from bureau_payable_entries where payout_id = $1",
			[payoutId],
		);
		expect(rows).toEqual([
			{ kind: "payout", amount: "-50.00", payout_id: payoutId },
		]);
	});

	it("does not duplicate the payout entry when repeated", async () => {
		const t = await newTenant();
		const payoutId = await openPayout(t);
		const receipt = { key: "receipts/y.png", mime: "image/png", sha: sha("y") };
		await asSuperadmin((c) => markPaid(c, payoutId, receipt));

		const again = await asSuperadmin((c) =>
			markPaid(c, payoutId, { ...receipt, key: "receipts/y-2.png" }),
		);
		const concurrent = await Promise.all(
			Array.from({ length: 3 }, () =>
				asSuperadmin((c) => markPaid(c, payoutId, receipt)),
			),
		);

		expect(again).toMatchObject({ ok: true, status: "paid" });
		expect(concurrent.every((r) => r.ok)).toBe(true);
		const { rows } = await owner.query(
			"select 1 from bureau_payable_entries where payout_id = $1",
			[payoutId],
		);
		expect(rows).toHaveLength(1);
		expect(await payableBalance(t.bureau.id)).toBe("0.00");
	});

	it("refuses a second paid call that brings a different receipt", async () => {
		const t = await newTenant();
		const payoutId = await openPayout(t);
		await asSuperadmin((c) => markPaid(c, payoutId, { sha: sha("one") }));

		const other = await asSuperadmin((c) =>
			markPaid(c, payoutId, { sha: sha("two") }),
		);

		expect(other).toMatchObject({
			ok: false,
			reason: "already_paid",
			status: "paid",
		});
		expect((await payoutRow(payoutId)).receipt_sha256).toBe(sha("one"));
	});

	it("returns invalid_state for a cancelled payout", async () => {
		const t = await newTenant();
		const payoutId = await openPayout(t);
		await asSuperadmin((c) => cancelPayout(c, payoutId));

		const res = await asSuperadmin((c) => markPaid(c, payoutId));

		expect(res).toMatchObject({
			ok: false,
			reason: "invalid_state",
			status: "cancelled",
		});
		expect(await payableBalance(t.bureau.id)).toBe("50.00");
	});

	it("refuses a missing or malformed receipt and a missing payout", async () => {
		const t = await newTenant();
		const payoutId = await openPayout(t);
		const bad = [
			{ key: null },
			{ key: "  " },
			{ mime: null },
			{ mime: "text/html" },
			{ sha: null },
			{ sha: "abc" },
			{ sha: "Z".repeat(64) },
		];
		for (const receipt of bad) {
			const res = await asSuperadmin((c) => markPaid(c, payoutId, receipt));
			expect(res, JSON.stringify(receipt)).toMatchObject({
				ok: false,
				reason: "invalid_receipt",
			});
		}
		expect((await payoutRow(payoutId)).status).toBe("open");
		expect(await payableBalance(t.bureau.id)).toBe("50.00");
		expect(await asSuperadmin((c) => markPaid(c, randomUUID()))).toMatchObject({
			ok: false,
			reason: "not_found",
		});
	});

	it("the CHECK refuses a paid payout without the receipt columns", async () => {
		const t = await newTenant();
		const payoutId = await openPayout(t);

		await expect(
			owner.query(
				"update payouts set status = 'paid', paid_at = now(), paid_by = $2 where id = $1",
				[payoutId, superadmin.userId],
			),
		).rejects.toThrow(/payouts_paid_complete/);
		await expect(
			owner.query(
				`update payouts set status = 'paid', paid_at = now(), paid_by = $2,
           receipt_object_key = 'k', receipt_mime = 'application/pdf' where id = $1`,
				[payoutId, superadmin.userId],
			),
		).rejects.toThrow(/payouts_paid_complete/);
	});
});

describe("cancel_payout", () => {
	it("frees the items so a new payout takes them", async () => {
		const t = await newTenant();
		const a = await seedEntry(t.bureau.id, "accrual", "15.00");
		const b = await seedEntry(t.bureau.id, "accrual", "25.00");
		const first = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);

		const res = await asSuperadmin((c) => cancelPayout(c, first.payout_id!));

		expect(res).toEqual({ ok: true, reason: null, status: "cancelled" });
		expect(await itemIds(first.payout_id!)).toEqual([]);
		expect((await payoutRow(first.payout_id!)).status).toBe("cancelled");
		const second = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);
		expect(second).toMatchObject({ ok: true, amount: "40.00" });
		expect(await itemIds(second.payout_id!)).toEqual([a, b].sort());
		expect(await payableBalance(t.bureau.id)).toBe("40.00");
	});

	it("is idempotent for a cancelled payout and refuses a paid one", async () => {
		const t = await newTenant();
		await seedEntry(t.bureau.id, "accrual", "15.00");
		const open = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);
		await asSuperadmin((c) => cancelPayout(c, open.payout_id!));
		expect(
			await asSuperadmin((c) => cancelPayout(c, open.payout_id!)),
		).toMatchObject({
			ok: true,
			status: "cancelled",
		});

		await seedEntry(t.bureau.id, "accrual", "20.00");
		const paid = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);
		await asSuperadmin((c) => markPaid(c, paid.payout_id!));
		const refused = await asSuperadmin((c) => cancelPayout(c, paid.payout_id!));

		expect(refused).toMatchObject({
			ok: false,
			reason: "invalid_state",
			status: "paid",
		});
		expect(await itemIds(paid.payout_id!)).toHaveLength(2);
		expect(
			await asSuperadmin((c) => cancelPayout(c, randomUUID())),
		).toMatchObject({
			ok: false,
			reason: "not_found",
		});
	});

	it("cancel and mark paid racing end in a single state", async () => {
		for (let round = 0; round < 5; round++) {
			// Um Bureau por rodada: um cancelamento da rodada anterior deixa o lançamento livre.
			const t = await newTenant();
			await seedEntry(t.bureau.id, "accrual", "10.00");
			const made = await asSuperadmin((c) =>
				createPayout(c, t.bureau.id, RELEASED_CUTOFF),
			);
			const [paid, cancelled] = await Promise.all([
				asSuperadmin((c) => markPaid(c, made.payout_id!)),
				asSuperadmin((c) => cancelPayout(c, made.payout_id!)),
			]);
			expect(
				[paid.ok, cancelled.ok].filter(Boolean),
				`round ${round}`,
			).toHaveLength(1);
			const final = (await payoutRow(made.payout_id!)).status;
			const items = await itemIds(made.payout_id!);
			const { rows } = await owner.query(
				"select 1 from bureau_payable_entries where payout_id = $1",
				[made.payout_id],
			);
			if (final === "paid") {
				expect(items).toHaveLength(1);
				expect(rows).toHaveLength(1);
			} else {
				expect(items).toHaveLength(0);
				expect(rows).toHaveLength(0);
			}
		}
	});
});

describe("immutability", () => {
	it("blocks direct edits that the functions never make", async () => {
		const t = await newTenant();
		await seedEntry(t.bureau.id, "accrual", "30.00");
		const made = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);
		const payoutId = made.payout_id!;

		await expect(
			owner.query("update payouts set amount = 1.00 where id = $1", [payoutId]),
		).rejects.toThrow(/allows only/);
		await expect(
			owner.query("update payouts set bureau_id = $2 where id = $1", [
				payoutId,
				(await newTenant()).bureau.id,
			]),
		).rejects.toThrow(/allows only/);
		await expect(
			owner.query("delete from payouts where id = $1", [payoutId]),
		).rejects.toThrow(/allows only/);
		// TRUNCATE toma lock exclusivo antes do trigger e travava testes paralelos: confira o trigger no catálogo.
		for (const table of ["payouts", "payout_items"]) {
			const { rows } = await owner.query(
				"select 1 from pg_trigger where tgrelid = $1::regclass and not tgisinternal and (tgtype & 32) = 32",
				[table],
			);
			expect(rows.length).toBeGreaterThan(0);
		}
		await expect(
			owner.query(
				"update payout_items set payout_id = payout_id where payout_id = $1",
				[payoutId],
			),
		).rejects.toThrow(/allows only/);

		await asSuperadmin((c) => markPaid(c, payoutId));
		await expect(
			owner.query("delete from payout_items where payout_id = $1", [payoutId]),
		).rejects.toThrow(/allows only/);
		await expect(
			owner.query("update payouts set status = 'cancelled' where id = $1", [
				payoutId,
			]),
		).rejects.toThrow(/allows only/);
	});

	it("keeps one item per entry and accepts only accrual or reversal entries", async () => {
		const t = await newTenant();
		const entry = await seedEntry(t.bureau.id, "accrual", "30.00");
		const made = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);
		await seedEntry(t.bureau.id, "accrual", "5.00");
		const second = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);

		await expect(
			owner.query(
				`insert into payout_items (payout_id, entry_id, bureau_id)
         values ($1, $2, $3)`,
				[second.payout_id, entry, t.bureau.id],
			),
		).rejects.toThrow(/payout_items_entry_id_key|duplicate key/);

		// O lançamento "payout" e o lançamento de outro Bureau não entram em repasse.
		await asSuperadmin((c) => markPaid(c, made.payout_id!));
		const { rows } = await owner.query<{ id: string }>(
			"select id from bureau_payable_entries where payout_id = $1",
			[made.payout_id],
		);
		const other = await newTenant("other");
		const foreign = await seedEntry(other.bureau.id, "accrual", "9.00");
		for (const [entryId, bureauId] of [
			[rows[0].id, t.bureau.id],
			[foreign, t.bureau.id],
			[randomUUID(), t.bureau.id],
		]) {
			await expect(
				owner.query(
					`insert into payout_items (payout_id, entry_id, bureau_id)
           values ($1, $2, $3)`,
					[second.payout_id, entryId, bureauId],
				),
			).rejects.toThrow(/accrual, reversal or coupon entry of the same Bureau/);
		}
	});

	it("only a payout entry may carry payout_id", async () => {
		const t = await newTenant();
		await seedEntry(t.bureau.id, "accrual", "30.00");
		const made = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);

		const orderRef = randomUUID();
		await owner.query(
			`insert into order_settlements (order_ref, bureau_id, mode, price, cost)
       values ($1, $2, 'counter', 1, 0)`,
			[orderRef, t.bureau.id],
		);
		await expect(
			owner.query(
				`insert into bureau_payable_entries (bureau_id, kind, amount, order_ref, payout_id)
         values ($1, 'accrual', 5, $2, $3)`,
				[t.bureau.id, orderRef, made.payout_id],
			),
		).rejects.toThrow(/bureau_payable_entries_payout_link/);
		await asSuperadmin((c) => markPaid(c, made.payout_id!));
		await expect(
			owner.query(
				`insert into bureau_payable_entries (bureau_id, kind, amount, payout_id)
         values ($1, 'payout', -1, $2)`,
				[t.bureau.id, made.payout_id],
			),
		).rejects.toThrow(/bureau_payable_entries_payout_idx|duplicate key/);
	});
});

describe("reconciliation", () => {
	it("accruals, reversals and payouts add up to the payable balance", async () => {
		const t = await newTenant();
		await seedClientWalletTopup(owner, {
			clientProfileId: t.client.userId,
			amount: "500.00",
			createdBy: t.client.userId,
		});
		await seedWalletTopup(owner, {
			bureauId: t.bureau.id,
			amount: "100.00",
			createdBy: t.bureauAdmin.userId,
		});
		// Acréscimo real, pelo fluxo de liquidação: preço 80, custo 50 -> 30.
		const orderRef = randomUUID();
		await seedOrderDossier(owner, { orderRef, bureauId: t.bureau.id, clientProfileId: t.client.userId });
		await committed(ctxOf(t.client), async (c) => {
			const quote = await seedOrderCatalog(owner, c, { productCode: "dossie_pf", price: "80.00", cost: "50.00" });
			await c.query(
				"select * from reserve_order($1, 'online', $2, '80.00', '50.00', $3::jsonb)",
				[orderRef, t.client.userId, JSON.stringify(quote)],
			);
			await c.query("select * from capture_order($1)", [orderRef]);
		});
		await seedEntry(t.bureau.id, "accrual", "70.00", "2026-01-10T00:00:00Z");
		await seedEntry(t.bureau.id, "reversal", "20.00", "2026-01-12T00:00:00Z");
		// O acréscimo real nasceu agora: sem envelhecer, a retenção o deixaria fora do repasse.
		await ageBureauPayableEntries(owner, t.bureau.id);

		const made = await asSuperadmin((c) =>
			createPayout(c, t.bureau.id, RELEASED_CUTOFF),
		);
		expect(made.amount).toBe("80.00");
		expect(await payableBalance(t.bureau.id)).toBe("80.00");
		await asSuperadmin((c) => markPaid(c, made.payout_id!));
		await seedEntry(t.bureau.id, "accrual", "12.00", "2026-03-01T00:00:00Z");

		const { rows } = await owner.query<{ kind: string; total: string }>(
			`select kind, sum(amount)::text as total from bureau_payable_entries
        where bureau_id = $1 group by kind order by kind`,
			[t.bureau.id],
		);
		const by = Object.fromEntries(rows.map((r) => [r.kind, Number(r.total)]));
		expect(by).toEqual({ accrual: 112, payout: -80, reversal: -20 });
		expect(by.accrual + by.reversal + by.payout).toBe(12);
		expect(await payableBalance(t.bureau.id)).toBe("12.00");
		// O que sobra a pagar é exatamente o que ainda não está em nenhum repasse.
		const { rows: free } = await owner.query<{ total: string }>(
			`select coalesce(sum(e.amount), 0)::text as total from bureau_payable_entries e
        where e.bureau_id = $1 and e.kind in ('accrual', 'reversal')
          and not exists (select 1 from payout_items i where i.entry_id = e.id)`,
			[t.bureau.id],
		);
		expect(free[0].total).toBe("12.00");
	});
});

describe("isolation", () => {
	async function twoBureaus() {
		const a = await newTenant("a");
		const b = await newTenant("b");
		await seedEntry(a.bureau.id, "accrual", "10.00");
		await seedEntry(b.bureau.id, "accrual", "20.00");
		const pa = (
			await asSuperadmin((c) => createPayout(c, a.bureau.id, RELEASED_CUTOFF))
		).payout_id!;
		const pb = (
			await asSuperadmin((c) => createPayout(c, b.bureau.id, RELEASED_CUTOFF))
		).payout_id!;
		return { a, b, pa, pb };
	}

	it("bureau_admin reads only the payouts and items of its own bureau", async () => {
		const { a, pa, pb } = await twoBureaus();

		await withDbContext(app, ctxOf(a.bureauAdmin), async (c) => {
			const payouts = await c.query<{ id: string }>("select id from payouts");
			expect(payouts.rows.map((r) => r.id)).toEqual([pa]);
			const items = await c.query<{ payout_id: string }>(
				"select payout_id from payout_items",
			);
			expect(new Set(items.rows.map((r) => r.payout_id))).toEqual(
				new Set([pa]),
			);
			const other = await c.query("select 1 from payouts where id = $1", [pb]);
			expect(other.rows).toHaveLength(0);
		});
	});

	it("operator and client read no payouts", async () => {
		const { a } = await twoBureaus();
		for (const identity of [a.operator, a.client]) {
			await withDbContext(app, ctxOf(identity), async (c) => {
				expect((await c.query("select 1 from payouts")).rows).toHaveLength(0);
				expect((await c.query("select 1 from payout_items")).rows).toHaveLength(
					0,
				);
			});
		}
	});

	it("superadmin reads every bureau without a support session, and not inside one", async () => {
		const { a, b, pa, pb } = await twoBureaus();

		await withDbContext(app, superadminCtx(), async (c) => {
			const { rows } = await c.query<{ id: string }>(
				"select id from payouts where id = any($1)",
				[[pa, pb]],
			);
			expect(rows.map((r) => r.id).sort()).toEqual([pa, pb].sort());
			const items = await c.query(
				"select 1 from payout_items where payout_id = any($1)",
				[[pa, pb]],
			);
			expect(items.rows).toHaveLength(2);
		});

		const session = await seedSupportSession(owner, {
			superadminId: superadmin.userId,
			bureauId: a.bureau.id,
		});
		await withDbContext(
			app,
			{ ...superadminCtx(), bureauId: a.bureau.id, supportSessionId: session },
			async (c) => {
				const { rows } = await c.query<{ id: string }>(
					"select id from payouts where id = any($1)",
					[[pa, pb]],
				);
				// Em suporte, o superadmin enxerga o Bureau da sessão pelo caminho comum de staff, não o outro.
				expect(rows.map((r) => r.id)).not.toContain(pb);
			},
		);
		expect(b.bureau.id).not.toBe(a.bureau.id);
	});

	it("only a superadmin without a support session runs the three functions", async () => {
		const { a, b, pa } = await twoBureaus();
		const session = await seedSupportSession(owner, {
			superadminId: superadmin.userId,
			bureauId: a.bureau.id,
		});
		const denied: Array<[string, Ctx & { supportSessionId?: string }]> = [
			["bureau_admin A", ctxOf(a.bureauAdmin)],
			["bureau_admin B", ctxOf(b.bureauAdmin)],
			["operator", ctxOf(a.operator)],
			["client", ctxOf(a.client)],
			[
				"superadmin in support",
				{
					...superadminCtx(),
					bureauId: a.bureau.id,
					supportSessionId: session,
				},
			],
		];
		for (const [label, ctx] of denied) {
			await withDbContext(app, ctx, async (c) => {
				const created = await createPayout(c, a.bureau.id, RELEASED_CUTOFF);
				expect(created, label).toMatchObject({
					ok: false,
					reason: "not_allowed",
				});
				expect(await markPaid(c, pa), label).toMatchObject({
					ok: false,
					reason: "not_allowed",
				});
				expect(await cancelPayout(c, pa), label).toMatchObject({
					ok: false,
					reason: "not_allowed",
				});
			});
		}
		expect((await payoutRow(pa)).status).toBe("open");
		// Sem contexto de sessão também não.
		const bare = await app.connect();
		try {
			const { rows } = await bare.query<CreateRow>(
				"select * from create_payout($1, $2::timestamptz)",
				[a.bureau.id, RELEASED_CUTOFF],
			);
			expect(rows[0]).toMatchObject({ ok: false, reason: "not_allowed" });
		} finally {
			bare.release();
		}
	});

	it("app_runtime and app_webhook cannot write the tables or run the functions directly", async () => {
		const { a, pa } = await twoBureaus();
		await withDbContext(app, superadminCtx(), async (c) => {
			await c.query("savepoint s");
			await expect(
				c.query(
					`insert into payouts (bureau_id, cutoff_at, amount, created_by)
           values ($1, now(), 5, $2)`,
					[a.bureau.id, superadmin.userId],
				),
			).rejects.toThrow(/permission denied/);
			await c.query("rollback to savepoint s");
			await expect(
				c.query("update payouts set status = 'cancelled'"),
			).rejects.toThrow(/permission denied/);
			await c.query("rollback to savepoint s");
			await expect(c.query("delete from payout_items")).rejects.toThrow(
				/permission denied/,
			);
			await c.query("rollback to savepoint s");
			await expect(
				c.query(
					`insert into bureau_payable_entries (bureau_id, kind, amount, payout_id)
           values ($1, 'payout', -1, $2)`,
					[a.bureau.id, pa],
				),
			).rejects.toThrow(/permission denied/);
		});
		const hookClient = await hook.connect();
		try {
			await expect(hookClient.query("select * from payouts")).rejects.toThrow(
				/permission denied/,
			);
			await expect(
				hookClient.query("select * from create_payout($1, $2::timestamptz)", [
					a.bureau.id,
					RELEASED_CUTOFF,
				]),
			).rejects.toThrow(/permission denied/);
		} finally {
			hookClient.release();
		}
	});
});

describe("NFS-e", () => {
	async function paidCharge(
		t: SeededTenant,
		status: "paid" | "pending" | "refunded" = "paid",
	) {
		return seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.bureauAdmin.userId,
			status,
		});
	}
	async function nfse(chargeId: string) {
		const { rows } = await owner.query<{
			nfse_status: string;
			nfse_number: string | null;
			nfse_url: string | null;
			nfse_attempts: number;
			nfse_updated_at: Date | null;
		}>(
			`select nfse_status, nfse_number, nfse_url, nfse_attempts, nfse_updated_at
         from pix_charges where id = $1`,
			[chargeId],
		);
		return rows[0];
	}
	type SetRow = {
		ok: boolean;
		reason: string | null;
		status: string | null;
		changed: boolean;
	};
	const setStatus = (
		chargeId: string,
		status: string,
		number: string | null = null,
		url: string | null = null,
	) =>
		hook
			.query<SetRow>("select * from set_nfse_status($1, $2, $3, $4)", [
				chargeId,
				status,
				number,
				url,
			])
			.then((r) => r.rows[0]);
	const retry = (ctx: Ctx, chargeId: string) =>
		committed(ctx, (c) =>
			c
				.query<StatusRow>("select * from request_nfse_retry($1)", [chargeId])
				.then((r) => r.rows[0]),
		);

	it("starts as not_requested with zero attempts", async () => {
		const t = await newTenant();
		const charge = await paidCharge(t);
		expect(await nfse(charge.id)).toMatchObject({
			nfse_status: "not_requested",
			nfse_number: null,
			nfse_url: null,
			nfse_attempts: 0,
			nfse_updated_at: null,
		});
	});

	it("moves not_requested to pending to issued and stores number and url", async () => {
		const t = await newTenant();
		const charge = await paidCharge(t);

		expect(await setStatus(charge.id, "pending")).toMatchObject({
			ok: true,
			status: "pending",
			changed: true,
		});
		const issued = await setStatus(
			charge.id,
			"issued",
			"123",
			"https://nfse.example/123",
		);

		expect(issued).toMatchObject({ ok: true, status: "issued", changed: true });
		const row = await nfse(charge.id);
		expect(row).toMatchObject({
			nfse_status: "issued",
			nfse_number: "123",
			nfse_url: "https://nfse.example/123",
		});
		expect(row.nfse_updated_at).not.toBeNull();
	});

	it("issued never regresses and a repeated issued changes nothing", async () => {
		const t = await newTenant();
		const charge = await paidCharge(t);
		await setStatus(charge.id, "issued", "9", "https://nfse.example/9");

		for (const status of ["pending", "failed"]) {
			expect(await setStatus(charge.id, status)).toMatchObject({
				ok: true,
				status: "issued",
				changed: false,
			});
		}
		expect(
			await setStatus(charge.id, "issued", "10", "https://nfse.example/10"),
		).toMatchObject({
			ok: true,
			status: "issued",
			changed: false,
		});
		expect(await nfse(charge.id)).toMatchObject({
			nfse_status: "issued",
			nfse_number: "9",
			nfse_url: "https://nfse.example/9",
		});
	});

	it("failed accepts a late issued but ignores a stale pending", async () => {
		const t = await newTenant();
		const charge = await paidCharge(t);
		await setStatus(charge.id, "failed");

		expect(await setStatus(charge.id, "pending")).toMatchObject({
			status: "failed",
			changed: false,
		});
		expect(
			await setStatus(charge.id, "issued", "7", "https://nfse.example/7"),
		).toMatchObject({
			status: "issued",
			changed: true,
		});
	});

	it("refuses unknown charges, unpaid charges, unknown statuses and unsafe urls", async () => {
		const t = await newTenant();
		const pending = await paidCharge(t, "pending");
		const paid = await paidCharge(t);

		expect(await setStatus(randomUUID(), "pending")).toMatchObject({
			ok: false,
			reason: "not_found",
		});
		expect(await setStatus(pending.id, "pending")).toMatchObject({
			ok: false,
			reason: "invalid_state",
		});
		for (const status of ["not_requested", "done", ""]) {
			expect(await setStatus(paid.id, status)).toMatchObject({
				ok: false,
				reason: "invalid_status",
			});
		}
		for (const url of [
			"javascript:alert(1)",
			"http://nfse.example/1",
			`https://x/${"a".repeat(2100)}`,
		]) {
			expect(await setStatus(paid.id, "issued", "1", url)).toMatchObject({
				ok: false,
				reason: "invalid_url",
			});
		}
		expect((await nfse(paid.id)).nfse_status).toBe("not_requested");
	});

	it("set_nfse_status runs only for app_webhook", async () => {
		const t = await newTenant();
		const charge = await paidCharge(t);
		const attempts = [ctxOf(t.bureauAdmin), ctxOf(t.client), superadminCtx()];
		for (const ctx of attempts) {
			await withDbContext(app, ctx, async (c) => {
				await expect(
					c.query(
						"select * from set_nfse_status($1, 'issued', '1', 'https://x.example/1')",
						[charge.id],
					),
				).rejects.toThrow(/permission denied/);
			});
		}
		expect((await nfse(charge.id)).nfse_status).toBe("not_requested");
	});

	it("request_nfse_retry accepts only failed, goes back to pending and counts the attempt", async () => {
		const t = await newTenant();
		const charge = await paidCharge(t);
		for (const status of ["not_requested", "pending"]) {
			if (status === "pending") await setStatus(charge.id, "pending");
			expect(await retry(superadminCtx(), charge.id)).toMatchObject({
				ok: false,
				reason: "invalid_state",
				status,
			});
		}
		await setStatus(charge.id, "failed");

		const res = await retry(superadminCtx(), charge.id);

		expect(res).toEqual({ ok: true, reason: null, status: "pending" });
		expect(await nfse(charge.id)).toMatchObject({
			nfse_status: "pending",
			nfse_attempts: 1,
		});
		// Segunda chamada seguida: já está pending, não conta outra tentativa.
		expect(await retry(superadminCtx(), charge.id)).toMatchObject({
			ok: false,
			reason: "invalid_state",
		});
		await setStatus(charge.id, "failed");
		await retry(superadminCtx(), charge.id);
		expect((await nfse(charge.id)).nfse_attempts).toBe(2);

		await setStatus(charge.id, "issued", "1", "https://nfse.example/1");
		expect(await retry(superadminCtx(), charge.id)).toMatchObject({
			ok: false,
			reason: "invalid_state",
			status: "issued",
		});
		expect(await retry(superadminCtx(), randomUUID())).toMatchObject({
			ok: false,
			reason: "not_found",
		});
	});

	it("request_nfse_retry is superadmin only and never inside a support session", async () => {
		const t = await newTenant();
		const charge = await paidCharge(t);
		await setStatus(charge.id, "failed");
		for (const ctx of [
			ctxOf(t.bureauAdmin),
			ctxOf(t.operator),
			ctxOf(t.client),
		]) {
			expect(await retry(ctx, charge.id)).toMatchObject({
				ok: false,
				reason: "not_allowed",
			});
		}
		const session = await seedSupportSession(owner, {
			superadminId: superadmin.userId,
			bureauId: t.bureau.id,
		});
		await withDbContext(
			app,
			{ ...superadminCtx(), bureauId: t.bureau.id, supportSessionId: session },
			async (c) => {
				const { rows } = await c.query<StatusRow>(
					"select * from request_nfse_retry($1)",
					[charge.id],
				);
				expect(rows[0]).toMatchObject({ ok: false, reason: "not_allowed" });
			},
		);
		expect(await nfse(charge.id)).toMatchObject({
			nfse_status: "failed",
			nfse_attempts: 0,
		});
		// app_webhook não chama a nova tentativa.
		await expect(
			hook.query("select * from request_nfse_retry($1)", [charge.id]),
		).rejects.toThrow(/permission denied/);
	});

	it("nfse failure and issue events never change the wallets", async () => {
		const t = await newTenant();
		await seedWalletTopup(owner, {
			bureauId: t.bureau.id,
			amount: "100.00",
			createdBy: t.bureauAdmin.userId,
		});
		const charge = await paidCharge(t);
		const snapshot = async () =>
			(
				await owner.query(
					`select (select available::text from wallets where bureau_id = $1) as available,
                  (select count(*)::int from ledger_entries where bureau_id = $1) as entries`,
					[t.bureau.id],
				)
			).rows[0];
		const before = await snapshot();

		await setStatus(charge.id, "failed");
		await retry(superadminCtx(), charge.id);
		await setStatus(charge.id, "issued", "1", "https://nfse.example/1");
		await setStatus(charge.id, "issued", "1", "https://nfse.example/1");

		expect(await snapshot()).toEqual(before);
	});

	it("app_runtime cannot write the nfse columns, even as superadmin", async () => {
		const t = await newTenant();
		const charge = await paidCharge(t);
		await withDbContext(app, superadminCtx(), async (c) => {
			await expect(
				c.query("update pix_charges set nfse_status = 'issued' where id = $1", [
					charge.id,
				]),
			).rejects.toThrow(/permission denied/);
		});
		await withDbContext(app, ctxOf(t.bureauAdmin), async (c) => {
			await expect(
				c.query(
					`insert into pix_charges (bureau_id, asaas_payment_id, amount, pix_payload, expires_at, requested_by, nfse_status)
           values ($1, $2, 50, 'x', now() + interval '1 hour', $3, 'issued')`,
					[
						t.bureau.id,
						`pay_${randomBytes(6).toString("hex")}`,
						t.bureauAdmin.userId,
					],
				),
			).rejects.toThrow(/permission denied/);
		});
	});

	it("list_failed_nfse shows failed notes of every bureau to the superadmin only", async () => {
		const a = await newTenant("a");
		const b = await newTenant("b");
		const failedA = await paidCharge(a);
		const failedB = await paidCharge(b);
		const pendingB = await paidCharge(b);
		await setStatus(failedA.id, "failed");
		await setStatus(failedB.id, "failed");
		await setStatus(pendingB.id, "pending");
		const list = (ctx: Ctx, supportSessionId?: string) =>
			withDbContext(app, { ...ctx, supportSessionId }, async (c) => {
				const { rows } = await c.query<{ charge_id: string; bureau_id: string }>(
					"select charge_id, bureau_id from list_failed_nfse(500)",
				);
				return rows;
			});

		const seen = await list(superadminCtx());
		const ids = seen.map((r) => r.charge_id);
		expect(ids).toContain(failedA.id);
		expect(ids).toContain(failedB.id);
		expect(ids).not.toContain(pendingB.id);
		expect(seen.find((r) => r.charge_id === failedB.id)?.bureau_id).toBe(
			b.bureau.id,
		);
		for (const ctx of [ctxOf(a.bureauAdmin), ctxOf(a.operator), ctxOf(a.client)]) {
			expect(await list(ctx)).toEqual([]);
		}
		const session = await seedSupportSession(owner, {
			superadminId: superadmin.userId,
			bureauId: a.bureau.id,
		});
		expect(
			await list({ ...superadminCtx(), bureauId: a.bureau.id }, session),
		).toEqual([]);
		// A lista não abre a tabela: o superadmin segue sem ler cobranças.
		await withDbContext(app, superadminCtx(), async (c) => {
			expect(
				(await c.query("select 1 from pix_charges where nfse_status = 'failed'"))
					.rowCount,
			).toBe(0);
		});
	});
});
