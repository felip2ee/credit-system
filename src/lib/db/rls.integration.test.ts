import { randomBytes, randomInt, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import {
	randomCpf,
	seedClientProfile,
	seedSupportSession,
	seedSuperadmin,
	seedTenant,
	withDbContext,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

type Rows = {
	holder: string;
	holderDoc: string;
	company: string;
	partnership: string;
	dossier: string;
	consultation: string;
	consultation2: string;
	payload: string;
	payload2: string;
	result: string;
	aiReport: string;
	scr: string;
	timeline: string;
	note: string;
};

type Actor = {
	userId: string;
	role: string;
	bureauId: string | null;
	supportSessionId?: string | null;
};

type Spec = {
	table: string;
	idCol: string;
	setCol: string;
	id: (rows: Rows) => string;
	// Insert válido para `bureauId`, com pais do mesmo Bureau (`rows`).
	insert: (bureauId: string, rows: Rows, actor: string) => [string, unknown[]];
};

function digits(length: number): string {
	return Array.from({ length }, () => randomInt(0, 10)).join("");
}

const sha = () => randomBytes(32).toString("hex");

const specs: Spec[] = [
	{
		table: "holders",
		idCol: "id",
		setCol: "name",
		id: (r) => r.company,
		insert: (b, _r, actor) => [
			"insert into holders (bureau_id, type, name, document, created_by) values ($1, 'PF', 'Novo', $2, $3)",
			[b, randomCpf(), actor],
		],
	},
	{
		table: "holder_partnerships",
		idCol: "id",
		setCol: "role",
		id: (r) => r.partnership,
		// Par invertido: (company_id, partner_id) diferente do par semeado.
		insert: (b, r) => [
			"insert into holder_partnerships (bureau_id, company_id, partner_id, source) values ($1, $2, $3, 'operator')",
			[b, r.holder, r.company],
		],
	},
	{
		table: "dossiers",
		idCol: "id",
		setCol: "product",
		id: (r) => r.dossier,
		insert: (b, r, actor) => [
			"insert into dossiers (bureau_id, kind, holder_id, product, created_by) values ($1, 'PF', $2, 'smart_pf', $3)",
			[b, r.holder, actor],
		],
	},
	{
		table: "consultations",
		idCol: "id",
		setCol: "product",
		id: (r) => r.consultation,
		insert: (b, r, actor) => [
			"insert into consultations (bureau_id, type, document, holder_id, dossier_id, created_by) values ($1, 'PF', $2, $3, $4, $5)",
			[b, r.holderDoc, r.holder, r.dossier, actor],
		],
	},
	{
		table: "scr_authorizations",
		idCol: "id",
		setCol: "name",
		id: (r) => r.scr,
		insert: (b, r) => [
			"insert into scr_authorizations (bureau_id, document, type, holder_id) values ($1, $2, 'PF', $3)",
			[b, r.holderDoc, r.holder],
		],
	},
	{
		table: "bureau_payloads",
		idCol: "id",
		setCol: "validation_status",
		id: (r) => r.payload,
		insert: (b, r) => [
			"insert into bureau_payloads (bureau_id, consultation_id, provider, product, received_at, http_status, payload, payload_sha256) values ($1, $2, 'deps', 'p', now(), 200, '{}'::jsonb, $3)",
			[b, r.consultation, sha()],
		],
	},
	{
		table: "bureau_results",
		idCol: "consultation_id",
		setCol: "person_name",
		id: (r) => r.consultation,
		insert: (b, r) => [
			"insert into bureau_results (bureau_id, consultation_id, payload_id, adapter_version, canonical_result, document) values ($1, $2, $3, 1, '{}'::jsonb, '1')",
			[b, r.consultation2, r.payload2],
		],
	},
	{
		table: "ai_reports",
		idCol: "id",
		setCol: "status",
		id: (r) => r.aiReport,
		insert: (b, r) => [
			"insert into ai_reports (bureau_id, consultation_id) values ($1, $2)",
			[b, r.consultation2],
		],
	},
	{
		table: "timeline_events",
		idCol: "id",
		setCol: "title",
		id: (r) => r.timeline,
		insert: (b, r) => [
			"insert into timeline_events (bureau_id, entity_type, entity_id, event_type, title) values ($1, 'holder', $2, 'test', 'Teste')",
			[b, r.company],
		],
	},
	{
		table: "crm_notes",
		idCol: "id",
		setCol: "content",
		id: (r) => r.note,
		insert: (b, r, actor) => [
			"insert into crm_notes (bureau_id, entity_type, entity_id, content, created_by) values ($1, 'holder', $2, 'nota', $3)",
			[b, r.company, actor],
		],
	},
];

async function insertId(sql: string, params: unknown[]): Promise<string> {
	const { rows } = await owner.query<{ id: string }>(sql, params);
	return rows[0].id;
}

async function seedRows(t: SeededTenant): Promise<Rows> {
	const b = t.bureau.id;
	const admin = t.bureauAdmin.userId;
	const company = await insertId(
		"insert into holders (bureau_id, type, name, document, created_by) values ($1, 'PJ', 'Empresa', $2, $3) returning id",
		[b, digits(14), admin],
	);
	const partnership = await insertId(
		"insert into holder_partnerships (bureau_id, company_id, partner_id, source) values ($1, $2, $3, 'operator') returning id",
		[b, company, t.holder.id],
	);
	const dossier = await insertId(
		"insert into dossiers (bureau_id, kind, holder_id, product, created_by) values ($1, 'PF', $2, 'smart_pf', $3) returning id",
		[b, t.holder.id, admin],
	);
	const consultationSql =
		"insert into consultations (bureau_id, type, document, holder_id, dossier_id, created_by) values ($1, 'PF', $2, $3, $4, $5) returning id";
	const consultationParams = [
		b,
		t.holder.document,
		t.holder.id,
		dossier,
		admin,
	];
	const consultation = await insertId(consultationSql, consultationParams);
	const consultation2 = await insertId(consultationSql, consultationParams);
	const payloadSql =
		"insert into bureau_payloads (bureau_id, consultation_id, provider, product, received_at, http_status, payload, payload_sha256) values ($1, $2, 'deps', 'p', now(), 200, '{}'::jsonb, $3) returning id";
	const payload = await insertId(payloadSql, [b, consultation, sha()]);
	const payload2 = await insertId(payloadSql, [b, consultation2, sha()]);
	await owner.query(
		"insert into bureau_results (bureau_id, consultation_id, payload_id, adapter_version, canonical_result, document) values ($1, $2, $3, 1, '{}'::jsonb, '1')",
		[b, consultation, payload],
	);
	const aiReport = await insertId(
		"insert into ai_reports (bureau_id, consultation_id, holder_id) values ($1, $2, $3) returning id",
		[b, consultation, t.holder.id],
	);
	const scr = await insertId(
		"insert into scr_authorizations (bureau_id, document, type, holder_id) values ($1, $2, 'PF', $3) returning id",
		[b, t.holder.document, t.holder.id],
	);
	const timeline = await insertId(
		"insert into timeline_events (bureau_id, entity_type, entity_id, event_type, title) values ($1, 'holder', $2, 'test', 'Teste') returning id",
		[b, t.holder.id],
	);
	const note = await insertId(
		"insert into crm_notes (bureau_id, entity_type, entity_id, content, created_by) values ($1, 'holder', $2, 'nota', $3) returning id",
		[b, t.holder.id, admin],
	);
	return {
		holder: t.holder.id,
		holderDoc: t.holder.document,
		company,
		partnership,
		dossier,
		consultation,
		consultation2,
		payload,
		payload2,
		result: consultation,
		aiReport,
		scr,
		timeline,
		note,
	};
}

// consultation2 e payload2 ficam sem resultado/relatório para os inserts de bureau_results e ai_reports.
async function visibleByTable(
	actor: Actor,
	ids: Record<string, string[]>,
): Promise<Record<string, string[]>> {
	return withDbContext(app, actor, async (client) => {
		const out: Record<string, string[]> = {};
		for (const spec of specs) {
			const { rows } = await client.query<{ id: string }>(
				`select ${spec.idCol}::text as id from ${spec.table} where ${spec.idCol} = any($1::uuid[]) order by 1`,
				[ids[spec.table]],
			);
			out[spec.table] = rows.map((row) => row.id);
		}
		return out;
	});
}

// Sem efeito = 0 linhas afetadas ou erro de privilégio/RLS (42501).
async function expectNoEffect(run: Promise<{ rowCount: number | null }>) {
	const outcome = await run.then(
		(result) => ({ rowCount: result.rowCount }),
		(error: { code?: string }) => ({ code: error.code }),
	);
	expect([{ rowCount: 0 }, { code: "42501" }]).toContainEqual(outcome);
}

async function expectCode(
	owner_: Pool,
	sql: string,
	params: unknown[],
	code: string,
) {
	await expect(owner_.query(sql, params)).rejects.toMatchObject({ code });
}

let A: SeededTenant;
let B: SeededTenant;
let rowsA: Rows;
let rowsB: Rows;
let sa: SeedSuperadmin;
let sa2: SeedSuperadmin;
let otherHolderA: string;
let ids: Record<string, string[]>;

const ctxOf = (i: {
	userId: string;
	role: string;
	bureauId: string | null;
}): Actor => ({
	userId: i.userId,
	role: i.role,
	bureauId: i.bureauId,
});

beforeAll(async () => {
	[A, B, sa, sa2] = await Promise.all([
		seedTenant(owner, "tenant A"),
		seedTenant(owner, "tenant B"),
		seedSuperadmin(owner),
		seedSuperadmin(owner),
	]);
	[rowsA, rowsB] = await Promise.all([seedRows(A), seedRows(B)]);
	otherHolderA = await insertId(
		"insert into holders (bureau_id, type, name, document, created_by) values ($1, 'PF', 'Outro', $2, $3) returning id",
		[A.bureau.id, randomCpf(), A.bureauAdmin.userId],
	);
	ids = Object.fromEntries(
		specs.map((s) => [s.table, [s.id(rowsA), s.id(rowsB)]]),
	);
	await owner.query(
		"insert into audit_logs (user_id, action, bureau_id) values ($1, 'test.audit', $2), ($3, 'test.audit', $4)",
		[A.bureauAdmin.userId, A.bureau.id, B.bureauAdmin.userId, B.bureau.id],
	);
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end()]);
});

