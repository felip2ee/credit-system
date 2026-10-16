// Fila de notificações do lado da aplicação (role app_runtime) contra um Postgres real.
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system",
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
import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSuperadmin, seedSupportSession, seedTenant, type SeededTenant, type SeedSuperadmin } from "@/test/seed";

import { enqueueNotification, listNotifications, listTemplates, retryNotification } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let tenantA: SeededTenant;
let tenantB: SeededTenant;
let superadmin: SeedSuperadmin;
let supportIdentity: DbIdentity;
let emailTemplateId: string;

const rand = () => randomBytes(6).toString("hex");
const email = () => `${rand()}@example.test`;
const adminA = (): DbIdentity => tenantA.bureauAdmin;

beforeAll(acquireClaimLock, 120_000);

beforeAll(async () => {
	[tenantA, tenantB, superadmin] = await Promise.all([
		seedTenant(owner, "Notif Q A"),
		seedTenant(owner, "Notif Q B"),
		seedSuperadmin(owner),
	]);
	const supportSessionId = await seedSupportSession(owner, { superadminId: superadmin.userId, bureauId: tenantA.bureau.id });
	supportIdentity = { ...superadmin, bureauId: tenantA.bureau.id, supportSessionId };
	const { rows } = await owner.query<{ id: string }>(
		"select id from notification_templates where key = 'platform_test' and channel = 'email' and status = 'active'",
	);
	emailTemplateId = rows[0].id;
});

// Linhas de teste são imutáveis (sem DELETE): encerra as pendentes para não vazarem para o claim de outro teste.
afterAll(async () => {
	await owner.query(
		`update notifications
        set status = 'suppressed', recipient = null, params = null, lease_id = null, locked_until = null
      where status in ('pending', 'sending') and created_by = any($1::uuid[])`,
		[[tenantA.bureauAdmin.userId, tenantB.bureauAdmin.userId, superadmin.userId]],
	);
	await Promise.all([owner.end(), pool.end()]);
	await releaseClaimLock();
});

const enqueue = (identity: DbIdentity, overrides: Partial<Parameters<typeof enqueueNotification>[2]> = {}) =>
	withUserTransaction(identity, (client) =>
		enqueueNotification(client, identity, {
			templateKey: "platform_test",
			channel: "email",
			recipient: email(),
			params: {},
			idempotencyKey: randomUUID(),
			...overrides,
		}),
	);

const auditRows = async (action: string, targetId: string) =>
	(
		await owner.query<{ metadata: Record<string, unknown>; bureau_id: string | null; user_id: string }>(
			"select metadata, bureau_id, user_id from audit_logs where action = $1 and record_id = $2",
			[action, targetId],
		)
	).rows;

// Cliente que falha o teste se o banco for consultado.
const untouchedClient = () => {
	const query = vi.fn();
	return { client: { query } as unknown as PoolClient, query };
};

