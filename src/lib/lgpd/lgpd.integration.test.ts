// Retenção LGPD contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.
// As varreduras técnicas são globais: os testes contam só as linhas que eles mesmos semeiam.

import { randomBytes, randomUUID } from "node:crypto";

import { Client, Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

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

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { pool } from "@/lib/db/pool";
import type { DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	randomCpf,
	seedClientWalletTopup,
	seedDossier,
	seedExpiredChallenge,
	seedExpiredSession,
	seedRegisterAttempt,
	seedTenant,
	type SeededTenant,
} from "@/test/seed";

import { exportHolder } from "./export";
import { anonymizeClientAccount, anonymizeHolder, purgeBureauData, purgeTechnicalData } from "./queries";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const REASON = "Pedido do titular por e-mail";
const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);

type Graph = {
	holderId: string;
	dossierId: string;
	consultationId: string;
	authCode: string;
	consentIp: string;
};

// Titular PF com dossiê concluído, consulta, payload, resultado, parecer, nota, linha do tempo, pedido e SCR.
async function seedHolderGraph(
	tenant: SeededTenant,
	options: { orderState?: string; name?: string } = {},
): Promise<Graph> {
	const bureauId = tenant.bureau.id;
	const adminId = tenant.bureauAdmin.userId;
	const holder = await owner.query<{ id: string }>(
		`insert into holders (bureau_id, type, name, document, email, phone, address, city, state, zip_code, notes, created_by)
     values ($1, 'PF', $2, $3, 'pessoa@example.test', '11999990000', 'Rua das Flores', 'Sao Paulo', 'SP', '01001000',
             'observacao interna', $4) returning id`,
		[bureauId, options.name ?? `Titular ${randomBytes(4).toString("hex")}`, randomCpf(), adminId],
	);
	const holderId = holder.rows[0].id;
	const dossierId = await seedDossier(owner, { bureauId, holderId, createdBy: adminId });
	await owner.query(
		`update dossiers set status = 'completed', completed_at = now(), report_markdown = 'parecer',
            full_report = '{"x":1}'::jsonb, executive_summary = 'resumo' where id = $1`,
		[dossierId],
	);
	const consultation = await owner.query<{ id: string }>(
		`insert into consultations (bureau_id, type, document, document_name, product, holder_id, dossier_id, created_by,
         status, scr_email, observations, consulted_at)
     values ($1, 'PF', $2, 'Nome Consultado', 'smart_pf', $3, $4, $5, 'completed', 'scr@example.test', 'obs', now())
     returning id`,
		[bureauId, randomCpf(), holderId, dossierId, adminId],
	);
	const consultationId = consultation.rows[0].id;
	const payload = await owner.query<{ id: string }>(
		`insert into bureau_payloads (bureau_id, consultation_id, provider, product, received_at, http_status, payload,
         payload_sha256, validation_status)
     values ($1, $2, 'deps', 'smart_pf', now(), 200, '{"cpf":"x"}'::jsonb, $3, 'valid') returning id`,
		[bureauId, consultationId, randomBytes(32).toString("hex")],
	);
	await owner.query(
		`insert into bureau_results (bureau_id, consultation_id, payload_id, adapter_version, canonical_result, document, person_name)
     values ($1, $2, $3, 1, '{"score":700}'::jsonb, $4, 'Nome Consultado')`,
		[bureauId, consultationId, payload.rows[0].id, randomCpf()],
	);
	await owner.query(
		`insert into ai_reports (bureau_id, consultation_id, holder_id, report_markdown, executive_summary, full_report, status)
     values ($1, $2, $3, 'parecer ia', 'resumo ia', '{"y":2}'::jsonb, 'completed')`,
		[bureauId, consultationId, holderId],
	);
	await owner.query(
		"insert into crm_notes (bureau_id, entity_type, entity_id, content, created_by) values ($1, 'holder', $2, 'nota privada', $3)",
		[bureauId, holderId, adminId],
	);
	await owner.query(
		`insert into timeline_events (bureau_id, entity_type, entity_id, event_type, title, description, metadata, created_by)
     values ($1, 'holder', $2, 'holder.created', 'Titular criado', 'detalhe pessoal', '{"k":"v"}'::jsonb, $3)`,
		[bureauId, holderId, adminId],
	);
	await owner.query(
		`insert into dossier_orders (dossier_id, bureau_id, mode, product_code, subject_name, subject_document_masked, state, created_by)
     values ($1, $2, 'counter', 'consulta_pf', 'Nome Real do Titular', '***.000.000-**', $3, $4)`,
		[dossierId, bureauId, options.orderState ?? "completed", adminId],
	);
	const authCode = `AUTH-${randomBytes(6).toString("hex")}`;
	const consentIp = "198.51.100.23";
	await owner.query(
		`insert into scr_authorizations (bureau_id, document, type, name, email, consultation_id, holder_id, status, channel,
         auth_code, consent_ip, expires_at)
     values ($1, $2, 'PF', 'Nome SCR', 'scr@example.test', $3, $4, 'authorized', 'internal', $5, $6, now() + interval '1 day')`,
		[bureauId, randomCpf(), consultationId, holderId, authCode, consentIp],
	);
	return { holderId, dossierId, consultationId, authCode, consentIp };
}