describe("tenant isolation per table", () => {
	for (const spec of specs) {
		describe(spec.table, () => {
			it("operator of A reads only rows of A", async () => {
				const visible = await visibleByTable(ctxOf(A.operator), ids);
				expect(visible[spec.table]).toEqual([spec.id(rowsA)]);
			});

			it("operator of A inserts into A but not into B", async () => {
				const [okSql, okParams] = spec.insert(
					A.bureau.id,
					rowsA,
					A.operator.userId,
				);
				await expect(
					withDbContext(app, ctxOf(A.operator), (c) =>
						c.query(okSql, okParams),
					),
				).resolves.toMatchObject({ rowCount: 1 });

				const [badSql, badParams] = spec.insert(
					B.bureau.id,
					rowsB,
					A.operator.userId,
				);
				await expect(
					withDbContext(app, ctxOf(A.operator), (c) =>
						c.query(badSql, badParams),
					),
				).rejects.toMatchObject({ code: "42501" });
			});

			it("operator of A cannot update or delete rows of B", async () => {
				const id = spec.id(rowsB);
				await expectNoEffect(
					withDbContext(app, ctxOf(A.operator), (c) =>
						c.query(
							`update ${spec.table} set ${spec.setCol} = ${spec.setCol} where ${spec.idCol} = $1`,
							[id],
						),
					),
				);
				await expectNoEffect(
					withDbContext(app, ctxOf(A.operator), (c) =>
						c.query(`delete from ${spec.table} where ${spec.idCol} = $1`, [id]),
					),
				);
			});
		});
	}

	it("operator of A updates a holder of A (control for the update statement)", async () => {
		await expect(
			withDbContext(app, ctxOf(A.operator), (c) =>
				c.query("update holders set name = name where id = $1", [
					rowsA.company,
				]),
			),
		).resolves.toMatchObject({ rowCount: 1 });
	});

	it("client of A reads no tenant row besides its own holder", async () => {
		const visible = await visibleByTable(ctxOf(A.client), ids);
		for (const spec of specs) expect(visible[spec.table]).toEqual([]);
	});
});

describe("composite FK rejects cross-bureau reference", () => {
	it("consultation of A with holder of B", async () => {
		await expect(
			withDbContext(app, ctxOf(A.operator), (c) =>
				c.query(
					"insert into consultations (bureau_id, type, document, holder_id, dossier_id, created_by) values ($1, 'PF', '1', $2, $3, $4)",
					[A.bureau.id, B.holder.id, rowsA.dossier, A.operator.userId],
				),
			),
		).rejects.toMatchObject({ code: "23503" });
	});

	it.each([
		[
			"dossier -> holder",
			"insert into dossiers (bureau_id, kind, holder_id, product, created_by) values ($1, 'PF', $2, 'x', $3)",
			() => [A.bureau.id, B.holder.id, A.bureauAdmin.userId],
		],
		[
			"partnership -> holder",
			"insert into holder_partnerships (bureau_id, company_id, partner_id, source) values ($1, $2, $3, 'operator')",
			() => [A.bureau.id, rowsA.company, B.holder.id],
		],
		[
			"scr -> holder",
			"insert into scr_authorizations (bureau_id, document, type, holder_id) values ($1, '1', 'PF', $2)",
			() => [A.bureau.id, B.holder.id],
		],
		[
			"scr -> consultation",
			"insert into scr_authorizations (bureau_id, document, type, holder_id, consultation_id) values ($1, '1', 'PF', $2, $3)",
			() => [A.bureau.id, A.holder.id, rowsB.consultation],
		],
		[
			"payload -> consultation",
			"insert into bureau_payloads (bureau_id, consultation_id, provider, product, received_at, http_status, payload, payload_sha256) values ($1, $2, 'deps', 'p', now(), 200, '{}'::jsonb, $3)",
			() => [A.bureau.id, rowsB.consultation, sha()],
		],
		[
			"result -> payload",
			"insert into bureau_results (bureau_id, consultation_id, payload_id, adapter_version, canonical_result, document) values ($1, $2, $3, 1, '{}'::jsonb, '1')",
			() => [A.bureau.id, rowsA.consultation2, rowsB.payload2],
		],
		[
			"ai_report -> consultation",
			"insert into ai_reports (bureau_id, consultation_id) values ($1, $2)",
			() => [A.bureau.id, rowsB.consultation2],
		],
		[
			"ai_report -> holder",
			"insert into ai_reports (bureau_id, consultation_id, holder_id) values ($1, $2, $3)",
			() => [A.bureau.id, rowsA.consultation2, B.holder.id],
		],
		[
			"holder -> client profile",
			"insert into holders (bureau_id, type, name, document, created_by, client_profile_id) values ($1, 'PF', 'x', $2, $3, $4)",
			() => [A.bureau.id, randomCpf(), A.bureauAdmin.userId, B.client.userId],
		],
	])("%s", async (_name, sql, params) => {
		await expectCode(owner, sql, params(), "23503");
	});
});

describe("client portal", () => {
	it("client sees only own holder", async () => {
		const visible = await withDbContext(app, ctxOf(A.client), async (c) => {
			const { rows } = await c.query<{ id: string }>(
				"select id from holders where id = any($1::uuid[]) order by id",
				[[A.holder.id, otherHolderA, rowsA.company, B.holder.id]],
			);
			return rows.map((row) => row.id);
		});
		expect(visible).toEqual([A.holder.id]);
	});

	it("client cannot write holders", async () => {
		await expectNoEffect(
			withDbContext(app, ctxOf(A.client), (c) =>
				c.query("update holders set name = name where id = $1", [A.holder.id]),
			),
		);
	});
});

