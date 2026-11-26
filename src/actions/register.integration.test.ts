// Cadastro público ponta a ponta contra um Postgres real: a ação grava as linhas e o e-mail confirma pelo token da notificação.
import { randomInt, randomUUID } from "node:crypto";

import { verifyPassword } from "better-auth/crypto";
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

const requestIp = vi.hoisted(() => ({ current: "10.0.0.1" }));

vi.mock("next/headers", () => ({
	headers: () => new Headers({ "x-forwarded-for": requestIp.current, "user-agent": "vitest-agent/1.0" }),
}));

import { pool } from "@/lib/db/pool";
import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { isValidCPF, onlyDigits } from "@/lib/utils";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { randomCpf, seedTenant, type SeededTenant } from "@/test/seed";

import { registerClientAction } from "./register";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

let tenant: SeededTenant;

beforeAll(acquireClaimLock, 120_000);
beforeAll(async () => {
	tenant = await seedTenant(owner, "Acc Register");
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

function validCpf(): string {
	let cpf = randomCpf();
	while (!isValidCPF(cpf)) cpf = randomCpf();
	return cpf;
}

const PASSWORD = "SenhaForte#2026ab";

function formValues(overrides: Record<string, unknown> = {}) {
	return {
		slug: tenant.bureau.slug,
		type: "PF",
		name: "Maria Integração",
		document: validCpf(),
		email: `${randomUUID()}@Example.test`,
		phone: `(63) 9${String(randomInt(0, 100_000_000)).padStart(8, "0")}`,
		password: PASSWORD,
		confirm: PASSWORD,
		acceptedTerms: true,
		termsVersion: 2,
		privacyVersion: 1,
		...overrides,
	};
}

describe("registerClientAction", () => {
	it("registers end to end with no confirmation e-mail", async () => {
		requestIp.current = `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
		const values = formValues();

		await expect(registerClientAction(values)).resolves.toEqual({ error: null });

		const email = values.email.toLowerCase();
		const user = await owner.query<{ id: string; email_verified: boolean }>(
			'select id, email_verified from "user" where email = $1',
			[email],
		);
		expect(user.rows).toHaveLength(1);
		expect(user.rows[0].email_verified).toBe(false);
		const userId = user.rows[0].id;

		const account = await owner.query<{ password: string }>(
			"select password from account where user_id = $1 and provider_id = 'credential'",
			[userId],
		);
		expect(account.rows).toHaveLength(1);
		expect(account.rows[0].password).not.toContain(PASSWORD);
		await expect(verifyPassword({ hash: account.rows[0].password, password: PASSWORD })).resolves.toBe(true);

		const profile = await owner.query(
			"select role, bureau_id, phone_e164 from profiles where id = $1",
			[userId],
		);
		expect(profile.rows[0]).toMatchObject({ role: "client", bureau_id: tenant.bureau.id });
		expect(profile.rows[0].phone_e164).toMatch(/^\+55639\d{8}$/);
		const holder = await owner.query("select document_digits from holders where client_profile_id = $1", [userId]);
		expect(holder.rows).toEqual([{ document_digits: onlyDigits(values.document) }]);
		const acceptances = await owner.query("select count(*)::int as n from legal_acceptances where profile_id = $1", [userId]);
		expect(acceptances.rows[0].n).toBe(2);

		const notifications = await owner.query("select 1 from notifications where reference = $1", [`profile:${userId}`]);
		expect(notifications.rows).toHaveLength(0);
		const challenges = await owner.query("select 1 from verification_challenges where profile_id = $1 and kind = 'email'", [userId]);
		expect(challenges.rows).toHaveLength(0);
	});

	it("refuses a second registration with the same e-mail", async () => {
		requestIp.current = `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
		const values = formValues();
		await expect(registerClientAction(values)).resolves.toEqual({ error: null });

		await expect(registerClientAction(formValues({ email: values.email }))).resolves.toEqual({
			error: "E-mail já cadastrado. Entre com sua senha ou recupere o acesso.",
		});
	});

	it("links the new account to the affiliate of a valid referral code", async () => {
		requestIp.current = `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
		const affiliateEmail = `${randomUUID()}@Example.test`;
		await expect(registerClientAction(formValues({ email: affiliateEmail }))).resolves.toEqual({ error: null });
		const affiliate = await owner.query<{ id: string; code: string }>(
			`select c.profile_id as id, c.code from affiliate_codes c join "user" u on u.id = c.profile_id::text where u.email = $1`,
			[affiliateEmail.toLowerCase()],
		);
		expect(affiliate.rows).toHaveLength(1);

		requestIp.current = `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
		const referred = formValues({ referralCode: affiliate.rows[0].code });
		await expect(registerClientAction(referred)).resolves.toEqual({ error: null });

		const link = await owner.query<{ affiliate_profile_id: string }>(
			`select r.affiliate_profile_id from affiliate_referrals r join "user" u on u.id = r.referred_profile_id::text where u.email = $1`,
			[referred.email.toLowerCase()],
		);
		expect(link.rows).toEqual([{ affiliate_profile_id: affiliate.rows[0].id }]);
	});

	it("completes the registration without a link when the ref is malformed", async () => {
		requestIp.current = `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
		const values = formValues({ referralCode: "NÃO-É-CÓDIGO" });

		await expect(registerClientAction(values)).resolves.toEqual({ error: null });

		const link = await owner.query(
			`select 1 from affiliate_referrals r join "user" u on u.id = r.referred_profile_id::text where u.email = $1`,
			[values.email.toLowerCase()],
		);
		expect(link.rows).toHaveLength(0);
		const user = await owner.query('select 1 from "user" where email = $1', [values.email.toLowerCase()]);
		expect(user.rows).toHaveLength(1);
	});
});