async function count(sql: string, params: unknown[]): Promise<number> {
	const { rows } = await owner.query<{ n: string }>(sql, params);
	return Number(rows[0].n);
}

async function auditRows(bureauId: string, action: string) {
	const { rows } = await owner.query<{ metadata: Record<string, unknown>; record_id: string | null }>(
		"select metadata, record_id from audit_logs where bureau_id = $1 and action = $2",
		[bureauId, action],
	);
	return rows;
}

const adminOf = (tenant: SeededTenant): DbIdentity => ({ ...tenant.bureauAdmin });

describe("anonymizeHolder", () => {
	it("anonymize clears identification payloads results and opinions", async () => {
		const tenant = await seedTenant(owner, "lgpd-clear");
		const g = await seedHolderGraph(tenant);

		expect(await anonymizeHolder(adminOf(tenant), { holderId: g.holderId, reason: REASON })).toEqual({ ok: true });

		const { rows } = await owner.query(
			`select name, document, document_digits, email, phone, address, city, state, zip_code, notes, anonymized_at
         from holders where id = $1`,
			[g.holderId],
		);
		expect(rows[0]).toMatchObject({
			name: "Titular anonimizado",
			document: null,
			document_digits: null,
			email: null,
			phone: null,
			address: null,
			city: null,
			state: null,
			zip_code: null,
			notes: null,
		});
		expect(rows[0].anonymized_at).not.toBeNull();

		const consultation = await owner.query(
			"select document, document_name, scr_email, observations from consultations where id = $1",
			[g.consultationId],
		);
		expect(consultation.rows[0]).toEqual({ document: null, document_name: null, scr_email: null, observations: null });
		expect(await count("select count(*) as n from bureau_payloads where consultation_id = $1", [g.consultationId])).toBe(0);
		expect(await count("select count(*) as n from bureau_results where consultation_id = $1", [g.consultationId])).toBe(0);

		const ai = await owner.query("select report_markdown, executive_summary, full_report from ai_reports where consultation_id = $1", [
			g.consultationId,
		]);
		expect(ai.rows[0]).toEqual({ report_markdown: null, executive_summary: null, full_report: null });
		const dossier = await owner.query("select report_markdown, executive_summary, full_report from dossiers where id = $1", [
			g.dossierId,
		]);
		expect(dossier.rows[0]).toEqual({ report_markdown: null, executive_summary: null, full_report: null });

		expect(await count("select count(*) as n from crm_notes where entity_id = $1", [g.holderId])).toBe(0);
		const events = await owner.query(
			"select description, metadata from timeline_events where entity_id = $1 and event_type = 'holder.created'",
			[g.holderId],
		);
		expect(events.rows[0]).toEqual({ description: null, metadata: null });
		const order = await owner.query("select subject_name from dossier_orders where dossier_id = $1", [g.dossierId]);
		expect(order.rows[0].subject_name).toBe("Titular anonimizado");
	});

	it("anonymize refuses an open order", async () => {
		const tenant = await seedTenant(owner, "lgpd-open");
		const g = await seedHolderGraph(tenant, { orderState: "ready" });

		expect(await anonymizeHolder(adminOf(tenant), { holderId: g.holderId, reason: REASON })).toEqual({
			ok: false,
			reason: "open_orders",
		});
		const { rows } = await owner.query("select anonymized_at, document from holders where id = $1", [g.holderId]);
		expect(rows[0].anonymized_at).toBeNull();
		expect(rows[0].document).not.toBeNull();
	});

	it("anonymize keeps scr authorizations ledger and audit", async () => {
		const tenant = await seedTenant(owner, "lgpd-keep");
		const g = await seedHolderGraph(tenant);
		await seedClientWalletTopup(owner, { clientProfileId: tenant.client.userId, amount: "10.00", createdBy: tenant.bureauAdmin.userId });
		const snapshot = async () => ({
			scr: await count("select count(*) as n from scr_authorizations where bureau_id = $1", [tenant.bureau.id]),
			ledger: await count("select count(*) as n from client_ledger_entries where bureau_id = $1", [tenant.bureau.id]),
			audit: await count("select count(*) as n from audit_logs where bureau_id = $1 and action <> 'lgpd.anonymize_holder'", [
				tenant.bureau.id,
			]),
			orders: await count("select count(*) as n from dossier_orders where bureau_id = $1", [tenant.bureau.id]),
		});
		const before = await snapshot();
		expect(before.scr).toBe(1);

		await anonymizeHolder(adminOf(tenant), { holderId: g.holderId, reason: REASON });

		expect(await snapshot()).toEqual(before);
	});

	it("anonymize twice returns already_anonymized", async () => {
		const tenant = await seedTenant(owner, "lgpd-twice");
		const g = await seedHolderGraph(tenant);

		await anonymizeHolder(adminOf(tenant), { holderId: g.holderId, reason: REASON });
		expect(await anonymizeHolder(adminOf(tenant), { holderId: g.holderId, reason: REASON })).toEqual({
			ok: false,
			reason: "already_anonymized",
		});
	});

	it("another bureau gets not_found", async () => {
		const tenant = await seedTenant(owner, "lgpd-a");
		const other = await seedTenant(owner, "lgpd-b");
		const g = await seedHolderGraph(tenant);

		expect(await anonymizeHolder(adminOf(other), { holderId: g.holderId, reason: REASON })).toEqual({
			ok: false,
			reason: "not_found",
		});
		const { rows } = await owner.query("select anonymized_at from holders where id = $1", [g.holderId]);
		expect(rows[0].anonymized_at).toBeNull();
	});

	it("anonymize is refused to an operator", async () => {
		const tenant = await seedTenant(owner, "lgpd-operator");
		const g = await seedHolderGraph(tenant);

		expect(await anonymizeHolder({ ...tenant.operator }, { holderId: g.holderId, reason: REASON })).toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("anonymize writes an audit event with the reason", async () => {
		const tenant = await seedTenant(owner, "lgpd-audit");
		const g = await seedHolderGraph(tenant);

		await anonymizeHolder(adminOf(tenant), { holderId: g.holderId, reason: REASON });

		const rows = await auditRows(tenant.bureau.id, "lgpd.anonymize_holder");
		expect(rows).toHaveLength(1);
		expect(rows[0].record_id).toBe(g.holderId);
		expect(rows[0].metadata).toEqual({ reason: REASON });
	});

	it("a failed anonymization writes no audit event", async () => {
		const tenant = await seedTenant(owner, "lgpd-noaudit");
		const g = await seedHolderGraph(tenant, { orderState: "ready" });

		await anonymizeHolder(adminOf(tenant), { holderId: g.holderId, reason: REASON });

		expect(await auditRows(tenant.bureau.id, "lgpd.anonymize_holder")).toHaveLength(0);
	});
});

describe("anonymizeClientAccount", () => {
	it("client account anonymize refuses non zero balance", async () => {
		const tenant = await seedTenant(owner, "lgpd-bal");
		await seedClientWalletTopup(owner, { clientProfileId: tenant.client.userId, amount: "25.00", createdBy: tenant.bureauAdmin.userId });

		expect(await anonymizeClientAccount(adminOf(tenant), { profileId: tenant.client.userId, reason: REASON })).toEqual({
			ok: false,
			reason: "balance",
		});
		const { rows } = await owner.query("select is_active, anonymized_at from profiles where id = $1", [tenant.client.userId]);
		expect(rows[0]).toEqual({ is_active: true, anonymized_at: null });
	});

	it("client account anonymize refuses an open order", async () => {
		const tenant = await seedTenant(owner, "lgpd-cord");
		const g = await seedHolderGraph(tenant);
		// Pedido online do cliente, ainda aberto, sobre o dossiê do Titular.
		const dossierId = await seedDossier(owner, { bureauId: tenant.bureau.id, holderId: g.holderId, createdBy: tenant.bureauAdmin.userId });
		await owner.query(
			`insert into dossier_orders (dossier_id, bureau_id, mode, client_profile_id, product_code, subject_name,
           subject_document_masked, state, created_by)
       values ($1, $2, 'online', $3, 'consulta_pf', 'Titular', '***', 'ready', $4)`,
			[dossierId, tenant.bureau.id, tenant.client.userId, tenant.bureauAdmin.userId],
		);

		expect(await anonymizeClientAccount(adminOf(tenant), { profileId: tenant.client.userId, reason: REASON })).toEqual({
			ok: false,
			reason: "open_orders",
		});
	});

	it("client account anonymize deletes sessions and disables login", async () => {
		const tenant = await seedTenant(owner, "lgpd-acct");
		const userId = tenant.client.userId;
		await seedExpiredSession(owner, { userId, expiresAt: new Date(Date.now() + DAY_MS) });
		await owner.query(
			`insert into account (issuer, account_id, provider_id, user_id, password, updated_at)
       values ('credential', $1, 'credential', $1, 'hash', now())`,
			[userId],
		);
		await owner.query("insert into two_factor (secret, backup_codes, user_id) values ('s', 'b', $1)", [userId]);
		// protect_profile_contact só deixa o contato mudar pelas funções da conta: a sessão sem triggers grava o telefone.
		const seedPhone = await owner.connect();
		try {
			await seedPhone.query("begin");
			await seedPhone.query("set local session_replication_role = replica");
			await seedPhone.query("update profiles set phone_e164 = '+5511999990000', phone_verified_at = now() where id = $1", [userId]);
			await seedPhone.query("commit");
		} finally {
			seedPhone.release();
		}

		expect(await anonymizeClientAccount(adminOf(tenant), { profileId: userId, reason: REASON })).toEqual({ ok: true });

		for (const table of ['"session"', "account", "two_factor"]) {
			expect(await count(`select count(*) as n from ${table} where user_id = $1`, [userId])).toBe(0);
		}
		const profile = await owner.query(
			"select is_active, full_name, email, phone_e164, anonymized_at from profiles where id = $1",
			[userId],
		);
		expect(profile.rows[0]).toMatchObject({ is_active: false, full_name: "Conta anonimizada", phone_e164: null });
		expect(profile.rows[0].email).toMatch(/@anonimizado\.invalid$/);
		expect(profile.rows[0].anonymized_at).not.toBeNull();
		const user = await owner.query('select name, email from "user" where id = $1', [userId]);
		expect(user.rows[0].email).toMatch(/@anonimizado\.invalid$/);
		expect(user.rows[0].name).toBe("Conta anonimizada");

		const rows = await auditRows(tenant.bureau.id, "lgpd.anonymize_client_account");
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata).toEqual({ reason: REASON });
		expect(await anonymizeClientAccount(adminOf(tenant), { profileId: userId, reason: REASON })).toEqual({
			ok: false,
			reason: "already_anonymized",
		});
	});

	it("client account anonymize keeps the holders of the client", async () => {
		const tenant = await seedTenant(owner, "lgpd-chold");

		await anonymizeClientAccount(adminOf(tenant), { profileId: tenant.client.userId, reason: REASON });

		const { rows } = await owner.query("select anonymized_at, document from holders where id = $1", [tenant.holder.id]);
		expect(rows[0].anonymized_at).toBeNull();
		expect(rows[0].document).toBe(tenant.holder.document);
	});

	it("client account anonymize does not reach a staff profile or another bureau", async () => {
		const tenant = await seedTenant(owner, "lgpd-cs");
		const other = await seedTenant(owner, "lgpd-co");

		expect(await anonymizeClientAccount(adminOf(tenant), { profileId: tenant.operator.userId, reason: REASON })).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await anonymizeClientAccount(adminOf(other), { profileId: tenant.client.userId, reason: REASON })).toEqual({
			ok: false,
			reason: "not_found",
		});
	});
});