describe("superadmin and support sessions", () => {
	const superCtx = (
		bureauId: string | null,
		supportSessionId: string | null,
	): Actor => ({
		userId: sa.userId,
		role: "superadmin",
		bureauId,
		supportSessionId,
	});

	it("superadmin without support sees zero rows", async () => {
		const counts = await withDbContext(app, superCtx(null, null), async (c) => {
			const out: Record<string, number> = {};
			for (const spec of specs) {
				const { rows } = await c.query<{ n: string }>(
					`select count(*) as n from ${spec.table}`,
				);
				out[spec.table] = Number(rows[0].n);
			}
			const audit = await c.query<{ n: string }>(
				"select count(*) as n from audit_logs where bureau_id is not null and support_session_id is null and action not in ('catalog.cost.set', 'wallet.adjust', 'payout.create', 'payout.pay', 'payout.cancel', 'nfse.retry')",
			);
			out.audit_logs = Number(audit.rows[0].n);
			return out;
		});
		expect(counts).toEqual({
			...Object.fromEntries(specs.map((s) => [s.table, 0])),
			audit_logs: 0,
		});
	});

	it("superadmin without support cannot write tenant rows", async () => {
		const [sql, params] = specs[0].insert(A.bureau.id, rowsA, sa.userId);
		await expect(
			withDbContext(app, superCtx(A.bureau.id, null), (c) =>
				c.query(sql, params),
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	it("active support sees rows of A and zero of B", async () => {
		const session = await seedSupportSession(owner, {
			superadminId: sa.userId,
			bureauId: A.bureau.id,
		});
		const visible = await visibleByTable(superCtx(A.bureau.id, session), ids);
		for (const spec of specs)
			expect(visible[spec.table]).toEqual([spec.id(rowsA)]);
	});

	it("active support can write to A", async () => {
		const session = await seedSupportSession(owner, {
			superadminId: sa.userId,
			bureauId: A.bureau.id,
		});
		const [sql, params] = specs[0].insert(A.bureau.id, rowsA, sa.userId);
		await expect(
			withDbContext(app, superCtx(A.bureau.id, session), (c) =>
				c.query(sql, params),
			),
		).resolves.toMatchObject({ rowCount: 1 });
	});

	describe("expired/ended support denied", () => {
		const denied: Array<[string, () => Promise<Actor>]> = [
			[
				"expired",
				async () => {
					const now = Date.now();
					const id = await seedSupportSession(owner, {
						superadminId: sa.userId,
						bureauId: A.bureau.id,
						startedAt: new Date(now - 2 * HOUR_MS),
						expiresAt: new Date(now - HOUR_MS),
					});
					return superCtx(A.bureau.id, id);
				},
			],
			[
				"ended",
				async () => {
					const now = Date.now();
					const id = await seedSupportSession(owner, {
						superadminId: sa.userId,
						bureauId: A.bureau.id,
						startedAt: new Date(now - 10 * MINUTE_MS),
						expiresAt: new Date(now + 50 * MINUTE_MS),
						endedAt: new Date(now - 5 * MINUTE_MS),
					});
					return superCtx(A.bureau.id, id);
				},
			],
			[
				"owned by another superadmin",
				async () => {
					const id = await seedSupportSession(owner, {
						superadminId: sa2.userId,
						bureauId: A.bureau.id,
					});
					return superCtx(A.bureau.id, id);
				},
			],
			[
				"for a different bureau than the GUC",
				async () => {
					const id = await seedSupportSession(owner, {
						superadminId: sa.userId,
						bureauId: A.bureau.id,
					});
					return superCtx(B.bureau.id, id);
				},
			],
			["unknown session id", async () => superCtx(A.bureau.id, randomUUID())],
		];

		it.each(denied)("%s", async (_name, build) => {
			const visible = await visibleByTable(await build(), ids);
			for (const spec of specs) expect(visible[spec.table]).toEqual([]);
		});
	});

	it("support session rejects an empty or blank reason", async () => {
		for (const reason of ["", "   "]) {
			await expect(
				seedSupportSession(owner, {
					superadminId: sa.userId,
					bureauId: A.bureau.id,
					reason,
				}),
			).rejects.toMatchObject({ code: "23514" });
		}
	});

	it("support session rejects expiry above one hour", async () => {
		const startedAt = new Date();
		await expect(
			seedSupportSession(owner, {
				superadminId: sa.userId,
				bureauId: A.bureau.id,
				startedAt,
				expiresAt: new Date(startedAt.getTime() + 2 * HOUR_MS),
			}),
		).rejects.toMatchObject({ code: "23514" });
	});

	it("superadmin starts and ends only own support session", async () => {
		await owner.query(
			"update support_sessions set ended_at = now() where superadmin_id = $1 and ended_at is null",
			[sa.userId],
		);
		await withDbContext(app, superCtx(null, null), async (c) => {
			const { rows } = await c.query<{ id: string }>(
				"insert into support_sessions (superadmin_id, bureau_id, reason) values ($1, $2, 'chamado 1') returning id",
				[sa.userId, A.bureau.id],
			);
			const ended = await c.query(
				"update support_sessions set ended_at = now() where id = $1",
				[rows[0].id],
			);
			expect(ended.rowCount).toBe(1);
		});
		await expect(
			withDbContext(app, superCtx(null, null), (c) =>
				c.query(
					"insert into support_sessions (superadmin_id, bureau_id, reason) values ($1, $2, 'x')",
					[sa2.userId, A.bureau.id],
				),
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	describe("support session hardening", () => {
		const endAll = () =>
			owner.query(
				"update support_sessions set ended_at = now() where superadmin_id = $1 and ended_at is null",
				[sa.userId],
			);
		const insertSql =
			"insert into support_sessions (superadmin_id, bureau_id, reason) values ($1, $2, 'chamado') returning id";

		it("superadmin cannot choose started_at or expires_at", async () => {
			for (const col of ["started_at", "expires_at"]) {
				await expect(
					withDbContext(app, superCtx(null, null), (c) =>
						c.query(
							`insert into support_sessions (superadmin_id, bureau_id, reason, ${col}) values ($1, $2, 'x', now())`,
							[sa.userId, A.bureau.id],
						),
					),
				).rejects.toMatchObject({ code: "42501" });
			}
		});

		it("inserted session expires one hour after it starts", async () => {
			await endAll();
			const { rows } = await withDbContext(app, superCtx(null, null), (c) =>
				c.query<{ ok: boolean }>(
					"insert into support_sessions (superadmin_id, bureau_id, reason) values ($1, $2, 'chamado') returning expires_at = started_at + interval '1 hour' as ok",
					[sa.userId, A.bureau.id],
				),
			);
			expect(rows[0].ok).toBe(true);
		});

		it("superadmin cannot hold two open sessions", async () => {
			await endAll();
			await expect(
				withDbContext(app, superCtx(null, null), async (c) => {
					await c.query(insertSql, [sa.userId, A.bureau.id]);
					await c.query(insertSql, [sa.userId, A.bureau.id]);
				}),
			).rejects.toMatchObject({ code: "23505" });
		});

		it("ending a session works once and hides tenant rows", async () => {
			await endAll();
			const id = await seedSupportSession(owner, {
				superadminId: sa.userId,
				bureauId: A.bureau.id,
			});
			await withDbContext(app, superCtx(A.bureau.id, id), async (c) => {
				const before = await c.query("select id from holders");
				expect(before.rowCount).toBeGreaterThan(0);
				await c.query("update support_sessions set ended_at = now() where id = $1", [id]);
				const after = await c.query("select id from holders");
				expect(after.rowCount).toBe(0);
			});
		});

		it("ended_at cannot be reopened or changed after it is set", async () => {
			const now = Date.now();
			const id = await seedSupportSession(owner, {
				superadminId: sa.userId,
				bureauId: A.bureau.id,
				startedAt: new Date(now - 10 * MINUTE_MS),
				expiresAt: new Date(now + 50 * MINUTE_MS),
				endedAt: new Date(now - 5 * MINUTE_MS),
			});
			for (const sql of [
				"update support_sessions set ended_at = null where id = $1",
				"update support_sessions set ended_at = now() where id = $1",
			]) {
				await expect(
					withDbContext(app, superCtx(null, null), (c) => c.query(sql, [id])),
				).rejects.toMatchObject({ code: "23514" });
			}
		});

		it("ended_at cannot precede started_at and other columns are immutable", async () => {
			await endAll();
			const id = await seedSupportSession(owner, {
				superadminId: sa.userId,
				bureauId: A.bureau.id,
			});
			await expect(
				withDbContext(app, superCtx(null, null), (c) =>
					c.query(
						"update support_sessions set ended_at = started_at - interval '1 minute' where id = $1",
						[id],
					),
				),
			).rejects.toMatchObject({ code: "23514" });
			await expect(
				withDbContext(app, superCtx(null, null), (c) =>
					c.query(
						"update support_sessions set expires_at = expires_at + interval '1 minute' where id = $1",
						[id],
					),
				),
			).rejects.toMatchObject({ code: "42501" });
			// owner bypasses column grants: the trigger still blocks it
			await expect(
				owner.query("update support_sessions set reason = 'outro' where id = $1", [id]),
			).rejects.toMatchObject({ code: "23514" });
		});

		it("session with future started_at grants no access", async () => {
			const now = Date.now();
			const id = await seedSupportSession(owner, {
				superadminId: sa2.userId,
				bureauId: A.bureau.id,
				startedAt: new Date(now + 10 * MINUTE_MS),
				expiresAt: new Date(now + 40 * MINUTE_MS),
			});
			await withDbContext(
				app,
				{ ...superCtx(A.bureau.id, id), userId: sa2.userId },
				async (c) => {
					const { rows } = await c.query("select id from holders");
					expect(rows).toEqual([]);
				},
			);
		});
	});

	it("operator cannot read or create support sessions", async () => {
		const other = await seedSupportSession(owner, {
			superadminId: sa.userId,
			bureauId: A.bureau.id,
		});
		const seen = await withDbContext(app, ctxOf(A.operator), (c) =>
			c.query("select id from support_sessions where id = $1", [other]),
		);
		expect(seen.rows).toEqual([]);
		await expect(
			withDbContext(app, ctxOf(A.operator), (c) =>
				c.query(
					"insert into support_sessions (superadmin_id, bureau_id, reason) values ($1, $2, 'x')",
					[A.operator.userId, A.bureau.id],
				),
			),
		).rejects.toMatchObject({ code: "42501" });
	});
});

describe("holder uniqueness", () => {
	it("same CPF is allowed in two bureaus", async () => {
		await expect(
			withDbContext(app, ctxOf(B.operator), (c) =>
				c.query(
					"insert into holders (bureau_id, type, name, document, created_by) values ($1, 'PF', 'Mesmo CPF', $2, $3)",
					[B.bureau.id, A.holder.document, B.operator.userId],
				),
			),
		).resolves.toMatchObject({ rowCount: 1 });
	});

	it("same CPF, with or without mask, is rejected in one bureau", async () => {
		const bare = A.holder.document.replace(/\D/g, "");
		for (const document of [bare, A.holder.document]) {
			await expect(
				withDbContext(app, ctxOf(A.operator), (c) =>
					c.query(
						"insert into holders (bureau_id, type, name, document, created_by) values ($1, 'PF', 'Duplicado', $2, $3)",
						[A.bureau.id, document, A.operator.userId],
					),
				),
			).rejects.toMatchObject({
				code: "23505",
				constraint: "holders_document_unique",
			});
		}
	});

	it("rejects a document with the wrong length for its type", async () => {
		await expectCode(
			owner,
			"insert into holders (bureau_id, type, name, document, created_by) values ($1, 'PJ', 'x', $2, $3)",
			[A.bureau.id, randomCpf(), A.bureauAdmin.userId],
			"23514",
		);
	});
});

describe("public SCR gateway", () => {
	async function seedScr(t: SeededTenant, code: string) {
		const token = randomUUID();
		await owner.query(
			`insert into scr_authorizations (bureau_id, document, type, holder_id, channel, auth_code, public_token)
       values ($1, $2, 'PF', $3, 'internal', $4, $5)`,
			[t.bureau.id, t.holder.document, t.holder.id, code, token],
		);
		return token;
	}
	const confirm = async (token: string, code: string, decision: string) =>
		(
			await app.query<{ r: string }>(
				"select public.confirm_public_scr_authorization($1, 'internal', $2, $3, '127.0.0.1') as r",
				[token, code, decision],
			)
		).rows[0].r;
	const timelineOf = async (t: SeededTenant) =>
		(
			await owner.query(
				"select bureau_id, entity_type::text, event_type from timeline_events where entity_id = $1 and event_type like 'scr.self_%'",
				[t.holder.id],
			)
		).rows;

	it("gateway writes the authorization bureau_id", async () => {
		const tokenA = await seedScr(A, "SECRET1");
		const tokenB = await seedScr(B, "SECRET2");

		await expect(confirm(tokenA, "WRONG", "authorize")).resolves.toBe(
			"invalid_code",
		);
		await expect(timelineOf(A)).resolves.toEqual([]);
		await expect(confirm(tokenA, "SECRET1", "authorize")).resolves.toBe(
			"authorized",
		);
		await expect(confirm(tokenA, "SECRET1", "authorize")).resolves.toBe(
			"already",
		);
		await expect(confirm(tokenB, "", "refuse")).resolves.toBe("refused");

		await expect(timelineOf(A)).resolves.toEqual([
			{
				bureau_id: A.bureau.id,
				entity_type: "holder",
				event_type: "scr.self_authorized",
			},
		]);
		await expect(timelineOf(B)).resolves.toEqual([
			{
				bureau_id: B.bureau.id,
				entity_type: "holder",
				event_type: "scr.self_refused",
			},
		]);
	});

	it("keeps the gateway role bound by RLS and column grants", async () => {
		const token = await seedScr(A, "SECRET3");
		await expect(
			app.query("select * from public.public_scr_authorization($1, 'deps')", [
				token,
			]),
		).resolves.toMatchObject({ rows: [] });
		await expect(
			app.query(
				"select status from public.public_scr_authorization($1, 'internal')",
				[token],
			),
		).resolves.toMatchObject({ rows: [{ status: "pending" }] });
		await expect(
			app.query<{ rolbypassrls: boolean }>(
				"select rolbypassrls from pg_roles where rolname = 'auth_profile_lookup'",
			),
		).resolves.toMatchObject({ rows: [{ rolbypassrls: false }] });
		await expect(
			app.query("select id from scr_authorizations"),
		).resolves.toMatchObject({ rows: [] });
		await expect(
			app.query(
				"update scr_authorizations set status = 'authorized' where public_token = $1",
				[token],
			),
		).resolves.toMatchObject({ rowCount: 0 });
		await expect(
			app.query(
				"insert into timeline_events (bureau_id, entity_type, entity_id, event_type, title) values ($1, 'holder', $2, 'scr.self_authorized', 'forged')",
				[A.bureau.id, A.holder.id],
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	it("returns not_found for a malformed token without raising", async () => {
		const token = await seedScr(A, "SECRET4");
		for (const bad of ["", "not-a-uuid", `${token}x`, `${token.slice(1)}`]) {
			await expect(
				app.query("select * from public.public_scr_authorization($1, 'internal')", [bad]),
			).resolves.toMatchObject({ rows: [] });
			await expect(confirm(bad, "SECRET4", "authorize")).resolves.toBe("not_found");
		}
		await expect(
			app.query("select status from public.public_scr_authorization($1, 'internal')", [
				token.toUpperCase(),
			]),
		).resolves.toMatchObject({ rows: [{ status: "pending" }] });
	});

	it("keeps profiles deny-by-default without a context", async () => {
		const { rows } = await app.query("select id from profiles where id = $1", [
			A.operator.userId,
		]);
		expect(rows).toEqual([]);
	});
});

describe("bureaus, slug checks and metrics", () => {
	it("public_bureau_by_slug returns only name and slug of an active bureau", async () => {
		const { rows } = await app.query(
			"select * from public_bureau_by_slug($1)",
			[A.bureau.slug],
		);
		expect(rows).toEqual([{ name: A.bureau.name, slug: A.bureau.slug }]);
	});

	it("public_bureau_by_slug returns nothing for inactive and unknown slugs", async () => {
		const suffix = randomBytes(4).toString("hex");
		const slug = `off-${suffix}`;
		await owner.query(
			"insert into bureaus (name, slug, status) values ($1, $2, 'inactive')",
			[`Off ${suffix}`, slug],
		);
		await expect(
			app.query("select * from public_bureau_by_slug($1)", [slug]),
		).resolves.toMatchObject({ rows: [] });
		await expect(
			app.query("select * from public_bureau_by_slug($1)", [
				`nao-existe-${suffix}`,
			]),
		).resolves.toMatchObject({ rows: [] });
	});

	it.each(["admin", "AB", "ab", "has space", "x".repeat(41)])(
		"rejects slug %j",
		async (slug) => {
			await expectCode(
				owner,
				"insert into bureaus (name, slug) values ('X', $1)",
				[slug],
				"23514",
			);
		},
	);

	it("rejects a blank bureau name", async () => {
		await expectCode(
			owner,
			"insert into bureaus (name, slug) values ('  ', $1)",
			[`b-${randomBytes(4).toString("hex")}`],
			"23514",
		);
	});

	it("platform_bureau_metrics gives counts to the superadmin", async () => {
		const rows = await withDbContext(
			app,
			{ userId: sa.userId, role: "superadmin", bureauId: null },
			async (c) =>
				(
					await c.query(
						"select * from platform_bureau_metrics() where bureau_id = any($1::uuid[]) order by name",
						[[A.bureau.id, B.bureau.id]],
					)
				).rows,
		);
		const expected = await Promise.all(
			[A, B].map(async (t) => ({
				holders: Number(
					(
						await owner.query(
							"select count(*) n from holders where bureau_id = $1",
							[t.bureau.id],
						)
					).rows[0].n,
				),
				dossiers: Number(
					(
						await owner.query(
							"select count(*) n from dossiers where bureau_id = $1",
							[t.bureau.id],
						)
					).rows[0].n,
				),
			})),
		);
		expect(rows).toHaveLength(2);
		const byId = new Map(rows.map((row) => [row.bureau_id, row]));
		[A, B].forEach((t, i) => {
			expect(byId.get(t.bureau.id)).toMatchObject({
				name: t.bureau.name,
				slug: t.bureau.slug,
				status: "active",
				staff_count: "2",
				holder_count: String(expected[i].holders),
				dossier_count: String(expected[i].dossiers),
			});
		});
		expect(
			Number(byId.get(A.bureau.id).consultation_count),
		).toBeGreaterThanOrEqual(2);
		expect(
			Number(byId.get(A.bureau.id).consultations_30d),
		).toBeGreaterThanOrEqual(2);
	});

	it("platform_bureau_metrics rejects an operator with 42501", async () => {
		await expect(
			withDbContext(app, ctxOf(A.operator), (c) =>
				c.query("select * from platform_bureau_metrics()"),
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	it("bureaus: staff read own bureau only; only superadmin writes", async () => {
		const own = await withDbContext(app, ctxOf(A.operator), (c) =>
			c.query("select id from bureaus where id = any($1::uuid[])", [
				[A.bureau.id, B.bureau.id],
			]),
		);
		expect(own.rows).toEqual([{ id: A.bureau.id }]);

		const all = await withDbContext(
			app,
			{ userId: sa.userId, role: "superadmin", bureauId: null },
			(c) =>
				c.query("select id from bureaus where id = any($1::uuid[])", [
					[A.bureau.id, B.bureau.id],
				]),
		);
		expect(all.rows).toHaveLength(2);

		await expectNoEffect(
			withDbContext(app, ctxOf(A.bureauAdmin), (c) =>
				c.query("update bureaus set name = 'Hack' where id = $1", [
					A.bureau.id,
				]),
			),
		);
		await expect(
			withDbContext(app, ctxOf(A.bureauAdmin), (c) =>
				c.query("insert into bureaus (name, slug) values ('Novo', $1)", [
					`n-${randomBytes(4).toString("hex")}`,
				]),
			),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			withDbContext(
				app,
				{ userId: sa.userId, role: "superadmin", bureauId: null },
				(c) =>
					c.query(
						"update bureaus set name = 'Renomeado', status = 'inactive' where id = $1",
						[A.bureau.id],
					),
			),
		).resolves.toMatchObject({ rowCount: 1 });
		await expect(
			withDbContext(
				app,
				{ userId: sa.userId, role: "superadmin", bureauId: null },
				(c) =>
					c.query("update bureaus set slug = 'outro-slug' where id = $1", [
						A.bureau.id,
					]),
			),
		).rejects.toMatchObject({ code: "42501" });
	});
});

// Segundo bureau_admin do mesmo Bureau (par do admin semeado).
async function seedPeerAdmin(bureauId: string): Promise<string> {
	const id = randomUUID();
	await owner.query(
		'insert into "user" (id, name, email) values ($1, $2, $3)',
		[id, "par", `${id}@example.test`],
	);
	await owner.query(
		"insert into profiles (id, auth_user_id, full_name, email, role, bureau_id) values ($1::uuid, $1::text, 'par', $2, 'bureau_admin', $3)",
		[id, `${id}@example.test`, bureauId],
	);
	return id;
}

describe("profiles", () => {
	const profileInsert = (
		c: import("pg").PoolClient,
		role: string,
		bureauId: string | null,
	) => {
		const id = randomUUID();
		return c
			.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
				id,
				"novo",
				`${id}@example.test`,
			])
			.then(() =>
				c.query(
					"insert into profiles (id, auth_user_id, full_name, email, role, bureau_id) values ($1::uuid, $1::text, 'novo', $2, $3::user_role, $4)",
					[id, `${id}@example.test`, role, bureauId],
				),
			);
	};

	it("rejects a superadmin with bureau_id and a non-superadmin without it", async () => {
		const id = randomUUID();
		await owner.query(
			'insert into "user" (id, name, email) values ($1, $2, $3)',
			[id, "x", `${id}@example.test`],
		);
		await expectCode(
			owner,
			"insert into profiles (id, auth_user_id, full_name, email, role, bureau_id) values ($1::uuid, $1::text, 'x', 'x@example.test', 'superadmin', $2)",
			[id, A.bureau.id],
			"23514",
		);
		await expectCode(
			owner,
			"insert into profiles (id, auth_user_id, full_name, email, role) values ($1::uuid, $1::text, 'x', 'x@example.test', 'operator')",
			[id],
			"23514",
		);
	});

	it("visibility: self, own bureau staff view, superadmin sees only superadmins outside support", async () => {
		const all = [A, B].flatMap((t) => [
			t.bureauAdmin.userId,
			t.operator.userId,
			t.client.userId,
		]);
		const idsOf = async (actor: Actor) =>
			(
				await withDbContext(app, actor, (c) =>
					c.query<{ id: string }>(
						"select id from profiles where id = any($1::uuid[]) order by id",
						[[...all, sa.userId]],
					),
				)
			).rows
				.map((row) => row.id)
				.sort();
		const sorted = (list: string[]) => [...list].sort();

		expect(await idsOf(ctxOf(A.operator))).toEqual(
			sorted([A.bureauAdmin.userId, A.operator.userId, A.client.userId]),
		);
		expect(await idsOf(ctxOf(A.client))).toEqual([A.client.userId]);
		expect(
			await idsOf({ userId: sa.userId, role: "superadmin", bureauId: null }),
		).toEqual([sa.userId]);

		const session = await seedSupportSession(owner, {
			superadminId: sa.userId,
			bureauId: A.bureau.id,
		});
		expect(
			await idsOf({
				userId: sa.userId,
				role: "superadmin",
				bureauId: A.bureau.id,
				supportSessionId: session,
			}),
		).toEqual(
			sorted([
				A.bureauAdmin.userId,
				A.operator.userId,
				A.client.userId,
				sa.userId,
			]),
		);
	});

	it("insert: bureau_admin only inside own bureau; operator never; superadmin only bureau_admin", async () => {
		await expect(
			withDbContext(app, ctxOf(A.bureauAdmin), (c) =>
				profileInsert(c, "operator", A.bureau.id),
			),
		).resolves.toMatchObject({ rowCount: 1 });
		await expect(
			withDbContext(app, ctxOf(A.bureauAdmin), (c) =>
				profileInsert(c, "operator", B.bureau.id),
			),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			withDbContext(app, ctxOf(A.bureauAdmin), (c) =>
				profileInsert(c, "superadmin", null),
			),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			withDbContext(app, ctxOf(A.operator), (c) =>
				profileInsert(c, "operator", A.bureau.id),
			),
		).rejects.toMatchObject({ code: "42501" });
		const superCtx = { userId: sa.userId, role: "superadmin", bureauId: null };
		await expect(
			withDbContext(app, superCtx, (c) =>
				profileInsert(c, "bureau_admin", B.bureau.id),
			),
		).resolves.toMatchObject({ rowCount: 1 });
		await expect(
			withDbContext(app, superCtx, (c) =>
				profileInsert(c, "operator", B.bureau.id),
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	it("operator cannot change its own role", async () => {
		await expect(
			withDbContext(app, ctxOf(A.operator), (c) =>
				c.query("update profiles set role = 'bureau_admin' where id = $1", [
					A.operator.userId,
				]),
			),
		).rejects.toThrow(/only administrators may change profile security fields/);
	});

	const ROLE_RULE = /role may only change from operator to bureau_admin/;
	const setRole = (actor: Actor, targetId: string, role: string) =>
		withDbContext(app, actor, (c) =>
			c.query("update profiles set role = $2::user_role where id = $1", [
				targetId,
				role,
			]),
		);

	it("bureau_admin promotes an operator of the own bureau", async () => {
		const T = await seedTenant(owner, "tenant promote");
		await expect(
			setRole(ctxOf(T.bureauAdmin), T.operator.userId, "bureau_admin"),
		).resolves.toMatchObject({ rowCount: 1 });
	});

	it("bureau_admin cannot demote a peer admin or itself", async () => {
		const T = await seedTenant(owner, "tenant demote");
		const peerId = await seedPeerAdmin(T.bureau.id);
		await expect(
			setRole(ctxOf(T.bureauAdmin), peerId, "operator"),
		).rejects.toThrow(ROLE_RULE);
		await expect(
			setRole(ctxOf(T.bureauAdmin), T.bureauAdmin.userId, "operator"),
		).rejects.toThrow(ROLE_RULE);
	});

	it("bureau_admin cannot move a client or an operator to another role", async () => {
		const T = await seedTenant(owner, "tenant role other");
		for (const [target, role] of [
			[T.client.userId, "operator"],
			[T.client.userId, "bureau_admin"],
			[T.operator.userId, "client"],
			[T.operator.userId, "superadmin"],
		] as const) {
			await expect(
				setRole(ctxOf(T.bureauAdmin), target, role),
			).rejects.toThrow(ROLE_RULE);
		}
	});

	it("operator and client cannot change any role", async () => {
		const T = await seedTenant(owner, "tenant role self");
		for (const actor of [T.operator, T.client]) {
			await expect(
				setRole(ctxOf(actor), actor.userId, "bureau_admin"),
			).rejects.toThrow(/only administrators may change profile security fields/);
		}
		await expect(
			setRole(ctxOf(T.operator), T.bureauAdmin.userId, "operator"),
		).resolves.toMatchObject({ rowCount: 0 });
	});

	it("bureau_id is immutable and a bureau_admin cannot reach another bureau", async () => {
		await expect(
			withDbContext(app, ctxOf(A.bureauAdmin), (c) =>
				c.query("update profiles set bureau_id = $1 where id = $2", [
					B.bureau.id,
					A.operator.userId,
				]),
			),
		).rejects.toThrow();
		await expectNoEffect(
			withDbContext(app, ctxOf(A.bureauAdmin), (c) =>
				c.query("update profiles set is_active = false where id = $1", [
					B.operator.userId,
				]),
			),
		);
		await expectNoEffect(
			setRole(ctxOf(A.bureauAdmin), B.operator.userId, "bureau_admin"),
		);
	});
});

describe("settings", () => {
	const key = `test.${randomUUID()}`;

	beforeAll(async () => {
		await owner.query(
			"insert into settings (key, value) values ($1, '{}'::jsonb)",
			[key],
		);
	});

	it("superadmin, bureau_admin and operator read; client reads none", async () => {
		for (const actor of [A.operator, A.bureauAdmin]) {
			const { rows } = await withDbContext(app, ctxOf(actor), (c) =>
				c.query("select key from settings where key = $1", [key]),
			);
			expect(rows).toHaveLength(1);
		}
		const { rows } = await withDbContext(
			app,
			{ userId: sa.userId, role: "superadmin", bureauId: null },
			(c) => c.query("select key from settings where key = $1", [key]),
		);
		expect(rows).toHaveLength(1);
		const client = await withDbContext(app, ctxOf(A.client), (c) =>
			c.query("select key from settings"),
		);
		expect(client.rows).toHaveLength(0);
	});

	it("operator and bureau_admin cannot write; superadmin can", async () => {
		for (const actor of [A.operator, A.bureauAdmin]) {
			await expect(
				withDbContext(app, ctxOf(actor), (c) =>
					c.query(
						"insert into settings (key, value) values ($1, '{}'::jsonb)",
						[`${key}.new`],
					),
				),
			).rejects.toMatchObject({ code: "42501" });
			await expectNoEffect(
				withDbContext(app, ctxOf(actor), (c) =>
					c.query(
						"update settings set value = '{\"x\":1}'::jsonb where key = $1",
						[key],
					),
				),
			);
			await expectNoEffect(
				withDbContext(app, ctxOf(actor), (c) =>
					c.query("delete from settings where key = $1", [key]),
				),
			);
		}
		const superCtx = { userId: sa.userId, role: "superadmin", bureauId: null };
		await expect(
			withDbContext(app, superCtx, (c) =>
				c.query(
					"update settings set value = '{\"x\":1}'::jsonb where key = $1",
					[key],
				),
			),
		).resolves.toMatchObject({ rowCount: 1 });
	});
});

describe("audit_logs", () => {
	const insertAudit = (
		c: import("pg").PoolClient,
		userId: string,
		bureauId: string | null,
		supportSessionId: string | null,
	) =>
		c.query(
			"insert into audit_logs (user_id, action, bureau_id, support_session_id) values ($1, 'test.audit', $2, $3)",
			[userId, bureauId, supportSessionId],
		);

	it("insert requires the bureau_id of the context", async () => {
		await expect(
			withDbContext(app, ctxOf(A.operator), (c) =>
				insertAudit(c, A.operator.userId, A.bureau.id, null),
			),
		).resolves.toMatchObject({ rowCount: 1 });
		await expect(
			withDbContext(app, ctxOf(A.operator), (c) =>
				insertAudit(c, A.operator.userId, B.bureau.id, null),
			),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			withDbContext(app, ctxOf(A.operator), (c) =>
				insertAudit(c, A.operator.userId, null, null),
			),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			withDbContext(app, ctxOf(A.operator), (c) =>
				insertAudit(c, B.operator.userId, A.bureau.id, null),
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	it("support insert requires the support_session_id of the context", async () => {
		const session = await seedSupportSession(owner, {
			superadminId: sa.userId,
			bureauId: A.bureau.id,
		});
		const inSupport: Actor = {
			userId: sa.userId,
			role: "superadmin",
			bureauId: A.bureau.id,
			supportSessionId: session,
		};
		await expect(
			withDbContext(app, inSupport, (c) =>
				insertAudit(c, sa.userId, A.bureau.id, session),
			),
		).resolves.toMatchObject({ rowCount: 1 });
		await expect(
			withDbContext(app, inSupport, (c) =>
				insertAudit(c, sa.userId, A.bureau.id, null),
			),
		).rejects.toMatchObject({ code: "42501" });
		await expect(
			withDbContext(app, inSupport, (c) =>
				insertAudit(c, sa.userId, A.bureau.id, randomUUID()),
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	it("platform insert: superadmin without support writes only with null bureau_id", async () => {
		const noSupport: Actor = {
			userId: sa.userId,
			role: "superadmin",
			bureauId: null,
		};
		await expect(
			withDbContext(app, noSupport, (c) =>
				insertAudit(c, sa.userId, null, null),
			),
		).resolves.toMatchObject({ rowCount: 1 });
		await expect(
			withDbContext(app, { ...noSupport, bureauId: A.bureau.id }, (c) =>
				insertAudit(c, sa.userId, A.bureau.id, null),
			),
		).rejects.toMatchObject({ code: "42501" });
	});

	it("select: bureau_admin sees own bureau; operator sees none; superadmin sees only platform and support rows", async () => {
		const count = async (actor: Actor, bureauId: string) =>
			Number(
				(
					await withDbContext(app, actor, (c) =>
						c.query<{ n: string }>(
							"select count(*) as n from audit_logs where bureau_id = $1",
							[bureauId],
						),
					)
				).rows[0].n,
			);
		expect(await count(ctxOf(A.bureauAdmin), A.bureau.id)).toBeGreaterThan(0);
		expect(await count(ctxOf(A.bureauAdmin), B.bureau.id)).toBe(0);
		expect(await count(ctxOf(A.operator), A.bureau.id)).toBe(0);
		expect(
			await count(
				{ userId: sa.userId, role: "superadmin", bureauId: null },
				A.bureau.id,
			),
		).toBeGreaterThanOrEqual(0);
		const supportRows = await withDbContext(
			app,
			{ userId: sa.userId, role: "superadmin", bureauId: null },
			(c) =>
				c.query<{ n: string }>(
					"select count(*) as n from audit_logs where bureau_id is not null and support_session_id is null and action not in ('catalog.cost.set', 'wallet.adjust', 'payout.create', 'payout.pay', 'payout.cancel', 'nfse.retry')",
				),
		);
		expect(Number(supportRows.rows[0].n)).toBe(0);
	});
});

// O dono é superusuário, mas o trigger protect_profile_identity também vale para ele.
// Para semear estado de teste, desliga os triggers só nesta transação.
async function ownerUpdateProfile(
	userId: string,
	set: "must_change_password = true" | "is_active = false",
) {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		await client.query(`update profiles set ${set} where id = $1`, [userId]);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

describe("admin_set_credentials target rules", () => {
	// Hash fixo e falso: o teste nunca usa senha real.
	const FAKE_HASH = "salt:fake-hash-for-tests";
	const OLD_HASH = "salt:old-fake-hash";

	const addAccount = (userId: string, hash: string = OLD_HASH) =>
		owner.query(
			`insert into account (issuer, account_id, provider_id, user_id, password, updated_at)
       values ('local:credential', $1, 'credential', $1, $2, now())`,
			[userId, hash],
		);
	const addSession = (userId: string) =>
		owner.query(
			`insert into "session" (expires_at, token, updated_at, user_id)
       values (now() + interval '1 hour', $2, now(), $1)`,
			[userId, randomBytes(16).toString("hex")],
		);

	type Snapshot = { password: string | null; flag: boolean; sessions: number };
	// Lê pelo dono: o RLS esconde o alvo de quem chama (ex.: superadmin fora de suporte).
	const snapshot = async (userId: string): Promise<Snapshot> => {
		const { rows } = await owner.query<{
			password: string | null;
			flag: boolean;
			sessions: string;
		}>(
			`select (select password from account where user_id = $1 and provider_id = 'credential') as password,
              (select must_change_password from profiles where id = $1::uuid) as flag,
              (select count(*) from "session" where user_id = $1) as sessions`,
			[userId],
		);
		return {
			password: rows[0].password,
			flag: rows[0].flag,
			sessions: Number(rows[0].sessions),
		};
	};
	// Confirma a transação do chamador (como a action faz) e lê o estado do alvo depois.
	const call = async (
		actor: Actor,
		targetId: string,
		bureauId: string,
		hash: string | null,
	) => {
		const client = await app.connect();
		try {
			await client.query("begin");
			await client.query(
				`select set_config('app.user_id', $1, true),
                set_config('app.user_role', $2, true),
                set_config('app.bureau_id', $3, true),
                set_config('app.support_session_id', '', true)`,
				[actor.userId, actor.role, actor.bureauId ?? ""],
			);
			const { rows } = await client.query<{ ok: boolean }>(
				"select admin_set_credentials($1::uuid, $2::uuid, $3) as ok",
				[targetId, bureauId, hash],
			);
			await client.query("commit");
			return { ok: rows[0].ok, after: await snapshot(targetId) };
		} catch (error) {
			await client.query("rollback");
			throw error;
		} finally {
			client.release();
		}
	};
	const asSuper = (): Actor => ({
		userId: sa.userId,
		role: "superadmin",
		bureauId: null,
	});
	const untouched = { password: OLD_HASH, flag: false, sessions: 1 };

	// Bureau novo, com conta e sessão para o admin e o operador.
	const fresh = async (label: string) => {
		const t = await seedTenant(owner, label);
		for (const id of [t.bureauAdmin.userId, t.operator.userId]) {
			await addAccount(id);
			await addSession(id);
		}
		return t;
	};

	it("superadmin sets the hash of a bureau_admin of the given bureau", async () => {
		const T = await fresh("creds sa");
		const result = await call(
			asSuper(),
			T.bureauAdmin.userId,
			T.bureau.id,
			FAKE_HASH,
		);
		expect(result).toEqual({
			ok: true,
			after: { password: FAKE_HASH, flag: true, sessions: 0 },
		});
		expect(await snapshot(T.operator.userId)).toEqual(untouched);
	});

	it("superadmin refuses operator, other superadmin and wrong bureau", async () => {
		const T = await fresh("creds sa refuse");
		const U = await fresh("creds sa other");
		const op = await call(
			asSuper(),
			T.operator.userId,
			T.bureau.id,
			FAKE_HASH,
		);
		expect(op).toEqual({ ok: false, after: untouched });
		const peer = await call(asSuper(), sa2.userId, T.bureau.id, FAKE_HASH);
		expect(peer.ok).toBe(false);
		const wrong = await call(
			asSuper(),
			U.bureauAdmin.userId,
			T.bureau.id,
			FAKE_HASH,
		);
		expect(wrong).toEqual({ ok: false, after: untouched });
	});

	it("superadmin with a bureau in the context is refused", async () => {
		const T = await fresh("creds sa support");
		await expectRejectCode(
			call(
				{ ...asSuper(), bureauId: T.bureau.id },
				T.bureauAdmin.userId,
				T.bureau.id,
				FAKE_HASH,
			),
			"42501",
		);
		expect(await snapshot(T.bureauAdmin.userId)).toEqual(untouched);
	});

	it("bureau_admin sets the hash of an operator of the own bureau", async () => {
		const T = await fresh("creds admin");
		const result = await call(
			ctxOf(T.bureauAdmin),
			T.operator.userId,
			T.bureau.id,
			FAKE_HASH,
		);
		expect(result).toEqual({
			ok: true,
			after: { password: FAKE_HASH, flag: true, sessions: 0 },
		});
		expect(await snapshot(T.bureauAdmin.userId)).toEqual(untouched);
	});

	it("bureau_admin refuses a peer admin, self and a client", async () => {
		const T = await fresh("creds peer");
		const peerAdminId = randomUUID();
		await owner.query(
			'insert into "user" (id, name, email) values ($1, $2, $3)',
			[peerAdminId, "par", `${peerAdminId}@example.test`],
		);
		await owner.query(
			"insert into profiles (id, auth_user_id, full_name, email, role, bureau_id) values ($1::uuid, $1::text, 'par', $2, 'bureau_admin', $3)",
			[peerAdminId, `${peerAdminId}@example.test`, T.bureau.id],
		);
		await addAccount(peerAdminId);
		await addSession(peerAdminId);
		const peer = await call(
			ctxOf(T.bureauAdmin),
			peerAdminId,
			T.bureau.id,
			FAKE_HASH,
		);
		expect(peer).toEqual({ ok: false, after: untouched });
		const self = await call(
			ctxOf(T.bureauAdmin),
			T.bureauAdmin.userId,
			T.bureau.id,
			FAKE_HASH,
		);
		expect(self).toEqual({ ok: false, after: untouched });
		const client = await call(
			ctxOf(T.bureauAdmin),
			T.client.userId,
			T.bureau.id,
			FAKE_HASH,
		);
		expect(client.ok).toBe(false);
	});

	it("bureau_admin cannot target another bureau, and its operators stay intact", async () => {
		const T = await fresh("creds own");
		const U = await fresh("creds foreign");
		await expectRejectCode(
			call(ctxOf(T.bureauAdmin), U.operator.userId, U.bureau.id, FAKE_HASH),
			"42501",
		);
		const crossed = await call(
			ctxOf(T.bureauAdmin),
			U.operator.userId,
			T.bureau.id,
			FAKE_HASH,
		);
		expect(crossed).toEqual({ ok: false, after: untouched });
	});

	it("operator, client and inactive bureau_admin are refused with 42501", async () => {
		const T = await fresh("creds roles");
		for (const actor of [T.operator, T.client]) {
			await expectRejectCode(
				call(ctxOf(actor), T.operator.userId, T.bureau.id, FAKE_HASH),
				"42501",
			);
		}
		const inactive = await fresh("creds inactive");
		await ownerUpdateProfile(inactive.bureauAdmin.userId, "is_active = false");
		await expectRejectCode(
			call(
				ctxOf(inactive.bureauAdmin),
				inactive.operator.userId,
				inactive.bureau.id,
				FAKE_HASH,
			),
			"42501",
		);
		expect(await snapshot(inactive.operator.userId)).toEqual(untouched);
	});

	it("null hash on a target with an account keeps the password and sets the flag", async () => {
		const T = await fresh("creds null hash");
		const result = await call(
			ctxOf(T.bureauAdmin),
			T.operator.userId,
			T.bureau.id,
			null,
		);
		expect(result).toEqual({
			ok: true,
			after: { password: OLD_HASH, flag: true, sessions: 0 },
		});
	});

	it("null hash on a pending invite returns false and leaves the flag", async () => {
		const pending = await seedTenant(owner, "creds pending");
		const result = await call(
			ctxOf(pending.bureauAdmin),
			pending.operator.userId,
			pending.bureau.id,
			null,
		);
		expect(result.ok).toBe(false);
		expect(result.after.flag).toBe(false);
	});

	it("hash on a pending invite creates the credential account", async () => {
		const pending = await seedTenant(owner, "creds pending hash");
		const id = pending.operator.userId;
		const result = await call(
			ctxOf(pending.bureauAdmin),
			id,
			pending.bureau.id,
			FAKE_HASH,
		);
		expect(result.ok).toBe(true);
		const { rows } = await owner.query(
			"select provider_id, account_id, user_id, password from account where user_id = $1",
			[id],
		);
		expect(rows).toEqual([
			{
				provider_id: "credential",
				account_id: id,
				user_id: id,
				password: FAKE_HASH,
			},
		]);
	});

	it("demote -> set credentials -> promote fails at the demotion", async () => {
		const T = await fresh("creds takeover");
		const peerId = await seedPeerAdmin(T.bureau.id);
		await addAccount(peerId);
		await addSession(peerId);
		await expect(
			withDbContext(app, ctxOf(T.bureauAdmin), (c) =>
				c.query("update profiles set role = 'operator' where id = $1", [peerId]),
			),
		).rejects.toThrow(/role may only change from operator to bureau_admin/);
		const result = await call(
			ctxOf(T.bureauAdmin),
			peerId,
			T.bureau.id,
			FAKE_HASH,
		);
		expect(result).toEqual({ ok: false, after: untouched });
	});

	describe("pending password reset tokens", () => {
		const addReset = (identifier: string, userId: string) =>
			owner.query(
				`insert into verification (identifier, value, expires_at)
         values ($1, $2, now() + interval '15 minutes')`,
				[identifier, userId],
			);
		const identifiersOf = async (userId: string) =>
			(
				await owner.query<{ identifier: string }>(
					"select identifier from verification where value = $1 order by identifier",
					[userId],
				)
			).rows.map((row) => row.identifier);

		it("deletes only the target's reset tokens when the call succeeds", async () => {
			const T = await fresh("creds reset");
			const token = `reset-password:${randomBytes(8).toString("hex")}`;
			const other = `reset-password:${randomBytes(8).toString("hex")}`;
			const unrelated = `email-verification:${randomBytes(8).toString("hex")}`;
			await addReset(token, T.operator.userId);
			await addReset(unrelated, T.operator.userId);
			await addReset(other, T.client.userId);
			const result = await call(
				ctxOf(T.bureauAdmin),
				T.operator.userId,
				T.bureau.id,
				FAKE_HASH,
			);
			expect(result.ok).toBe(true);
			expect(await identifiersOf(T.operator.userId)).toEqual([unrelated]);
			expect(await identifiersOf(T.client.userId)).toEqual([other]);
		});

		it("deletes the token when only the flag is set (null hash)", async () => {
			const T = await fresh("creds reset null");
			await addReset(
				`reset-password:${randomBytes(8).toString("hex")}`,
				T.operator.userId,
			);
			const result = await call(
				ctxOf(T.bureauAdmin),
				T.operator.userId,
				T.bureau.id,
				null,
			);
			expect(result.ok).toBe(true);
			expect(await identifiersOf(T.operator.userId)).toEqual([]);
		});

		it("keeps the tokens when the call returns false", async () => {
			const T = await fresh("creds reset refused");
			const peerId = await seedPeerAdmin(T.bureau.id);
			await addAccount(peerId);
			const token = `reset-password:${randomBytes(8).toString("hex")}`;
			await addReset(token, peerId);
			const result = await call(
				ctxOf(T.bureauAdmin),
				peerId,
				T.bureau.id,
				FAKE_HASH,
			);
			expect(result.ok).toBe(false);
			expect(await identifiersOf(peerId)).toEqual([token]);
		});
	});
});

describe("trigger blocks flag writes", () => {
	const setFlag = (actor: Actor, targetId: string, value: boolean) =>
		withDbContext(app, actor, (c) =>
			c.query("update profiles set must_change_password = $2 where id = $1", [
				targetId,
				value,
			]),
		);
	const FLAG_ERROR = /must_change_password changes only through/;

	it("bureau_admin cannot turn the flag on or off for an operator", async () => {
		const T = await seedTenant(owner, "tenant flag");
		await expect(
			setFlag(ctxOf(T.bureauAdmin), T.operator.userId, true),
		).rejects.toThrow(FLAG_ERROR);
		await ownerUpdateProfile(T.operator.userId, "must_change_password = true");
		await expect(
			setFlag(ctxOf(T.bureauAdmin), T.operator.userId, false),
		).rejects.toThrow(FLAG_ERROR);
	});

	it("a user cannot turn the own flag on, but can turn it off", async () => {
		const T = await seedTenant(owner, "tenant flag self");
		await expect(
			setFlag(ctxOf(T.operator), T.operator.userId, true),
		).rejects.toThrow(FLAG_ERROR);
		await ownerUpdateProfile(T.operator.userId, "must_change_password = true");
		await expect(
			setFlag(ctxOf(T.operator), T.operator.userId, false),
		).resolves.toBeDefined();
	});
});

describe("auth_profile_for_session returns the flag", () => {
	it("is true after admin_set_credentials", async () => {
		const T = await seedTenant(owner, "tenant lookup");
		await owner.query(
			`insert into account (issuer, account_id, provider_id, user_id, password, updated_at)
			 values ('local:credential', $1, 'credential', $1, 'salt:fake', now())`,
			[T.operator.userId],
		);
		const read = () =>
			app.query<{ must_change_password: boolean }>(
				"select must_change_password from auth_profile_for_session($1)",
				[T.operator.userId],
			);
		expect((await read()).rows[0].must_change_password).toBe(false);
		await ownerUpdateProfile(T.operator.userId, "must_change_password = true");
		expect((await read()).rows[0].must_change_password).toBe(true);
	});
});

describe("change-password is a reserved slug", () => {
	it("rejects the slug", async () => {
		await expectCode(
			owner,
			"insert into bureaus (name, slug) values ('X', 'change-password')",
			[],
			"23514",
		);
	});
});

async function expectRejectCode(promise: Promise<unknown>, code: string) {
	await expect(promise).rejects.toMatchObject({ code });
}

describe("client accounts (021)", () => {
	const PUBLIC_FUNCTIONS = [
		"register_client(text, text, text, text, text, text, text, integer, integer, inet, text, text, text)",
		"confirm_email_verification(text)",
		"request_email_verification(uuid, text, text)",
		"request_phone_verification(uuid, text, text)",
		"confirm_phone_verification(uuid, text)",
		"accept_legal_documents(uuid, integer, integer, inet, text)",
		"set_notification_channel(uuid, text)",
	];
	const INTERNAL_FUNCTIONS = [
		"enqueue_system_notification(uuid, uuid, text, text, text, jsonb, text, text)",
		"account_issue_email_challenge(uuid, text, text)",
		"legal_current_version(text)",
		"account_secret_hash(text)",
		"account_mask_recipient(text, text)",
	];
	const NEW_TABLES = ["legal_documents", "legal_acceptances", "verification_challenges", "client_register_attempts"];
	const CONTACT_UPDATES = [
		"phone_e164 = '+5563999999999'",
		"phone_verified_at = now()",
		"notification_channel = 'whatsapp'",
	];

	let T: SeededTenant;
	let acceptanceId: string;

	beforeAll(async () => {
		T = await seedTenant(owner, "tenant accounts");
		const { rows } = await owner.query<{ id: string }>(
			`insert into legal_acceptances (profile_id, document_id)
       select $1, d.id from legal_documents d where d.kind = 'terms' and d.version = 1 returning id`,
			[T.client.userId],
		);
		acceptanceId = rows[0].id;
	});

	it("app_runtime cannot write phone_e164, phone_verified_at or notification_channel", async () => {
		for (const actor of [T.client, T.bureauAdmin]) {
			for (const assignment of CONTACT_UPDATES) {
				await withDbContext(app, ctxOf(actor), (client) =>
					expectNoEffect(client.query(`update profiles set ${assignment} where id = $1`, [T.client.userId])),
				);
			}
			const inserted = randomUUID();
			await owner.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
				inserted, "Contato", `${inserted}@example.test`,
			]);
			await withDbContext(app, ctxOf(actor), async (client) => {
				await expect(
					client.query(
						`insert into profiles (id, auth_user_id, full_name, email, role, bureau_id, phone_e164)
             values ($1::uuid, $1::text, 'Contato', $2, 'client', $3, '+5563999999999')`,
						[inserted, `${inserted}@example.test`, T.bureau.id],
					),
				).rejects.toMatchObject({ code: "42501" });
			});
		}
		const { rows } = await owner.query(
			"select phone_e164, phone_verified_at, notification_channel from profiles where id = $1",
			[T.client.userId],
		);
		expect(rows).toEqual([{ phone_e164: null, phone_verified_at: null, notification_channel: "email" }]);
	});

	it("app_runtime cannot read verification_challenges or client_register_attempts", async () => {
		await expectCode(app, "select 1 from verification_challenges", [], "42501");
		await expectCode(app, "select 1 from client_register_attempts", [], "42501");
	});

	it("app_runtime cannot insert, update or delete the new tables", async () => {
		const writes: Record<string, string[]> = {
			legal_documents: [
				"insert into legal_documents (kind, version, title, body_md) values ('terms', 99, 'x', 'x')",
				"update legal_documents set title = 'x'",
				"delete from legal_documents",
			],
			legal_acceptances: [
				`insert into legal_acceptances (profile_id, document_id) values ('${T.client.userId}', gen_random_uuid())`,
				"update legal_acceptances set ip = null",
				"delete from legal_acceptances",
			],
			verification_challenges: [
				`insert into verification_challenges (profile_id, kind, target, code_hash, expires_at)
         values ('${T.client.userId}', 'email', 'a@b.c', '${sha()}', now())`,
				"update verification_challenges set attempts = 0",
				"delete from verification_challenges",
			],
			client_register_attempts: [
				"insert into client_register_attempts (ip) values ('10.0.0.1')",
				"update client_register_attempts set ip = null",
				"delete from client_register_attempts",
			],
		};
		for (const table of NEW_TABLES) {
			for (const sql of writes[table]) await expectCode(app, sql, [], "42501");
		}
	});

	it("legal_documents are readable without context", async () => {
		const { rows } = await app.query<{ kind: string; version: number }>(
			"select kind, version from legal_documents where version = 1 order by kind",
		);
		expect(rows).toEqual([
			{ kind: "buyer_declaration", version: 1 },
			{ kind: "privacy", version: 1 },
			{ kind: "terms", version: 1 },
		]);
	});

	it("client reads only own legal_acceptances", async () => {
		const other = await seedClientProfile(owner, T.bureau.id);
		await owner.query(
			"insert into legal_acceptances (profile_id, document_id) select $1, d.id from legal_documents d where d.kind = 'privacy' and d.version = 1",
			[other.userId],
		);
		const own = await withDbContext(app, ctxOf(T.client), (client) =>
			client.query<{ profile_id: string }>("select profile_id from legal_acceptances"),
		);
		expect(own.rows.length).toBeGreaterThan(0);
		expect(new Set(own.rows.map((row) => row.profile_id))).toEqual(new Set([T.client.userId]));
	});

	it("staff reads zero legal_acceptances", async () => {
		for (const actor of [T.bureauAdmin, T.operator]) {
			const { rows } = await withDbContext(app, ctxOf(actor), (client) =>
				client.query<{ n: string }>("select count(*) as n from legal_acceptances"),
			);
			expect(Number(rows[0].n)).toBe(0);
		}
		expect(await app.query("select 1 from legal_acceptances")).toMatchObject({ rowCount: 0 });
	});

	it("enqueue_system_notification and helpers are not executable by app_runtime", async () => {
		const privilege = async (signature: string) =>
			(
				await owner.query<{ allowed: boolean }>(
					"select has_function_privilege('app_runtime', $1::regprocedure, 'execute') as allowed",
					[signature],
				)
			).rows[0].allowed;
		for (const signature of INTERNAL_FUNCTIONS) expect(await privilege(signature)).toBe(false);
		for (const signature of PUBLIC_FUNCTIONS) expect(await privilege(signature)).toBe(true);
		await expectCode(app, "select account_secret_hash('x')", [], "42501");
		await expectCode(app, "select legal_current_version('terms')", [], "42501");
	});

	it("legal_documents and legal_acceptances reject update and delete", async () => {
		const guarded = [
			"update legal_documents set title = 'x' where kind = 'terms' and version = 1",
			"delete from legal_documents where kind = 'terms' and version = 1",
		];
		for (const sql of guarded) await expectCode(owner, sql, [], "23514");
		await expectCode(owner, "update legal_acceptances set ip = null where id = $1", [acceptanceId], "23514");
		await expectCode(owner, "delete from legal_acceptances where id = $1", [acceptanceId], "23514");
	});

	it("rejects the slugs cadastro, termos and privacidade", async () => {
		for (const slug of ["cadastro", "termos", "privacidade"]) {
			await expectCode(owner, "insert into bureaus (name, slug) values ('X', $1)", [slug], "23514");
		}
	});
});

describe("orders and delivery (022)", () => {
	const PUBLIC_FUNCTIONS = [
		"open_order(text, boolean, text, text, text, jsonb, text, text, uuid)",
		"refresh_order_state(uuid)",
		"due_order_bureaus()",
		"reserve_order(uuid, text, uuid, numeric, numeric, jsonb)",
		"confirm_public_scr_authorization(text, text, text, text, text)",
		"cancel_client_order(uuid)",
		"client_order_members(uuid)",
		"record_order_declaration(uuid, integer, inet, text)",
	];
	const INTERNAL_FUNCTIONS = ["create_bureau_system_profile()", "order_mask_document(text)"];

	let T: SeededTenant;
	let rows: Rows;
	let otherClient: { userId: string; role: "client"; bureauId: string };
	let thirdPartyHolder: string;
	let ownOrder: string;
	let otherOrder: string;
	let foreign: SeededTenant;

	const insertOrder = (dossier: string, clientId: string | null, state = "completed") =>
		owner.query(
			`insert into dossier_orders (dossier_id, bureau_id, mode, client_profile_id, product_code, subject_name,
         subject_document_masked, state, released_at, created_by)
       values ($1, $2, $3, $4, 'dossie_pf', 'Titular', '***.000.000-**', $5, case when $5 = 'released' then now() end, $6)`,
			[dossier, T.bureau.id, clientId ? "online" : "counter", clientId, state, T.bureauAdmin.userId],
		);
	const setState = (dossier: string, state: string) =>
		owner.query(
			"update dossier_orders set state = $2::text, released_at = case when $2::text = 'released' then now() end where dossier_id = $1",
			[dossier, state],
		);
	const countAs = async (actor: Actor, sql: string, params: unknown[] = []) =>
		withDbContext(app, actor, async (client) => Number((await client.query<{ n: string }>(sql, params)).rows[0].n));

	beforeAll(async () => {
		[T, foreign] = await Promise.all([seedTenant(owner, "tenant orders"), seedTenant(owner, "tenant orders foreign")]);
		rows = await seedRows(T);
		otherClient = { ...(await seedClientProfile(owner, T.bureau.id)), role: "client" };
		thirdPartyHolder = await insertId(
			"insert into holders (bureau_id, type, name, document, created_by) values ($1, 'PF', 'Terceiro', $2, $3) returning id",
			[T.bureau.id, randomCpf(), T.bureauAdmin.userId],
		);
		ownOrder = rows.dossier;
		await insertOrder(ownOrder, T.client.userId);
		otherOrder = await insertId(
			"insert into dossiers (bureau_id, kind, holder_id, product, created_by) values ($1, 'PF', $2, 'smart_pf', $3) returning id",
			[T.bureau.id, thirdPartyHolder, T.bureauAdmin.userId],
		);
		await insertOrder(otherOrder, otherClient.userId);
	});

	it("client reads only own dossier_orders", async () => {
		const own = await withDbContext(app, ctxOf(T.client), (client) =>
			client.query<{ dossier_id: string }>("select dossier_id from dossier_orders"),
		);
		expect(own.rows.map((r) => r.dossier_id)).toEqual([ownOrder]);
		const other = await withDbContext(app, ctxOf(otherClient), (client) =>
			client.query<{ dossier_id: string }>("select dossier_id from dossier_orders"),
		);
		expect(other.rows.map((r) => r.dossier_id)).toEqual([otherOrder]);
	});

	it("staff reads the orders of its bureau and nothing of another", async () => {
		for (const actor of [T.bureauAdmin, T.operator]) {
			expect(await countAs(ctxOf(actor), "select count(*) as n from dossier_orders")).toBe(2);
		}
		expect(await countAs(ctxOf(foreign.operator), "select count(*) as n from dossier_orders where bureau_id = $1", [T.bureau.id])).toBe(0);
		expect(await countAs(ctxOf(foreign.bureauAdmin), "select count(*) as n from dossier_orders where bureau_id = $1", [T.bureau.id])).toBe(0);
		expect(await countAs(ctxOf(sa), "select count(*) as n from dossier_orders")).toBe(0);
	});

	it("client reads delivery only while released", async () => {
		const deliveries = (actor: Actor) =>
			withDbContext(app, actor, async (client) => {
				const count = async (sql: string, id: string) =>
					Number((await client.query<{ n: string }>(sql, [id])).rows[0].n);
				return {
					dossiers: await count("select count(*) as n from dossiers where id = $1", rows.dossier),
					consultations: await count("select count(*) as n from consultations where id = $1", rows.consultation),
					results: await count("select count(*) as n from bureau_results where consultation_id = $1", rows.consultation),
					reports: await count("select count(*) as n from ai_reports where consultation_id = $1", rows.consultation),
					payloads: await count("select count(*) as n from bureau_payloads where consultation_id = $1", rows.consultation),
				};
			});
		const none = { dossiers: 0, consultations: 0, results: 0, reports: 0, payloads: 0 };
		const all = { dossiers: 1, consultations: 1, results: 1, reports: 1, payloads: 1 };

		await setState(ownOrder, "completed");
		expect(await deliveries(ctxOf(T.client))).toEqual(none);
		await setState(ownOrder, "released");
		expect(await deliveries(ctxOf(T.client))).toEqual(all);
		// Outro cliente, com pedido liberado de outro Dossiê, não lê o deste.
		await setState(otherOrder, "released");
		expect(await deliveries(ctxOf(otherClient))).toEqual(none);
		expect(await deliveries(ctxOf(foreign.client))).toEqual(none);
		await setState(otherOrder, "completed");
		await setState(ownOrder, "completed");
		expect(await deliveries(ctxOf(T.client))).toEqual(none);
	});

	it("client reads zero third party holders, other payloads, scr rows and costs", async () => {
		await setState(ownOrder, "released");
		try {
			expect(await countAs(ctxOf(T.client), "select count(*) as n from holders where id = $1", [thirdPartyHolder])).toBe(0);
			expect(await countAs(ctxOf(T.client), "select count(*) as n from holders where id = $1", [T.holder.id])).toBe(1);
			expect(await countAs(ctxOf(T.client), "select count(*) as n from bureau_payloads where consultation_id not in (select id from consultations where dossier_id = $1)", [ownOrder])).toBe(0);
			expect(await countAs(ctxOf(T.client), "select count(*) as n from scr_authorizations")).toBe(0);
			expect(await countAs(ctxOf(T.client), "select count(*) as n from order_settlement_cost($1)", [ownOrder])).toBe(0);
		} finally {
			await setState(ownOrder, "completed");
		}
	});

	it("nobody inserts dossier_orders outside open_order", async () => {
		const dossier = await insertId(
			"insert into dossiers (bureau_id, kind, holder_id, product, created_by) values ($1, 'PF', $2, 'smart_pf', $3) returning id",
			[T.bureau.id, thirdPartyHolder, T.bureauAdmin.userId],
		);
		for (const actor of [T.client, T.operator, T.bureauAdmin]) {
			await withDbContext(app, ctxOf(actor), async (client) => {
				await expect(
					client.query(
						`insert into dossier_orders (dossier_id, bureau_id, mode, client_profile_id, product_code, subject_name,
               subject_document_masked, state, created_by)
             values ($1, $2, 'online', $3, 'dossie_pf', 'X', '***.000.000-**', 'awaiting_authorization', $3)`,
						[dossier, T.bureau.id, T.client.userId],
					),
				).rejects.toMatchObject({ code: "42501" });
			});
		}
	});

	it("client cannot update or delete dossier_orders", async () => {
		await withDbContext(app, ctxOf(T.client), async (client) => {
			await expectNoEffect(client.query("update dossier_orders set attempts = 5 where dossier_id = $1", [ownOrder]));
			await expectNoEffect(client.query("update dossier_orders set state = 'released' where dossier_id = $1", [ownOrder]));
			await expectNoEffect(client.query("delete from dossier_orders where dossier_id = $1", [ownOrder]));
		});
		const { rows: check } = await owner.query("select state, attempts from dossier_orders where dossier_id = $1", [ownOrder]);
		expect(check).toEqual([{ state: "completed", attempts: 0 }]);
	});

	it("staff updates only the mutable columns", async () => {
		await withDbContext(app, ctxOf(T.operator), async (client) => {
			await expect(client.query("update dossier_orders set attempts = 1 where dossier_id = $1", [ownOrder])).resolves.toMatchObject({ rowCount: 1 });
		});
		// Um erro aborta a transação: cada recusa roda na sua.
		for (const sql of ["update dossier_orders set subject_name = 'X' where dossier_id = $1", "delete from dossier_orders where dossier_id = $1"]) {
			await withDbContext(app, ctxOf(T.operator), async (client) => {
				await expect(client.query(sql, [ownOrder])).rejects.toMatchObject({ code: "42501" });
			});
		}
		await withDbContext(app, ctxOf(foreign.operator), async (client) => {
			await expectNoEffect(client.query("update dossier_orders set attempts = 1 where dossier_id = $1", [otherOrder]));
		});
	});

	it("app_runtime cannot change is_system or update the system profile", async () => {
		const { rows: system } = await owner.query<{ id: string }>("select id from profiles where bureau_id = $1 and is_system", [T.bureau.id]);
		expect(system).toHaveLength(1);
		const refusals = [
			["update profiles set is_system = true where id = $1", T.operator.userId],
			["update profiles set is_system = false where id = $1", system[0].id],
			["update profiles set full_name = 'Outro' where id = $1", system[0].id],
			["update profiles set is_active = false where id = $1", system[0].id],
			["delete from profiles where id = $1", system[0].id],
		] as const;
		for (const [sql, id] of refusals) {
			await withDbContext(app, ctxOf(T.bureauAdmin), async (client) => {
				await expect(client.query(sql, [id])).rejects.toMatchObject({ code: "42501" });
			});
		}
		const id = randomUUID();
		await owner.query('insert into "user" (id, name, email) values ($1, $2, $3)', [id, "Falso", `${id}@example.test`]);
		await withDbContext(app, ctxOf(T.bureauAdmin), async (client) => {
			await expect(
				client.query(
					`insert into profiles (id, auth_user_id, full_name, email, role, bureau_id, is_system)
           values ($1::uuid, $1::text, 'Falso', $2, 'operator', $3, true)`,
					[id, `${id}@example.test`, T.bureau.id],
				),
			).rejects.toMatchObject({ code: "42501" });
		});
		const { rows: after } = await owner.query("select full_name, is_active from profiles where id = $1", [system[0].id]);
		expect(after).toEqual([{ full_name: "Sistema", is_active: true }]);
	});

	it("create_bureau_system_profile and order_mask_document are not executable by app_runtime", async () => {
		const privilege = async (signature: string) =>
			(
				await owner.query<{ allowed: boolean }>(
					"select has_function_privilege('app_runtime', $1::regprocedure, 'execute') as allowed",
					[signature],
				)
			).rows[0].allowed;
		for (const signature of INTERNAL_FUNCTIONS) expect(await privilege(signature)).toBe(false);
		for (const signature of PUBLIC_FUNCTIONS) expect(await privilege(signature)).toBe(true);
		await expectCode(app, "select order_mask_document('12345678901')", [], "42501");
		await expectCode(app, "select create_bureau_system_profile()", [], "42501");
	});

	it("order_declarations is isolated by bureau and by client, and is append-only", async () => {
		const { rows: doc } = await owner.query<{ id: string }>(
			"select id from legal_documents where kind = 'buyer_declaration' and version = 1",
		);
		for (const [order, profile] of [
			[ownOrder, T.client.userId],
			[otherOrder, otherClient.userId],
		]) {
			await owner.query(
				"insert into order_declarations (dossier_id, bureau_id, profile_id, document_id) values ($1, $2, $3, $4)",
				[order, T.bureau.id, profile, doc[0].id],
			);
		}
		const visible = (actor: Actor) =>
			withDbContext(app, actor, async (client) =>
				(await client.query<{ dossier_id: string }>("select dossier_id from order_declarations order by dossier_id")).rows.map(
					(r) => r.dossier_id,
				),
			);
		expect(await visible(ctxOf(T.client))).toEqual([ownOrder]);
		expect(await visible(ctxOf(otherClient))).toEqual([otherOrder]);
		expect(await visible(ctxOf(T.operator))).toEqual([ownOrder, otherOrder].sort());
		expect(await visible(ctxOf(foreign.operator))).toEqual([]);
		expect(await visible(ctxOf(foreign.client))).toEqual([]);
		expect(await visible(ctxOf(sa))).toEqual([]);

		// Só a função grava; o app não tem INSERT, UPDATE nem DELETE, e nem o dono altera a linha.
		for (const sql of [
			"insert into order_declarations (dossier_id, bureau_id, profile_id, document_id) select dossier_id, bureau_id, profile_id, document_id from order_declarations",
			"update order_declarations set ip = null",
			"delete from order_declarations",
		]) {
			await expectCode(app, sql, [], "42501");
		}
		await expect(owner.query("update order_declarations set ip = null")).rejects.toMatchObject({ code: "23514" });
		await expect(owner.query("delete from order_declarations")).rejects.toMatchObject({ code: "23514" });
	});
});
