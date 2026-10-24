// Contas de cliente (migração 021) contra um Postgres real: pool do dono para preparar e conferir,
// pool app_runtime para chamar as funções.
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import { randomCpf, seedClientProfile, seedTenant, withDbContext, type SeededTenant } from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });

const SITE_URL = "https://app.example.test";
const onlyDigits = (value: string) => value.replace(/\D/g, "");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const newToken = () => randomBytes(32).toString("base64url"); // 43 caracteres
const newCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");
const newPhone = () => `+55639${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
// Um IP por caso: o limite do cadastro é por IP e a tabela persiste entre execuções.
const newIp = () => `10.${randomInt(0, 256)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;

type Identity = { userId: string; role: string; bureauId: string };
type Registered = { userId: string; bureauId: string; digits: string; email: string; phone: string; token: string };
type RegisterArgs = {
	slug: string;
	type: string;
	name: string;
	digits: string;
	email: string;
	phone: string;
	termsVersion: number;
	privacyVersion: number;
	ip: string;
	userAgent: string;
	token: string;
	siteUrl: string;
};

let A: SeededTenant;
let B: SeededTenant;
const bureauIds: string[] = [];
const registered: Registered[] = [];
const secrets: string[] = [];

beforeAll(acquireClaimLock, 120_000);

beforeAll(async () => {
	[A, B] = await Promise.all([seedTenant(owner, "Acc A"), seedTenant(owner, "Acc B")]);
	bureauIds.push(A.bureau.id, B.bureau.id);
});

// Linhas de notificação são imutáveis (sem DELETE): encerra as pendentes para não vazarem para o claim de outro teste.
afterAll(async () => {
	await owner.query(
		`update notifications
        set status = 'suppressed', recipient = null, params = null, lease_id = null, locked_until = null
      where status in ('pending', 'sending') and bureau_id = any($1::uuid[])`,
		[bureauIds],
	);
	await Promise.all([owner.end(), app.end()]);
	await releaseClaimLock();
});

function baseArgs(slug: string, overrides: Partial<RegisterArgs> = {}): RegisterArgs {
	return {
		slug,
		type: "PF",
		name: "Maria Teste",
		digits: onlyDigits(randomCpf()),
		email: `${randomUUID()}@example.test`,
		phone: newPhone(),
		termsVersion: 2,
		privacyVersion: 1,
		ip: newIp(),
		userAgent: "vitest-agent/1.0",
		token: newToken(),
		siteUrl: SITE_URL,
		...overrides,
	};
}

async function callRegister(a: RegisterArgs) {
	const { rows } = await app.query<{ ok: boolean; reason: string | null; user_id: string | null }>(
		`select ok, reason, user_id from register_client($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::inet, $11, $12, $13)`,
		[
			a.slug, a.type, a.name, a.digits, a.email, a.phone, `hash-${randomBytes(16).toString("hex")}`,
			a.termsVersion, a.privacyVersion, a.ip, a.userAgent, a.token, a.siteUrl,
		],
	);
	return rows[0];
}

async function registerOk(tenant: SeededTenant, overrides: Partial<RegisterArgs> = {}): Promise<Registered> {
	const a = baseArgs(tenant.bureau.slug, overrides);
	const result = await callRegister(a);
	expect(result).toMatchObject({ ok: true, reason: null });
	const entry = {
		userId: result.user_id as string,
		bureauId: tenant.bureau.id,
		digits: a.digits,
		email: a.email.toLowerCase(),
		phone: a.phone,
		token: a.token,
	};
	registered.push(entry);
	secrets.push(a.token);
	return entry;
}

// Pedido de código por WhatsApp exige o e-mail confirmado.
async function registerVerified(tenant: SeededTenant): Promise<Registered> {
	const r = await registerOk(tenant);
	await owner.query('update "user" set email_verified = true where id = $1', [r.userId]);
	return r;
}

const clientOf = (r: Registered): Identity => ({ userId: r.userId, role: "client", bureauId: r.bureauId });

// Confirma a transação (withDbContext faz rollback): as funções gravam tentativas e desafios.
async function committed<T>(identity: Identity, work: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
              set_config('app.bureau_id', $3, true), set_config('app.support_session_id', '', true)`,
			[identity.userId, identity.role, identity.bureauId],
		);
		const result = await work(client);
		await client.query("commit");
		return result;
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

type Outcome = { ok: boolean; reason: string | null };

async function callAs(identity: Identity, sql: string, params: unknown[]): Promise<Outcome> {
	return committed(identity, async (client) => (await client.query<Outcome>(sql, params)).rows[0]);
}

const requestEmail = (r: Registered, token: string, identity = clientOf(r)) => {
	secrets.push(token);
	return callAs(identity, "select ok, reason from request_email_verification($1, $2, $3)", [r.userId, token, SITE_URL]);
};
const requestPhone = (r: Registered, phone: string, code: string, identity = clientOf(r)) => {
	secrets.push(code);
	return callAs(identity, "select ok, reason from request_phone_verification($1, $2, $3)", [r.userId, phone, code]);
};
const confirmPhone = (r: Registered, code: string) =>
	callAs(clientOf(r), "select ok, reason from confirm_phone_verification($1, $2)", [r.userId, code]);
const confirmEmail = async (token: string): Promise<Outcome> =>
	(await app.query<Outcome>("select ok, reason from confirm_email_verification($1)", [token])).rows[0];
const setChannel = (r: Registered, channel: string) =>
	callAs(clientOf(r), "select ok, reason from set_notification_channel($1, $2)", [r.userId, channel]);
const acceptLegal = (identity: Identity, terms: number, privacy: number) =>
	callAs(identity, "select ok, reason from accept_legal_documents($1, $2, $3, $4::inet, $5)", [
		identity.userId, terms, privacy, newIp(), "vitest-agent/1.0",
	]);

// Recua o relógio dos desafios: simula o tempo sem esperar.
async function ageChallenges(profileId: string, kind: "email" | "phone", interval = "2 minutes") {
	await owner.query(
		`update verification_challenges set created_at = created_at - $3::interval where profile_id = $1 and kind = $2`,
		[profileId, kind, interval],
	);
}

async function count(sql: string, params: unknown[]): Promise<number> {
	const { rows } = await owner.query<{ n: string }>(sql, params);
	return Number(rows[0].n);
}

const auditCount = (profileId: string, action: string) =>
	count("select count(*) as n from audit_logs where user_id = $1 and action = $2", [profileId, action]);

describe("register_client", () => {
	it("register_client creates every row in one transaction", async () => {
		const a = baseArgs(A.bureau.slug, { type: "PJ", digits: `${randomInt(10_000_000, 99_999_999)}000199`, name: "Empresa Teste" });
		const result = await callRegister(a);
		expect(result).toMatchObject({ ok: true, reason: null });
		const uid = result.user_id as string;
		registered.push({ userId: uid, bureauId: A.bureau.id, digits: a.digits, email: a.email, phone: a.phone, token: a.token });
		secrets.push(a.token);

		const user = await owner.query("select email, email_verified from \"user\" where id = $1", [uid]);
		expect(user.rows).toEqual([{ email: a.email, email_verified: false }]);
		expect(await count("select count(*) as n from account where user_id = $1 and provider_id = 'credential'", [uid])).toBe(1);
		const profile = await owner.query(
			"select role, bureau_id, phone_e164, notification_channel, phone_verified_at from profiles where id = $1",
			[uid],
		);
		expect(profile.rows).toEqual([
			{ role: "client", bureau_id: A.bureau.id, phone_e164: a.phone, notification_channel: "email", phone_verified_at: null },
		]);
		const wallet = await owner.query("select available, reserved from client_wallets where client_profile_id = $1", [uid]);
		expect(wallet.rows).toEqual([{ available: "0.00", reserved: "0.00" }]);
		const holder = await owner.query(
			"select type, document_digits, client_profile_id, created_by from holders where bureau_id = $1 and client_profile_id = $2",
			[A.bureau.id, uid],
		);
		expect(holder.rows).toEqual([{ type: "PJ", document_digits: a.digits, client_profile_id: uid, created_by: uid }]);
		const acceptances = await owner.query(
			`select d.kind, d.version, host(la.ip) as ip, la.user_agent
         from legal_acceptances la join legal_documents d on d.id = la.document_id
        where la.profile_id = $1 order by d.kind`,
			[uid],
		);
		expect(acceptances.rows).toEqual([
			{ kind: "privacy", version: 1, ip: a.ip, user_agent: a.userAgent },
			{ kind: "terms", version: 2, ip: a.ip, user_agent: a.userAgent },
		]);
		const audit = await owner.query(
			"select bureau_id, host(ip_address) as ip, user_agent, metadata from audit_logs where user_id = $1 and action = 'client.register'",
			[uid],
		);
		expect(audit.rows).toEqual([{ bureau_id: A.bureau.id, ip: a.ip, user_agent: a.userAgent, metadata: { type: "PJ" } }]);
		expect(await count("select count(*) as n from verification_challenges where profile_id = $1 and kind = 'email'", [uid])).toBe(1);
		expect(
			await count(
				`select count(*) as n from notifications n join notification_templates t on t.id = n.template_id
          where n.reference = $1 and t.key = 'email_verification' and n.channel = 'email' and n.status = 'pending'`,
				[`profile:${uid}`],
			),
		).toBe(1);
	});

	it("register_client enqueues email_verification with the token url and no document", async () => {
		const r = await registerOk(A);
		const { rows } = await owner.query<{ params: Record<string, string>; recipient: string; recipient_masked: string }>(
			"select params, recipient, recipient_masked from notifications where reference = $1",
			[`profile:${r.userId}`],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].params.url).toBe(`${SITE_URL}/cadastro/confirmar-email?token=${r.token}`);
		expect(rows[0].recipient).toBe(r.email);
		expect(Object.keys(rows[0].params).sort()).toEqual(["clientName", "url"]);
		for (const value of [...Object.values(rows[0].params), rows[0].recipient_masked]) {
			expect(value).not.toContain(r.digits);
		}
		const audit = await owner.query<{ metadata: unknown }>("select metadata from audit_logs where user_id = $1", [r.userId]);
		expect(JSON.stringify(audit.rows)).not.toContain(r.digits);
	});

	it("challenge stores only the sha256 of the secret", async () => {
		const r = await registerOk(A);
		const { rows } = await owner.query<{ code_hash: string; as_text: string }>(
			"select code_hash, c::text as as_text from verification_challenges c where profile_id = $1",
			[r.userId],
		);
		expect(rows).toHaveLength(1);
		expect(rows[0].code_hash).toBe(sha256(r.token));
		expect(rows[0].as_text).not.toContain(r.token);

		const code = newCode();
		await owner.query('update "user" set email_verified = true where id = $1', [r.userId]);
		await requestPhone(r, newPhone(), code);
		const phone = await owner.query<{ code_hash: string; as_text: string }>(
			"select code_hash, c::text as as_text from verification_challenges c where profile_id = $1 and kind = 'phone'",
			[r.userId],
		);
		expect(phone.rows[0].code_hash).toBe(sha256(code));
		expect(phone.rows[0].as_text).not.toContain(code);
	});

	it("email challenge failure rolls back the whole registration", async () => {
		const a = baseArgs(A.bureau.slug, { siteUrl: "ftp://x" });
		await expect(callRegister(a)).rejects.toThrow(/email challenge failed/);
		expect(await count('select count(*) as n from "user" where lower(email) = $1', [a.email])).toBe(0);
		expect(await count("select count(*) as n from holders where bureau_id = $1 and document_digits = $2", [A.bureau.id, a.digits])).toBe(0);
	});

	it("document already in the bureau is refused with and without client_profile_id", async () => {
		const linked = await callRegister(baseArgs(A.bureau.slug, { digits: onlyDigits(A.holder.document) }));
		expect(linked).toMatchObject({ ok: false, reason: "document_in_use" });

		const loose = onlyDigits(randomCpf());
		await owner.query(
			"insert into holders (bureau_id, type, name, document, created_by) values ($1, 'PF', 'Sem conta', $2, $3)",
			[A.bureau.id, loose, A.bureauAdmin.userId],
		);
		const unlinked = await callRegister(baseArgs(A.bureau.slug, { digits: loose }));
		expect(unlinked).toMatchObject({ ok: false, reason: "document_in_use" });
	});

	it("same document registers in another bureau with another email", async () => {
		const first = await registerOk(A);
		await registerOk(B, { digits: first.digits });
		const sameEmail = await callRegister(baseArgs(B.bureau.slug, { email: first.email }));
		expect(sameEmail).toMatchObject({ ok: false, reason: "email_in_use" });
		const upper = await callRegister(baseArgs(B.bureau.slug, { email: first.email.toUpperCase() }));
		expect(upper).toMatchObject({ ok: false, reason: "email_in_use" });
	});

	it("rejects an unknown or inactive bureau, outdated terms and invalid input", async () => {
		expect(await callRegister(baseArgs("nao-existe-xyz"))).toMatchObject({ ok: false, reason: "bureau_not_found" });

		const inactive = await seedTenant(owner, "Acc inactive");
		bureauIds.push(inactive.bureau.id);
		await owner.query("update bureaus set status = 'inactive' where id = $1", [inactive.bureau.id]);
		expect(await callRegister(baseArgs(inactive.bureau.slug))).toMatchObject({ ok: false, reason: "bureau_not_found" });

		expect(await callRegister(baseArgs(A.bureau.slug, { termsVersion: 0 }))).toMatchObject({ ok: false, reason: "outdated_terms" });
		expect(await callRegister(baseArgs(A.bureau.slug, { privacyVersion: 0 }))).toMatchObject({ ok: false, reason: "outdated_terms" });

		const cpf10 = baseArgs(A.bureau.slug, { digits: onlyDigits(randomCpf()).slice(1) });
		expect(await callRegister(cpf10)).toMatchObject({ ok: false, reason: "invalid_input" });
		const pj11 = baseArgs(A.bureau.slug, { type: "PJ", digits: onlyDigits(randomCpf()) });
		expect(await callRegister(pj11)).toMatchObject({ ok: false, reason: "invalid_input" });
		const noPlus = baseArgs(A.bureau.slug, { phone: newPhone().slice(1) });
		expect(await callRegister(noPlus)).toMatchObject({ ok: false, reason: "invalid_input" });
	});

	it("11th attempt from the same ip in one hour is rate_limited", async () => {
		const ip = newIp();
		for (let i = 0; i < 10; i += 1) {
			const result = await callRegister(baseArgs(A.bureau.slug, { ip, type: "XX" }));
			expect(result).toMatchObject({ ok: false, reason: "invalid_input" });
		}
		const eleventh = await callRegister(baseArgs(A.bureau.slug, { ip }));
		expect(eleventh).toMatchObject({ ok: false, reason: "rate_limited" });
		const other = baseArgs(A.bureau.slug, { ip: newIp() });
		expect(await callRegister(other)).toMatchObject({ ok: true });
	});

	it("ip allowed goes false after 10 attempts", async () => {
		const ip = newIp();
		const allowed = async () =>
			(await app.query<{ ok: boolean }>("select client_register_ip_allowed($1::inet) as ok", [ip])).rows[0].ok;
		expect(await allowed()).toBe(true);
		for (let i = 0; i < 10; i += 1) {
			expect(await callRegister(baseArgs(A.bureau.slug, { ip, type: "XX" }))).toMatchObject({ reason: "invalid_input" });
		}
		expect(await allowed()).toBe(false);
		// A consulta não grava tentativa.
		expect(await count("select count(*) as n from client_register_attempts where ip = $1::inet", [ip])).toBe(10);
	});

	it("two addresses in the same ipv6 /64 share the limit", async () => {
		const prefix = `2001:db8:${randomInt(1, 65_535).toString(16)}:${randomInt(1, 65_535).toString(16)}`;
		for (let i = 0; i < 10; i += 1) {
			const result = await callRegister(baseArgs(A.bureau.slug, { ip: `${prefix}::${i + 1}`, type: "XX" }));
			expect(result).toMatchObject({ ok: false, reason: "invalid_input" });
		}
		expect(await callRegister(baseArgs(A.bureau.slug, { ip: `${prefix}:0:0:0:ffff` }))).toMatchObject({
			ok: false,
			reason: "rate_limited",
		});
		const elsewhere = `2001:db8:${randomInt(1, 65_535).toString(16)}:${randomInt(1, 65_535).toString(16)}::1`;
		expect(await callRegister(baseArgs(A.bureau.slug, { ip: elsewhere }))).toMatchObject({ ok: true });
	});
});

describe("email verification", () => {
	it("confirm_email_verification confirms, audits, and a second click is ok", async () => {
		const r = await registerOk(A);
		expect(await confirmEmail(r.token)).toEqual({ ok: true, reason: null });
		const user = await owner.query("select email_verified from \"user\" where id = $1", [r.userId]);
		expect(user.rows[0].email_verified).toBe(true);
		expect(await auditCount(r.userId, "client.email_verified")).toBe(1);
		expect(await confirmEmail(r.token)).toEqual({ ok: true, reason: null });
		expect(await auditCount(r.userId, "client.email_verified")).toBe(1);
	});

	it("confirm_email_verification refuses unknown, malformed and expired tokens", async () => {
		expect(await confirmEmail(newToken())).toEqual({ ok: false, reason: "invalid" });
		expect(await confirmEmail("abc")).toEqual({ ok: false, reason: "invalid" });
		const r = await registerOk(A);
		await owner.query("update verification_challenges set expires_at = now() - interval '1 minute' where profile_id = $1", [r.userId]);
		expect(await confirmEmail(r.token)).toEqual({ ok: false, reason: "expired" });
		const user = await owner.query("select email_verified from \"user\" where id = $1", [r.userId]);
		expect(user.rows[0].email_verified).toBe(false);
	});

	it("a new request invalidates the previous link", async () => {
		const r = await registerOk(A);
		await ageChallenges(r.userId, "email");
		const second = newToken();
		expect(await requestEmail(r, second)).toEqual({ ok: true, reason: null });
		expect(await confirmEmail(r.token)).toEqual({ ok: false, reason: "invalid" });
		expect(await confirmEmail(second)).toEqual({ ok: true, reason: null });
	});

	it("resend respects 60 s cooldown and 5 per hour, and refuses a verified email", async () => {
		const r = await registerOk(A);
		expect(await requestEmail(r, newToken())).toEqual({ ok: false, reason: "cooldown" });
		for (let i = 0; i < 4; i += 1) {
			await ageChallenges(r.userId, "email");
			expect(await requestEmail(r, newToken())).toEqual({ ok: true, reason: null });
		}
		await ageChallenges(r.userId, "email");
		expect(await requestEmail(r, newToken())).toEqual({ ok: false, reason: "too_many" });

		const done = await registerOk(A);
		await confirmEmail(done.token);
		expect(await requestEmail(done, newToken())).toEqual({ ok: false, reason: "already_verified" });
	});

	it("request_email_verification refuses another user, a malformed token and a bad site url", async () => {
		const r = await registerOk(A);
		const other = await registerOk(A);
		await ageChallenges(r.userId, "email");
		expect(await requestEmail(r, newToken(), clientOf(other))).toEqual({ ok: false, reason: "not_allowed" });
		expect(await requestEmail(r, "curto")).toEqual({ ok: false, reason: "invalid_input" });
		const badUrl = await callAs(clientOf(r), "select ok, reason from request_email_verification($1, $2, $3)", [
			r.userId, newToken(), "ftp://x",
		]);
		expect(badUrl).toEqual({ ok: false, reason: "invalid_input" });
		const noContext = await app.query("select ok, reason from request_email_verification($1, $2, $3)", [r.userId, newToken(), SITE_URL]);
		expect(noContext.rows[0]).toEqual({ ok: false, reason: "not_allowed" });
	});
});

describe("phone verification", () => {
	it("request_phone_verification creates the challenge and the whatsapp notification", async () => {
		const r = await registerVerified(A);
		const code = newCode();
		expect(await requestPhone(r, r.phone, code)).toEqual({ ok: true, reason: null });
		const challenge = await owner.query(
			"select target, attempts, max_attempts from verification_challenges where profile_id = $1 and kind = 'phone'",
			[r.userId],
		);
		expect(challenge.rows).toEqual([{ target: r.phone, attempts: 0, max_attempts: 5 }]);
		const note = await owner.query(
			`select n.params, n.recipient, n.channel from notifications n join notification_templates t on t.id = n.template_id
        where n.reference = $1 and t.key = 'phone_verification'`,
			[`profile:${r.userId}`],
		);
		expect(note.rows).toEqual([{ params: { code }, recipient: r.phone, channel: "whatsapp" }]);
		expect(await auditCount(r.userId, "client.phone_verification_requested")).toBe(1);
	});

	it("request_phone_verification refuses other users, other roles and no context", async () => {
		const r = await registerVerified(A);
		const other = await registerVerified(A);
		expect(await requestPhone(r, r.phone, newCode(), clientOf(other))).toEqual({ ok: false, reason: "not_allowed" });
		const operator: Identity = { userId: A.operator.userId, role: "operator", bureauId: A.bureau.id };
		const asOperator = await callAs(operator, "select ok, reason from request_phone_verification($1, $2, $3)", [
			A.operator.userId, r.phone, newCode(),
		]);
		expect(asOperator).toEqual({ ok: false, reason: "not_allowed" });
		const bare = await app.query("select ok, reason from request_phone_verification($1, $2, $3)", [r.userId, r.phone, newCode()]);
		expect(bare.rows[0]).toEqual({ ok: false, reason: "not_allowed" });
		expect(await requestPhone(r, "11999999999", newCode())).toEqual({ ok: false, reason: "invalid_input" });
		expect(await requestPhone(r, r.phone, "12345")).toEqual({ ok: false, reason: "invalid_input" });
		expect(await count("select count(*) as n from verification_challenges where profile_id = $1 and kind = 'phone'", [r.userId])).toBe(0);
	});

	it("phone request is refused until the email is verified", async () => {
		const r = await registerOk(A);
		expect(await requestPhone(r, r.phone, newCode())).toEqual({ ok: false, reason: "email_not_verified" });
		expect(await count("select count(*) as n from verification_challenges where profile_id = $1 and kind = 'phone'", [r.userId])).toBe(0);
		await confirmEmail(r.token);
		expect(await requestPhone(r, r.phone, newCode())).toEqual({ ok: true, reason: null });
	});

	it("phone request refuses a non-Brazilian or landline number", async () => {
		const r = await registerVerified(A);
		for (const phone of ["+14155552671", "+556332221234", "+5563899991234", "+55639999912345"]) {
			expect(await requestPhone(r, phone, newCode())).toEqual({ ok: false, reason: "invalid_input" });
		}
		expect(await count("select count(*) as n from verification_challenges where profile_id = $1 and kind = 'phone'", [r.userId])).toBe(0);
	});

	it("sixth code to the same target number in one hour is too_many", async () => {
		const target = newPhone();
		const first = await registerVerified(A);
		expect(await requestPhone(first, target, newCode())).toEqual({ ok: true, reason: null });
		for (let i = 0; i < 4; i += 1) {
			await ageChallenges(first.userId, "phone");
			expect(await requestPhone(first, target, newCode())).toEqual({ ok: true, reason: null });
		}
		const second = await registerVerified(A);
		expect(await requestPhone(second, target, newCode())).toEqual({ ok: false, reason: "too_many" });
		const profile = await owner.query("select phone_e164 from profiles where id = $1", [second.userId]);
		expect(profile.rows[0].phone_e164).toBe(second.phone);
	});

	it("resend respects 60 s cooldown and 5 per hour, and refuses a verified phone", async () => {
		const r = await registerVerified(A);
		expect(await requestPhone(r, r.phone, newCode())).toEqual({ ok: true, reason: null });
		expect(await requestPhone(r, r.phone, newCode())).toEqual({ ok: false, reason: "cooldown" });
		for (let i = 0; i < 4; i += 1) {
			await ageChallenges(r.userId, "phone");
			expect(await requestPhone(r, r.phone, newCode())).toEqual({ ok: true, reason: null });
		}
		await ageChallenges(r.userId, "phone");
		expect(await requestPhone(r, r.phone, newCode())).toEqual({ ok: false, reason: "too_many" });
		// Pedido recusado não muda o telefone.
		expect(await requestPhone(r, newPhone(), newCode())).toEqual({ ok: false, reason: "too_many" });
		const profile = await owner.query("select phone_e164 from profiles where id = $1", [r.userId]);
		expect(profile.rows[0].phone_e164).toBe(r.phone);

		const done = await registerVerified(A);
		const code = newCode();
		await requestPhone(done, done.phone, code);
		await confirmPhone(done, code);
		expect(await requestPhone(done, done.phone, newCode())).toEqual({ ok: false, reason: "already_verified" });
	});

	it("new phone clears verification and resets channel to email", async () => {
		const r = await registerVerified(A);
		const code = newCode();
		await requestPhone(r, r.phone, code);
		expect(await confirmPhone(r, code)).toEqual({ ok: true, reason: null });
		expect(await setChannel(r, "whatsapp")).toEqual({ ok: true, reason: null });

		await ageChallenges(r.userId, "phone");
		const next = newPhone();
		expect(await requestPhone(r, next, newCode())).toEqual({ ok: true, reason: null });
		const profile = await owner.query("select phone_e164, phone_verified_at, notification_channel from profiles where id = $1", [r.userId]);
		expect(profile.rows).toEqual([{ phone_e164: next, phone_verified_at: null, notification_channel: "email" }]);
		const audit = await owner.query<{ metadata: unknown }>(
			"select metadata from audit_logs where user_id = $1 and action = 'client.phone_verification_requested' order by created_at",
			[r.userId],
		);
		expect(audit.rows.map((row) => row.metadata)).toEqual([{ phoneChanged: false }, { phoneChanged: true }]);
	});

	it("confirm_phone_verification confirms with the right code and audits", async () => {
		const r = await registerVerified(A);
		const code = newCode();
		await requestPhone(r, r.phone, code);
		expect(await confirmPhone(r, code)).toEqual({ ok: true, reason: null });
		const profile = await owner.query("select phone_verified_at is not null as verified from profiles where id = $1", [r.userId]);
		expect(profile.rows[0].verified).toBe(true);
		expect(await auditCount(r.userId, "client.phone_verified")).toBe(1);
		// O desafio foi consumido: o mesmo código não vale duas vezes.
		expect(await confirmPhone(r, code)).toEqual({ ok: false, reason: "invalid" });
	});

	it("fifth wrong code consumes the challenge", async () => {
		const r = await registerVerified(A);
		const code = "111111";
		await requestPhone(r, r.phone, code);
		for (let i = 0; i < 4; i += 1) {
			expect(await confirmPhone(r, "222222")).toEqual({ ok: false, reason: "invalid" });
		}
		expect(await confirmPhone(r, "222222")).toEqual({ ok: false, reason: "too_many_attempts" });
		expect(await confirmPhone(r, code)).toEqual({ ok: false, reason: "invalid" });
		const profile = await owner.query("select phone_verified_at from profiles where id = $1", [r.userId]);
		expect(profile.rows[0].phone_verified_at).toBeNull();
	});

	it("expired code is refused", async () => {
		const r = await registerVerified(A);
		const code = newCode();
		await requestPhone(r, r.phone, code);
		await owner.query("update verification_challenges set expires_at = now() - interval '1 minute' where profile_id = $1 and kind = 'phone'", [r.userId]);
		expect(await confirmPhone(r, code)).toEqual({ ok: false, reason: "expired" });
	});

	it("a right code for a challenge whose phone changed is invalid", async () => {
		const r = await registerVerified(A);
		const code = newCode();
		await requestPhone(r, r.phone, code);
		// O dono do teste não está na lista do trigger protect_profile_contact: replica desliga o trigger só nesta transação.
		const tx = await owner.connect();
		try {
			await tx.query("begin");
			await tx.query("set local session_replication_role = replica");
			await tx.query("update profiles set phone_e164 = $2 where id = $1", [r.userId, newPhone()]);
			await tx.query("commit");
		} finally {
			tx.release();
		}
		expect(await confirmPhone(r, code)).toEqual({ ok: false, reason: "invalid" });
	});

	it("confirm_phone_verification refuses other users and malformed codes", async () => {
		const r = await registerVerified(A);
		const other = await registerVerified(A);
		const code = newCode();
		await requestPhone(r, r.phone, code);
		const asOther = await callAs(clientOf(other), "select ok, reason from confirm_phone_verification($1, $2)", [r.userId, code]);
		expect(asOther).toEqual({ ok: false, reason: "not_allowed" });
		expect(await confirmPhone(r, "12ab56")).toEqual({ ok: false, reason: "invalid" });
	});
});

describe("notification channel", () => {
	it("set_notification_channel needs a verified phone, audits once and ignores a repeat", async () => {
		const r = await registerVerified(A);
		expect(await setChannel(r, "whatsapp")).toEqual({ ok: false, reason: "phone_not_verified" });
		expect(await setChannel(r, "sms")).toEqual({ ok: false, reason: "invalid_input" });

		const code = newCode();
		await requestPhone(r, r.phone, code);
		await confirmPhone(r, code);
		expect(await setChannel(r, "whatsapp")).toEqual({ ok: true, reason: null });
		const profile = await owner.query("select notification_channel from profiles where id = $1", [r.userId]);
		expect(profile.rows[0].notification_channel).toBe("whatsapp");
		expect(await auditCount(r.userId, "client.notification_channel_set")).toBe(1);

		expect(await setChannel(r, "whatsapp")).toEqual({ ok: true, reason: null });
		expect(await auditCount(r.userId, "client.notification_channel_set")).toBe(1);
		expect(await setChannel(r, "email")).toEqual({ ok: true, reason: null });
		expect(await auditCount(r.userId, "client.notification_channel_set")).toBe(2);
	});
});

describe("legal acceptance", () => {
	it("accept_legal_documents records both acceptances once and audits once", async () => {
		const client = await seedClientProfile(owner, A.bureau.id);
		expect(await acceptLegal(client, 2, 1)).toEqual({ ok: true, reason: null });
		const countAcceptances = () => count("select count(*) as n from legal_acceptances where profile_id = $1", [client.userId]);
		expect(await countAcceptances()).toBe(2);
		expect(await auditCount(client.userId, "client.legal_accepted")).toBe(1);
		const audit = await owner.query<{ metadata: unknown }>("select metadata from audit_logs where user_id = $1 and action = 'client.legal_accepted'", [client.userId]);
		expect(audit.rows[0].metadata).toEqual({ termsVersion: 2, privacyVersion: 1 });

		expect(await acceptLegal(client, 2, 1)).toEqual({ ok: true, reason: null });
		expect(await countAcceptances()).toBe(2);
		expect(await auditCount(client.userId, "client.legal_accepted")).toBe(1);
	});

	it("acceptance of an outdated version is refused", async () => {
		const client = await seedClientProfile(owner, A.bureau.id);
		expect(await acceptLegal(client, 0, 1)).toEqual({ ok: false, reason: "outdated" });
		expect(await acceptLegal(client, 2, 0)).toEqual({ ok: false, reason: "outdated" });
		expect(await count("select count(*) as n from legal_acceptances where profile_id = $1", [client.userId])).toBe(0);
		const other = await seedClientProfile(owner, A.bureau.id);
		const asOther = await callAs(other, "select ok, reason from accept_legal_documents($1, 2, 1, null, null)", [client.userId]);
		expect(asOther).toEqual({ ok: false, reason: "not_allowed" });
	});

	// Mesma consulta de getClientAccountStatus (Task 3), sob a identidade e as políticas do cliente.
	const termsAccepted = async (client: PoolClient, userId: string) =>
		(
			await client.query<{ accepted: boolean }>(
				`select not exists (
           select 1
             from (select distinct on (d.kind) d.id from legal_documents d
                    where d.published_at <= now() and d.kind in ('terms', 'privacy')
                    order by d.kind, d.version desc) cur
            where not exists (select 1 from legal_acceptances a where a.profile_id = $1 and a.document_id = cur.id)
         ) as accepted`,
				[userId],
			)
		).rows[0].accepted;

	it("new version requires a new acceptance", async () => {
		const r = await registerOk(A);
		const ownerTx = await owner.connect();
		try {
			await ownerTx.query("begin");
			await ownerTx.query("insert into legal_documents (kind, version, title, body_md) values ('terms', 3, 'Termos v3', 'v3')");
			const current = await ownerTx.query<{ v: number }>("select legal_current_version('terms') as v");
			expect(current.rows[0].v).toBe(3);
			await ownerTx.query("set local role app_runtime");
			await ownerTx.query(
				`select set_config('app.user_id', $1, true), set_config('app.user_role', 'client', true),
                set_config('app.bureau_id', $2, true), set_config('app.support_session_id', '', true)`,
				[r.userId, r.bureauId],
			);
			expect(await termsAccepted(ownerTx, r.userId)).toBe(false);
			const old = await ownerTx.query("select ok, reason from accept_legal_documents($1, 2, 1, null, null)", [r.userId]);
			expect(old.rows[0]).toEqual({ ok: false, reason: "outdated" });
			const next = await ownerTx.query("select ok, reason from accept_legal_documents($1, 3, 1, null, null)", [r.userId]);
			expect(next.rows[0]).toEqual({ ok: true, reason: null });
			expect(await termsAccepted(ownerTx, r.userId)).toBe(true);
		} finally {
			await ownerTx.query("rollback");
			ownerTx.release();
		}
		await withDbContext(app, clientOf(r), async (client) => {
			expect(await termsAccepted(client, r.userId)).toBe(true);
		});
	});
});

describe("audit hygiene", () => {
	it("audit metadata has no document, raw email, raw phone, token or code", async () => {
		expect(registered.length).toBeGreaterThan(5);
		const { rows } = await owner.query<{ blob: string }>(
			`select concat_ws('|', action, table_name, metadata::text, coalesce(user_agent, '')) as blob
         from audit_logs where user_id = any($1::uuid[])`,
			[registered.map((r) => r.userId)],
		);
		expect(rows.length).toBeGreaterThan(registered.length);
		const sensitive = [
			...registered.flatMap((r) => [r.digits, r.email, r.phone, r.token]),
			...secrets,
		];
		for (const row of rows) {
			for (const value of sensitive) expect(row.blob).not.toContain(value);
		}
	});
});
