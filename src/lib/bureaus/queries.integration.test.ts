import { randomBytes } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const session = vi.hoisted(() => ({ current: null as unknown }));

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
	auth: { api: { requestPasswordReset: vi.fn() } },
}));
vi.mock("@/lib/auth/session", () => ({
	getRequiredSession: async () => session.current,
}));

import { saveAiPrompts } from "@/actions/settings";
import { getPublicBureau } from "@/lib/bureaus/public";
import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedSuperadmin, seedTenant, type SeedSuperadmin } from "@/test/seed";

import {
	createBureau,
	inviteBureauAdmin,
	listBureauMetrics,
	setBureauStatus,
	updateBureau,
} from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL });
let superadmin: SeedSuperadmin;

beforeEach(async () => {
	superadmin = await seedSuperadmin(owner);
});

afterAll(async () => {
	try {
		await owner.end();
	} finally {
		await pool.end();
	}
});

function newInput(overrides: Partial<Parameters<typeof createBureau>[1]> = {}) {
	const suffix = randomBytes(5).toString("hex");
	return {
		name: `Bureau ${suffix}`,
		slug: `bu-${suffix}`,
		adminName: "Admin Inicial",
		adminEmail: `admin-${suffix}@example.test`,
		...overrides,
	};
}

describe("createBureau", () => {
	it("creates bureau, bureau_admin profile and audit with null bureau_id", async () => {
		const input = newInput();
		const result = await createBureau(superadmin, input);

		expect(result).toMatchObject({ ok: true, adminEmail: input.adminEmail });
		if (!result.ok) throw new Error("unreachable");
		const bureau = await owner.query(
			"select name, slug, status from bureaus where id = $1",
			[result.id],
		);
		expect(bureau.rows[0]).toEqual({
			name: input.name,
			slug: input.slug,
			status: "active",
		});
		const profile = await owner.query(
			"select role::text, bureau_id from profiles where email = $1",
			[input.adminEmail],
		);
		expect(profile.rows[0]).toEqual({
			role: "bureau_admin",
			bureau_id: result.id,
		});
		const audit = await owner.query(
			"select bureau_id, record_id from audit_logs where action = 'bureau.create' and user_id = $1",
			[superadmin.userId],
		);
		expect(audit.rows).toEqual([{ bureau_id: null, record_id: result.id }]);
	});

	it("returns slug_reserved for a reserved slug", async () => {
		await expect(
			createBureau(superadmin, newInput({ slug: "admin" })),
		).resolves.toEqual({
			ok: false,
			reason: "slug_reserved",
		});
	});

	it("returns slug_taken for a repeated slug", async () => {
		const first = newInput();
		await createBureau(superadmin, first);
		await expect(
			createBureau(superadmin, newInput({ slug: first.slug })),
		).resolves.toEqual({ ok: false, reason: "slug_taken" });
	});

	it("returns email_in_use and creates no bureau when the e-mail belongs to another bureau", async () => {
		const tenant = await seedTenant(owner, "mail");
		const { rows } = await owner.query<{ email: string }>(
			"select email from profiles where id = $1",
			[tenant.operator.userId],
		);
		const input = newInput({ adminEmail: rows[0].email });

		await expect(createBureau(superadmin, input)).resolves.toEqual({
			ok: false,
			reason: "email_in_use",
		});
		const count = await owner.query("select 1 from bureaus where slug = $1", [
			input.slug,
		]);
		expect(count.rowCount).toBe(0);
	});

	it("fails for an operator", async () => {
		const tenant = await seedTenant(owner, "op");
		const input = newInput();
		await expect(createBureau(tenant.operator, input)).rejects.toThrow();
		const count = await owner.query("select 1 from bureaus where slug = $1", [
			input.slug,
		]);
		expect(count.rowCount).toBe(0);
	});
});

