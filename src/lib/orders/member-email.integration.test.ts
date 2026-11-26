// Cliente corrige ou reenvia o e-mail de quem autoriza o SCR no próprio pedido (068) contra um Postgres real:
// posse do pedido, rotação do token, limites, auditoria mascarada e a lista de membros com as flags de ação.
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

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { quoteOrder } from "@/lib/catalog/quote";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { getPublicScrAuthorization, issueSelfScrAuthorization } from "@/lib/scr/queries";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	randomCpf,
	seedBureauCost,
	seedCatalogItem,
	seedClientProfile,
	seedClientWalletTopup,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
} from "@/test/seed";

import { placeOrder } from "./queries";
import { listScrRequestsToIssue } from "./tick-queries";
import type { OpenOrderInput } from "./types";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

beforeAll(acquireClaimLock, 120_000);

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
	await releaseClaimLock();
});

const SITE = "http://localhost:3000";
const onlyDigits = (value: string) => value.replace(/\D/g, "");
const cnpjDigits = () => Array.from({ length: 14 }, () => Math.floor(Math.random() * 10)).join("");
const mail = () => `p${Math.random().toString(36).slice(2)}@example.com`;

async function newTenant(label: string, walletAmount = "300.00"): Promise<SeededTenant> {
	const t = await seedTenant(owner, label);
	for (const code of ["dossie_pf", "dossie_empresarial"]) {
		// O seed do catálogo deixa os produtos inativos.
		await owner.query("update products set active = true where code = $1", [code]);
		const { rows } = await owner.query<{ id: string }>("select id from products where code = $1", [code]);
		await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: "1.00", setBy: t.bureauAdmin.userId });
		await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: rows[0].id, salePrice: "50.00", updatedBy: t.bureauAdmin.userId });
	}
	await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: walletAmount, createdBy: t.bureauAdmin.userId });
	await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "2000.00", createdBy: t.bureauAdmin.userId });
	return t;
}

const staff = (t: SeededTenant): DbIdentity => ({ ...t.operator });

const ownInput: OpenOrderInput = {
	productCode: "dossie_pf",
	self: true,
	subject: null,
	partners: [],
	contact: { email: null, phoneE164: null },
	buyerProfileId: null,
};

const companyInput = (partnerEmails: string[]): OpenOrderInput => ({
	productCode: "dossie_empresarial",
	self: false,
	subject: { type: "PJ", name: "Empresa Teste", documentDigits: cnpjDigits() },
	partners: partnerEmails.map((email, i) => ({
		documentDigits: onlyDigits(randomCpf()),
		name: `Sócio ${i + 1}`,
		email,
		percentage: null,
		role: null,
	})),
	contact: { email: mail(), phoneE164: null },
	buyerProfileId: null,
});

async function place(t: SeededTenant, buyer: DbIdentity, input: OpenOrderInput): Promise<string> {
	const q = await quoteOrder(staff(t), input.productCode, { partnerCount: input.partners.length });
	if (!q.ok) throw new Error(q.reason);
	const result = await placeOrder(buyer, input, q);
	if (!result.ok) throw new Error(result.reason);
	return result.dossierId;
}

type Member = { consultation_id: string; scr_id: string; token: string; email: string; name: string };
const membersOf = async (dossierId: string): Promise<Member[]> =>
	(
		await owner.query<Member>(
			`select c.id as consultation_id, s.id as scr_id, s.public_token::text as token, s.email, c.document_name as name
			   from consultations c join scr_authorizations s on s.id = c.scr_authorization_id
			  where c.dossier_id = $1 order by c.created_at, c.id`,
			[dossierId],
		)
	).rows;
const partnerOf = async (dossierId: string) => (await membersOf(dossierId)).find((m) => m.name.startsWith("Sócio"))!;

// Pedido de empresa com um sócio pendente (e-mail digitado errado).
async function companyWithPartner(t: SeededTenant) {
	const wrong = mail();
	const dossierId = await place(t, t.client, companyInput([wrong]));
	return { dossierId, partner: await partnerOf(dossierId), wrong };
}

