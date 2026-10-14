// Política audit_logs_insert (017): payout.* e nfse.retry com bureau_id alvo, só com a linha que prova o evento.
import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import {
	seedPixCharge,
	seedSuperadmin,
	seedSupportSession,
	seedTenant,
	withDbContext,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), app.end()]);
});

type Ctx = {
	userId: string;
	role: string;
	bureauId: string | null;
	supportSessionId?: string | null;
};

const RLS = /row-level security/;

// Uma recusa aborta a transação: o savepoint deixa o teste tentar de novo na mesma transação.
async function rejected(c: PoolClient, attempt: () => Promise<unknown>): Promise<void> {
	await c.query("savepoint attempt");
	await expect(attempt()).rejects.toThrow(RLS);
	await c.query("rollback to savepoint attempt");
}

const accrue = (bureauId: string) =>
	owner.query(
		"insert into bureau_payable_entries (bureau_id, kind, amount) values ($1, 'accrual', '40.00')",
		[bureauId],
	);

async function setup() {
	const superadmin = await seedSuperadmin(owner);
	const a = await seedTenant(owner, "audA");
	const b = await seedTenant(owner, "audB");
	await owner.query(
		"insert into bureau_payable_entries (bureau_id, kind, amount) values ($1, 'accrual', '40.00')",
		[a.bureau.id],
	);
	const sa: Ctx = {
		userId: superadmin.userId,
		role: "superadmin",
		bureauId: null,
	};
	return { sa, a, b };
}

const audit = (
	c: PoolClient,
	i: {
		userId: string;
		action: string;
		table: string;
		recordId: string | null;
		bureauId: string | null;
	},
) =>
	c.query(
		`insert into audit_logs (user_id, action, table_name, record_id, bureau_id, metadata) values ($1, $2, $3, $4, $5, '{}'::jsonb)`,
		[i.userId, i.action, i.table, i.recordId, i.bureauId],
	);

async function newPayout(c: PoolClient, bureauId: string): Promise<string> {
	const { rows } = await c.query<{ ok: boolean; payout_id: string }>(
		"select ok, payout_id from create_payout($1, '2100-01-01T00:00:00Z')",
		[bureauId],
	);
	expect(rows[0].ok).toBe(true);
	return rows[0].payout_id;
}

const pay = (c: PoolClient, id: string) =>
	c.query("select * from mark_payout_paid($1, $2, 'application/pdf', $3)", [
		id,
		`ab/${randomUUID()}`,
		"a".repeat(64),
	]);

// Repasse gravado e confirmado antes do teste: a transação do teste não é a que o escreveu.
async function committedPayout(sa: Ctx, bureauId: string): Promise<string> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			"select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true), set_config('app.bureau_id', '', true), set_config('app.support_session_id', '', true)",
			[sa.userId, sa.role],
		);
		const id = await newPayout(client, bureauId);
		await client.query("commit");
		return id;
	} finally {
		client.release();
	}
}