describe("enqueueNotification", () => {
	it("creates the notification and one audit event with only the template key and channel", async () => {
		const recipient = email();
		const result = await enqueue(adminA(), { recipient, reference: `ref-${rand()}` });

		expect(result).toMatchObject({ ok: true, duplicate: false });
		if (!result.ok) return;
		const audit = await auditRows("notification.enqueue", result.id);
		expect(audit).toEqual([
			{ metadata: { templateKey: "platform_test", channel: "email" }, bureau_id: tenantA.bureau.id, user_id: tenantA.bureauAdmin.userId },
		]);
		expect(JSON.stringify(audit)).not.toContain(recipient);
	});

	it("does not audit a duplicate", async () => {
		const idempotencyKey = randomUUID();
		const first = await enqueue(adminA(), { idempotencyKey });
		const second = await enqueue(adminA(), { idempotencyKey });

		expect(first.ok && second.ok && second.duplicate && second.id === first.id).toBe(true);
		if (!first.ok) return;
		expect(await auditRows("notification.enqueue", first.id)).toHaveLength(1);
	});

	it("rolls back the notification and its audit event with the caller's transaction", async () => {
		const idempotencyKey = randomUUID();
		let id = "";
		await expect(
			withUserTransaction(adminA(), async (client) => {
				const result = await enqueueNotification(client, adminA(), {
					templateKey: "platform_test",
					channel: "email",
					recipient: email(),
					params: {},
					idempotencyKey,
				});
				if (result.ok) id = result.id;
				throw new Error("caller failed");
			}),
		).rejects.toThrow("caller failed");

		expect(id).not.toBe("");
		expect((await owner.query("select 1 from notifications where idempotency_key = $1", [idempotencyKey])).rowCount).toBe(0);
		expect(await auditRows("notification.enqueue", id)).toHaveLength(0);
	});

	it("queues a platform test from a superadmin outside support, without a Bureau", async () => {
		const result = await enqueue(superadmin);

		expect(result).toMatchObject({ ok: true, duplicate: false });
		if (!result.ok) return;
		const { rows } = await owner.query("select bureau_id from notifications where id = $1", [result.id]);
		expect(rows[0].bureau_id).toBeNull();
		expect((await auditRows("notification.enqueue", result.id))[0]).toMatchObject({ bureau_id: null });
	});

	it("queues in the support Bureau for a superadmin in support", async () => {
		const result = await enqueue(supportIdentity);

		if (!result.ok) throw new Error(result.reason);
		const { rows } = await owner.query("select bureau_id from notifications where id = $1", [result.id]);
		expect(rows[0].bureau_id).toBe(tenantA.bureau.id);
	});

	it("refuses an unknown template and a client", async () => {
		expect(await enqueue(adminA(), { templateKey: "no_such_template" })).toEqual({ ok: false, reason: "template_not_found" });
		expect(await enqueue(tenantA.client)).toEqual({ ok: false, reason: "not_allowed" });
	});

	it("refuses params the template does not declare", async () => {
		expect(await enqueue(adminA(), { params: { extra: "x" } })).toEqual({ ok: false, reason: "invalid_params" });
	});

	it("normalizes and masks the e-mail before the database call", async () => {
		const result = await enqueue(adminA(), { recipient: `  ${rand().toUpperCase()}@Example.Test ` });

		if (!result.ok) throw new Error(result.reason);
		const { rows } = await owner.query("select recipient, recipient_masked from notifications where id = $1", [result.id]);
		expect(rows[0].recipient).toBe(rows[0].recipient.toLowerCase());
		expect(rows[0].recipient_masked).not.toBe(rows[0].recipient);
		expect(rows[0].recipient_masked).toContain("*");
	});

	it("normalizes a Brazilian phone to E.164 for WhatsApp", async () => {
		const result = await enqueue(adminA(), { channel: "whatsapp", recipient: "(11) 98765-4321" });

		if (!result.ok) throw new Error(result.reason);
		const { rows } = await owner.query("select recipient from notifications where id = $1", [result.id]);
		expect(rows[0].recipient).toBe("+5511987654321");
	});

	it.each([
		["an invalid e-mail", { channel: "email", recipient: "nope" }],
		["an invalid phone", { channel: "whatsapp", recipient: "123" }],
	] as const)("returns invalid_recipient for %s without querying the database", async (_name, input) => {
		const { client, query } = untouchedClient();

		const result = await enqueueNotification(client, adminA(), {
			templateKey: "platform_test",
			params: {},
			idempotencyKey: randomUUID(),
			...input,
		});

		expect(result).toEqual({ ok: false, reason: "invalid_recipient" });
		expect(query).not.toHaveBeenCalled();
	});

	it.each(["cpf", "cnpj", "document", "documento", "token", "password", "clientCpf"])(
		"refuses the sensitive param key %s without querying the database",
		async (key) => {
			const { client, query } = untouchedClient();

			const result = await enqueueNotification(client, adminA(), {
				templateKey: "scr_authorization",
				channel: "email",
				recipient: email(),
				params: { [key]: "123.456.789-09" },
				idempotencyKey: randomUUID(),
			});

			expect(result).toEqual({ ok: false, reason: "invalid_params" });
			expect(query).not.toHaveBeenCalled();
		},
	);

	it("refuses WhatsApp params the Meta would reject, without querying the database", async () => {
		const { client, query } = untouchedClient();

		const result = await enqueueNotification(client, adminA(), {
			templateKey: "platform_test",
			channel: "whatsapp",
			recipient: "+5511987654321",
			params: { a: "line\nbreak" },
			idempotencyKey: randomUUID(),
		});

		expect(result).toEqual({ ok: false, reason: "invalid_params" });
		expect(query).not.toHaveBeenCalled();
	});

	it("maps an unknown SQL reason (invalid_input) to invalid_params", async () => {
		const result = await enqueue(adminA(), { idempotencyKey: "k".repeat(201) });

		expect(result).toEqual({ ok: false, reason: "invalid_params" });
	});
});

