// M4 / migration 020: fila de notificações (enqueue_notification, claim_notifications, complete_notification,
// apply_whatsapp_status, record_notification_opt_out, retry_notification), RLS, grants por coluna e guardas.
import { randomBytes, randomInt, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	TEST_DATABASE_DISPATCH_URL,
	TEST_DATABASE_OWNER_URL,
	TEST_DATABASE_URL,
	TEST_DATABASE_WEBHOOK_URL,
} from "@/test/db-env";
import {
	seedSuperadmin,
	seedSupportSession,
	seedTenant,
	withDbContext,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

import { acquireClaimLock, releaseClaimLock } from "./claim-lock.test-util";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 4 });
const dispatch = new Pool({ connectionString: TEST_DATABASE_DISPATCH_URL, max: 4 });

type Ctx = {
	userId: string;
	role: string;
	bureauId: string | null;
	supportSessionId?: string | null;
};

let tenantA: SeededTenant;
let tenantB: SeededTenant;
let superadmin: SeedSuperadmin;
let supportCtx: Ctx;
let emailTemplateId: string;
let whatsappTemplateId: string;
let paramsTemplateKey: string;
let retiredTemplateKey: string;

const adminA = (): Ctx => ({ ...tenantA.bureauAdmin });
const superCtx = (): Ctx => ({
	userId: superadmin.userId,
	role: "superadmin",
	bureauId: null,
});

const rand = () => randomBytes(6).toString("hex");
const phone = () => `+5511${randomInt(900000000, 999999999)}`;
const email = () => `${rand()}@example.test`;

async function newTemplate(
	key: string,
	params: string[],
	status: "active" | "retired" = "active",
): Promise<string> {
	const { rows } = await owner.query<{ id: string }>(
		`insert into notification_templates (key, channel, version, status, params, email_subject, email_html, email_text)
     values ($1, 'email', 1, $2, $3, 's', '<p>h</p>', 't') returning id`,
		[key, status, params],
	);
	return rows[0].id;
}

beforeAll(acquireClaimLock, 120_000);

beforeAll(async () => {
	[tenantA, tenantB, superadmin] = await Promise.all([
		seedTenant(owner, "Notif A"),
		seedTenant(owner, "Notif B"),
		seedSuperadmin(owner),
	]);
	const session = await seedSupportSession(owner, {
		superadminId: superadmin.userId,
		bureauId: tenantA.bureau.id,
	});
	supportCtx = {
		...superCtx(),
		bureauId: tenantA.bureau.id,
		supportSessionId: session,
	};

	const { rows } = await owner.query<{ id: string; channel: string }>(
		"select id, channel from notification_templates where key = 'platform_test' and status = 'active'",
	);
	emailTemplateId = rows.find((r) => r.channel === "email")!.id;
	whatsappTemplateId = rows.find((r) => r.channel === "whatsapp")!.id;
	paramsTemplateKey = `tpl_${rand()}`;
	await newTemplate(paramsTemplateKey, ["a", "b"]);
	retiredTemplateKey = `tpl_${rand()}`;
	await newTemplate(retiredTemplateKey, [], "retired");
});

// Linhas de teste são imutáveis (sem DELETE): encerra as pendentes para não vazarem para outro claim.
afterAll(async () => {
	await owner.query(
		`update notifications
        set status = 'suppressed', recipient = null, params = null, lease_id = null, locked_until = null
      where status in ('pending', 'sending') and created_by = any($1::uuid[])`,
		[
			[
				tenantA.bureauAdmin.userId,
				tenantB.bureauAdmin.userId,
				superadmin.userId,
			],
		],
	);
	await Promise.all([owner.end(), app.end(), hook.end(), dispatch.end()]);
	await releaseClaimLock();
});

async function setCtx(client: PoolClient, ctx: Ctx) {
	await client.query(
		`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
            set_config('app.bureau_id', $3, true), set_config('app.support_session_id', $4, true)`,
		[ctx.userId, ctx.role, ctx.bureauId ?? "", ctx.supportSessionId ?? ""],
	);
}

type Enqueue = {
	key?: string;
	channel?: string;
	recipient?: string;
	masked?: string;
	params?: unknown;
	idempotencyKey?: string;
	reference?: string | null;
};
type EnqueueResult = {
	ok: boolean;
	reason: string | null;
	notification_id: string | null;
	duplicate: boolean;
};

async function enqueue(
	client: PoolClient,
	o: Enqueue = {},
): Promise<EnqueueResult> {
	const { rows } = await client.query<EnqueueResult>(
		"select * from enqueue_notification($1, $2, $3, $4, $5::jsonb, $6, $7)",
		[
			o.key ?? "platform_test",
			o.channel ?? "email",
			o.recipient ?? email(),
			o.masked ?? "a***@example.test",
			JSON.stringify(o.params ?? {}),
			o.idempotencyKey ?? randomUUID(),
			o.reference ?? null,
		],
	);
	return rows[0];
}