describe("payout.* audit with a target Bureau", () => {
	it.each(["payout.create", "payout.pay", "payout.cancel"])(
		"accepts %s next to the payout the same transaction changed",
		async (action) => {
			const { sa, a } = await setup();
			await withDbContext(app, sa, async (c) => {
				const id = await newPayout(c, a.bureau.id);
				if (action === "payout.pay") await pay(c, id);
				if (action === "payout.cancel")
					await c.query("select * from cancel_payout($1)", [id]);

				await audit(c, {
					userId: sa.userId,
					action,
					table: "payouts",
					recordId: id,
					bureauId: a.bureau.id,
				});

				const read = await c.query(
					"select 1 from audit_logs where action = $1 and bureau_id = $2",
					[action, a.bureau.id],
				);
				expect(read.rowCount).toBe(1);
			});
		},
	);

	it("rejects another Bureau, a missing payout and a payout from an earlier transaction", async () => {
		const { sa, a, b } = await setup();
		const earlier = await committedPayout(sa, a.bureau.id);
		await accrue(a.bureau.id);
		await withDbContext(app, sa, async (c) => {
			const id = await newPayout(c, a.bureau.id);
			await expect(
				audit(c, {
					userId: sa.userId,
					action: "payout.create",
					table: "payouts",
					recordId: id,
					bureauId: b.bureau.id,
				}),
			).rejects.toThrow(RLS);
		});
		await withDbContext(app, sa, async (c) => {
			await expect(
				audit(c, {
					userId: sa.userId,
					action: "payout.create",
					table: "payouts",
					recordId: randomUUID(),
					bureauId: a.bureau.id,
				}),
			).rejects.toThrow(RLS);
		});
		await withDbContext(app, sa, async (c) => {
			await expect(
				audit(c, {
					userId: sa.userId,
					action: "payout.create",
					table: "payouts",
					recordId: earlier,
					bureauId: a.bureau.id,
				}),
			).rejects.toThrow(RLS);
		});
	});

	it("rejects an action that the payout state does not match, another table and another action", async () => {
		const { sa, a } = await setup();
		await withDbContext(app, sa, async (c) => {
			const id = await newPayout(c, a.bureau.id);
			for (const action of ["payout.pay", "payout.cancel"]) {
				await c.query("savepoint attempt");
				await expect(
					audit(c, {
						userId: sa.userId,
						action,
						table: "payouts",
						recordId: id,
						bureauId: a.bureau.id,
					}),
				).rejects.toThrow(RLS);
				await c.query("rollback to savepoint attempt");
			}
		});
		await withDbContext(app, sa, async (c) => {
			const id = await newPayout(c, a.bureau.id);
			await expect(
				audit(c, {
					userId: sa.userId,
					action: "payout.create",
					table: "payout_items",
					recordId: id,
					bureauId: a.bureau.id,
				}),
			).rejects.toThrow(RLS);
		});
		await withDbContext(app, sa, async (c) => {
			const id = await newPayout(c, a.bureau.id);
			await expect(
				audit(c, {
					userId: sa.userId,
					action: "payout.other",
					table: "payouts",
					recordId: id,
					bureauId: a.bureau.id,
				}),
			).rejects.toThrow(RLS);
		});
	});

	it("rejects an actor that is not the session user", async () => {
		const { sa, a } = await setup();
		await withDbContext(app, sa, async (c) => {
			const id = await newPayout(c, a.bureau.id);
			await expect(
				audit(c, {
					userId: a.bureauAdmin.userId,
					action: "payout.create",
					table: "payouts",
					recordId: id,
					bureauId: a.bureau.id,
				}),
			).rejects.toThrow(RLS);
		});
	});

	it("rejects a superadmin in a support session and a bureau_admin aiming at another Bureau", async () => {
		const { sa, a, b } = await setup();
		const earlier = await committedPayout(sa, a.bureau.id);
		const supportSessionId = await seedSupportSession(owner, {
			superadminId: sa.userId,
			bureauId: b.bureau.id,
		});
		await withDbContext(
			app,
			{ ...sa, bureauId: b.bureau.id, supportSessionId },
			async (c) => {
				await expect(
					audit(c, {
						userId: sa.userId,
						action: "payout.create",
						table: "payouts",
						recordId: earlier,
						bureauId: a.bureau.id,
					}),
				).rejects.toThrow(RLS);
			},
		);
		await withDbContext(app, a.bureauAdmin, async (c) => {
			await expect(
				audit(c, {
					userId: a.bureauAdmin.userId,
					action: "payout.create",
					table: "payouts",
					recordId: earlier,
					bureauId: b.bureau.id,
				}),
			).rejects.toThrow(RLS);
		});
	});

	it("lets the superadmin and the Bureau admin read the event, and no other Bureau", async () => {
		const { sa, a, b } = await setup();
		const client = await app.connect();
		let id: string;
		try {
			await client.query("begin");
			await client.query(
				"select set_config('app.user_id', $1, true), set_config('app.user_role', 'superadmin', true), set_config('app.bureau_id', '', true), set_config('app.support_session_id', '', true)",
				[sa.userId],
			);
			id = await newPayout(client, a.bureau.id);
			await audit(client, {
				userId: sa.userId,
				action: "payout.create",
				table: "payouts",
				recordId: id,
				bureauId: a.bureau.id,
			});
			await client.query("commit");
		} finally {
			client.release();
		}
		const count = (ctx: Ctx) =>
			withDbContext(app, ctx, async (c) => {
				const { rows } = await c.query(
					"select 1 from audit_logs where action = 'payout.create' and record_id = $1",
					[id],
				);
				return rows.length;
			});

		expect(await count(sa)).toBe(1);
		expect(await count(a.bureauAdmin)).toBe(1);
		expect(await count(b.bureauAdmin)).toBe(0);
	});
});

