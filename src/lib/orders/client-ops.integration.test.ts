// Operações do cliente sobre o próprio pedido (025) contra um Postgres real: cancelar, listar membros e declaração.
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
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	randomCpf,
	seedBureauCost,
	seedCatalogItem,
	seedClientProfile,
	seedClientWalletTopup,
	seedTenant,
	type SeededTenant,
} from "@/test/seed";

import { cancelMyOrder, currentDeclarationVersion, listMyOrderMembers, recordOrderDeclaration } from "./client-ops";
import { claimOrders, placeOrder, refreshOrderState } from "./queries";
import type { OpenOrderInput } from "./types";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

beforeAll(acquireClaimLock, 120_000);

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
	await releaseClaimLock();
});

const onlyDigits = (value: string) => value.replace(/\D/g, "");
const cnpjDigits = () => Array.from({ length: 14 }, () => Math.floor(Math.random() * 10)).join("");
const mail = () => `p${Math.random().toString(36).slice(2)}@example.com`;
const WALLET_START = "300.00";

async function newTenant(label: string): Promise<SeededTenant> {
	const t = await seedTenant(owner, label);
	for (const code of ["dossie_pf", "dossie_empresarial"]) {
		// O seed do catálogo deixa os produtos inativos.
		await owner.query("update products set active = true where code = $1", [code]);
		const { rows } = await owner.query<{ id: string }>("select id from products where code = $1", [code]);
		await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: "1.00", setBy: t.bureauAdmin.userId });
		await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: rows[0].id, salePrice: "50.00", updatedBy: t.bureauAdmin.userId });
	}
	await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: WALLET_START, createdBy: t.bureauAdmin.userId });
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

const companyInput = (partnerNames: string[]): OpenOrderInput => ({
	productCode: "dossie_empresarial",
	self: false,
	subject: { type: "PJ", name: "Empresa Teste", documentDigits: cnpjDigits() },
	partners: partnerNames.map((name) => ({
		documentDigits: onlyDigits(randomCpf()),
		name,
		email: mail(),
		percentage: null,
		role: null,
	})),
	contact: { email: mail(), phoneE164: null },
	buyerProfileId: null,
});

async function place(t: SeededTenant, buyer: DbIdentity, input: OpenOrderInput): Promise<string> {
	// O cliente não lê o custo do catálogo: a cotação sai com a identidade da equipe.
	const q = await quoteOrder(staff(t), input.productCode, { partnerCount: input.partners.length });
	if (!q.ok) throw new Error(q.reason);
	const result = await placeOrder(buyer, input, q);
	if (!result.ok) throw new Error(result.reason);
	return result.dossierId;
}

const authorize = (dossierId: string) =>
	owner.query(
		`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days'
		  where id in (select scr_authorization_id from consultations where dossier_id = $1) and status = 'pending'`,
		[dossierId],
	);

const wallet = async (t: SeededTenant) =>
	(
		await owner.query<{ available: string; reserved: string }>(
			"select available::text, reserved::text from client_wallets where client_profile_id = $1",
			[t.client.userId],
		)
	).rows[0];

const orderRow = async (dossierId: string) =>
	(await owner.query<{ state: string; state_reason: string | null }>("select state, state_reason from dossier_orders where dossier_id = $1", [dossierId]))
		.rows[0];