type Result = { ok: boolean; reason: string | null; authorization_id: string | null };
const call = (identity: DbIdentity, dossierId: string, consultationId: string, email: string | null) =>
	withUserTransaction(
		identity,
		async (c) =>
			(
				await c.query<Result>("select ok, reason, authorization_id from update_my_order_member_email($1, $2, $3)", [
					dossierId,
					consultationId,
					email,
				])
			).rows[0],
	);

const listMembers = (identity: DbIdentity, dossierId: string) =>
	withUserTransaction(
		identity,
		async (c) =>
			(
				await c.query<{
					consultation_id: string;
					role: string;
					name: string;
					document_masked: string;
					email_masked: string | null;
					scr_status: string;
					can_edit_email: boolean;
					can_resend: boolean;
					changes_left: number;
				}>("select * from client_order_members($1)", [dossierId])
			).rows,
	);

// Recua os instantes de troca para fora do intervalo de reenvio (continuam dentro das 24 h).
const ageChanges = (scrId: string) =>
	owner.query(
		"update scr_authorizations set contact_changes_at = array(select t - interval '10 minutes' from unnest(contact_changes_at) t) where id = $1",
		[scrId],
	);

const authRow = async (scrId: string) =>
	(
		await owner.query<{ email: string; public_token: string; auth_code: string | null; request_expires_at: Date; changes: number; status: string }>(
			`select email, public_token::text, auth_code, request_expires_at, cardinality(contact_changes_at) as changes, status::text
			   from scr_authorizations where id = $1`,
			[scrId],
		)
	).rows[0];

const memberAudit = async (dossierId: string) =>
	(await owner.query("select * from audit_logs where record_id = $1 and action like 'order.member_%'", [dossierId])).rows;

const issueWith = (t: SeededTenant, scrId: string, email: string, code: string, publicToken?: string) =>
	issueSelfScrAuthorization(
		staff(t),
		scrId,
		{
			code,
			email,
			consentText: "termo",
			consentName: "Fulano de Tal",
			consentDocument: "000.000.000-00",
			notification: { recipient: email, clientName: "Fulano de Tal", authorizedName: "Bureau", siteUrl: SITE },
		},
		publicToken ? { publicToken } : undefined,
	);