describe("exportHolder", () => {
	it("export has no auth_code public_token consent_ip or other holder", async () => {
		const tenant = await seedTenant(owner, "lgpd-export");
		const g = await seedHolderGraph(tenant);
		const second = await seedHolderGraph(tenant, { name: `Segundo ${randomBytes(6).toString("hex")}` });
		const token = await owner.query<{ public_token: string }>(
			"select public_token from scr_authorizations where holder_id = $1",
			[g.holderId],
		);

		const result = await exportHolder(adminOf(tenant), g.holderId);

		expect(result).not.toBeNull();
		expect(result!.consultations).toHaveLength(1);
		expect(result!.consultations[0].result).not.toBeNull();
		expect(result!.consultations[0].aiReport).not.toBeNull();
		expect(result!.scrAuthorizations).toHaveLength(1);
		expect(result!.orders).toHaveLength(1);
		expect(result!.timeline).toHaveLength(1);
		expect(result!.notes).toHaveLength(1);
		const json = JSON.stringify(result);
		expect(json).not.toContain(g.authCode);
		expect(json).not.toContain(g.consentIp);
		expect(json).not.toContain(token.rows[0].public_token);
		expect(json).not.toContain("auth_code");
		expect(json).not.toContain("public_token");
		expect(json).not.toContain("consent_ip");
		const secondName = (await owner.query<{ name: string }>("select name from holders where id = $1", [second.holderId])).rows[0].name;
		expect(json).not.toContain(secondName);
		expect(await auditRows(tenant.bureau.id, "lgpd.export_holder")).toHaveLength(1);
	});

	it("export is null for another bureau", async () => {
		const tenant = await seedTenant(owner, "lgpd-ex-a");
		const other = await seedTenant(owner, "lgpd-ex-b");
		const g = await seedHolderGraph(tenant);

		expect(await exportHolder(adminOf(other), g.holderId)).toBeNull();
	});
});