// Cria uma notificação direto pelo dono (ignora RLS e funções) para montar o estado de cada caso.
type Row = {
	bureauId?: string;
	channel?: "email" | "whatsapp";
	recipient?: string | null;
	params?: object | null;
	status?: string;
	attempts?: number;
	maxAttempts?: number;
	nextAttemptAt?: string;
	leaseId?: string | null;
	lockedUntil?: string | null;
	providerMessageId?: string | null;
	updatedAt?: string;
	reference?: string;
};
async function insertRow(o: Row = {}): Promise<string> {
	const channel = o.channel ?? "email";
	const recipient =
		o.recipient === undefined
			? channel === "email"
				? email()
				: phone()
			: o.recipient;
	const status = o.status ?? "pending";
	const sending = status === "sending";
	const { rows } = await owner.query<{ id: string }>(
		`insert into notifications
       (bureau_id, template_id, channel, recipient, recipient_masked, recipient_hash, params, idempotency_key,
        status, attempts, max_attempts, next_attempt_at, lease_id, locked_until, provider_message_id, created_by, updated_at,
        reference)
     values ($1, $2, $3, $4, 'masked', notification_recipient_hash(coalesce($4, $5)), $6::jsonb, $7,
        $8, $9, $10, coalesce($11::timestamptz, now()), $12, $13, $14, $15, coalesce($16::timestamptz, now()), $17)
     returning id`,
		[
			o.bureauId ?? tenantA.bureau.id,
			channel === "email" ? emailTemplateId : whatsappTemplateId,
			channel,
			recipient,
			randomUUID(),
			o.params === undefined
				? recipient
					? "{}"
					: null
				: o.params === null
					? null
					: JSON.stringify(o.params),
			randomUUID(),
			status,
			o.attempts ?? 0,
			o.maxAttempts ?? 8,
			o.nextAttemptAt ?? null,
			o.leaseId === undefined ? (sending ? randomUUID() : null) : o.leaseId,
			o.lockedUntil === undefined
				? sending
					? "2000-01-01T00:00:00Z"
					: null
				: o.lockedUntil,
			o.providerMessageId ?? null,
			tenantA.bureauAdmin.userId,
			o.updatedAt ?? null,
			o.reference ?? null,
		],
	);
	return rows[0].id;
}

async function rowOf(id: string) {
	const { rows } = await owner.query(
		`select *, extract(epoch from (next_attempt_at - updated_at)) / 60 as backoff_min
       from notifications where id = $1`,
		[id],
	);
	return rows[0];
}

async function eventKinds(id: string): Promise<string[]> {
	const { rows } = await owner.query<{ kind: string }>(
		"select kind from notification_events where notification_id = $1 order by id",
		[id],
	);
	return rows.map((r) => r.kind);
}

type Claimed = {
	id: string;
	lease_id: string;
	channel: string;
	recipient: string | null;
	attempts: number;
	opted_out: boolean;
	template_key: string;
};
async function claim(pool: Pool, limit: number): Promise<Claimed[]> {
	const { rows } = await pool.query<Claimed>(
		"select * from claim_notifications($1)",
		[limit],
	);
	return rows;
}

const complete = async (
	id: string,
	lease: string,
	outcome: string,
	providerId: string | null = null,
	errorCode: string | null = null,
) =>
	(
		await dispatch.query<{ r: string }>(
			"select complete_notification($1, $2, $3, $4, $5) as r",
			[id, lease, outcome, providerId, errorCode],
		)
	).rows[0].r;

const metaStatus = async (
	providerId: string,
	status: string,
	errorCode: string | null = null,
) =>
	(
		await hook.query<{ r: string }>(
			"select apply_whatsapp_status($1, $2, $3, now()) as r",
			[providerId, status, errorCode],
		)
	).rows[0].r;

// Linha 'sending' que o worker acabou de pegar: lease válida, attempts conforme o caso.
async function sendingRow(attempts: number, maxAttempts = 8) {
	const leaseId = randomUUID();
	const id = await insertRow({
		status: "sending",
		attempts,
		maxAttempts,
		leaseId,
		lockedUntil: "2100-01-01T00:00:00Z",
	});
	return { id, leaseId };
}