describe("cancelMyOrder", () => {
	it("cancels in awaiting_authorization and gives the reservation back", async () => {
		const t = await newTenant("co cancel auth");
		const id = await place(t, t.client, ownInput);
		expect(await wallet(t)).toEqual({ available: "250.00", reserved: "50.00" });

		expect(await withUserTransaction(t.client, (c) => cancelMyOrder(c, id))).toEqual({ ok: true });

		expect(await orderRow(id)).toEqual({ state: "cancelled", state_reason: "cancelled_by_client" });
		expect(await wallet(t)).toEqual({ available: WALLET_START, reserved: "0.00" });
		const { rows: dossier } = await owner.query("select status from dossiers where id = $1", [id]);
		expect(dossier[0].status).toBe("cancelled");
		const { rows: pending } = await owner.query("select status from consultations where dossier_id = $1", [id]);
		expect(pending.every((r) => r.status === "rejected")).toBe(true);
		const { rows: audit } = await owner.query(
			"select user_id, bureau_id, metadata from audit_logs where action = 'order.cancel' and record_id = $1",
			[id],
		);
		expect(audit).toEqual([{ user_id: t.client.userId, bureau_id: t.bureau.id, metadata: { reason: "cancelled_by_client" } }]);
		const { rows: timeline } = await owner.query(
			"select title from timeline_events where event_type = 'order.cancelled' and metadata ->> 'dossier_id' = $1",
			[id],
		);
		expect(timeline).toHaveLength(1);
	});

	it("cancels in ready", async () => {
		const t = await newTenant("co cancel ready");
		const id = await place(t, t.client, ownInput);
		await authorize(id);
		await withUserTransaction(staff(t), (c) => refreshOrderState(c, id));
		expect((await orderRow(id)).state).toBe("ready");

		expect(await withUserTransaction(t.client, (c) => cancelMyOrder(c, id))).toEqual({ ok: true });

		expect(await orderRow(id)).toEqual({ state: "cancelled", state_reason: "cancelled_by_client" });
		expect(await wallet(t)).toEqual({ available: WALLET_START, reserved: "0.00" });
	});

	it("refuses an executing order and keeps the reservation", async () => {
		const t = await newTenant("co cancel exec");
		const id = await place(t, t.client, ownInput);
		await authorize(id);
		await withUserTransaction(staff(t), async (c) => {
			await refreshOrderState(c, id);
			await claimOrders(c, 10, id);
		});
		expect((await orderRow(id)).state).toBe("executing");

		expect(await withUserTransaction(t.client, (c) => cancelMyOrder(c, id))).toEqual({ ok: false, reason: "invalid_state" });

		expect((await orderRow(id)).state).toBe("executing");
		expect(await wallet(t)).toEqual({ available: "250.00", reserved: "50.00" });
	});

	it("does not find the order of another client or another role", async () => {
		const t = await newTenant("co cancel other");
		const other = await seedClientProfile(owner, t.bureau.id);
		await seedClientWalletTopup(owner, { clientProfileId: other.userId, amount: "100.00", createdBy: t.bureauAdmin.userId });
		const mine = await place(t, t.client, ownInput);

		expect(await withUserTransaction(other, (c) => cancelMyOrder(c, mine))).toEqual({ ok: false, reason: "not_found" });
		expect(await withUserTransaction(staff(t), (c) => cancelMyOrder(c, mine))).toEqual({ ok: false, reason: "not_found" });
		expect(await withUserTransaction(t.client, (c) => cancelMyOrder(c, "00000000-0000-4000-8000-000000000000"))).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect((await orderRow(mine)).state).toBe("awaiting_authorization");
		expect(await wallet(t)).toEqual({ available: "250.00", reserved: "50.00" });
	});

	it("does not find the order of another bureau", async () => {
		const t = await newTenant("co cancel bureau a");
		const foreign = await newTenant("co cancel bureau b");
		const mine = await place(t, t.client, ownInput);

		expect(await withUserTransaction(foreign.client, (c) => cancelMyOrder(c, mine))).toEqual({ ok: false, reason: "not_found" });
		expect((await orderRow(mine)).state).toBe("awaiting_authorization");
	});

	it("is not repeatable: a second cancel is invalid_state", async () => {
		const t = await newTenant("co cancel twice");
		const id = await place(t, t.client, ownInput);
		await withUserTransaction(t.client, (c) => cancelMyOrder(c, id));
		expect(await withUserTransaction(t.client, (c) => cancelMyOrder(c, id))).toEqual({ ok: false, reason: "invalid_state" });
		expect(await wallet(t)).toEqual({ available: WALLET_START, reserved: "0.00" });
	});
});

