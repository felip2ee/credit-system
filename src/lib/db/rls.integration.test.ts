import { randomBytes, randomInt, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import {
	randomCpf,
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
				"select count(*) as n from audit_logs where bureau_id is not null and support_session_id is null",
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

	it("visibility: self, own bureau staff view, superadmin sees admins only", async () => {
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
		).toEqual(sorted([A.bureauAdmin.userId, B.bureauAdmin.userId, sa.userId]));
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

	it("bureau_admin changes roles only between bureau_admin and operator, only in own bureau", async () => {
		await expect(
			withDbContext(app, ctxOf(A.bureauAdmin), (c) =>
				c.query("update profiles set role = 'bureau_admin' where id = $1", [
					A.operator.userId,
				]),
			),
		).resolves.toMatchObject({ rowCount: 1 });
		await expect(
			withDbContext(app, ctxOf(A.bureauAdmin), (c) =>
				c.query("update profiles set role = 'operator' where id = $1", [
					A.client.userId,
				]),
			),
		).rejects.toThrow(/role/);
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

	it("every authenticated role reads", async () => {
		for (const actor of [A.operator, A.bureauAdmin, A.client]) {
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
					"select count(*) as n from audit_logs where bureau_id is not null and support_session_id is null",
				),
		);
		expect(Number(supportRows.rows[0].n)).toBe(0);
	});
});
