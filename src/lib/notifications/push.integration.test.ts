// Migração 034: canal push, inscrições de aparelho (RLS, funções do cliente e do worker) e os gatilhos dos 4 eventos,
// contra um Postgres real.
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
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

import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { releaseDelivery, revokeDelivery } from "@/lib/orders/queries";
import { TEST_DATABASE_DISPATCH_URL, TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL } from "@/test/db-env";
import {
	seedClientProfile,
	seedClientWalletTopup,
	seedLegacyOnlineOrder,
	seedOrderDossier,
	seedTenant,
	type SeedIdentity,
	type SeededTenant,
} from "@/test/seed";

import { acquireClaimLock, releaseClaimLock } from "./claim-lock.test-util";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
const dispatch = new Pool({ connectionString: TEST_DATABASE_DISPATCH_URL, max: 2 });

beforeAll(acquireClaimLock, 120_000);

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), dispatch.end(), pool.end()]);
	await releaseClaimLock();
});

type Ctx = { userId: string; role: string; bureauId: string | null };
const PLATFORM: Ctx = { userId: "", role: "operator", bureauId: null };

async function committed<T>(ctx: Ctx, work: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
              set_config('app.bureau_id', $3, true), set_config('app.support_session_id', '', true)`,
			[ctx.userId, ctx.role, ctx.bureauId ?? ""],
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

const base64url = (bytes: number) => randomBytes(bytes).toString("base64url");
const newEndpoint = () => `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
// p256dh: ponto P-256 sem compressão (65 bytes = 87 caracteres). auth: 16 bytes = 22 caracteres.
const newKeys = () => ({ p256dh: base64url(65), auth: base64url(16) });

type Result = { ok: boolean; reason: string | null };
type Keys = { p256dh: string; auth: string };

function register(ctx: Ctx, endpoint: string, keys: Keys = newKeys(), userAgent: string | null = "test-agent") {
	return committed(ctx, (c) =>
		c
			.query<Result>("select * from register_push_subscription($1, $2, $3, $4)", [endpoint, keys.p256dh, keys.auth, userAgent])
			.then((r) => r.rows[0]),
	);
}
const remove = (ctx: Ctx, endpoint: string) =>
	committed(ctx, (c) => c.query<Result>("select * from remove_push_subscription($1)", [endpoint]).then((r) => r.rows[0]));
const active = (ctx: Ctx, endpoint: string) =>
	committed(ctx, (c) =>
		c.query<{ a: boolean }>("select push_subscription_active($1) as a", [endpoint]).then((r) => r.rows[0].a),
	);

const asClient = (id: SeedIdentity): Ctx => ({ userId: id.userId, role: "client", bureauId: id.bureauId });
const asStaff = (id: SeedIdentity): Ctx => ({ userId: id.userId, role: id.role, bureauId: id.bureauId });

async function subscriptionsOf(profileId: string) {
	const { rows } = await owner.query<{ id: string; endpoint: string; p256dh: string; auth: string; profile_id: string }>(
		"select id, endpoint, p256dh, auth, profile_id from push_subscriptions where profile_id = $1 order by updated_at",
		[profileId],
	);
	return rows;
}
async function auditOf(profileId: string, action: string) {
	const { rows } = await owner.query<{ metadata: unknown; record_id: string }>(
		"select metadata, record_id from audit_logs where user_id = $1 and action = $2",
		[profileId, action],
	);
	return rows;
}
// Cliente com `devices` aparelhos já inscritos.
async function subscribed(identity: SeedIdentity, devices: number) {
	const endpoints: string[] = [];
	for (let i = 0; i < devices; i += 1) {
		const endpoint = newEndpoint();
		expect(await register(asClient(identity), endpoint)).toEqual({ ok: true, reason: null });
		endpoints.push(endpoint);
	}
	return endpoints;
}
// Avisos push de um template, para uma referência.
async function pushNotices(templateKey: string, reference: string) {
	const { rows } = await owner.query<{ params: { url: string } | null; recipient: string | null; status: string }>(
		`select n.params, n.recipient, n.status
		   from notifications n join notification_templates t on t.id = n.template_id
		  where n.channel = 'push' and t.key = $1 and n.reference = $2 order by n.created_at, n.id`,
		[templateKey, reference],
	);
	return rows;
}

describe("register_push_subscription e remove_push_subscription", () => {
	it("register creates one row and audits", async () => {
		const t = await seedTenant(owner, "push register");
		const endpoint = newEndpoint();

		expect(await register(asClient(t.client), endpoint)).toEqual({ ok: true, reason: null });

		const rows = await subscriptionsOf(t.client.userId);
		expect(rows).toHaveLength(1);
		expect(rows[0].endpoint).toBe(endpoint);
		const audit = await auditOf(t.client.userId, "client.push_subscribed");
		expect(audit).toHaveLength(1);
		expect(audit[0].record_id).toBe(t.client.userId);
		expect(JSON.stringify(audit[0].metadata)).not.toContain("https://");
	});

	it("register same endpoint same profile updates keys without audit", async () => {
		const t = await seedTenant(owner, "push re-register");
		const endpoint = newEndpoint();
		await register(asClient(t.client), endpoint);
		const fresh = newKeys();

		expect(await register(asClient(t.client), endpoint, fresh, "novo-agente")).toEqual({ ok: true, reason: null });

		const rows = await subscriptionsOf(t.client.userId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject(fresh);
		expect(await auditOf(t.client.userId, "client.push_subscribed")).toHaveLength(1);
	});

	it("register same endpoint by another client transfers it", async () => {
		const t = await seedTenant(owner, "push transfer");
		const other = await seedClientProfile(owner, t.bureau.id);
		const endpoint = newEndpoint();
		await register(asClient(t.client), endpoint);

		expect(await register(asClient(other), endpoint)).toEqual({ ok: true, reason: null });

		expect(await subscriptionsOf(t.client.userId)).toHaveLength(0);
		expect(await subscriptionsOf(other.userId)).toHaveLength(1);
		expect(await auditOf(other.userId, "client.push_subscribed")).toHaveLength(1);
	});

	it("register rejects staff and bad input", async () => {
		const t = await seedTenant(owner, "push invalid");
		const client = asClient(t.client);

		expect(await register(asStaff(t.operator), newEndpoint())).toEqual({ ok: false, reason: "not_allowed" });
		expect(await register(PLATFORM, newEndpoint())).toEqual({ ok: false, reason: "not_allowed" });
		expect(await register(client, "http://fcm.googleapis.com/fcm/send/abc")).toEqual({ ok: false, reason: "invalid_input" });
		expect(await register(client, newEndpoint(), { p256dh: base64url(20), auth: newKeys().auth })).toEqual({
			ok: false,
			reason: "invalid_input",
		});
		expect(await register(client, newEndpoint(), { p256dh: newKeys().p256dh, auth: `${base64url(15)}=` })).toEqual({
			ok: false,
			reason: "invalid_input",
		});
		expect(await subscriptionsOf(t.client.userId)).toHaveLength(0);
		expect(await subscriptionsOf(t.operator.userId)).toHaveLength(0);
	});

	it("register and the table CHECK refuse a host with characters outside [A-Za-z0-9.-]", async () => {
		const t = await seedTenant(owner, "push host chars");
		const keys = newKeys();
		for (const endpoint of [
			"https://evil.example;.notify.windows.com/x",
			"https://evil!.notify.windows.com/x",
			"https://evil_.notify.windows.com/x",
			"https://evil.example?.notify.windows.com",
		]) {
			expect(await register(asClient(t.client), endpoint, keys)).toEqual({ ok: false, reason: "invalid_input" });
			await expect(
				owner.query(
					"insert into push_subscriptions (bureau_id, profile_id, endpoint, p256dh, auth) values ($1, $2, $3, $4, $5)",
					[t.bureau.id, t.client.userId, endpoint, keys.p256dh, keys.auth],
				),
			).rejects.toMatchObject({ code: "23514" });
		}
		expect(await register(asClient(t.client), "https://wns2-bn3p.notify.windows.com/w/?token=x", keys)).toEqual({ ok: true, reason: null });
	});

	it("eleventh subscription evicts the oldest", async () => {
		const t = await seedTenant(owner, "push limit");
		const endpoints = await subscribed(t.client, 11);

		const rows = await subscriptionsOf(t.client.userId);
		expect(rows).toHaveLength(10);
		expect(rows.map((r) => r.endpoint)).not.toContain(endpoints[0]);
		expect(rows.map((r) => r.endpoint)).toContain(endpoints[10]);
	});

	it("remove own endpoint deletes and audits", async () => {
		const t = await seedTenant(owner, "push remove");
		const [endpoint] = await subscribed(t.client, 1);

		expect(await remove(asClient(t.client), endpoint)).toEqual({ ok: true, reason: null });

		expect(await subscriptionsOf(t.client.userId)).toHaveLength(0);
		expect(await auditOf(t.client.userId, "client.push_unsubscribed")).toHaveLength(1);
	});

	it("remove other client's endpoint removes nothing", async () => {
		const t = await seedTenant(owner, "push remove other");
		const other = await seedClientProfile(owner, t.bureau.id);
		const [endpoint] = await subscribed(t.client, 1);

		expect(await remove(asClient(other), endpoint)).toEqual({ ok: true, reason: null });
		expect(await remove(asClient(other), newEndpoint())).toEqual({ ok: true, reason: null });

		expect(await subscriptionsOf(t.client.userId)).toHaveLength(1);
		expect(await auditOf(other.userId, "client.push_unsubscribed")).toHaveLength(0);
		expect(await remove(asStaff(t.operator), endpoint)).toEqual({ ok: false, reason: "not_allowed" });
	});

	it("push_subscription_active", async () => {
		const t = await seedTenant(owner, "push active");
		const other = await seedClientProfile(owner, t.bureau.id);
		const [endpoint] = await subscribed(t.client, 1);

		expect(await active(asClient(t.client), endpoint)).toBe(true);
		expect(await active(asClient(other), endpoint)).toBe(false);
		expect(await active(asClient(t.client), newEndpoint())).toBe(false);
		expect(await active(asStaff(t.operator), endpoint)).toBe(false);
	});
});

// Autorização SCR de um sócio ligada (ou não) a um pedido do comprador. O Titular do seed é o do comprador.
async function seedPartnerScr(t: SeededTenant, o: { buyer: SeedIdentity; email: string; withOrder: boolean }) {
	let dossierId: string | null = null;
	if (o.withOrder) {
		dossierId = randomUUID();
		await seedOrderDossier(owner, { orderRef: dossierId, bureauId: t.bureau.id, clientProfileId: o.buyer.userId, members: 1 });
	}
	const code = "ABC123";
	const { rows } = await owner.query<{ id: string; public_token: string }>(
		`insert into scr_authorizations (bureau_id, document, type, name, email, holder_id, channel, status, requested_by,
		                                 client_profile_id, auth_code)
		 values ($1, '12345678909', 'PF', 'Sócio Teste', $2, $3, 'internal', 'pending', $4, $5, $6)
		 returning id, public_token::text`,
		[t.bureau.id, o.email, t.holder.id, t.operator.userId, o.buyer.userId, code],
	);
	if (dossierId) {
		await owner.query("update consultations set scr_authorization_id = $1 where dossier_id = $2", [rows[0].id, dossierId]);
	}
	const answer = (decision: "authorize" | "refuse") =>
		app
			.query<{ r: string }>("select confirm_public_scr_authorization($1, 'internal', $2, $3, '203.0.113.9') as r", [
				rows[0].public_token, code, decision,
			])
			.then((r) => r.rows[0].r);
	return { id: rows[0].id, dossierId, answer };
}

describe("evento 1: sócio autorizou o SCR", () => {
	it("event 1 one notice per subscription; confirm twice keeps count", async () => {
		const t = await seedTenant(owner, "push ev1");
		await subscribed(t.client, 2);
		const scr = await seedPartnerScr(t, { buyer: t.client, email: `socio-${randomUUID()}@example.test`, withOrder: true });

		expect(await scr.answer("authorize")).toBe("authorized");

		const rows = await pushNotices("scr_partner_authorized", `order:${scr.dossierId}`);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.params)).toEqual([{ url: `/portal/pesquisas/${scr.dossierId}` }, { url: `/portal/pesquisas/${scr.dossierId}` }]);
		expect(new Set(rows.map((r) => r.recipient)).size).toBe(2);
		expect(rows.every((r) => r.status === "pending")).toBe(true);

		expect(await scr.answer("authorize")).toBe("already");
		expect(await pushNotices("scr_partner_authorized", `order:${scr.dossierId}`)).toHaveLength(2);
	});

	it("event 1 without a linked order points to the list", async () => {
		const t = await seedTenant(owner, "push ev1 list");
		await subscribed(t.client, 1);
		const scr = await seedPartnerScr(t, { buyer: t.client, email: `socio-${randomUUID()}@example.test`, withOrder: false });

		expect(await scr.answer("authorize")).toBe("authorized");

		expect((await pushNotices("scr_partner_authorized", `scr:${scr.id}`)).map((r) => r.params)).toEqual([{ url: "/portal/pesquisas" }]);
	});

	it("event 1 skipped for self member, refusal and buyer without subscription", async () => {
		const t = await seedTenant(owner, "push ev1 skip");
		const lonely = await seedClientProfile(owner, t.bureau.id);
		await subscribed(t.client, 1);

		const { rows: mail } = await owner.query<{ email: string }>("select email from profiles where id = $1", [t.client.userId]);
		const self = await seedPartnerScr(t, { buyer: t.client, email: mail[0].email.toUpperCase(), withOrder: true });
		expect(await self.answer("authorize")).toBe("authorized");
		expect(await pushNotices("scr_partner_authorized", `order:${self.dossierId}`)).toHaveLength(0);

		const refused = await seedPartnerScr(t, { buyer: t.client, email: `socio-${randomUUID()}@example.test`, withOrder: true });
		expect(await refused.answer("refuse")).toBe("refused");
		expect(await pushNotices("scr_partner_authorized", `order:${refused.dossierId}`)).toHaveLength(0);

		const none = await seedPartnerScr(t, { buyer: lonely, email: `socio-${randomUUID()}@example.test`, withOrder: false });
		expect(await none.answer("authorize")).toBe("authorized");
		expect(await pushNotices("scr_partner_authorized", `scr:${none.id}`)).toHaveLength(0);
	});
});