describe("listMyOrderMembers", () => {
	it("lists company and partners with the authorization state and masked documents", async () => {
		const t = await newTenant("co members");
		const id = await place(t, t.client, companyInput(["Sócio A", "Sócio B"]));
		const { rows: cons } = await owner.query<{ id: string; document: string; name: string }>(
			`select c.id, c.document, h.name from consultations c join holders h on h.id = c.holder_id where c.dossier_id = $1`,
			[id],
		);
		const byName = (name: string) => cons.find((r) => r.name === name)!;
		const company = byName("Empresa Teste");
		// Empresa autorizada; Sócio A pendente no prazo; Sócio B pendente com o prazo vencido.
		await owner.query(
			`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days'
			  where id = (select scr_authorization_id from consultations where id = $1)`,
			[company.id],
		);
		await owner.query(
			`update scr_authorizations set request_expires_at = now() - interval '1 day'
			  where id = (select scr_authorization_id from consultations where id = $1)`,
			[byName("Sócio B").id],
		);

		const members = await withUserTransaction(t.client, (c) => listMyOrderMembers(c, id));

		expect(members).toHaveLength(3);
		expect(members[0]).toEqual({
			role: "company",
			name: "Empresa Teste",
			documentMasked: `**.${company.document.slice(2, 5)}.${company.document.slice(5, 8)}/${company.document.slice(8, 12)}-**`,
			scrStatus: "authorized",
		});
		const partners = members.slice(1);
		expect(partners.map((m) => [m.role, m.name, m.scrStatus])).toEqual([
			["partner", "Sócio A", "pending"],
			["partner", "Sócio B", "expired"],
		]);
		const text = JSON.stringify(members);
		for (const row of cons) expect(text).not.toContain(row.document);
		for (const m of members) expect(m.documentMasked).toMatch(/\*/);
	});

	it("marks a refused authorization and calls the PF member the subject", async () => {
		const t = await newTenant("co members pf");
		const id = await place(t, t.client, ownInput);
		await owner.query(
			`update scr_authorizations set status = 'not_authorized', refused_at = now()
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[id],
		);
		const members = await withUserTransaction(t.client, (c) => listMyOrderMembers(c, id));
		expect(members).toHaveLength(1);
		expect(members[0]).toMatchObject({ role: "subject", scrStatus: "refused" });
	});

	it("returns nothing for the order of another client, another bureau or staff", async () => {
		const t = await newTenant("co members other");
		const foreign = await newTenant("co members foreign");
		const other = await seedClientProfile(owner, t.bureau.id);
		const id = await place(t, t.client, companyInput(["Sócio A"]));

		expect(await withUserTransaction(other, (c) => listMyOrderMembers(c, id))).toEqual([]);
		expect(await withUserTransaction(foreign.client, (c) => listMyOrderMembers(c, id))).toEqual([]);
		expect(await withUserTransaction(staff(t), (c) => listMyOrderMembers(c, id))).toEqual([]);
	});
});

describe("recordOrderDeclaration", () => {
	it("records the declaration with the current version and audits it", async () => {
		const t = await newTenant("co decl ok");
		const id = await place(t, t.client, companyInput(["Sócio A"]));
		const version = await withUserTransaction(t.client, (c) => currentDeclarationVersion(c));
		expect(version).toBeGreaterThanOrEqual(1);

		const result = await withUserTransaction(t.client, (c) =>
			recordOrderDeclaration(c, { dossierId: id, version, ip: "203.0.113.7", userAgent: "vitest-agent" }),
		);

		expect(result).toEqual({ ok: true });
		const { rows } = await owner.query(
			`select d.profile_id, d.bureau_id, host(d.ip) as ip, d.user_agent, l.kind, l.version
			   from order_declarations d join legal_documents l on l.id = d.document_id where d.dossier_id = $1`,
			[id],
		);
		expect(rows).toEqual([
			{ profile_id: t.client.userId, bureau_id: t.bureau.id, ip: "203.0.113.7", user_agent: "vitest-agent", kind: "buyer_declaration", version },
		]);
		const { rows: audit } = await owner.query(
			"select metadata from audit_logs where action = 'order.declaration_accepted' and record_id = $1 and user_id = $2",
			[id, t.client.userId],
		);
		expect(audit).toEqual([{ metadata: { version } }]);
	});

	it("refuses an outdated version and writes nothing", async () => {
		const t = await newTenant("co decl old");
		const id = await place(t, t.client, companyInput(["Sócio A"]));
		const version = await withUserTransaction(t.client, (c) => currentDeclarationVersion(c));

		const result = await withUserTransaction(t.client, (c) =>
			recordOrderDeclaration(c, { dossierId: id, version: version - 1, ip: null, userAgent: null }),
		);

		expect(result).toEqual({ ok: false, reason: "outdated" });
		expect((await owner.query("select 1 from order_declarations where dossier_id = $1", [id])).rowCount).toBe(0);
	});

	it("fails on a second record for the same order", async () => {
		const t = await newTenant("co decl twice");
		const id = await place(t, t.client, companyInput(["Sócio A"]));
		const version = await withUserTransaction(t.client, (c) => currentDeclarationVersion(c));
		const input = { dossierId: id, version, ip: null, userAgent: null };
		expect(await withUserTransaction(t.client, (c) => recordOrderDeclaration(c, input))).toEqual({ ok: true });

		await expect(withUserTransaction(t.client, (c) => recordOrderDeclaration(c, input))).rejects.toMatchObject({ code: "23505" });

		expect((await owner.query("select 1 from order_declarations where dossier_id = $1", [id])).rowCount).toBe(1);
	});

	it("does not find the order of another client, another bureau or staff", async () => {
		const t = await newTenant("co decl other");
		const foreign = await newTenant("co decl foreign");
		const other = await seedClientProfile(owner, t.bureau.id);
		const id = await place(t, t.client, companyInput(["Sócio A"]));
		const version = await withUserTransaction(t.client, (c) => currentDeclarationVersion(c));
		const input = { dossierId: id, version, ip: null, userAgent: null };

		for (const who of [other, foreign.client, staff(t)]) {
			expect(await withUserTransaction(who, (c) => recordOrderDeclaration(c, input))).toEqual({ ok: false, reason: "not_found" });
		}
		expect((await owner.query("select 1 from order_declarations where dossier_id = $1", [id])).rowCount).toBe(0);
	});
});