describe("enqueue_notification", () => {
	it("creates the notification with a queued event and the session bureau", async () => {
		await withDbContext(app, tenantA.operator, async (c) => {
			const r = await enqueue(c, { reference: `ref-${rand()}` });
			expect(r).toMatchObject({ ok: true, reason: null, duplicate: false });
			const n = await c.query(
				"select bureau_id, status, attempts, created_by, channel from notifications where id = $1",
				[r.notification_id],
			);
			expect(n.rows[0]).toMatchObject({
				bureau_id: tenantA.bureau.id,
				status: "pending",
				attempts: 0,
				created_by: tenantA.operator.userId,
				channel: "email",
			});
			const ev = await c.query(
				"select kind, bureau_id from notification_events where notification_id = $1",
				[r.notification_id],
			);
			expect(ev.rows).toEqual([
				{ kind: "queued", bureau_id: tenantA.bureau.id },
			]);
		});
	});

	it("returns the existing id as duplicate for the same key in the same bureau, without a new row or event", async () => {
		await withDbContext(app, adminA(), async (c) => {
			const key = randomUUID();
			const reference = `ref-${rand()}`;
			const first = await enqueue(c, { idempotencyKey: key, reference });
			const second = await enqueue(c, { idempotencyKey: key, reference });
			expect(second).toMatchObject({
				ok: true,
				duplicate: true,
				notification_id: first.notification_id,
			});
			const rows = await c.query(
				"select id from notifications where reference = $1",
				[reference],
			);
			expect(rows.rows).toHaveLength(1);
			const ev = await c.query(
				"select id from notification_events where notification_id = $1",
				[first.notification_id],
			);
			expect(ev.rows).toHaveLength(1);
		});
	});

	it("creates another row for the same key in another bureau", async () => {
		await withDbContext(app, adminA(), async (c) => {
			const key = randomUUID();
			const a = await enqueue(c, { idempotencyKey: key });
			await setCtx(c, tenantB.bureauAdmin);
			const b = await enqueue(c, { idempotencyKey: key });
			expect(b.duplicate).toBe(false);
			expect(b.notification_id).not.toBe(a.notification_id);
			const n = await c.query(
				"select bureau_id from notifications where id = $1",
				[b.notification_id],
			);
			expect(n.rows[0].bureau_id).toBe(tenantB.bureau.id);
		});
	});

	it("dedupes the null bureau key of the superadmin test", async () => {
		await withDbContext(app, superCtx(), async (c) => {
			const key = randomUUID();
			const first = await enqueue(c, { idempotencyKey: key });
			const second = await enqueue(c, { idempotencyKey: key });
			expect(first.ok).toBe(true);
			expect(second).toMatchObject({
				duplicate: true,
				notification_id: first.notification_id,
			});
			const n = await c.query(
				"select bureau_id from notifications where id = $1",
				[first.notification_id],
			);
			expect(n.rows[0].bureau_id).toBeNull();
		});
	});

	it("uses the support session bureau for a superadmin in support", async () => {
		await withDbContext(app, supportCtx, async (c) => {
			const r = await enqueue(c);
			expect(r.ok).toBe(true);
			const n = await c.query(
				"select bureau_id from notifications where id = $1",
				[r.notification_id],
			);
			expect(n.rows[0].bureau_id).toBe(tenantA.bureau.id);
		});
	});

	it("rejects an unknown template key and a retired template", async () => {
		await withDbContext(app, adminA(), async (c) => {
			expect(await enqueue(c, { key: "does_not_exist" })).toMatchObject({
				ok: false,
				reason: "template_not_found",
			});
			expect(await enqueue(c, { key: retiredTemplateKey })).toMatchObject({
				ok: false,
				reason: "template_not_found",
			});
			expect(await enqueue(c, { channel: "sms" })).toMatchObject({
				reason: "template_not_found",
			});
		});
	});

	it("rejects params with an extra key, a missing key, a non-string value or a non-object", async () => {
		await withDbContext(app, adminA(), async (c) => {
			const bad = [
				{ a: "1", b: "2", c: "3" },
				{ a: "1" },
				{ a: "1", b: 2 },
				{ a: "1", b: null },
				["a", "b"],
			];
			for (const params of bad) {
				expect(
					await enqueue(c, { key: paramsTemplateKey, params }),
				).toMatchObject({
					ok: false,
					reason: "invalid_params",
				});
			}
			expect(
				await enqueue(c, {
					key: paramsTemplateKey,
					params: { a: "1", b: "2" },
				}),
			).toMatchObject({
				ok: true,
			});
			expect(await enqueue(c, { params: { extra: "x" } })).toMatchObject({
				reason: "invalid_params",
			});
		});
	});

	it("rejects a recipient that fails the channel format instead of raising", async () => {
		await withDbContext(app, adminA(), async (c) => {
			for (const recipient of ["5511999990000", "+0511999990000", "+55119"]) {
				expect(
					await enqueue(c, { channel: "whatsapp", recipient }),
				).toMatchObject({
					ok: false,
					reason: "invalid_recipient",
				});
			}
			expect(await enqueue(c, { recipient: "no-at-sign" })).toMatchObject({
				reason: "invalid_recipient",
			});
			expect(
				await enqueue(c, { channel: "whatsapp", recipient: phone() }),
			).toMatchObject({ ok: true });
		});
	});

	it("rejects an oversized key, mask or reference with invalid_input", async () => {
		await withDbContext(app, adminA(), async (c) => {
			expect(
				await enqueue(c, { idempotencyKey: "k".repeat(201) }),
			).toMatchObject({ reason: "invalid_input" });
			expect(await enqueue(c, { masked: "" })).toMatchObject({
				reason: "invalid_input",
			});
			expect(await enqueue(c, { reference: "r".repeat(201) })).toMatchObject({
				reason: "invalid_input",
			});
		});
	});

	it("gives not_allowed to a client and to a missing context", async () => {
		await withDbContext(app, tenantA.client, async (c) => {
			expect(await enqueue(c)).toMatchObject({
				ok: false,
				reason: "not_allowed",
			});
		});
		const { rows } = await app.query<EnqueueResult>(
			"select * from enqueue_notification('platform_test', 'email', 'a@b.c', 'm', '{}'::jsonb, $1, null)",
			[randomUUID()],
		);
		expect(rows[0]).toMatchObject({ ok: false, reason: "not_allowed" });
	});

	it("gives not_allowed to a superadmin with an expired support session", async () => {
		// Um único Date.now(): duas leituras podem diferir 1 ms e violar expires_at <= started_at + 1 hora.
		const now = Date.now();
		const expired = await seedSupportSession(owner, {
			superadminId: superadmin.userId,
			bureauId: tenantA.bureau.id,
			startedAt: new Date(now - 7200_000),
			expiresAt: new Date(now - 3600_000),
		});
		await withDbContext(
			app,
			{ ...superCtx(), bureauId: tenantA.bureau.id, supportSessionId: expired },
			async (c) => {
				expect(await enqueue(c)).toMatchObject({
					ok: false,
					reason: "not_allowed",
				});
			},
		);
	});
});