// Pedido online do comprador já concluído e com parecer: pronto para releaseDelivery.
async function seedCompletedOrder(t: SeededTenant) {
	const dossierId = randomUUID();
	await seedOrderDossier(owner, { orderRef: dossierId, bureauId: t.bureau.id, clientProfileId: t.client.userId });
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica"); // dossier_orders_guard bloqueia o dono do pool
		await client.query("update dossier_orders set state = 'completed', ai_status = 'done' where dossier_id = $1", [dossierId]);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
	return dossierId;
}

describe("evento 2: consulta pronta", () => {
	it("event 2 adds push and keeps e-mail", async () => {
		const t = await seedTenant(owner, "push ev2");
		const staff = { ...t.operator };
		await subscribed(t.client, 2);
		const dossierId = await seedCompletedOrder(t);
		const release = () => withUserTransaction(staff, (c) => releaseDelivery(c, staff, dossierId, "https://app.example.test"));

		expect(await release()).toEqual({ ok: true });

		const email = await owner.query(
			`select 1 from notifications n join notification_templates t on t.id = n.template_id
			  where n.channel = 'email' and t.key = 'research_released' and n.reference = $1`,
			[`order:${dossierId}`],
		);
		expect(email.rowCount).toBe(1);
		const first = await pushNotices("research_released", `order:${dossierId}`);
		expect(first).toHaveLength(2);
		expect(first.map((r) => r.params)).toEqual([{ url: `/portal/pesquisas/${dossierId}` }, { url: `/portal/pesquisas/${dossierId}` }]);

		await withUserTransaction(staff, (c) => revokeDelivery(c, staff, dossierId, "Titular errado"));
		expect(await pushNotices("research_released", `order:${dossierId}`)).toHaveLength(2);
		expect(await release()).toEqual({ ok: true });
		expect(await pushNotices("research_released", `order:${dossierId}`)).toHaveLength(4);
	});
});