describe("updateBureau / setBureauStatus", () => {
	it("updates only the name and audits", async () => {
		const created = await createBureau(superadmin, newInput());
		if (!created.ok) throw new Error("setup");
		await expect(
			updateBureau(superadmin, { id: created.id, name: "Novo Nome" }),
		).resolves.toEqual({ ok: true });
		const { rows } = await owner.query(
			"select name from bureaus where id = $1",
			[created.id],
		);
		expect(rows[0].name).toBe("Novo Nome");
		const audit = await owner.query(
			"select 1 from audit_logs where action = 'bureau.update' and record_id = $1",
			[created.id],
		);
		expect(audit.rowCount).toBe(1);
	});

	it("returns not_found for an unknown id", async () => {
		const id = "00000000-0000-4000-8000-000000000000";
		await expect(updateBureau(superadmin, { id, name: "X" })).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
		await expect(setBureauStatus(superadmin, id, "inactive")).resolves.toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("setBureauStatus inactive hides the public page", async () => {
		const input = newInput();
		const created = await createBureau(superadmin, input);
		if (!created.ok) throw new Error("setup");
		await expect(getPublicBureau(input.slug)).resolves.toEqual({
			name: input.name,
			slug: input.slug,
		});

		await expect(
			setBureauStatus(superadmin, created.id, "inactive"),
		).resolves.toEqual({
			ok: true,
		});
		await expect(getPublicBureau(input.slug)).resolves.toBeNull();
	});
});

describe("inviteBureauAdmin", () => {
	it("resends safely to a pending admin and rejects a duplicate e-mail of another role", async () => {
		const input = newInput();
		const created = await createBureau(superadmin, input);
		if (!created.ok) throw new Error("setup");

		const resend = await inviteBureauAdmin(superadmin, {
			bureauId: created.id,
			name: input.adminName,
			email: input.adminEmail,
		});
		expect(resend).toMatchObject({ ok: true, resent: true });

		const tenant = await seedTenant(owner, "inv");
		const { rows } = await owner.query<{ email: string }>(
			"select email from profiles where id = $1",
			[tenant.operator.userId],
		);
		await expect(
			inviteBureauAdmin(superadmin, {
				bureauId: created.id,
				name: "Outra Pessoa",
				email: rows[0].email,
			}),
		).resolves.toEqual({ ok: false, reason: "email_in_use" });
	});
});

describe("listBureauMetrics", () => {
	it("returns only name, slug, status and counters", async () => {
		const tenant = await seedTenant(owner, "metrics");
		const rows = await listBureauMetrics(superadmin);
		const row = rows.find((r) => r.bureauId === tenant.bureau.id);

		expect(row).toBeDefined();
		expect(Object.keys(row!).sort()).toEqual(
			[
				"bureauId",
				"consultationCount",
				"consultations30d",
				"dossierCount",
				"holderCount",
				"name",
				"slug",
				"staffCount",
				"status",
			].sort(),
		);
		expect(row).toMatchObject({ staffCount: 2, holderCount: 1 });
	});

	it("fails for a non-superadmin", async () => {
		const tenant = await seedTenant(owner, "metrics2");
		await expect(listBureauMetrics(tenant.bureauAdmin)).rejects.toThrow();
	});
});

describe("saveAiPrompts", () => {
	it("returns an error for a bureau_admin", async () => {
		const tenant = await seedTenant(owner, "prompts");
		session.current = { ...tenant.bureauAdmin, supportSessionId: null };
		const result = await saveAiPrompts({ pf: "x", pj: "y", empresa: "z" });
		expect(result.error).not.toBeNull();
	});

	it("saves for the superadmin", async () => {
		session.current = { ...superadmin, supportSessionId: null };
		const result = await saveAiPrompts({
			pf: "prompt pf",
			pj: "",
			empresa: "",
		});
		expect(result.error).toBeNull();
		await owner.query("delete from settings where key = 'ai_prompt_pf'");
	});
});