async function seedPage(bureauId: string, createdBy: string, reference: string, count: number) {
	const ids: string[] = [];
	for (let i = 0; i < count; i += 1) {
		const { rows } = await owner.query<{ id: string }>(
			`insert into notifications
         (bureau_id, template_id, channel, recipient, recipient_masked, recipient_hash, params, idempotency_key,
          reference, created_by, created_at)
       values ($1, $2, 'email', $3, 'masked', notification_recipient_hash($3), '{}'::jsonb, $4, $5, $6,
          -- mesmo created_at nas duas primeiras: o desempate é pelo id
          '2030-01-01T00:00:00Z'::timestamptz + make_interval(secs => $7))
       returning id`,
			[bureauId, emailTemplateId, email(), randomUUID(), reference, createdBy, i < 2 ? 0 : i],
		);
		ids.push(rows[0].id);
	}
	return ids;
}

describe("listNotifications", () => {
	it("pages by (created_at, id) without repeating or skipping rows, and stays inside the Bureau", async () => {
		const reference = `page-${rand()}`;
		const ids = await seedPage(tenantA.bureau.id, tenantA.bureauAdmin.userId, reference, 5);
		await seedPage(tenantB.bureau.id, tenantB.bureauAdmin.userId, reference, 2);

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page = await listNotifications(adminA(), { limit: 2, cursor });
			seen.push(...page.rows.filter((r) => r.reference === reference).map((r) => r.id));
			cursor = page.nextCursor;
			pages += 1;
		} while (cursor && pages < 100);

		expect([...seen].sort()).toEqual([...ids].sort());
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("returns only the grant columns, never the recipient", async () => {
		await enqueue(adminA());

		const [row] = (await listNotifications(adminA(), { limit: 1 })).rows;

		expect(Object.keys(row).sort()).toEqual(
			[
				"attempts", "bureauId", "channel", "createdAt", "createdBy", "id", "lastErrorCode", "maxAttempts",
				"nextAttemptAt", "recipientMasked", "reference", "retryable", "sentAt", "status", "templateId", "templateKey",
				"updatedAt",
			].sort(),
		);
	});

	it("filters by status and channel, and caps the page at 100", async () => {
		const failedId = (await seedPage(tenantA.bureau.id, tenantA.bureauAdmin.userId, `f-${rand()}`, 1))[0];
		await owner.query("update notifications set status = 'failed' where id = $1", [failedId]);

		const failed = await listNotifications(adminA(), { status: "failed", channel: "email", limit: 1000 });
		const whatsapp = await listNotifications(adminA(), { channel: "whatsapp", limit: 100 });

		expect(failed.rows.length).toBeGreaterThan(0);
		expect(failed.rows.length).toBeLessThanOrEqual(100);
		expect(failed.rows.every((r) => r.status === "failed" && r.channel === "email")).toBe(true);
		expect(whatsapp.rows.every((r) => r.channel === "whatsapp")).toBe(true);
	});

	it("flags retryable only for a failed row that still holds its payload", async () => {
		const live = await failedNotification();
		const purged = await failedNotification({ recipient: null, params: null });
		const pending = await failedNotification({ status: "pending" });

		// seedPage deixa linhas imutáveis datadas de 2030 a cada execução: elas se acumulam e passam a ocupar a primeira página.
		// Por isso pagina até achar as três linhas do teste.
		const wanted = new Set([live, purged, pending]);
		const rows: Awaited<ReturnType<typeof listNotifications>>["rows"] = [];
		let cursor: string | null = null;
		do {
			const page = await listNotifications(superadmin, { limit: 100, cursor });
			rows.push(...page.rows.filter((r) => wanted.has(r.id)));
			cursor = rows.length === wanted.size ? null : page.nextCursor;
		} while (cursor);
		const retryable = (id: string) => rows.find((r) => r.id === id)?.retryable;

		expect(retryable(live)).toBe(true);
		expect(retryable(purged)).toBe(false);
		expect(retryable(pending)).toBe(false);
		// O sinal é o mesmo critério de retry_notification.
		expect(await retryNotification(superadmin, purged)).toEqual({ ok: false, reason: "payload_purged" });
		expect(await retryNotification(superadmin, live)).toEqual({ ok: true });
		await owner.query("update notifications set status = 'suppressed', recipient = null, params = null where id = any($1)", [
			[live, pending],
		]);
	});

	it("shows the template key to the superadmin and every Bureau to nobody else", async () => {
		await enqueue(adminA());

		const asSuperadmin = await listNotifications(superadmin, { limit: 5 });
		const asStaff = await listNotifications(adminA(), { limit: 5 });

		expect(asSuperadmin.rows.some((r) => r.templateKey === "platform_test")).toBe(true);
		expect(asStaff.rows.every((r) => r.bureauId === tenantA.bureau.id)).toBe(true);
	});

	it("rejects a malformed cursor before querying", async () => {
		await expect(listNotifications(adminA(), { limit: 5, cursor: "x'; drop table notifications;--" })).rejects.toThrow(
			"Invalid notification cursor",
		);
	});
});

describe("listTemplates", () => {
	it("lists the templates without bodies for the superadmin", async () => {
		const templates = await listTemplates(superadmin);

		const wa = templates.find((t) => t.key === "platform_test" && t.channel === "whatsapp");
		expect(wa).toMatchObject({ waTemplateName: "hello_world", waLanguage: "en_US", params: [], status: "active" });
		expect(templates.find((t) => t.key === "scr_authorization")?.params).toEqual(["clientName", "authorizedName", "code", "url"]);
		expect(JSON.stringify(templates)).not.toContain("<html");
	});

	it("shows nothing to a Bureau user", async () => {
		expect(await listTemplates(adminA())).toEqual([]);
	});
});

async function failedNotification(overrides: { recipient?: string | null; params?: object | null; status?: string } = {}) {
	const recipient = overrides.recipient === undefined ? email() : overrides.recipient;
	const { rows } = await owner.query<{ id: string }>(
		`insert into notifications
       (bureau_id, template_id, channel, recipient, recipient_masked, recipient_hash, params, idempotency_key,
        status, attempts, created_by)
     values ($1, $2, 'email', $3, 'masked', notification_recipient_hash(coalesce($3, $4)), $5::jsonb, $6, $7, 8, $8)
     returning id`,
		[
			tenantA.bureau.id,
			emailTemplateId,
			recipient,
			randomUUID(),
			overrides.params === undefined ? "{}" : overrides.params === null ? null : JSON.stringify(overrides.params),
			randomUUID(),
			overrides.status ?? "failed",
			tenantA.bureauAdmin.userId,
		],
	);
	return rows[0].id;
}

describe("retryNotification", () => {
	it("moves a failed notification back to pending and audits it with the Bureau of the notification in the metadata", async () => {
		const id = await failedNotification();

		expect(await retryNotification(superadmin, id)).toEqual({ ok: true });

		const { rows } = await owner.query("select status, attempts from notifications where id = $1", [id]);
		expect(rows[0]).toMatchObject({ status: "pending", attempts: 0 });
		expect(await auditRows("notification.retry", id)).toEqual([
			{ metadata: { bureauId: tenantA.bureau.id }, bureau_id: null, user_id: superadmin.userId },
		]);
		await owner.query("update notifications set status = 'suppressed', recipient = null, params = null where id = $1", [id]);
	});

	it("refuses a notification that is not failed, without audit", async () => {
		const id = await failedNotification({ status: "pending" });

		expect(await retryNotification(superadmin, id)).toEqual({ ok: false, reason: "invalid_state" });
		expect(await auditRows("notification.retry", id)).toHaveLength(0);
		await owner.query("update notifications set status = 'suppressed', recipient = null, params = null where id = $1", [id]);
	});

	it("refuses when the payload was purged, an unknown id, a Bureau user and a superadmin in support", async () => {
		const purged = await failedNotification({ recipient: null, params: null });
		const live = await failedNotification();

		expect(await retryNotification(superadmin, purged)).toEqual({ ok: false, reason: "payload_purged" });
		expect(await retryNotification(superadmin, randomUUID())).toEqual({ ok: false, reason: "not_found" });
		expect(await retryNotification(adminA(), live)).toEqual({ ok: false, reason: "not_allowed" });
		expect(await retryNotification(supportIdentity, live)).toEqual({ ok: false, reason: "not_allowed" });
		expect(await auditRows("notification.retry", live)).toHaveLength(0);
	});
});