// ---- Comissão de afiliado (eventos 3 e 4) ----

type SettleRow = { ok: boolean; reason: string | null; status: string | null };

// Só o pedido reservado antes da 072 gera comissão do afiliado na captura (o push da comissão nasce dela): grava a reserva
// no formato antigo (Bureau 40%, custo 600,00 sobre 1000,00). Devolve o mesmo formato de reserve_order.
async function reserveOrder(_c: PoolClient, o: { orderRef: string; clientId: string; price: string; cost: string }) {
	await seedLegacyOnlineOrder(owner, {
		bureauId: (await owner.query<{ bureau_id: string }>("select bureau_id from profiles where id = $1", [o.clientId])).rows[0].bureau_id,
		clientProfileId: o.clientId,
		price: o.price,
		commissionPct: "40",
		orderRef: o.orderRef,
	});
	return { ok: true, reason: null, status: "reserved" } as SettleRow;
}
const captureOrder = (c: PoolClient, ref: string) =>
	c.query<SettleRow>("select * from capture_order($1)", [ref]).then((r) => r.rows[0]);

// Afiliado indicou o comprador do seed (telefone verificado, saldo, % padrão 10).
async function affiliateScenario(label: string) {
	const t = await seedTenant(owner, label);
	const affiliate = await seedClientProfile(owner, t.bureau.id);
	await owner.query(
		"insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)",
		[t.client.userId, affiliate.userId, t.bureau.id],
	);
	// O trigger protect_profile_contact só libera as funções da conta: o dono escreve com os gatilhos desligados.
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		await client.query("update profiles set phone_e164 = '+5563999990000', phone_verified_at = now() where id = $1", [t.client.userId]);
		await client.query("commit");
	} finally {
		client.release();
	}
	await owner.query(
		`insert into bureau_affiliate_settings (bureau_id, default_pct) values ($1, '10')
		 on conflict (bureau_id) do update set default_pct = excluded.default_pct`,
		[t.bureau.id],
	);
	await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "3000.00", createdBy: t.client.userId });
	return { t, affiliate };
}