describe("update_my_order_member_email (068)", () => {
	it("rotates the token and clears the code", async () => {
		const t = await newTenant("me rotate");
		const { dossierId, partner } = await companyWithPartner(t);
		const right = "novo@example.com";
		// Com o link já emitido ao e-mail errado.
		expect(await issueWith(t, partner.scr_id, partner.email, "ABC234")).toEqual({ ok: true });
		expect((await authRow(partner.scr_id)).auth_code).toBe("ABC234");
		await owner.query("update scr_authorizations set request_expires_at = now() + interval '1 hour' where id = $1", [partner.scr_id]);

		expect(await call(t.client, dossierId, partner.consultation_id, right)).toEqual({
			ok: true,
			reason: null,
			authorization_id: partner.scr_id,
		});

		const after = await authRow(partner.scr_id);
		expect(after).toMatchObject({ email: right, auth_code: null, changes: 1, status: "pending" });
		expect(after.public_token).not.toBe(partner.token);
		expect(after.request_expires_at.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
		expect((await owner.query("select scr_email from consultations where id = $1", [partner.consultation_id])).rows[0]).toEqual({
			scr_email: right,
		});
		// O link antigo deixa de existir. O novo abre.
		expect(await getPublicScrAuthorization(partner.token)).toBeNull();
		expect(await getPublicScrAuthorization(after.public_token)).not.toBeNull();
		// O tick emite com o e-mail e o token novos.
		const toIssue = await withUserTransaction(staff(t), (c) => listScrRequestsToIssue(c, staff(t), 20));
		expect(toIssue.find((r) => r.scrId === partner.scr_id)).toMatchObject({ email: right, publicToken: after.public_token });
	});

	it("voids the queued email of the old address", async () => {
		const t = await newTenant("me void");
		const { dossierId, partner } = await companyWithPartner(t);
		expect(await issueWith(t, partner.scr_id, partner.email, "ABC234")).toEqual({ ok: true });
		const queued = () =>
			owner.query<{ status: string }>("select status from notifications where reference = $1 and channel = 'email' order by created_at", [
				`scr_authorization:${partner.scr_id}`,
			]);
		expect((await queued()).rows.map((r) => r.status)).toEqual(["pending"]);

		expect((await call(t.client, dossierId, partner.consultation_id, mail())).ok).toBe(true);

		expect((await queued()).rows.map((r) => r.status)).toEqual(["suppressed"]);
	});

	it("writes one audit event with masked emails only", async () => {
		const t = await newTenant("me audit");
		const { dossierId, partner, wrong } = await companyWithPartner(t);
		const right = "novo@example.com";
		const document = (await owner.query<{ document: string }>("select document from consultations where id = $1", [partner.consultation_id]))
			.rows[0].document;

		expect((await call(t.client, dossierId, partner.consultation_id, right)).ok).toBe(true);

		const rows = await memberAudit(dossierId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ action: "order.member_email_update", record_id: dossierId, user_id: t.client.userId, bureau_id: t.bureau.id });
		expect(rows[0].metadata).toMatchObject({
			consultation_id: partner.consultation_id,
			authorization_id: partner.scr_id,
			email_masked: "n***@example.com",
			shared_dossiers: 1,
		});
		expect(rows[0].metadata.previous_email_masked).toContain("***@");
		const text = JSON.stringify(rows);
		expect(text).not.toContain(right);
		expect(text).not.toContain(wrong);
		expect(text).not.toContain(document);
	});

	it("refuses another client, another bureau, staff and a mismatched consultation", async () => {
		const t = await newTenant("me own");
		const foreign = await newTenant("me foreign");
		const other = await seedClientProfile(owner, t.bureau.id);
		const { dossierId, partner } = await companyWithPartner(t);
		const second = await companyWithPartner(t);
		const before = await authRow(partner.scr_id);
		const beforeSecond = await authRow(second.partner.scr_id);

		for (const identity of [other, foreign.client, staff(t)]) {
			expect(await call(identity, dossierId, partner.consultation_id, mail())).toEqual({
				ok: false,
				reason: "not_found",
				authorization_id: null,
			});
		}
		// Pedido próprio com a consulta de outro pedido do mesmo cliente.
		expect(await call(t.client, dossierId, second.partner.consultation_id, mail())).toMatchObject({ ok: false, reason: "not_found" });

		expect(await authRow(partner.scr_id)).toEqual(before);
		expect(await authRow(second.partner.scr_id)).toEqual(beforeSecond);
		expect(await memberAudit(dossierId)).toEqual([]);
		expect(await memberAudit(second.dossierId)).toEqual([]);
	});

	it("refuses a decided or expired authorization", async () => {
		const t = await newTenant("me decided");
		const { dossierId, partner } = await companyWithPartner(t);
		const before = await authRow(partner.scr_id);

		for (const set of [
			"status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days'",
			"status = 'not_authorized', refused_at = now()",
			"status = 'pending', request_expires_at = now() - interval '1 day'",
		]) {
			await owner.query(`update scr_authorizations set ${set} where id = $1`, [partner.scr_id]);
			expect(await call(t.client, dossierId, partner.consultation_id, mail())).toMatchObject({ ok: false, reason: "invalid_state" });
		}
		await owner.query("update scr_authorizations set status = 'pending', request_expires_at = $2 where id = $1", [
			partner.scr_id,
			before.request_expires_at,
		]);
		await owner.query("update dossier_orders set state = 'ready' where dossier_id = $1", [dossierId]);
		expect(await call(t.client, dossierId, partner.consultation_id, mail())).toMatchObject({ ok: false, reason: "invalid_state" });

		expect((await authRow(partner.scr_id)).email).toBe(before.email);
		expect((await authRow(partner.scr_id)).public_token).toBe(before.public_token);
		expect(await memberAudit(dossierId)).toEqual([]);
	});

	it("rechecks the state under lock after the signer answers", async () => {
		const t = await newTenant("me recheck");
		const { dossierId, partner } = await companyWithPartner(t);
		expect((await listMembers(t.client, dossierId)).find((m) => m.consultation_id === partner.consultation_id)?.can_edit_email).toBe(true);

		await owner.query(
			"update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days' where id = $1",
			[partner.scr_id],
		);

		expect(await call(t.client, dossierId, partner.consultation_id, mail())).toMatchObject({ ok: false, reason: "invalid_state" });
		expect((await authRow(partner.scr_id)).email).toBe(partner.email);
	});

	it("refuses the same email without using a slot", async () => {
		const t = await newTenant("me same");
		const { dossierId, partner } = await companyWithPartner(t);

		expect(await call(t.client, dossierId, partner.consultation_id, partner.email.toUpperCase())).toMatchObject({
			ok: false,
			reason: "same_email",
		});

		expect((await authRow(partner.scr_id)).changes).toBe(0);
		expect(await memberAudit(dossierId)).toEqual([]);
	});

	it("refuses an invalid or blank email", async () => {
		const t = await newTenant("me invalid");
		const { dossierId, partner } = await companyWithPartner(t);
		for (const bad of ["joao@", "   ", "a b@example.com", `${"x".repeat(250)}@example.com`]) {
			expect(await call(t.client, dossierId, partner.consultation_id, bad)).toMatchObject({ ok: false, reason: "invalid_input" });
		}
		expect((await authRow(partner.scr_id)).changes).toBe(0);
	});

	it("refuses the buyer's email and the own-account member", async () => {
		const t = await newTenant("me buyer");
		const buyerEmail = (await owner.query<{ email: string }>("select email from profiles where id = $1", [t.client.userId])).rows[0].email;
		const { dossierId, partner } = await companyWithPartner(t);
		expect(await call(t.client, dossierId, partner.consultation_id, buyerEmail.toUpperCase())).toMatchObject({
			ok: false,
			reason: "contact_is_buyer",
		});

		// Pedido PF próprio: o Titular é o comprador.
		const own = await place(t, t.client, ownInput);
		const [self] = await membersOf(own);
		expect(await call(t.client, own, self.consultation_id, mail())).toMatchObject({ ok: false, reason: "own_account_email" });
		expect((await listMembers(t.client, own))[0]).toMatchObject({ can_edit_email: false, can_resend: true });
		expect(await call(t.client, own, self.consultation_id, null)).toMatchObject({ ok: true, authorization_id: self.scr_id });
		expect((await authRow(self.scr_id)).email).toBe(self.email);
	});

	it("enforces the cooldown and the daily limit", async () => {
		const t = await newTenant("me limit");
		const { dossierId, partner } = await companyWithPartner(t);
		const limit = (await pool.query<{ n: number }>("select client_member_change_limit() as n")).rows[0].n;
		expect(limit).toBe(3);

		expect((await call(t.client, dossierId, partner.consultation_id, mail())).ok).toBe(true);
		expect(await call(t.client, dossierId, partner.consultation_id, mail())).toMatchObject({ ok: false, reason: "resend_too_soon" });
		for (let i = 1; i < limit; i++) {
			await ageChanges(partner.scr_id);
			expect((await call(t.client, dossierId, partner.consultation_id, mail())).ok).toBe(true);
		}
		await ageChanges(partner.scr_id);
		expect(await call(t.client, dossierId, partner.consultation_id, mail())).toMatchObject({ ok: false, reason: "resend_limit_reached" });
		expect(await call(t.client, dossierId, partner.consultation_id, null)).toMatchObject({ ok: false, reason: "resend_limit_reached" });

		const row = (await listMembers(t.client, dossierId)).find((m) => m.consultation_id === partner.consultation_id)!;
		expect(row).toMatchObject({ changes_left: 0, can_edit_email: false, can_resend: false });
		expect((await authRow(partner.scr_id)).changes).toBe(limit);
	});

	it("lets only one of two parallel changes through", async () => {
		const t = await newTenant("me parallel");
		const { dossierId, partner } = await companyWithPartner(t);

		const results = await Promise.all([
			call(t.client, dossierId, partner.consultation_id, mail()),
			call(t.client, dossierId, partner.consultation_id, mail()),
		]);

		expect(results.map((r) => r.reason).sort()).toEqual([null, "resend_too_soon"]);
		expect((await authRow(partner.scr_id)).changes).toBe(1);
		expect(await memberAudit(dossierId)).toHaveLength(1);
	});

	it("resends without a new email", async () => {
		const t = await newTenant("me resend");
		const { dossierId, partner } = await companyWithPartner(t);

		expect(await call(t.client, dossierId, partner.consultation_id, null)).toMatchObject({ ok: true, authorization_id: partner.scr_id });

		const after = await authRow(partner.scr_id);
		expect(after).toMatchObject({ email: partner.email, auth_code: null, changes: 1 });
		expect(after.public_token).not.toBe(partner.token);
		const audit = await memberAudit(dossierId);
		expect(audit.map((r) => r.action)).toEqual(["order.member_resend"]);
		expect(JSON.stringify(audit)).not.toContain(partner.email);

		// Antes do pagamento: reenviar não faz nada, corrigir só grava e não mexe no prazo.
		await ageChanges(partner.scr_id);
		await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [dossierId]);
		expect(await call(t.client, dossierId, partner.consultation_id, null)).toMatchObject({ ok: false, reason: "invalid_state" });
		const deadline = (await authRow(partner.scr_id)).request_expires_at;
		const right = mail();
		expect((await call(t.client, dossierId, partner.consultation_id, right)).ok).toBe(true);
		const saved = await authRow(partner.scr_id);
		expect(saved.email).toBe(right);
		expect(saved.request_expires_at).toEqual(deadline);
	});

	it("caps pending requests per recipient", async () => {
		const t = await newTenant("me cap", "3000.00");
		const target = "alvo@example.com";
		for (let i = 0; i < 3; i++) await place(t, t.client, companyInput([target]));
		const { dossierId, partner } = await companyWithPartner(t);

		expect(await call(t.client, dossierId, partner.consultation_id, target)).toMatchObject({ ok: false, reason: "too_many_requests" });
		expect((await authRow(partner.scr_id)).changes).toBe(0);
	});
});