describe("claim_notifications", () => {
	it("concurrent claims never return the same notification", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 30; i++) ids.add(await insertRow());
		const second = new Pool({
			connectionString: TEST_DATABASE_DISPATCH_URL,
			max: 1,
		});
		try {
			const [a, b] = await Promise.all([claim(dispatch, 20), claim(second, 20)]);
			const all = [...a, ...b].map((r) => r.id);
			expect(new Set(all).size).toBe(all.length);
			const mine = all.filter((id) => ids.has(id));
			expect(mine.length).toBeGreaterThan(0);
		} finally {
			await second.end();
		}
	});

	it("increments attempts, creates a lease and returns the resolved template", async () => {
		const id = await insertRow();
		const claimed = (await claim(dispatch, 50)).find((r) => r.id === id)!;
		expect(claimed).toMatchObject({
			attempts: 1,
			channel: "email",
			template_key: "platform_test",
			opted_out: false,
		});
		expect(claimed.recipient).toBeTruthy();
		const row = await rowOf(id);
		expect(row).toMatchObject({
			status: "sending",
			attempts: 1,
			lease_id: claimed.lease_id,
		});
		expect(row.locked_until.getTime()).toBeGreaterThan(Date.now());
	});

	it("respects a future next_attempt_at", async () => {
		const id = await insertRow({ nextAttemptAt: "2100-01-01T00:00:00Z" });
		expect((await claim(dispatch, 50)).map((r) => r.id)).not.toContain(id);
		expect((await rowOf(id)).status).toBe("pending");
	});

	it("reclaims an expired lease with attempts left", async () => {
		const { id, leaseId } = await sendingRow(1);
		await owner.query(
			"update notifications set locked_until = now() - interval '1 minute' where id = $1",
			[id],
		);
		const claimed = (await claim(dispatch, 50)).find((r) => r.id === id)!;
		expect(claimed.attempts).toBe(2);
		expect(claimed.lease_id).not.toBe(leaseId);
	});

	it("fails an expired lease on the last attempt with lease_expired", async () => {
		const id = await insertRow({
			status: "sending",
			attempts: 8,
			maxAttempts: 8,
			lockedUntil: "2000-01-01T00:00:00Z",
		});
		expect((await claim(dispatch, 50)).map((r) => r.id)).not.toContain(id);
		expect(await rowOf(id)).toMatchObject({
			status: "failed",
			last_error_code: "lease_expired",
			lease_id: null,
		});
		expect(await eventKinds(id)).toEqual(["failed"]);
	});

	it("flags an opted-out recipient", async () => {
		const optedOut = phone();
		await hook.query("select record_notification_opt_out('whatsapp', $1)", [
			optedOut,
		]);
		await hook.query("select record_notification_opt_out('whatsapp', $1)", [
			optedOut,
		]);
		const blocked = await insertRow({
			channel: "whatsapp",
			recipient: optedOut,
		});
		const other = await insertRow({ channel: "whatsapp" });
		const rows = await claim(dispatch, 50);
		expect(rows.find((r) => r.id === blocked)!.opted_out).toBe(true);
		expect(rows.find((r) => r.id === other)!.opted_out).toBe(false);
	});

	it("purges the payload of a failed notification after 7 days", async () => {
		const old = await insertRow({
			status: "failed",
			updatedAt: new Date(Date.now() - 8 * 86400_000).toISOString(),
		});
		const fresh = await insertRow({ status: "failed" });
		await claim(dispatch, 1);
		expect(await rowOf(old)).toMatchObject({ recipient: null, params: null });
		const kept = await rowOf(fresh);
		expect(kept.recipient).not.toBeNull();
		expect(kept.params).not.toBeNull();
	});
});

describe("complete_notification", () => {
	it("stale lease result is ignored", async () => {
		const { id, leaseId: oldLease } = await sendingRow(1);
		await owner.query(
			"update notifications set locked_until = now() - interval '1 minute' where id = $1",
			[id],
		);
		const fresh = (await claim(dispatch, 50)).find((r) => r.id === id)!;
		expect(await complete(id, oldLease, "sent", `wamid.${rand()}`)).toBe(
			"stale",
		);
		expect(await rowOf(id)).toMatchObject({
			status: "sending",
			lease_id: fresh.lease_id,
		});
		expect(await complete(id, fresh.lease_id, "sent", `wamid.${rand()}`)).toBe(
			"applied",
		);
		expect((await rowOf(id)).status).toBe("sent");
	});

	it("returns stale for a row that is not sending", async () => {
		const id = await insertRow();
		expect(await complete(id, randomUUID(), "failed")).toBe("stale");
	});

	it("rejects an unknown outcome and a sent without a provider id", async () => {
		const { id, leaseId } = await sendingRow(1);
		await expect(complete(id, leaseId, "bogus")).rejects.toThrow(
			/invalid notification outcome/,
		);
		await expect(complete(id, leaseId, "sent", null)).rejects.toThrow(
			/provider_message_id is required/,
		);
	});

	it("backoff schedules 1, 2 and 60 minutes and the last failure is final", async () => {
		const expected: Array<[number, number]> = [
			[1, 1],
			[2, 2],
			[7, 60],
		];
		for (const [attempts, minutes] of expected) {
			const { id, leaseId } = await sendingRow(attempts);
			expect(await complete(id, leaseId, "retry", null, "timeout")).toBe(
				"applied",
			);
			const row = await rowOf(id);
			expect(row).toMatchObject({
				status: "pending",
				lease_id: null,
				locked_until: null,
				last_error_code: "timeout",
			});
			expect(row.backoff_min).toBeCloseTo(minutes, 3);
			expect(await eventKinds(id)).toEqual(["attempt_failed"]);
		}
		const last = await sendingRow(8);
		expect(
			await complete(last.id, last.leaseId, "retry", null, "timeout"),
		).toBe("applied");
		expect(await rowOf(last.id)).toMatchObject({
			status: "failed",
			last_error_code: "timeout",
		});
		expect(await eventKinds(last.id)).toEqual(["attempt_failed", "failed"]);
	});

	it("clears an old error code when the row finally becomes sent", async () => {
		const { id, leaseId } = await sendingRow(2);
		await owner.query(
			"update notifications set last_error_code = 'timeout' where id = $1",
			[id],
		);
		expect(await complete(id, leaseId, "sent", `wamid.${rand()}`)).toBe(
			"applied",
		);
		expect(await rowOf(id)).toMatchObject({
			status: "sent",
			last_error_code: null,
		});
	});

	it("payload is purged on terminal state: sent, suppressed and Meta status; failed keeps it", async () => {
		const sent = await sendingRow(1);
		await complete(sent.id, sent.leaseId, "sent", `wamid.${rand()}`);
		expect(await rowOf(sent.id)).toMatchObject({
			status: "sent",
			recipient: null,
			params: null,
			lease_id: null,
		});
		expect((await rowOf(sent.id)).sent_at).not.toBeNull();
		expect(await eventKinds(sent.id)).toEqual(["sent"]);

		const suppressed = await sendingRow(1);
		await complete(suppressed.id, suppressed.leaseId, "suppressed");
		expect(await rowOf(suppressed.id)).toMatchObject({
			status: "suppressed",
			recipient: null,
			params: null,
		});
		expect(await eventKinds(suppressed.id)).toEqual(["suppressed"]);

		const failed = await sendingRow(1);
		await complete(failed.id, failed.leaseId, "failed", null, "invalid_number");
		const failedRow = await rowOf(failed.id);
		expect(failedRow).toMatchObject({
			status: "failed",
			last_error_code: "invalid_number",
			lease_id: null,
		});
		expect(failedRow.recipient).not.toBeNull();
		// Falha do worker guarda o payload: nova tentativa manual possível.
		expect(failedRow.retryable).toBe(true);
		expect(await eventKinds(failed.id)).toEqual(["failed"]);

		const providerId = `wamid.${rand()}`;
		const viaMeta = await insertRow({
			status: "sent",
			providerMessageId: providerId,
		});
		await metaStatus(providerId, "delivered");
		expect(await rowOf(viaMeta)).toMatchObject({
			status: "delivered",
			recipient: null,
			params: null,
		});
	});
});