async function placeAndCapture(t: SeededTenant) {
	const order = { orderRef: randomUUID(), clientId: t.client.userId, price: "1000.00", cost: "600.00" };
	expect(await committed(asClient(t.client), (c) => reserveOrder(c, order))).toMatchObject({ ok: true });
	expect(await committed(asStaff(t.bureauAdmin), (c) => captureOrder(c, order.orderRef))).toMatchObject({ ok: true });
	const { rows } = await owner.query<{ id: string }>("select id from affiliate_commissions where order_ref = $1", [order.orderRef]);
	return { orderRef: order.orderRef, commissionId: rows[0]?.id };
}
// Libera as comissões dadas numa única transação (um "tick"). Não chama release_due_commissions(): outro arquivo de
// teste roda essa função em paralelo, para todos os Bureaus, e liberaria as nossas antes.
const releaseNow = (...ids: string[]) =>
	owner.query("update affiliate_commissions set status = 'released' where id = any($1::uuid[]) and status = 'pending'", [ids]);

describe("evento 3: comissão recebida", () => {
	it("event 3 one notice per commission", async () => {
		const { t, affiliate } = await affiliateScenario("push ev3");
		await subscribed(affiliate, 2);

		const order = await placeAndCapture(t);

		const rows = await pushNotices("commission_received", `commission:${order.commissionId}`);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.params)).toEqual([{ url: "/portal/afiliacao" }, { url: "/portal/afiliacao" }]);

		expect(await committed(asStaff(t.bureauAdmin), (c) => captureOrder(c, order.orderRef))).toMatchObject({ status: "captured" });
		expect(await pushNotices("commission_received", `commission:${order.commissionId}`)).toHaveLength(2);
	});

	it("event 3 affiliate without subscription gets no notice", async () => {
		const { t } = await affiliateScenario("push ev3 none");

		const order = await placeAndCapture(t);

		expect(order.commissionId).toBeDefined();
		expect(await pushNotices("commission_received", `commission:${order.commissionId}`)).toHaveLength(0);
	});
});

