// Emissão do código SCR pela fila de notificações, contra um Postgres real (role app_runtime).
import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
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

// Retirar o template seedado é irreversível e o banco é compartilhado: simula a falha por um mock de uma chamada.
vi.mock("@/lib/notifications/queries", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/notifications/queries")>();
	return { ...original, enqueueNotification: vi.fn(original.enqueueNotification) };
});

import { pool } from "@/lib/db/pool";
import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { enqueueNotification } from "@/lib/notifications/queries";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedTenant, type SeededTenant } from "@/test/seed";

import { issueSelfScrAuthorization, listScrAuthorizations } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const OLD_CODE = "OLDCOD";
const SITE_URL = "https://canonical.example.test";

let tenantA: SeededTenant;
let tenantB: SeededTenant;

beforeAll(acquireClaimLock, 120_000);

beforeAll(async () => {
	[tenantA, tenantB] = await Promise.all([seedTenant(owner, "Scr Q A"), seedTenant(owner, "Scr Q B")]);
});

// Linhas de notificação são imutáveis (sem DELETE): encerra as pendentes para não vazarem para o claim de outro teste.
afterAll(async () => {
	await owner.query(
		`update notifications
        set status = 'suppressed', recipient = null, params = null, lease_id = null, locked_until = null
      where status in ('pending', 'sending') and reference like 'scr_authorization:%' and bureau_id = any($1::uuid[])`,
		[[tenantA.bureau.id, tenantB.bureau.id]],
	);
	await Promise.all([owner.end(), pool.end()]);
	await releaseClaimLock();
});

async function seedScr(tenant: SeededTenant): Promise<string> {
	const { rows } = await owner.query<{ id: string }>(
		`insert into scr_authorizations (bureau_id, document, type, holder_id, status, channel, auth_code)
     values ($1, $2, 'PF', $3, 'pending', 'internal', $4) returning id`,
		[tenant.bureau.id, randomBytes(6).toString("hex"), tenant.holder.id, OLD_CODE],
	);
	return rows[0].id;
}

const input = (overrides: Partial<{ code: string; recipient: string }> = {}) => ({
	code: "NEW234",
	email: "titular@example.test",
	consentText: "consent",
	consentName: "Titular",
	consentDocument: "000.000.000-00",
	notification: {
		recipient: overrides.recipient ?? `${randomUUID()}@example.test`,
		clientName: "Titular",
		authorizedName: "Rainha",
		siteUrl: SITE_URL,
	},
	...(overrides.code ? { code: overrides.code } : {}),
});

const authCode = async (id: string) =>
	(await owner.query<{ auth_code: string }>("select auth_code from scr_authorizations where id = $1", [id])).rows[0].auth_code;

const notificationsOf = async (id: string) =>
	(
		await owner.query<{ id: string; status: string; reference: string; bureau_id: string }>(
			"select id, status, reference, bureau_id from notifications where reference = $1 order by created_at",
			[`scr_authorization:${id}`],
		)
	).rows;

describe("issueSelfScrAuthorization", () => {
	it("queues one scr_authorization e-mail with the reference and an audit event", async () => {
		const id = await seedScr(tenantA);

		const result = await issueSelfScrAuthorization(tenantA.operator, id, input());

		expect(result).toEqual({ ok: true });
		expect(await authCode(id)).toBe("NEW234");
		const queued = await notificationsOf(id);
		expect(queued).toEqual([
			{ id: expect.any(String), status: "pending", reference: `scr_authorization:${id}`, bureau_id: tenantA.bureau.id },
		]);
		const audit = await owner.query("select metadata from audit_logs where action = 'notification.enqueue' and record_id = $1", [queued[0].id]);
		expect(audit.rows).toEqual([{ metadata: { templateKey: "scr_authorization", channel: "email" } }]);
	});

	it("queues a new notification and suppresses the previous pending one when the code is issued again", async () => {
		const id = await seedScr(tenantA);

		await issueSelfScrAuthorization(tenantA.operator, id, input());
		await issueSelfScrAuthorization(tenantA.operator, id, input({ code: "NEW567" }));

		const queued = await notificationsOf(id);
		expect(queued.map((row) => row.status)).toEqual(["suppressed", "pending"]);
		expect(await authCode(id)).toBe("NEW567");
	});

	it("leaves a notification that is already sending or sent when the code is issued again", async () => {
		const id = await seedScr(tenantA);
		await issueSelfScrAuthorization(tenantA.operator, id, input());
		const [first] = await notificationsOf(id);
		await owner.query(
			"update notifications set status = 'sent', recipient = null, params = null where id = $1",
			[first.id],
		);

		await issueSelfScrAuthorization(tenantA.operator, id, input({ code: "NEW567" }));

		expect((await notificationsOf(id)).map((row) => row.status)).toEqual(["sent", "pending"]);
	});

	it("keeps the previous pending notification when the new one cannot be queued", async () => {
		const id = await seedScr(tenantA);
		await issueSelfScrAuthorization(tenantA.operator, id, input());

		const result = await issueSelfScrAuthorization(tenantA.operator, id, input({ recipient: "sem-arroba" }));

		expect(result).toEqual({ ok: false, reason: "invalid_recipient" });
		expect((await notificationsOf(id)).map((row) => row.status)).toEqual(["pending"]);
	});

	it("keeps the old code and queues nothing when the template is not found", async () => {
		const id = await seedScr(tenantA);
		vi.mocked(enqueueNotification).mockResolvedValueOnce({ ok: false, reason: "template_not_found" });

		const result = await issueSelfScrAuthorization(tenantA.operator, id, input());

		expect(result).toEqual({ ok: false, reason: "template_not_found" });
		expect(await authCode(id)).toBe(OLD_CODE);
		expect(await notificationsOf(id)).toHaveLength(0);
	});

	it("keeps the old code and queues nothing when the recipient is invalid", async () => {
		const id = await seedScr(tenantA);

		const result = await issueSelfScrAuthorization(tenantA.operator, id, input({ recipient: "sem-arroba" }));

		expect(result).toEqual({ ok: false, reason: "invalid_recipient" });
		expect(await authCode(id)).toBe(OLD_CODE);
		expect(await notificationsOf(id)).toHaveLength(0);
	});

	it("does not let an operator of another Bureau issue for this SCR", async () => {
		const id = await seedScr(tenantA);

		const result = await issueSelfScrAuthorization(tenantB.operator, id, input());

		expect(result).toEqual({ ok: false, reason: "not_found" });
		expect(await authCode(id)).toBe(OLD_CODE);
		expect(await notificationsOf(id)).toHaveLength(0);
	});
});

describe("listScrAuthorizations", () => {
	it("returns the status of the most recent notification, or null when none exists", async () => {
		const withMail = await seedScr(tenantA);
		const withoutMail = await seedScr(tenantA);
		await issueSelfScrAuthorization(tenantA.operator, withMail, input());
		await issueSelfScrAuthorization(tenantA.operator, withMail, input({ code: "NEW567" }));
		const [older] = await notificationsOf(withMail);
		await owner.query(
			"update notifications set status = 'suppressed', recipient = null, params = null where id = $1",
			[older.id],
		);

		const rows = await listScrAuthorizations(tenantA.operator);

		expect(rows.find((row) => row.id === withMail)?.lastNotificationStatus).toBe("pending");
		expect(rows.find((row) => row.id === withoutMail)?.lastNotificationStatus).toBeNull();
	});
});