describe("apply_whatsapp_status", () => {
	it("status never regresses and a repeated event is a duplicate", async () => {
		const providerId = `wamid.${rand()}`;
		const id = await insertRow({
			status: "sent",
			providerMessageId: providerId,
		});
		expect(await metaStatus(providerId, "read")).toBe("applied");
		expect(await metaStatus(providerId, "delivered")).toBe("ignored");
		expect(await metaStatus(providerId, "sent")).toBe("ignored");
		expect((await rowOf(id)).status).toBe("read");
		expect(await metaStatus(providerId, "read")).toBe("duplicate");
		expect((await eventKinds(id)).sort()).toEqual([
			"delivered",
			"read",
			"sent",
		]);

		const otherId = `wamid.${rand()}`;
		const other = await insertRow({
			status: "sent",
			providerMessageId: otherId,
		});
		expect(await metaStatus(otherId, "delivered")).toBe("applied");
		expect(await metaStatus(otherId, "failed", "131026")).toBe("ignored");
		expect(await rowOf(other)).toMatchObject({
			status: "delivered",
			last_error_code: null,
		});
	});

	it("applies failed over sent and stores the error code", async () => {
		const providerId = `wamid.${rand()}`;
		const id = await insertRow({
			status: "sent",
			providerMessageId: providerId,
		});
		expect(await metaStatus(providerId, "failed", "131026")).toBe("applied");
		expect(await rowOf(id)).toMatchObject({
			status: "failed",
			last_error_code: "131026",
			recipient: null,
		});
		// A Meta apagou o payload: sem nova tentativa possível.
		expect((await rowOf(id)).retryable).toBe(false);
	});

	it("ignores an unknown status without logging it", async () => {
		expect(await metaStatus(`wamid.${rand()}`, "deleted")).toBe("ignored");
	});

	it("orphan status is adopted on complete", async () => {
		const providerId = `wamid.${rand()}`;
		expect(await metaStatus(providerId, "delivered")).toBe("orphan");
		const orphan = await owner.query(
			"select notification_id, bureau_id from notification_events where provider_message_id = $1",
			[providerId],
		);
		expect(orphan.rows).toEqual([{ notification_id: null, bureau_id: null }]);

		const { id, leaseId } = await sendingRow(1);
		expect(await complete(id, leaseId, "sent", providerId)).toBe("applied");
		expect(await rowOf(id)).toMatchObject({
			status: "delivered",
			recipient: null,
			params: null,
		});
		const adopted = await owner.query(
			"select notification_id, bureau_id from notification_events where provider_message_id = $1",
			[providerId],
		);
		expect(
			adopted.rows.every(
				(r) => r.notification_id === id && r.bureau_id === tenantA.bureau.id,
			),
		).toBe(true);
		expect((await eventKinds(id)).sort()).toEqual(["delivered", "sent"]);
	});

	it("applies the highest orphan status on complete", async () => {
		const providerId = `wamid.${rand()}`;
		await metaStatus(providerId, "read");
		await metaStatus(providerId, "delivered");
		const { id, leaseId } = await sendingRow(1);
		await complete(id, leaseId, "sent", providerId);
		expect((await rowOf(id)).status).toBe("read");
	});

	it("applies an orphan failed on complete when nothing higher exists", async () => {
		const providerId = `wamid.${rand()}`;
		await metaStatus(providerId, "failed", "131047");
		const { id, leaseId } = await sendingRow(1);
		await complete(id, leaseId, "sent", providerId);
		expect(await rowOf(id)).toMatchObject({
			status: "failed",
			last_error_code: "131047",
		});
	});
});