describe("evento 4: comissão disponível para saque", () => {
	it("event 4 one notice per affiliate per transaction", async () => {
		const { t, affiliate } = await affiliateScenario("push ev4");
		await subscribed(affiliate, 2);
		const reference = `affiliate:${affiliate.userId}`;
		const first = await placeAndCapture(t);
		const second = await placeAndCapture(t);

		await releaseNow(first.commissionId, second.commissionId);
		const afterRun = await pushNotices("commission_available", reference);
		expect(afterRun).toHaveLength(2);
		expect(afterRun.map((r) => r.params)).toEqual([{ url: "/portal/afiliacao" }, { url: "/portal/afiliacao" }]);

		const third = await placeAndCapture(t);
		await releaseNow(third.commissionId);
		expect(await pushNotices("commission_available", reference)).toHaveLength(4);

		await releaseNow(first.commissionId, second.commissionId, third.commissionId);
		expect(await pushNotices("commission_available", reference)).toHaveLength(4);
	});
});

describe("o aviso push não derruba a operação de origem", () => {
	// Sem template push ativo o enqueue_push_for_profile lança P0002. Aposenta o template só dentro de uma transação
	// que termina em rollback: nada fica gravado e o template volta.
	it("capture_order succeeds and warns when the push template is missing", async () => {
		const { t, affiliate } = await affiliateScenario("push resilient");
		await subscribed(affiliate, 1);
		const order = { orderRef: randomUUID(), clientId: t.client.userId, price: "1000.00", cost: "600.00" };
		expect(await committed(asClient(t.client), (c) => reserveOrder(c, order))).toMatchObject({ ok: true });

		const c = await owner.connect();
		const warnings: string[] = [];
		c.on("notice", (n) => warnings.push(n.message ?? ""));
		try {
			await c.query("begin");
			await c.query("update notification_templates set status = 'retired' where key = 'commission_received' and channel = 'push' and status = 'active'");
			await c.query(
				`select set_config('app.user_id', $1, true), set_config('app.user_role', 'bureau_admin', true),
				        set_config('app.bureau_id', $2, true), set_config('app.support_session_id', '', true)`,
				[t.bureauAdmin.userId, t.bureau.id],
			);
			const captured = await c.query<SettleRow>("select * from capture_order($1)", [order.orderRef]);
			expect(captured.rows[0]).toMatchObject({ ok: true, status: "captured" });
			const commission = await c.query("select 1 from affiliate_commissions where order_ref = $1", [order.orderRef]);
			expect(commission.rowCount).toBe(1);
			const queued = await c.query("select 1 from notifications where channel = 'push' and created_by = $1", [affiliate.userId]);
			expect(queued.rowCount).toBe(0);
		} finally {
			await c.query("rollback");
			c.release();
		}
		expect(warnings.some((m) => m.includes("push enqueue failed (commission_received): sqlstate P0002"))).toBe(true);
		expect(warnings.join(" ")).not.toContain(affiliate.userId);
	});
});