describe("client_order_members (068)", () => {
	it("lists members with masked email and action flags", async () => {
		const t = await newTenant("me list");
		const foreign = await newTenant("me list foreign");
		const other = await seedClientProfile(owner, t.bureau.id);
		const { dossierId, partner, wrong } = await companyWithPartner(t);
		const document = (await owner.query<{ document: string }>("select document from consultations where id = $1", [partner.consultation_id]))
			.rows[0].document;

		const rows = await listMembers(t.client, dossierId);

		expect(rows).toHaveLength(2);
		expect(rows[0].role).toBe("company");
		const row = rows.find((r) => r.consultation_id === partner.consultation_id)!;
		expect(row).toMatchObject({ role: "partner", scr_status: "pending", can_edit_email: true, can_resend: true, changes_left: 3 });
		expect(row.email_masked).toContain("***@");
		const text = JSON.stringify(rows);
		expect(text).not.toContain(wrong);
		expect(text).not.toContain(document);

		expect(await listMembers(other, dossierId)).toEqual([]);
		expect(await listMembers(foreign.client, dossierId)).toEqual([]);
		expect(await listMembers(staff(t), dossierId)).toEqual([]);
	});

	it("hides the actions for a decided authorization and before payment for resend", async () => {
		const t = await newTenant("me flags");
		const { dossierId, partner } = await companyWithPartner(t);
		const flags = async () => (await listMembers(t.client, dossierId)).find((m) => m.consultation_id === partner.consultation_id)!;

		await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [dossierId]);
		expect(await flags()).toMatchObject({ can_edit_email: true, can_resend: false });

		await owner.query(
			"update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days' where id = $1",
			[partner.scr_id],
		);
		expect(await flags()).toMatchObject({ scr_status: "authorized", can_edit_email: false, can_resend: false });
	});
});
