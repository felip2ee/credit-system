// Queries de conta (Task 3) contra um Postgres real: pool do dono para preparar, pool app_runtime (RLS) para consultar.
import { randomBytes, randomInt, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

import { pool } from "@/lib/db/pool";
import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { randomCpf, seedClientProfile, seedTenant, withDbContext, type SeededTenant } from "@/test/seed";

import {
	getClientAccountStatus,
	getCurrentLegalDocuments,
	registerClient,
	type RegisterClientInput,
} from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

const onlyDigits = (value: string) => value.replace(/\D/g, "");
const newIp = () => `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;

let tenant: SeededTenant;

beforeAll(acquireClaimLock, 120_000);
beforeAll(async () => {
	tenant = await seedTenant(owner, "Acc Queries");
});

// Notificações são imutáveis (sem DELETE): encerra as pendentes para não vazarem para o claim de outro teste.
afterAll(async () => {
	await owner.query(
		`update notifications
        set status = 'suppressed', recipient = null, params = null, lease_id = null, locked_until = null
      where status in ('pending', 'sending') and bureau_id = $1`,
		[tenant.bureau.id],
	);
	await Promise.all([owner.end(), pool.end()]);
	await releaseClaimLock();
});

function registerInput(overrides: Partial<RegisterClientInput> = {}): RegisterClientInput {
	return {
		slug: tenant.bureau.slug,
		type: "PF",
		name: "Maria Teste",
		documentDigits: onlyDigits(randomCpf()),
		email: `${randomUUID()}@example.test`,
		phoneE164: `+55639${String(randomInt(0, 100_000_000)).padStart(8, "0")}`,
		passwordHash: `hash-${randomBytes(16).toString("hex")}`,
		termsVersion: 2,
		privacyVersion: 1,
		ip: newIp(),
		userAgent: "vitest-agent/1.0",
		emailToken: randomBytes(32).toString("base64url"),
		siteUrl: "https://app.example.test",
		...overrides,
	};
}

describe("getClientAccountStatus", () => {
	it("getClientAccountStatus reports termsAccepted per current version", async () => {
		const client = await seedClientProfile(owner, tenant.bureau.id);

		await withDbContext(pool, client, async (db) => {
			const before = await getClientAccountStatus(db, client.userId);
			expect(before).toMatchObject({
				phoneE164: null,
				phoneVerified: false,
				notificationChannel: "email",
				termsAccepted: false,
				documentMasked: null,
			});

			const accepted = await db.query("select ok, reason from accept_legal_documents($1, 2, 1, null, 'vitest')", [
				client.userId,
			]);
			expect(accepted.rows[0]).toEqual({ ok: true, reason: null });
			expect((await getClientAccountStatus(db, client.userId)).termsAccepted).toBe(true);
		});

		// Versão 3 publicada: quem aceitou só a 2 volta a pendente. Transação do dono, desfeita no fim.
		const db = await owner.connect();
		try {
			await db.query("begin");
			await db.query(
				`select set_config('app.user_id', $1, true), set_config('app.user_role', 'client', true),
                set_config('app.bureau_id', $2, true), set_config('app.support_session_id', '', true)`,
				[client.userId, client.bureauId],
			);
			await db.query("select ok from accept_legal_documents($1, 2, 1, null, 'vitest')", [client.userId]);
			expect((await getClientAccountStatus(db, client.userId)).termsAccepted).toBe(true);
			await db.query("insert into legal_documents (kind, version, title, body_md) values ('terms', 3, 'Termos v3', 'texto')");
			expect((await getClientAccountStatus(db, client.userId)).termsAccepted).toBe(false);
		} finally {
			await db.query("rollback");
			db.release();
		}
	});

	it("getClientAccountStatus masks the PF and PJ document", async () => {
		const digits = onlyDigits(randomCpf());
		const cpfOwner = tenant.client;
		await owner.query("update holders set document = $2 where id = $1", [tenant.holder.id, digits]);
		await withDbContext(pool, cpfOwner, async (db) => {
			const status = await getClientAccountStatus(db, cpfOwner.userId);
			expect(status.documentMasked).toBe(`***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`);
		});

		const pj = await seedClientProfile(owner, tenant.bureau.id);
		const cnpj = `${randomInt(10_000_000, 99_999_999)}000199`;
		await owner.query(
			`insert into holders (bureau_id, type, name, document, created_by, client_profile_id)
       values ($1, 'PJ', 'Empresa Teste', $2, $3, $3)`,
			[tenant.bureau.id, cnpj, pj.userId],
		);
		await withDbContext(pool, pj, async (db) => {
			const status = await getClientAccountStatus(db, pj.userId);
			expect(status.documentMasked).toBe(`**.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-**`);
		});
	});

	it("getClientAccountStatus throws when the profile is not visible", async () => {
		await withDbContext(pool, tenant.client, async (db) => {
			await expect(getClientAccountStatus(db, randomUUID())).rejects.toThrow();
		});
	});
});

describe("getCurrentLegalDocuments", () => {
	it("getCurrentLegalDocuments without a session returns terms v2 and privacy v1", async () => {
		const docs = await getCurrentLegalDocuments();
		expect(docs.terms).toMatchObject({ kind: "terms", version: 2 });
		expect(docs.privacy).toMatchObject({ kind: "privacy", version: 1 });
		expect(docs.terms.title.length).toBeGreaterThan(0);
		expect(docs.privacy.bodyMd.length).toBeGreaterThan(0);
		expect(docs.terms.publishedAt).toBeInstanceOf(Date);
	});
});

describe("registerClient", () => {
	it("registerClient returns the userId on success and maps email_in_use", async () => {
		const input = registerInput();
		const first = await registerClient(input);
		expect(first).toMatchObject({ ok: true });
		expect(first.ok && first.userId).toMatch(/^[0-9a-f-]{36}$/);

		const again = await registerClient(registerInput({ email: input.email.toUpperCase() }));
		expect(again).toEqual({ ok: false, reason: "email_in_use" });
	});

	it("registerClient maps document_in_use, bureau_not_found and invalid_input", async () => {
		const input = registerInput();
		expect(await registerClient(input)).toMatchObject({ ok: true });
		expect(await registerClient(registerInput({ documentDigits: input.documentDigits }))).toEqual({
			ok: false,
			reason: "document_in_use",
		});
		expect(await registerClient(registerInput({ slug: "no-such-bureau" }))).toEqual({
			ok: false,
			reason: "bureau_not_found",
		});
		expect(await registerClient(registerInput({ phoneE164: "123" }))).toEqual({ ok: false, reason: "invalid_input" });
	});

	it("registerClient maps rate_limited after ten attempts from one IP", async () => {
		const ip = newIp();
		for (let i = 0; i < 10; i += 1) await registerClient(registerInput({ ip, slug: "no-such-bureau" }));
		expect(await registerClient(registerInput({ ip }))).toEqual({ ok: false, reason: "rate_limited" });
	});
});