describe("busca de entrega do worker", () => {
	// Enfileira um aviso push (função interna, só o dono do banco executa) e o pega como o worker.
	async function queuedAndClaimed(t: SeededTenant, profile: SeedIdentity) {
		const eventKey = `test_delivery:${randomUUID()}`;
		const { rows: queued } = await owner.query<{ n: number }>(
			"select enqueue_push_for_profile($1, 'commission_received', '/portal/afiliacao', $2, $3) as n",
			[profile.userId, eventKey, `test:${eventKey}`],
		);
		expect(queued[0].n).toBe(1);
		const { rows: mine } = await owner.query<{ id: string }>(
			"select id from notifications where reference = $1 and bureau_id = $2",
			[`test:${eventKey}`, t.bureau.id],
		);
		const claimed = async () => {
			for (let attempt = 0; attempt < 5; attempt += 1) {
				const { rows } = await dispatch.query<{ id: string; lease_id: string; channel: string }>(
					"select id, lease_id, channel from claim_notifications(50)",
				);
				const found = rows.find((r) => r.id === mine[0].id);
				if (found) return found;
			}
			throw new Error("notification was not claimed");
		};
		return claimed();
	}
	const lookup = (id: string, lease: string) =>
		dispatch
			.query<{ endpoint: string; p256dh: string; auth: string }>("select * from push_subscription_for_delivery($1, $2)", [id, lease])
			.then((r) => r.rows);

	it("enqueue_push_for_profile twice with the same event key creates no new rows", async () => {
		const t = await seedTenant(owner, "push idempotent");
		await subscribed(t.client, 2);
		const eventKey = `test_idem:${randomUUID()}`;
		const enqueue = () =>
			owner
				.query<{ n: number }>("select enqueue_push_for_profile($1, 'commission_received', '/portal/afiliacao', $2, $3) as n", [
					t.client.userId, eventKey, `test:${eventKey}`,
				])
				.then((r) => r.rows[0].n);

		expect(await enqueue()).toBe(2);
		expect(await enqueue()).toBe(0);
		expect(await pushNotices("commission_received", `test:${eventKey}`)).toHaveLength(2);
	});

	it("delivery lookup returns endpoint only with the lease", async () => {
		const t = await seedTenant(owner, "push delivery");
		const [endpoint] = await subscribed(t.client, 1);
		const job = await queuedAndClaimed(t, t.client);

		expect(job.channel).toBe("push");
		const rows = await lookup(job.id, job.lease_id);
		expect(rows).toHaveLength(1);
		expect(rows[0].endpoint).toBe(endpoint);
		expect(await lookup(job.id, randomUUID())).toHaveLength(0);
	});

	it("delivery lookup returns no row after endpoint transfer", async () => {
		const t = await seedTenant(owner, "push delivery transfer");
		const other = await seedClientProfile(owner, t.bureau.id);
		const [endpoint] = await subscribed(t.client, 1);
		const queued = await owner.query(
			"select enqueue_push_for_profile($1, 'commission_received', '/portal/afiliacao', $2, $3)",
			[t.client.userId, `test_transfer:${randomUUID()}`, `test_transfer:${t.client.userId}`],
		);
		expect(queued.rowCount).toBe(1);
		await register(asClient(other), endpoint);

		const { rows: mine } = await owner.query<{ id: string }>("select id from notifications where reference = $1", [`test_transfer:${t.client.userId}`]);
		let lease: string | null = null;
		for (let attempt = 0; attempt < 5 && !lease; attempt += 1) {
			const { rows } = await dispatch.query<{ id: string; lease_id: string }>("select id, lease_id from claim_notifications(50)");
			lease = rows.find((r) => r.id === mine[0].id)?.lease_id ?? null;
		}

		expect(lease).not.toBeNull();
		expect(await lookup(mine[0].id, lease as string)).toHaveLength(0);
	});

	it("delete_gone removes the subscription only with the lease", async () => {
		const t = await seedTenant(owner, "push delete gone");
		await subscribed(t.client, 1);
		const job = await queuedAndClaimed(t, t.client);
		const gone = (lease: string) =>
			dispatch.query<{ r: boolean }>("select delete_gone_push_subscription($1, $2) as r", [job.id, lease]).then((r) => r.rows[0].r);

		expect(await gone(randomUUID())).toBe(false);
		expect(await subscriptionsOf(t.client.userId)).toHaveLength(1);
		expect(await gone(job.lease_id)).toBe(true);
		expect(await subscriptionsOf(t.client.userId)).toHaveLength(0);
	});
});