describe("retry_notification", () => {
	const retry = async (ctx: Ctx, id: string) =>
		withDbContext(app, ctx, async (c) => {
			const { rows } = await c.query("select * from retry_notification($1)", [
				id,
			]);
			return rows[0] as { ok: boolean; reason: string | null };
		});

	it("lets only a superadmin without support retry a failed notification", async () => {
		const id = await insertRow({ status: "failed", attempts: 8 });
		expect(await retry(adminA(), id)).toEqual({
			ok: false,
			reason: "not_allowed",
		});
		expect(await retry(supportCtx, id)).toEqual({
			ok: false,
			reason: "not_allowed",
		});
		expect(await retry(tenantA.client, id)).toEqual({
			ok: false,
			reason: "not_allowed",
		});
		expect((await rowOf(id)).status).toBe("failed");

		const before = Date.now();
		const committedRetry = async () => {
			const c = await app.connect();
			try {
				await c.query("begin");
				await setCtx(c, superCtx());
				const { rows } = await c.query("select * from retry_notification($1)", [
					id,
				]);
				await c.query("commit");
				return rows[0];
			} finally {
				c.release();
			}
		};
		expect(await committedRetry()).toEqual({ ok: true, reason: null });
		const row = await rowOf(id);
		expect(row).toMatchObject({ status: "pending", attempts: 0 });
		expect(row.next_attempt_at.getTime()).toBeGreaterThanOrEqual(before - 5000);
		expect(await eventKinds(id)).toEqual(["retried"]);
	});

	it("accepts only a failed notification with its payload", async () => {
		const pending = await insertRow();
		expect(await retry(superCtx(), pending)).toEqual({
			ok: false,
			reason: "invalid_state",
		});
		const purged = await insertRow({
			status: "failed",
			recipient: null,
			params: null,
		});
		expect(await retry(superCtx(), purged)).toEqual({
			ok: false,
			reason: "payload_purged",
		});
		expect(await retry(superCtx(), randomUUID())).toEqual({
			ok: false,
			reason: "not_found",
		});
	});
});

describe("supersede_notifications", () => {
	// withDbContext sempre desfaz a transação; aqui o efeito precisa ficar para a leitura pelo dono.
	const committed = async <T>(ctx: Ctx, work: (c: PoolClient) => Promise<T>) => {
		const c = await app.connect();
		try {
			await c.query("begin");
			await setCtx(c, ctx);
			const result = await work(c);
			await c.query("commit");
			return result;
		} catch (error) {
			await c.query("rollback");
			throw error;
		} finally {
			c.release();
		}
	};
	const supersede = (ctx: Ctx, reference: string) =>
		committed(ctx, async (c) => {
			const { rows } = await c.query<{ n: number }>(
				"select supersede_notifications('platform_test', $1) as n",
				[reference],
			);
			return rows[0].n;
		});

	it("suppresses older pending and failed rows of the same reference, purges them and logs the event", async () => {
		const reference = `scr_authorization:${rand()}`;
		const first = await committed(adminA(), (c) => enqueue(c, { reference }));
		const failed = await insertRow({ status: "failed", reference });
		expect(await supersede(adminA(), reference)).toBe(2);
		const second = await committed(adminA(), (c) => enqueue(c, { reference }));

		for (const id of [first.notification_id!, failed]) {
			expect(await rowOf(id)).toMatchObject({
				status: "suppressed",
				recipient: null,
				params: null,
				last_error_code: "superseded",
			});
		}
		expect(await eventKinds(first.notification_id!)).toEqual([
			"queued",
			"suppressed",
		]);
		expect(await rowOf(second.notification_id!)).toMatchObject({
			status: "pending",
		});
		expect(await claim(dispatch, 50)).not.toContainEqual(
			expect.objectContaining({ id: first.notification_id }),
		);
	});

	it("leaves sending, sent, delivered, read and suppressed rows and other references untouched", async () => {
		const reference = `scr_authorization:${rand()}`;
		const ids: Record<string, string> = {};
		for (const status of ["sending", "sent", "delivered", "read", "suppressed"]) {
			ids[status] = await insertRow({ status, reference });
		}
		const other = await insertRow({ reference: `scr_authorization:${rand()}` });
		expect(await supersede(adminA(), reference)).toBe(0);
		for (const [status, id] of Object.entries(ids)) {
			expect((await rowOf(id)).status).toBe(status);
			expect((await rowOf(id)).last_error_code).toBeNull();
		}
		expect((await rowOf(ids.sending)).lease_id).not.toBeNull();
		expect((await rowOf(other)).status).toBe("pending");
	});

	it("never touches another bureau and does nothing for a client", async () => {
		const reference = `scr_authorization:${rand()}`;
		const ofB = await insertRow({ bureauId: tenantB.bureau.id, reference });
		const ofA = await insertRow({ reference });
		expect(await supersede(adminA(), reference)).toBe(1);
		expect((await rowOf(ofB)).status).toBe("pending");
		expect(await supersede(tenantA.client, reference)).toBe(0);
		expect(await supersede(tenantB.bureauAdmin, reference)).toBe(1);
		expect((await rowOf(ofB)).status).toBe("suppressed");
		expect((await rowOf(ofA)).status).toBe("suppressed");
	});
});