describe("nfse.retry audit with a target Bureau", () => {
	async function failedCharge(bureau: { id: string }, adminId: string) {
		const charge = await seedPixCharge(owner, {
			bureauId: bureau.id,
			requestedBy: adminId,
			status: "paid",
		});
		await owner.query(
			"update pix_charges set nfse_status = 'failed' where id = $1",
			[charge.id],
		);
		return charge.id;
	}
	const retry = (c: PoolClient, id: string) =>
		c.query("select * from request_nfse_retry($1)", [id]);
	const nfseAudit = (
		sa: Ctx,
		c: PoolClient,
		id: string,
		bureauId: string,
		over: { action?: string; table?: string } = {},
	) =>
		audit(c, {
			userId: sa.userId,
			action: over.action ?? "nfse.retry",
			table: over.table ?? "pix_charges",
			recordId: id,
			bureauId,
		});

	it("accepts the event next to the retry the same transaction made, and the Bureau admin reads it", async () => {
		const { sa, a } = await setup();
		const id = await failedCharge(a.bureau, a.bureauAdmin.userId);
		await withDbContext(app, sa, async (c) => {
			await retry(c, id);
			await nfseAudit(sa, c, id, a.bureau.id);
			const read = await c.query(
				"select 1 from audit_logs where action = 'nfse.retry' and record_id = $1",
				[id],
			);
			expect(read.rowCount).toBe(1);
		});
	});

	it("rejects a charge that was not retried, one retried earlier, another Bureau and an unknown charge", async () => {
		const { sa, a, b } = await setup();
		const failed = await failedCharge(a.bureau, a.bureauAdmin.userId);
		await withDbContext(app, sa, async (c) => {
			await expect(nfseAudit(sa, c, failed, a.bureau.id)).rejects.toThrow(RLS);
		});
		await withDbContext(app, sa, async (c) => {
			await retry(c, failed);
			await expect(nfseAudit(sa, c, failed, b.bureau.id)).rejects.toThrow(RLS);
		});
		await withDbContext(app, sa, async (c) => {
			await expect(nfseAudit(sa, c, randomUUID(), a.bureau.id)).rejects.toThrow(
				RLS,
			);
		});
		const earlier = await failedCharge(a.bureau, a.bureauAdmin.userId);
		await owner.query(
			"update pix_charges set nfse_status = 'pending', nfse_attempts = 1, nfse_updated_at = now() where id = $1",
			[earlier],
		);
		await withDbContext(app, sa, async (c) => {
			await expect(nfseAudit(sa, c, earlier, a.bureau.id)).rejects.toThrow(RLS);
		});
	});

	it("rejects another action, another table, a support session and a non-superadmin", async () => {
		const { sa, a, b } = await setup();
		const id = await failedCharge(a.bureau, a.bureauAdmin.userId);
		await withDbContext(app, sa, async (c) => {
			await retry(c, id);
			await rejected(c, () =>
				nfseAudit(sa, c, id, a.bureau.id, { action: "nfse.other" }),
			);
			await rejected(c, () =>
				nfseAudit(sa, c, id, a.bureau.id, { table: "payouts" }),
			);
		});
		const supportSessionId = await seedSupportSession(owner, {
			superadminId: sa.userId,
			bureauId: b.bureau.id,
		});
		await withDbContext(
			app,
			{ ...sa, bureauId: b.bureau.id, supportSessionId },
			async (c) => {
				await expect(nfseAudit(sa, c, id, a.bureau.id)).rejects.toThrow(RLS);
			},
		);
		await withDbContext(app, a.bureauAdmin, async (c) => {
			await expect(
				nfseAudit(a.bureauAdmin, c, id, b.bureau.id),
			).rejects.toThrow(RLS);
		});
	});
});