describe("conta encerrada", () => {
	it("closed account drops subscriptions", async () => {
		const t = await seedTenant(owner, "push closed");
		const anonymized = await seedClientProfile(owner, t.bureau.id);
		await subscribed(t.client, 2);
		await subscribed(anonymized, 1);

		// protect_profile_identity: só o bureau_admin muda is_active.
		const c = await owner.connect();
		try {
			await c.query("begin");
			await c.query("select set_config('app.user_role', 'bureau_admin', true)");
			await c.query("update profiles set is_active = false where id = $1", [t.client.userId]);
			await c.query("commit");
		} finally {
			c.release();
		}
		expect(await subscriptionsOf(t.client.userId)).toHaveLength(0);

		const result = await committed(asStaff(t.bureauAdmin), (client) =>
			client.query<{ result: string }>("select lgpd_anonymize_client_account($1) as result", [anonymized.userId]).then((r) => r.rows[0].result),
		);
		expect(result).toBe("ok");
		expect(await subscriptionsOf(anonymized.userId)).toHaveLength(0);
	});
});

describe("CHECKs do canal push", () => {
	it("push template with e-mail body is rejected", async () => {
		await expect(
			owner.query(
				`insert into notification_templates (key, channel, version, params, email_subject, email_html, email_text)
				 values ($1, 'push', 1, array['url'], 's', '<p>h</p>', 't')`,
				[`push_body_${randomBytes(4).toString("hex")}`],
			),
		).rejects.toMatchObject({ code: "23514" });
	});

	it("push row with non-uuid recipient is rejected", async () => {
		const t = await seedTenant(owner, "push recipient");
		const { rows } = await owner.query<{ id: string }>(
			"select id from notification_templates where key = 'commission_received' and channel = 'push' and status = 'active'",
		);
		const insert = (recipient: string) =>
			owner.query(
				`insert into notifications (bureau_id, template_id, channel, recipient, recipient_masked, recipient_hash, params,
				                            idempotency_key, created_by)
				 values ($1, $2, 'push', $3, 'aparelho', repeat('a', 64), '{"url":"/portal/afiliacao"}', $4, $5)`,
				[t.bureau.id, rows[0].id, recipient, randomUUID(), t.client.userId],
			);

		await expect(insert("https://fcm.googleapis.com/fcm/send/abc")).rejects.toMatchObject({ code: "23514" });
		await expect(insert(randomUUID())).resolves.toBeDefined();
	});
});