describe("RLS and grants", () => {
	let idA: string;
	let idB: string;

	beforeAll(async () => {
		idA = await insertRow({ bureauId: tenantA.bureau.id });
		idB = await insertRow({ bureauId: tenantB.bureau.id });
		await owner.query(
			`insert into notification_events (notification_id, bureau_id, kind)
       values ($1, $2, 'queued'), ($3, $4, 'queued')`,
			[idA, tenantA.bureau.id, idB, tenantB.bureau.id],
		);
	});

	it("bureau A never reads bureau B notifications or events", async () => {
		await withDbContext(app, adminA(), async (c) => {
			const n = await c.query(
				"select id from notifications where id in ($1, $2)",
				[idA, idB],
			);
			expect(n.rows.map((r) => r.id)).toEqual([idA]);
			const e = await c.query(
				"select notification_id from notification_events where notification_id in ($1, $2)",
				[idA, idB],
			);
			expect(e.rows.map((r) => r.notification_id)).toEqual([idA]);
		});
		await withDbContext(app, tenantB.operator, async (c) => {
			const n = await c.query(
				"select id from notifications where id in ($1, $2)",
				[idA, idB],
			);
			expect(n.rows.map((r) => r.id)).toEqual([idB]);
		});
	});

	it("lets a superadmin without support read all rows and one in support read only the session bureau", async () => {
		await withDbContext(app, superCtx(), async (c) => {
			const n = await c.query(
				"select id from notifications where id in ($1, $2)",
				[idA, idB],
			);
			expect(n.rows).toHaveLength(2);
			const t = await c.query("select id from notification_templates");
			expect(t.rows.length).toBeGreaterThan(0);
		});
		await withDbContext(app, supportCtx, async (c) => {
			const n = await c.query(
				"select id from notifications where id in ($1, $2)",
				[idA, idB],
			);
			expect(n.rows.map((r) => r.id)).toEqual([idA]);
		});
	});

	it("hides the templates from staff and everything from a client", async () => {
		await withDbContext(app, adminA(), async (c) => {
			expect(
				(await c.query("select id from notification_templates")).rows,
			).toHaveLength(0);
		});
		await withDbContext(app, tenantA.client, async (c) => {
			expect((await c.query("select id from notifications")).rows).toHaveLength(
				0,
			);
			expect(
				(await c.query("select id from notification_events")).rows,
			).toHaveLength(0);
		});
	});

	it("denies staff the personal and internal columns", async () => {
		const denied = [
			"select recipient from notifications",
			"select params from notifications",
			"select recipient_hash from notifications",
			"select idempotency_key from notifications",
			"select lease_id from notifications",
			"select provider_message_id from notifications",
			"select dedupe_key from notification_events",
			"select provider_message_id from notification_events",
			"select * from notifications",
			"select * from notification_opt_outs",
		];
		for (const sql of denied) {
			await expect(
				withDbContext(app, adminA(), (c) => c.query(sql)),
				sql,
			).rejects.toThrow(/permission denied/);
		}
	});

	it("denies app_runtime any direct write and the webhook-only functions", async () => {
		const denied = [
			"insert into notifications (template_id, channel, recipient_masked, recipient_hash, idempotency_key, created_by) values (gen_random_uuid(), 'email', 'm', repeat('a', 64), 'k', gen_random_uuid())",
			"update notifications set status = 'failed'",
			"delete from notifications",
			"insert into notification_events (kind) values ('queued')",
			"update notification_events set notification_id = null",
			"delete from notification_events",
			"insert into notification_templates (key, channel, version) values ('abc', 'email', 9)",
			"update notification_templates set status = 'retired'",
			"insert into notification_opt_outs (channel, recipient_hash, source) values ('email', repeat('a', 64), 'whatsapp_keyword')",
			"select claim_notifications(1)",
			"select complete_notification(gen_random_uuid(), gen_random_uuid(), 'sent', 'x', null)",
			"select apply_whatsapp_status('x', 'read', null, now())",
			"select record_notification_opt_out('email', 'a@b.c')",
			"select notification_advance_status(gen_random_uuid(), 'read', null)",
		];
		for (const sql of denied) {
			await expect(
				withDbContext(app, superCtx(), (c) => c.query(sql)),
				sql,
			).rejects.toThrow(/permission denied/);
		}
	});

	it("denies app_webhook any direct table access and the runtime-only functions", async () => {
		for (const table of [
			"notifications",
			"notification_events",
			"notification_templates",
			"notification_opt_outs",
		]) {
			await expect(
				hook.query(`select count(*) from ${table}`),
				table,
			).rejects.toThrow(/permission denied/);
		}
		await expect(
			hook.query(
				"insert into notification_opt_outs (channel, recipient_hash, source) values ('email', repeat('a', 64), 'whatsapp_keyword')",
			),
		).rejects.toThrow(/permission denied/);
		await expect(
			hook.query(
				"select enqueue_notification('platform_test', 'email', 'a@b.c', 'm', '{}'::jsonb, 'k', null)",
			),
		).rejects.toThrow(/permission denied/);
		await expect(
			hook.query("select retry_notification(gen_random_uuid())"),
		).rejects.toThrow(/permission denied/);
		await expect(
			hook.query("select supersede_notifications('platform_test', 'r')"),
		).rejects.toThrow(/permission denied/);
	});

	it("denies app_webhook the dispatch-only functions that return the cleartext recipient", async () => {
		await expect(hook.query("select * from claim_notifications(1)")).rejects.toThrow(
			/permission denied/,
		);
		await expect(
			hook.query(
				"select complete_notification(gen_random_uuid(), gen_random_uuid(), 'sent', null, null)",
			),
		).rejects.toThrow(/permission denied/);
	});

	it("denies app_dispatch everything but claim and complete", async () => {
		for (const table of [
			"notifications",
			"notification_events",
			"notification_templates",
			"notification_opt_outs",
		]) {
			await expect(
				dispatch.query(`select count(*) from ${table}`),
				table,
			).rejects.toThrow(/permission denied/);
		}
		for (const sql of [
			"select apply_whatsapp_status('wamid.x', 'delivered', null, now())",
			"select record_notification_opt_out('whatsapp', 'x')",
			"select apply_asaas_payment('e', 'PAYMENT_RECEIVED', 'p', '{}'::jsonb)",
			"select nfse_charge_by_payment('p')",
			"select retry_notification(gen_random_uuid())",
			"select enqueue_notification('platform_test', 'email', 'a@b.c', 'm', '{}'::jsonb, 'k', null)",
			"select supersede_notifications('platform_test', 'r')",
		]) {
			await expect(dispatch.query(sql), sql).rejects.toThrow(
				/permission denied/,
			);
		}
	});

	it("lets app_dispatch claim and complete", async () => {
		const id = await insertRow();
		const claimed = (await claim(dispatch, 50)).find((r) => r.id === id)!;
		expect(claimed.recipient).toBeTruthy();
		expect(await complete(id, claimed.lease_id, "sent", `wamid.${rand()}`)).toBe(
			"applied",
		);
	});
});

