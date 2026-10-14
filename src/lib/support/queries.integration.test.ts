import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL:
			process.env.TEST_DATABASE_URL ??
			"postgres://app_runtime:test@localhost:54329/credit_system",
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

import { listAuditLogs } from "@/lib/audit/read";
import { writeAuditEvent } from "@/lib/audit/write";
import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedSuperadmin,
	seedSupportSession,
	seedTenant,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

import { endSupportSession, startSupportSession } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });
const HOUR_MS = 60 * 60 * 1000;
let superadmin: SeedSuperadmin;
let tenant: SeededTenant;

beforeEach(async () => {
	superadmin = await seedSuperadmin(owner);
	tenant = await seedTenant(owner, "support");
});

afterAll(async () => {
	try {
		await owner.end();
	} finally {
		await pool.end();
	}
});

function supportIdentity(sessionId: string) {
	return {
		...superadmin,
		bureauId: tenant.bureau.id,
		supportSessionId: sessionId,
	};
}

function countHolders(identity: Parameters<typeof withUserTransaction>[0]) {
	return withUserTransaction(identity, async (client) => {
		const { rows } = await client.query("select id from holders");
		return rows.length;
	});
}

describe("startSupportSession", () => {
	it.each(["", "   ", "\n\t"])("rejects reason %j", async (reason) => {
		await expect(
			startSupportSession(superadmin, { bureauId: tenant.bureau.id, reason }),
		).resolves.toEqual({ ok: false, reason: "invalid_reason" });
		const { rowCount } = await owner.query(
			"select 1 from support_sessions where superadmin_id = $1",
			[superadmin.userId],
		);
		expect(rowCount).toBe(0);
	});

	it("rejects a reason longer than 500 characters", async () => {
		await expect(
			startSupportSession(superadmin, {
				bureauId: tenant.bureau.id,
				reason: "x".repeat(501),
			}),
		).resolves.toEqual({ ok: false, reason: "invalid_reason" });
	});

	it("returns bureau_not_found for an unknown bureau", async () => {
		await expect(
			startSupportSession(superadmin, {
				bureauId: "00000000-0000-4000-8000-000000000000",
				reason: "chamado 1",
			}),
		).resolves.toEqual({ ok: false, reason: "bureau_not_found" });
	});

	it("opens a session with trimmed reason and 1h expiry", async () => {
		const result = await startSupportSession(superadmin, {
			bureauId: tenant.bureau.id,
			reason: "  chamado 123  ",
		});
		if (!result.ok) throw new Error("setup");
		const { rows } = await owner.query(
			"select reason, bureau_id, ended_at from support_sessions where id = $1",
			[result.id],
		);
		expect(rows[0]).toEqual({
			reason: "chamado 123",
			bureau_id: tenant.bureau.id,
			ended_at: null,
		});
		expect(result.expiresAt.getTime() - Date.now()).toBeGreaterThan(HOUR_MS - 60_000);
	});

	it("ends the open session when a second one starts", async () => {
		const other = await seedTenant(owner, "support-2");
		const first = await startSupportSession(superadmin, {
			bureauId: tenant.bureau.id,
			reason: "primeiro",
		});
		const second = await startSupportSession(superadmin, {
			bureauId: other.bureau.id,
			reason: "segundo",
		});
		if (!first.ok || !second.ok) throw new Error("setup");

		const { rows } = await owner.query<{ id: string; ended_at: Date | null }>(
			"select id, ended_at from support_sessions where superadmin_id = $1",
			[superadmin.userId],
		);
		const open = rows.filter((r) => r.ended_at === null);
		expect(rows).toHaveLength(2);
		expect(open.map((r) => r.id)).toEqual([second.id]);
	});

	it("writes support.start with null bureau_id", async () => {
		const result = await startSupportSession(superadmin, {
			bureauId: tenant.bureau.id,
			reason: "chamado 9",
		});
		if (!result.ok) throw new Error("setup");
		const { rows } = await owner.query(
			"select bureau_id, support_session_id, metadata from audit_logs where action = 'support.start' and record_id = $1",
			[result.id],
		);
		expect(rows).toEqual([
			{
				bureau_id: null,
				support_session_id: null,
				metadata: { bureauId: tenant.bureau.id, reason: "chamado 9" },
			},
		]);
	});
});

