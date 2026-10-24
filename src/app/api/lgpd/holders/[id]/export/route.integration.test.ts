import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

const auth = vi.hoisted(() => ({ session: null as unknown, error: null as Error | null }));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: vi.fn(async () => {
		if (auth.error) throw auth.error;
		return auth.session;
	}),
}));

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedTenant, type SeededTenant } from "@/test/seed";

import { GET } from "./route";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 2 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

beforeEach(() => {
	auth.error = null;
});

const auditCount = async (t: SeededTenant) =>
	(await owner.query("select 1 from audit_logs where bureau_id = $1 and action = 'lgpd.export_holder'", [t.bureau.id])).rowCount;

const call = (id: string) => GET(new Request("http://localhost/api/lgpd/holders/x/export"), { params: { id } });
const asRole = (t: SeededTenant, who: "bureauAdmin" | "operator") => {
	auth.session = { ...t[who], supportSessionId: null };
};

describe("GET /api/lgpd/holders/[id]/export", () => {
	it("returns 403 without lgpd:manage", async () => {
		const t = await seedTenant(owner, "lgpd-route-403");
		const id = t.holder.id;
		asRole(t, "operator");

		const response = await call(id);

		expect(response.status).toBe(403);
		expect(await auditCount(t)).toBe(0);
	});

	it("returns 401 without a session", async () => {
		auth.error = new Error("no session");

		expect((await call(randomUUID())).status).toBe(401);
	});

	it("returns 404 for an unknown or malformed id", async () => {
		const t = await seedTenant(owner, "lgpd-route-404");
		asRole(t, "bureauAdmin");

		expect((await call(randomUUID())).status).toBe(404);
		expect((await call("nao-uuid")).status).toBe(404);
	});

	it("returns 404 for another bureau", async () => {
		const t = await seedTenant(owner, "lgpd-route-a");
		const other = await seedTenant(owner, "lgpd-route-b");
		const id = t.holder.id;
		asRole(other, "bureauAdmin");

		expect((await call(id)).status).toBe(404);
	});

	it("downloads the export and the audit event exists", async () => {
		const t = await seedTenant(owner, "lgpd-route-ok");
		const id = t.holder.id;
		asRole(t, "bureauAdmin");

		const response = await call(id);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("application/json");
		expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="titular-${id}.json"`);
		const body = await response.json();
		expect(body.holder.id).toBe(id);
		expect(await auditCount(t)).toBe(1);
	});
});