describe("guards", () => {
	it("rejects a template body update, accepts active to retired and keeps one active per key and channel", async () => {
		const key = `tpl_${rand()}`;
		const id = await newTemplate(key, []);
		await expect(
			owner.query(
				"update notification_templates set email_html = 'x' where id = $1",
				[id],
			),
		).rejects.toThrow(/only accepts active -> retired/);
		await expect(
			owner.query(
				"update notification_templates set status = 'retired', email_html = 'x' where id = $1",
				[id],
			),
		).rejects.toThrow(/only accepts active -> retired/);
		await expect(
			owner.query(
				`insert into notification_templates (key, channel, version, params, email_subject, email_html, email_text)
         values ($1, 'email', 2, '{}', 's', 'h', 't')`,
				[key],
			),
		).rejects.toThrow(/notification_templates_one_active/);

		await owner.query(
			"update notification_templates set status = 'retired' where id = $1",
			[id],
		);
		await expect(
			owner.query(
				"update notification_templates set status = 'active' where id = $1",
				[id],
			),
		).rejects.toThrow(/only accepts active -> retired/);
		await owner.query(
			`insert into notification_templates (key, channel, version, params, email_subject, email_html, email_text)
       values ($1, 'email', 2, '{}', 's', 'h', 't')`,
			[key],
		);
	});

	it("rejects every DELETE and a channel/body mismatch on templates", async () => {
		const id = await insertRow();
		await expect(
			owner.query("delete from notifications where id = $1", [id]),
		).rejects.toThrow(/does not accept DELETE/);
		await expect(
			owner.query("delete from notification_templates where id = $1", [
				emailTemplateId,
			]),
		).rejects.toThrow(/does not accept DELETE/);
		await expect(
			owner.query("delete from notification_events"),
		).rejects.toThrow(/does not accept DELETE/);
		await expect(
			owner.query(
				`insert into notification_templates (key, channel, version, params, wa_template_name, wa_language, email_html)
         values ($1, 'whatsapp', 1, '{}', 'hello_world', 'en_US', 'x')`,
				[`tpl_${rand()}`],
			),
		).rejects.toThrow(/violates check constraint/);
	});

	it("lets an event change only by adopting an orphan", async () => {
		const id = await insertRow();
		const providerId = `wamid.${rand()}`;
		const { rows } = await owner.query<{ id: string }>(
			"insert into notification_events (kind, provider_message_id) values ('delivered', $1) returning id",
			[providerId],
		);
		const orphanId = rows[0].id;
		await expect(
			owner.query(
				"update notification_events set kind = 'read' where id = $1",
				[orphanId],
			),
		).rejects.toThrow(/adoption of an orphan/);
		await owner.query(
			"update notification_events set notification_id = $2, bureau_id = $3 where id = $1",
			[orphanId, id, tenantA.bureau.id],
		);
		await expect(
			owner.query(
				"update notification_events set notification_id = null where id = $1",
				[orphanId],
			),
		).rejects.toThrow(/adoption of an orphan/);
	});
});

describe("seeds", () => {
	it("stores the SCR authorization e-mail with the expected subject, text and HTML values", async () => {
		const { rows } = await owner.query(
			`select params, email_subject, email_html, email_text from notification_templates
        where key = 'scr_authorization' and channel = 'email' and status = 'active'`,
		);
		const values = {
			clientName: "Maria",
			authorizedName: "Empresa X",
			code: "123456",
			url: "https://x.test/a/abc",
			siteUrl: "https://x.test",
		};
		const render = (s: string) =>
			s.replace(/\{\{(\w+)\}\}/g, (_, k: keyof typeof values) => values[k]);
		const expectedText = [
			"Olá Maria,",
			"",
			"A Empresa X gostaria de realizar a consulta SCR dos seus dados.",
			"Seu código de confirmação: 123456",
			"",
			"Autorize em: https://x.test/a/abc",
			"",
			"Rainha Cred · suporte@rainhacred.com.br",
		].join("\n");
		const html = render(rows[0].email_html);
		expect(rows[0].params).toEqual([
			"clientName",
			"authorizedName",
			"code",
			"url",
		]);
		expect(rows[0].email_subject).toBe(
			"Autorização de consulta SCR — Rainha Cred",
		);
		expect(html).toContain("Olá Maria,");
		expect(html).toContain("A Empresa X gostaria");
		expect(html).toContain(">123456</div>");
		expect(html).toContain('href="https://x.test/a/abc"');
		expect(render(rows[0].email_text)).toBe(expectedText);
	});

	it("seeds platform_test for e-mail and WhatsApp without parameters", async () => {
		const { rows } = await owner.query(
			`select channel, params, email_subject, wa_template_name, wa_language from notification_templates
        where key = 'platform_test' and status = 'active' order by channel`,
		);
		expect(rows).toEqual([
			{
				channel: "email",
				params: [],
				email_subject: "Teste de envio — Plataforma Bureau",
				wa_template_name: null,
				wa_language: null,
			},
			{
				channel: "whatsapp",
				params: [],
				email_subject: null,
				wa_template_name: "hello_world",
				wa_language: "en_US",
			},
		]);
	});
});