describe("endSupportSession", () => {
	it("returns no_active_session when nothing is open", async () => {
		await expect(endSupportSession(superadmin)).resolves.toEqual({
			ok: false,
			reason: "no_active_session",
		});
	});

	it("ends the session and writes support.end with null bureau_id", async () => {
		const started = await startSupportSession(superadmin, {
			bureauId: tenant.bureau.id,
			reason: "chamado 5",
		});
		if (!started.ok) throw new Error("setup");

		// A requisição em modo suporte carrega o suporte; o fim usa a identidade da plataforma.
		await expect(
			endSupportSession(supportIdentity(started.id)),
		).resolves.toEqual({ ok: true });

		const session = await owner.query(
			"select ended_at from support_sessions where id = $1",
			[started.id],
		);
		expect(session.rows[0].ended_at).not.toBeNull();
		const audit = await owner.query(
			"select bureau_id, metadata from audit_logs where action = 'support.end' and record_id = $1",
			[started.id],
		);
		expect(audit.rows).toEqual([
			{
				bureau_id: null,
				metadata: { bureauId: tenant.bureau.id, reason: "chamado 5" },
			},
		]);
		await expect(endSupportSession(superadmin)).resolves.toEqual({
			ok: false,
			reason: "no_active_session",
		});
	});
});

describe("support access", () => {
	it("reads tenant holders and audits a write with the support session and target bureau", async () => {
		const started = await startSupportSession(superadmin, {
			bureauId: tenant.bureau.id,
			reason: "chamado 7",
		});
		if (!started.ok) throw new Error("setup");
		const identity = supportIdentity(started.id);

		await expect(countHolders(identity)).resolves.toBe(1);

		await withUserTransaction(identity, async (client) => {
			await client.query("update holders set name = 'Alterado' where id = $1", [
				tenant.holder.id,
			]);
			await writeAuditEvent(client, {
				actorId: identity.userId,
				action: "holder.update",
				targetTable: "holders",
				targetId: tenant.holder.id,
			});
		});

		const { rows } = await owner.query(
			"select bureau_id, support_session_id from audit_logs where action = 'holder.update' and record_id = $1",
			[tenant.holder.id],
		);
		expect(rows).toEqual([
			{ bureau_id: tenant.bureau.id, support_session_id: started.id },
		]);
	});

	it("gives no tenant access with an expired session", async () => {
		const now = Date.now();
		const id = await seedSupportSession(owner, {
			superadminId: superadmin.userId,
			bureauId: tenant.bureau.id,
			startedAt: new Date(now - 2 * HOUR_MS),
			expiresAt: new Date(now - HOUR_MS),
		});
		await expect(countHolders(supportIdentity(id))).resolves.toBe(0);
	});

	it("gives no tenant access after the session ends", async () => {
		const started = await startSupportSession(superadmin, {
			bureauId: tenant.bureau.id,
			reason: "chamado 8",
		});
		if (!started.ok) throw new Error("setup");
		await endSupportSession(superadmin);
		await expect(countHolders(supportIdentity(started.id))).resolves.toBe(0);
	});
});

describe("audit trail", () => {
	it("shows support rows to the bureau_admin with supportSessionId", async () => {
		const started = await startSupportSession(superadmin, {
			bureauId: tenant.bureau.id,
			reason: "chamado 11",
		});
		if (!started.ok) throw new Error("setup");
		const identity = supportIdentity(started.id);
		await withUserTransaction(identity, (client) =>
			writeAuditEvent(client, {
				actorId: identity.userId,
				action: "holder.view",
				targetTable: "holders",
				targetId: tenant.holder.id,
			}),
		);

		const logs = await listAuditLogs(tenant.bureauAdmin);
		const row = logs.find((l) => l.action === "holder.view");
		expect(row?.supportSessionId).toBe(started.id);
		// O início é evento da plataforma: o Bureau não o vê.
		expect(logs.some((l) => l.action === "support.start")).toBe(false);
	});
});