describe("purge", () => {
	it("purge deletes expired technical rows and keeps fresh ones", async () => {
		const tenant = await seedTenant(owner, "lgpd-tech");
		const userId = tenant.client.userId;
		const oldChallenge = await seedExpiredChallenge(owner, { profileId: userId, expiresAt: ago(2) });
		const freshChallenge = await seedExpiredChallenge(owner, { profileId: userId, expiresAt: hoursAgo(1) });
		const oldAttempt = await seedRegisterAttempt(owner, { createdAt: ago(31) });
		const freshAttempt = await seedRegisterAttempt(owner, { createdAt: ago(29) });
		const oldSession = await seedExpiredSession(owner, { userId, expiresAt: ago(2) });
		const freshSession = await seedExpiredSession(owner, { userId, expiresAt: hoursAgo(1) });

		const counts = await purgeTechnicalData(adminOf(tenant));

		expect(counts.verification_challenges).toBeGreaterThanOrEqual(1);
		const exists = async (table: string, id: string | number) =>
			(await count(`select count(*) as n from ${table} where id = $1`, [id])) === 1;
		expect(await exists("verification_challenges", oldChallenge)).toBe(false);
		expect(await exists("verification_challenges", freshChallenge)).toBe(true);
		expect(await exists("client_register_attempts", oldAttempt)).toBe(false);
		expect(await exists("client_register_attempts", freshAttempt)).toBe(true);
		expect(await exists('"session"', oldSession)).toBe(false);
		expect(await exists('"session"', freshSession)).toBe(true);
	});

	it("purge anonymizes a holder idle for 5 years", async () => {
		const tenant = await seedTenant(owner, "lgpd-idle");
		const idle = await seedHolderGraph(tenant);
		const recent = await seedHolderGraph(tenant);
		const system = await owner.query<{ id: string }>("select id from profiles where bureau_id = $1 and is_system", [tenant.bureau.id]);
		const systemIdentity: DbIdentity = { userId: system.rows[0].id, role: "operator", bureauId: tenant.bureau.id };
		const age = async (holderId: string, dossierId: string, years: number, extraDays: number) => {
			const when = new Date(Date.now() - (years * 365 + extraDays) * DAY_MS);
			const c = await owner.connect();
			try {
				await c.query("begin");
				// updated_at só muda pelo trigger; a sessão sem triggers grava a data escolhida.
				await c.query("set local session_replication_role = replica");
				await c.query("update holders set updated_at = $2 where id = $1", [holderId, when]);
				await c.query("update dossiers set completed_at = $2 where id = $1", [dossierId, when]);
				await c.query("update consultations set consulted_at = $2 where dossier_id = $1", [dossierId, when]);
				await c.query("commit");
			} finally {
				c.release();
			}
		};
		await age(idle.holderId, idle.dossierId, 5, 1);
		await age(recent.holderId, recent.dossierId, 4, 0);

		const counts = await purgeBureauData(systemIdentity);

		expect(counts.holders_anonymized).toBe(1);
		const state = async (id: string) =>
			(await owner.query("select anonymized_at, document from holders where id = $1", [id])).rows[0];
		expect((await state(idle.holderId)).anonymized_at).not.toBeNull();
		expect((await state(recent.holderId)).anonymized_at).toBeNull();
		expect((await state(recent.holderId)).document).not.toBeNull();
		expect(await auditRows(tenant.bureau.id, "lgpd.purge_bureau")).toHaveLength(1);
	});

	it("purge keeps an idle holder with an open order", async () => {
		const tenant = await seedTenant(owner, "lgpd-idle-open");
		const g = await seedHolderGraph(tenant, { orderState: "ready" });
		const when = new Date(Date.now() - (6 * 365) * DAY_MS);
		const c = await owner.connect();
		try {
			await c.query("begin");
			await c.query("set local session_replication_role = replica");
			await c.query("update holders set updated_at = $2 where id = $1", [g.holderId, when]);
			await c.query("update dossiers set completed_at = $2 where id = $1", [g.dossierId, when]);
			await c.query("update consultations set consulted_at = $2 where dossier_id = $1", [g.dossierId, when]);
			await c.query("commit");
		} finally {
			c.release();
		}

		const counts = await purgeBureauData(adminOf(tenant));

		expect(counts.holders_anonymized).toBe(0);
	});

	it("purge deletes scr authorizations expired 5 years ago", async () => {
		const tenant = await seedTenant(owner, "lgpd-scr");
		const g = await seedHolderGraph(tenant);
		// A consulta aponta para a autorização vencida: a varredura solta a referência antes de apagar.
		const old = await owner.query<{ id: string }>(
			`insert into scr_authorizations (bureau_id, document, type, holder_id, status, channel, expires_at)
       values ($1, $2, 'PF', $3, 'authorized', 'internal', now() - interval '5 years 1 day') returning id`,
			[tenant.bureau.id, randomCpf(), g.holderId],
		);
		await owner.query("update consultations set scr_authorization_id = $1 where id = $2", [old.rows[0].id, g.consultationId]);

		const counts = await purgeBureauData(adminOf(tenant));

		expect(counts.scr_authorizations).toBe(1);
		expect(await count("select count(*) as n from scr_authorizations where id = $1", [old.rows[0].id])).toBe(0);
		// A autorização vigente do mesmo Titular fica.
		expect(await count("select count(*) as n from scr_authorizations where holder_id = $1", [g.holderId])).toBe(1);
	});

	it("purge technical returns empty when the lock is held", async () => {
		const tenant = await seedTenant(owner, "lgpd-lock");
		const holder = new Client({ connectionString: TEST_DATABASE_OWNER_URL });
		await holder.connect();
		try {
			await holder.query("select pg_advisory_lock(hashtext('lgpd_purge'))");
			expect(await purgeTechnicalData(adminOf(tenant))).toEqual({});
		} finally {
			await holder.end(); // fechar a sessão libera o lock
		}
		expect(await purgeTechnicalData(adminOf(tenant))).toHaveProperty("session");
	});
});

describe("unknown holder", () => {
	it("an unknown holder id gets not_found", async () => {
		const tenant = await seedTenant(owner, "lgpd-unknown");

		expect(await anonymizeHolder(adminOf(tenant), { holderId: randomUUID(), reason: REASON })).toEqual({
			ok: false,
			reason: "not_found",
		});
	});
});
