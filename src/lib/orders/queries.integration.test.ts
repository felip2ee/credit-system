// Pedido (M6) contra um Postgres real, sob RLS: abertura com reserva, claim, transições, liberação e avisos.
// Cada teste usa um Bureau novo; o pool do dono prepara e confere, o pool da aplicação executa.
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

import { maskRecipient } from "@/lib/auth/email";
import { quoteOrder } from "@/lib/catalog/quote";
import { registerCounterPayment } from "@/lib/counter-payments/queries";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { listDossiers } from "@/lib/dossiers/queries";
import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	randomCpf,
	seedBureauCost,
	seedCatalogItem,
	seedClientWalletTopup,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
} from "@/test/seed";

import { confirmPublicScrAuthorization, issueSelfScrAuthorization } from "@/lib/scr/queries";

import { getMyDelivery } from "./client-queries";
import {
	cancelOrder,
	claimOrders,
	completeOrder,
	failOrder,
	getExecutionPlan,
	placeOrder,
	refreshOrderState,
	releaseDelivery,
	retryOrderLater,
	revokeDelivery,
} from "./queries";
import { updateOrderContact } from "./contact";
import { getStaffOrder } from "./staff-queries";
import {
	cancelStalledOrders,
	claimOrderForAi,
	expireScrRequests,
	listOnlineOrdersToRelease,
	listOrdersForAi,
	listOrdersToPromote,
	listScrRequestsToIssue,
	setAiStatus,
} from "./tick-queries";
import type { OpenOrderInput, OrderProductCode } from "./types";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

const onlyDigits = (value: string) => value.replace(/\D/g, "");
const cpf = () => onlyDigits(randomCpf());
const SITE = "https://app.example.test";
const ALL_PRICES: Partial<Record<string, string>> = {
	dossie_pf: "50.00",
	dossie_empresarial: "50.00",
};

beforeAll(acquireClaimLock, 120_000);

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
	await releaseClaimLock();
});

// Preço de venda por código; custo fixo de 1,00. O Dossiê Empresarial cobra 10,00 (custo 1,00) por sócio.
async function sell(t: SeededTenant, prices: Partial<Record<string, string>>) {
	for (const code of ["dossie_pf", "dossie_empresarial"]) {
		const price = prices[code];
		if (!price) continue;
		const perPartner = code === "dossie_empresarial";
		// O seed do catálogo deixa os produtos inativos.
		await owner.query("update products set active = true where code = $1", [code]);
		const { rows } = await owner.query<{ id: string }>("select id from products where code = $1", [code]);
		await seedBureauCost(owner, {
			bureauId: t.bureau.id,
			productId: rows[0].id,
			cost: "1.00",
			costPerPartner: perPartner ? "1.00" : "0.00",
			setBy: t.bureauAdmin.userId,
		});
		await seedCatalogItem(owner, {
			bureauId: t.bureau.id,
			productId: rows[0].id,
			salePrice: price,
			salePricePerPartner: perPartner ? "10.00" : "0.00",
			updatedBy: t.bureauAdmin.userId,
		});
	}
}

type Funds = { client?: string; bureau?: string };

async function newTenant(label: string, funds: Funds = { client: "200.00", bureau: "200.00" }): Promise<SeededTenant> {
	const t = await seedTenant(owner, label);
	await sell(t, ALL_PRICES);
	if (funds.client) {
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: funds.client, createdBy: t.bureauAdmin.userId });
	}
	if (funds.bureau) {
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: funds.bureau, createdBy: t.bureauAdmin.userId });
	}
	return t;
}

const staff = (t: SeededTenant): DbIdentity => ({ ...t.operator });
const buyerOf = (t: SeededTenant): DbIdentity => ({ ...t.client });

// O cliente não lê o custo do catálogo: a cotação sai com a identidade da equipe do Bureau.
async function quote(identity: DbIdentity, code: OrderProductCode, partnerCount = 0) {
	const q = await quoteOrder(identity, code, { partnerCount });
	if (!q.ok) throw new Error(`quote failed: ${q.reason}`);
	return q;
}

const ownInput = (over: Partial<OpenOrderInput> = {}): OpenOrderInput => ({
	productCode: "dossie_pf",
	self: true,
	subject: null,
	partners: [],
	contact: { email: null, phoneE164: null },
	buyerProfileId: null,
	...over,
});

const thirdInput = (over: Partial<OpenOrderInput> = {}): OpenOrderInput => ({
	productCode: "dossie_pf",
	self: false,
	subject: { type: "PF", name: "Fulano de Tal", documentDigits: cpf() },
	partners: [],
	contact: { email: `titular-${crypto.randomUUID()}@example.com`, phoneE164: null },
	buyerProfileId: null,
	...over,
});

// Dossiê Empresarial online: qualquer CNPJ, também o de terceiro (o Dossiê Pessoa Física online é só do próprio cliente).
const companyInput = (over: Partial<OpenOrderInput> = {}): OpenOrderInput =>
	thirdInput({
		productCode: "dossie_empresarial",
		subject: { type: "PJ", name: "Empresa Teste", documentDigits: Array.from({ length: 14 }, () => Math.floor(Math.random() * 10)).join("") },
		...over,
	});

async function placeOnline(t: SeededTenant, input: OpenOrderInput = ownInput()): Promise<string> {
	const result = await placeOrder(buyerOf(t), input, await quote(staff(t), input.productCode, input.partners.length));
	if (!result.ok) throw new Error(`placeOrder failed: ${result.reason}`);
	return result.dossierId;
}

async function placeCounter(t: SeededTenant, input: OpenOrderInput = thirdInput()): Promise<string> {
	const result = await placeOrder(staff(t), input, await quote(staff(t), input.productCode, input.partners.length));
	if (!result.ok) throw new Error(`placeOrder failed: ${result.reason}`);
	return result.dossierId;
}

async function rows<R extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<R[]> {
	return (await owner.query<R>(sql, params)).rows;
}

const orderOf = async (id: string) =>
	(await rows<{ state: string; state_reason: string | null; ai_status: string; attempts: number; lease_until: Date | null }>(
		"select state, state_reason, ai_status, attempts, lease_until from dossier_orders where dossier_id = $1",
		[id],
	))[0];

const clientWallet = async (t: SeededTenant) =>
	(await rows("select available, reserved from client_wallets where client_profile_id = $1", [t.client.userId]))[0];
const bureauWallet = async (t: SeededTenant) =>
	(await rows("select available, reserved from wallets where bureau_id = $1", [t.bureau.id]))[0];

// Autoriza todas as solicitações ligadas ao pedido (o Titular responde fora do sistema).
const authorizeAll = (dossierId: string, interval = "30 days") =>
	owner.query(
		`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + $2::interval, auth_code = null
		  where id in (select scr_authorization_id from consultations where dossier_id = $1) and status = 'pending'`,
		[dossierId, interval],
	);

const refresh = (t: SeededTenant, id: string) => withUserTransaction(staff(t), (c) => refreshOrderState(c, id));

async function makeReady(t: SeededTenant, id: string) {
	await authorizeAll(id);
	expect(await refresh(t, id)).toBe("ready");
}

async function claim(t: SeededTenant, id: string) {
	const claimed = await withUserTransaction(staff(t), (c) => claimOrders(c, 10, id));
	expect(claimed).toHaveLength(1);
	return claimed[0].attempts;
}

async function toCompleted(t: SeededTenant, id: string) {
	await makeReady(t, id);
	await claim(t, id);
	expect(await withUserTransaction(staff(t), (c) => completeOrder(c, staff(t), id))).toBe("completed");
}

// Todo pedido concluído espera o parecer; a liberação só vem depois dele (feito ou falho).
async function toReleasable(t: SeededTenant, id: string) {
	await toCompleted(t, id);
	await withUserTransaction(staff(t), (c) => setAiStatus(c, staff(t), id, "done", 1));
}

// Os gatilhos de perfil e do pedido bloqueiam o dono do pool: o teste os desliga só nesta transação.
async function asReplica(sql: string, params: unknown[]) {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		await client.query(sql, params);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

const count = async (table: string, t: SeededTenant) =>
	Number((await rows<{ n: string }>(`select count(*) as n from ${table} where bureau_id = $1`, [t.bureau.id]))[0].n);

describe("placeOrder", () => {
	it("online without balance waits for the PIX and reserves nothing", async () => {
		const t = await newTenant("ord broke online", {});
		const online = await placeOrder(buyerOf(t), ownInput(), await quote(staff(t), "dossie_pf"));
		expect(online).toMatchObject({ ok: true, state: "awaiting_payment", pixPriceCents: 5000 });

		expect(await count("order_settlements", t)).toBe(0);
		expect(await count("order_pix_quotes", t)).toBe(1);
		expect(await count("dossier_orders", t)).toBe(1);
	});

	it("counter insufficient balance leaves no dossier, order or scr row", async () => {
		const t = await newTenant("ord broke", {});
		const counter = await placeOrder(staff(t), thirdInput(), await quote(staff(t), "dossie_pf"));
		expect(counter).toEqual({ ok: false, reason: "insufficient_balance" });

		for (const table of ["dossiers", "dossier_orders", "consultations", "scr_authorizations", "order_settlements"]) {
			expect(await count(table, t), table).toBe(0);
		}
		// Só o Titular do seed: o Titular novo do balcão foi desfeito junto.
		expect(await count("holders", t)).toBe(1);
	});

	it("returns the opening failure without reserving", async () => {
		const t = await newTenant("ord kind");
		const wrong = await placeOrder(
			staff(t),
			thirdInput({ productCode: "dossie_empresarial" }),
			await quote(staff(t), "dossie_empresarial"),
		);
		expect(wrong).toEqual({ ok: false, reason: "kind_mismatch" });
		expect(await bureauWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
	});

	it("placeOrder online reserves P on the client wallet", async () => {
		const t = await newTenant("ord online");
		const id = await placeOnline(t);

		expect(await clientWallet(t)).toEqual({ available: "150.00", reserved: "50.00" });
		expect(await bureauWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect((await orderOf(id)).state).toBe("awaiting_authorization");
		const [settlement] = await rows("select mode, status, price from order_settlements where order_ref = $1", [id]);
		expect(settlement).toEqual({ mode: "online", status: "reserved", price: "50.00" });
	});

	it("placeOrder counter reserves C on the bureau wallet and stays awaiting_payment", async () => {
		const t = await newTenant("ord counter");
		const id = await placeCounter(t);

		expect(await bureauWallet(t)).toEqual({ available: "199.00", reserved: "1.00" });
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect((await orderOf(id)).state).toBe("awaiting_payment");
	});

	it("listDossiers shows the order state of the dossier", async () => {
		const t = await newTenant("ord list");
		const id = await placeCounter(t);

		const listed = await listDossiers(staff(t), {});

		expect(listed.find((d) => d.id === id)?.order_state).toBe("awaiting_payment");
	});
});

describe("claimOrders", () => {
	it("two concurrent claims return disjoint orders", async () => {
		const t = await newTenant("ord claim", { client: "400.00" });
		const ids: string[] = [];
		for (let i = 0; i < 4; i += 1) {
			const id = await placeOnline(t);
			await authorizeAll(id);
			await refresh(t, id);
			ids.push(id);
		}
		// A segunda transação só pede depois que a primeira já travou as suas linhas, e a primeira só confirma depois.
		let aClaimed!: () => void;
		let bDone!: () => void;
		const afterA = new Promise<void>((resolve) => (aClaimed = resolve));
		const afterB = new Promise<void>((resolve) => (bDone = resolve));
		const a = withUserTransaction(staff(t), async (c) => {
			const got = await claimOrders(c, 2);
			aClaimed();
			await afterB;
			return got;
		});
		const b = withUserTransaction(staff(t), async (c) => {
			await afterA;
			const got = await claimOrders(c, 2);
			bDone();
			return got;
		});
		const [first, second] = await Promise.all([a, b]);

		const all = [...first, ...second].map((r) => r.dossierId);
		expect(first).toHaveLength(2);
		expect(second).toHaveLength(2);
		expect(new Set(all).size).toBe(4);
		expect([...all].sort()).toEqual([...ids].sort());
		expect([...first, ...second].every((r) => r.attempts === 1)).toBe(true);
	});

	it("expired lease is claimed again and counts as an attempt", async () => {
		const t = await newTenant("ord lease");
		const id = await placeOnline(t);
		await makeReady(t, id);
		expect(await claim(t, id)).toBe(1);

		// Lease vigente: ninguém mais assume.
		expect(await withUserTransaction(staff(t), (c) => claimOrders(c, 10, id))).toEqual([]);
		await owner.query("update dossier_orders set lease_until = now() - interval '1 minute' where dossier_id = $1", [id]);
		expect(await claim(t, id)).toBe(2);
		expect((await orderOf(id)).state).toBe("executing");
	});

	it("a reclaim at the attempts ceiling does not break the claim", async () => {
		const t = await newTenant("ord ceiling");
		const id = await placeOnline(t);
		await makeReady(t, id);
		await claim(t, id);
		await owner.query("update dossier_orders set attempts = 20, lease_until = now() - interval '1 minute' where dossier_id = $1", [id]);

		expect(await withUserTransaction(staff(t), (c) => claimOrders(c, 10, id))).toEqual([{ dossierId: id, attempts: 20 }]);
	});

	it("next_attempt_at in the future is not claimed", async () => {
		const t = await newTenant("ord backoff");
		const id = await placeOnline(t);
		await makeReady(t, id);
		await owner.query("update dossier_orders set next_attempt_at = now() + interval '1 hour' where dossier_id = $1", [id]);

		expect(await withUserTransaction(staff(t), (c) => claimOrders(c, 10))).toEqual([]);
		await owner.query("update dossier_orders set next_attempt_at = now() - interval '1 second' where dossier_id = $1", [id]);
		expect(await withUserTransaction(staff(t), (c) => claimOrders(c, 10))).toHaveLength(1);
	});

	it("does not claim an order of another Bureau", async () => {
		const t = await newTenant("ord claim A");
		const other = await newTenant("ord claim B");
		const id = await placeOnline(t);
		await makeReady(t, id);
		expect(await withUserTransaction(staff(other), (c) => claimOrders(c, 10))).toEqual([]);
	});
});

describe("completeOrder", () => {
	it("completeOrder captures and leaves the opinion pending", async () => {
		const t = await newTenant("ord complete");
		const id = await placeOnline(t);
		await toCompleted(t, id);

		expect(await orderOf(id)).toMatchObject({ state: "completed", ai_status: "pending", lease_until: null });
		const [settlement] = await rows("select status from order_settlements where order_ref = $1", [id]);
		expect(settlement.status).toBe("captured");
		expect(await clientWallet(t)).toEqual({ available: "150.00", reserved: "0.00" });
		const audit = await rows<{ metadata: unknown }>("select metadata from audit_logs where action = 'order.complete' and record_id = $1", [id]);
		expect(audit).toHaveLength(1);
		const timeline = await rows("select 1 from timeline_events where event_type = 'order.completed' and bureau_id = $1", [t.bureau.id]);
		expect(timeline).toHaveLength(1);
	});

	it("counter order captures C on the bureau wallet and accrues nothing to the payable", async () => {
		const t = await newTenant("ord counter capture");
		const id = await placeCounter(t);
		await registerCounterPayment(staff(t), {
			dossierId: id,
			method: "cash",
			amount: "50.00",
			note: null,
			receivedAt: new Date("2026-10-14T12:00:00Z"),
		});
		expect(await bureauWallet(t)).toEqual({ available: "199.00", reserved: "1.00" });
		const payableBefore = await rows("select kind, amount::text from bureau_payable_entries where bureau_id = $1", [t.bureau.id]);

		await makeReady(t, id);
		await claim(t, id);
		expect(await withUserTransaction(staff(t), (c) => completeOrder(c, staff(t), id))).toBe("completed");

		expect(await bureauWallet(t)).toEqual({ available: "199.00", reserved: "0.00" });
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		const [settlement] = await rows("select mode, status, cost::text from order_settlements where order_ref = $1", [id]);
		expect(settlement).toEqual({ mode: "counter", status: "captured", cost: "1.00" });
		expect(await rows("select kind, amount::text from bureau_payable_entries where bureau_id = $1", [t.bureau.id])).toEqual(payableBefore);
	});

	it("clawed back capture fails the order without delivery", async () => {
		const t = await newTenant("ord clawback", { client: "100.00" });
		const id = await placeOnline(t);
		await makeReady(t, id);
		await claim(t, id);
		await owner.query("select * from client_wallet_post_entry($1, 'reversal', 100, $2, null, null, $1)", [
			t.client.userId,
			`claw-${id}`,
		]);

		expect(await withUserTransaction(staff(t), (c) => completeOrder(c, staff(t), id))).toBe("failed");

		expect(await orderOf(id)).toMatchObject({ state: "failed", state_reason: "reservation_clawed_back", lease_until: null });
		const [settlement] = await rows<{ id: string; status: string }>("select id, status from order_settlements where order_ref = $1", [id]);
		expect(settlement.status).toBe("released");
		// O fechamento foi gravado uma vez só; não houve nova liberação.
		expect(await rows("select 1 from audit_logs where action = 'settlement.release' and record_id = $1", [settlement.id])).toHaveLength(1);
		expect(await rows("select 1 from audit_logs where action = 'order.fail' and record_id = $1", [id])).toHaveLength(1);
		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE))).toEqual({ ok: false, reason: "invalid_state" });
	});
});

describe("cancelOrder, failOrder and retryOrderLater", () => {
	it("cancel and fail release the reservation exactly once", async () => {
		const t = await newTenant("ord release");
		const cancelled = await placeOnline(t);
		expect(await clientWallet(t)).toEqual({ available: "150.00", reserved: "50.00" });

		expect(await withUserTransaction(staff(t), (c) => cancelOrder(c, staff(t), cancelled, "cancelled_by_staff"))).toEqual({ ok: true });
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect(await orderOf(cancelled)).toMatchObject({ state: "cancelled", state_reason: "cancelled_by_staff" });
		expect(await rows("select status from dossiers where id = $1", [cancelled])).toEqual([{ status: "cancelled" }]);
		expect(await rows("select status from consultations where dossier_id = $1", [cancelled])).toEqual([{ status: "rejected" }]);
		expect(await withUserTransaction(staff(t), (c) => cancelOrder(c, staff(t), cancelled, "cancelled_by_staff"))).toEqual({
			ok: false,
			reason: "invalid_state",
		});
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect(await rows("select 1 from audit_logs where action = 'order.cancel' and record_id = $1", [cancelled])).toHaveLength(1);
		expect(await rows("select 1 from timeline_events where event_type = 'order.cancelled' and bureau_id = $1", [t.bureau.id])).toHaveLength(1);

		const failed = await placeOnline(t);
		await makeReady(t, failed);
		await claim(t, failed);
		await withUserTransaction(staff(t), (c) => failOrder(c, staff(t), failed, "deps_no_data"));
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect(await orderOf(failed)).toMatchObject({ state: "failed", state_reason: "deps_no_data", lease_until: null });
		const audit = await rows<{ metadata: { reason: string } }>("select metadata from audit_logs where action = 'order.fail' and record_id = $1", [failed]);
		expect(audit).toHaveLength(1);
		expect(audit[0].metadata).toEqual({ reason: "deps_no_data" });

		// Repetir não muda o saldo nem grava de novo: o pedido já não está em consulta.
		await expect(withUserTransaction(staff(t), (c) => failOrder(c, staff(t), failed, "deps_no_data"))).rejects.toThrow();
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect(await rows("select 1 from audit_logs where action = 'order.fail' and record_id = $1", [failed])).toHaveLength(1);
	});

	it("cancel after executing is invalid_state", async () => {
		const t = await newTenant("ord cancel exec");
		const id = await placeOnline(t);
		await makeReady(t, id);
		await claim(t, id);

		expect(await withUserTransaction(staff(t), (c) => cancelOrder(c, staff(t), id, "cancelled_by_staff"))).toEqual({
			ok: false,
			reason: "invalid_state",
		});
		expect(await clientWallet(t)).toEqual({ available: "150.00", reserved: "50.00" });
		expect(await withUserTransaction(staff(t), (c) => cancelOrder(c, staff(t), crypto.randomUUID(), "cancelled_by_staff"))).toEqual({
			ok: false,
			reason: "not_found",
		});
	});

	it("cancels a counter order and gives the Bureau cost back", async () => {
		const t = await newTenant("ord cancel counter");
		const id = await placeCounter(t);
		expect(await withUserTransaction(staff(t), (c) => cancelOrder(c, staff(t), id, "cancelled_by_staff"))).toEqual({ ok: true });
		expect(await bureauWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
	});

	it("retryOrderLater backs off and fails on the fifth attempt", async () => {
		const t = await newTenant("ord retry");
		const id = await placeOnline(t);
		await makeReady(t, id);
		const minutes = async () =>
			Math.round(Number((await rows<{ m: string }>("select extract(epoch from next_attempt_at - now()) / 60 as m from dossier_orders where dossier_id = $1", [id]))[0].m));

		expect(await claim(t, id)).toBe(1);
		expect(await withUserTransaction(staff(t), (c) => retryOrderLater(c, staff(t), id, 1))).toBe("ready");
		expect(await orderOf(id)).toMatchObject({ state: "ready", lease_until: null });
		expect(await minutes()).toBe(1);
		const retried = await rows<{ metadata: { attempts: number; next_attempt_at: string } }>(
			"select metadata from audit_logs where action = 'order.retry' and record_id = $1",
			[id],
		);
		expect(retried).toHaveLength(1);
		expect(retried[0].metadata.attempts).toBe(1);
		expect(Number.isNaN(Date.parse(retried[0].metadata.next_attempt_at))).toBe(false);

		await owner.query("update dossier_orders set next_attempt_at = null, attempts = 2 where dossier_id = $1", [id]);
		expect(await claim(t, id)).toBe(3);
		expect(await withUserTransaction(staff(t), (c) => retryOrderLater(c, staff(t), id, 3))).toBe("ready");
		expect(await minutes()).toBe(4);
		expect(await clientWallet(t)).toEqual({ available: "150.00", reserved: "50.00" });

		await owner.query("update dossier_orders set next_attempt_at = null, attempts = 4 where dossier_id = $1", [id]);
		expect(await claim(t, id)).toBe(5);
		expect(await withUserTransaction(staff(t), (c) => retryOrderLater(c, staff(t), id, 5))).toBe("failed");
		expect(await orderOf(id)).toMatchObject({ state: "failed", state_reason: "deps_unavailable" });
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
	});
});

describe("releaseDelivery and revokeDelivery", () => {
	const releasedNotices = (id: string) =>
		rows<{ channel: string; status: string }>(
			`select n.channel, n.status from notifications n where n.reference = $1 order by n.channel`,
			[`order:${id}`],
		);

	it("releaseDelivery enqueues email always and whatsapp only for whatsapp channel", async () => {
		const t = await newTenant("ord notice");
		const emailOnly = await placeOnline(t);
		await toReleasable(t, emailOnly);
		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), emailOnly, `${SITE}/`))).toEqual({ ok: true });
		expect(await releasedNotices(emailOnly)).toEqual([{ channel: "email", status: "pending" }]);
		expect(await orderOf(emailOnly)).toMatchObject({ state: "released" });
		const [row] = await rows<{ released_by: string; released_at: Date | null }>(
			"select released_by, released_at from dossier_orders where dossier_id = $1",
			[emailOnly],
		);
		expect(row.released_by).toBe(t.operator.userId);
		expect(row.released_at).toBeInstanceOf(Date);
		expect(await rows("select 1 from audit_logs where action = 'order.release' and record_id = $1", [emailOnly])).toHaveLength(1);
		expect(await rows("select 1 from timeline_events where event_type = 'order.released' and bureau_id = $1", [t.bureau.id])).toHaveLength(1);

		await asReplica(
			"update profiles set phone_e164 = '+5563992345615', phone_verified_at = now(), notification_channel = 'whatsapp' where id = $1",
			[t.client.userId],
		);
		const both = await placeOnline(t);
		await toReleasable(t, both);
		await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), both, SITE));
		expect(await releasedNotices(both)).toEqual([
			{ channel: "email", status: "pending" },
			{ channel: "whatsapp", status: "pending" },
		]);
		const [audit] = await rows("select count(*)::int as n from audit_logs where action = 'notification.enqueue' and bureau_id = $1", [t.bureau.id]);
		expect(audit.n).toBe(3);
	});

	it("no buyer is no_buyer", async () => {
		const t = await newTenant("ord nobuyer");
		const id = await placeCounter(t);
		await registerCounterPayment(staff(t), {
			dossierId: id,
			method: "cash",
			amount: "50.00",
			note: null,
			receivedAt: new Date("2026-10-14T12:00:00Z"),
		});
		await makeReady(t, id);
		await claim(t, id);
		await withUserTransaction(staff(t), (c) => completeOrder(c, staff(t), id));
		await withUserTransaction(staff(t), (c) => setAiStatus(c, staff(t), id, "done", 1));

		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE))).toEqual({ ok: false, reason: "no_buyer" });
		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), crypto.randomUUID(), SITE))).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect((await orderOf(id)).state).toBe("completed");
	});

	it("release of a pending ai order is invalid_state", async () => {
		const t = await newTenant("ord aipending");
		const id = await placeOnline(t, ownInput());
		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE))).toEqual({ ok: false, reason: "invalid_state" });
		await toCompleted(t, id);
		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE))).toEqual({ ok: false, reason: "invalid_state" });
		await withUserTransaction(staff(t), (c) => setAiStatus(c, staff(t), id, "failed", 3));
		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE))).toEqual({ ok: true });
	});

	it("release after revoke clears the revocation and the client reads the delivery again", async () => {
		const t = await newTenant("ord rerelease");
		const id = await placeOnline(t);
		await toReleasable(t, id);
		await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE));
		await withUserTransaction(staff(t), (c) => revokeDelivery(c, staff(t), id, "Titular errado"));
		expect(await withUserTransaction(buyerOf(t), (c) => getMyDelivery(c, id))).toBeNull();

		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE))).toEqual({ ok: true });

		expect(await rows("select revoked_at, revoked_by, revoke_reason from dossier_orders where dossier_id = $1", [id])).toEqual([
			{ revoked_at: null, revoked_by: null, revoke_reason: null },
		]);
		expect((await orderOf(id)).state).toBe("released");
		expect(await withUserTransaction(buyerOf(t), (c) => getMyDelivery(c, id))).not.toBeNull();
	});

	it("revokeDelivery requires a reason and hides the delivery from the client", async () => {
		const t = await newTenant("ord revoke");
		const id = await placeOnline(t);
		await toReleasable(t, id);
		expect(await withUserTransaction(staff(t), (c) => revokeDelivery(c, staff(t), id, "erro"))).toEqual({ ok: false, reason: "invalid_state" });
		await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE));
		expect(await withUserTransaction(buyerOf(t), (c) => getMyDelivery(c, id))).not.toBeNull();
		const notices = (await releasedNotices(id)).length;

		await expect(withUserTransaction(staff(t), (c) => revokeDelivery(c, staff(t), id, "   "))).rejects.toThrow();
		await expect(withUserTransaction(staff(t), (c) => revokeDelivery(c, staff(t), id, "x".repeat(501)))).rejects.toThrow();
		expect((await orderOf(id)).state).toBe("released");

		expect(await withUserTransaction(staff(t), (c) => revokeDelivery(c, staff(t), id, "  Titular errado no cadastro  "))).toEqual({ ok: true });
		expect(await withUserTransaction(buyerOf(t), (c) => getMyDelivery(c, id))).toBeNull();
		expect((await orderOf(id)).state).toBe("completed");
		const [row] = await rows<{ revoked_by: string; revoke_reason: string; revoked_at: Date }>(
			"select revoked_by, revoke_reason, revoked_at from dossier_orders where dossier_id = $1",
			[id],
		);
		expect(row.revoke_reason).toBe("Titular errado no cadastro");
		expect(row.revoked_by).toBe(t.operator.userId);
		const audit = await rows("select metadata from audit_logs where action = 'order.revoke' and record_id = $1", [id]);
		expect(audit).toHaveLength(1);
		expect(JSON.stringify(audit)).not.toContain("Titular errado");
		expect(await rows("select 1 from timeline_events where event_type = 'order.revoked' and bureau_id = $1", [t.bureau.id])).toHaveLength(1);
		// Sem aviso ao cliente, e o pedido revogado não volta sozinho.
		expect((await releasedNotices(id)).length).toBe(notices);
		expect(await withUserTransaction(staff(t), (c) => listOnlineOrdersToRelease(c, 10))).toEqual([]);
		expect(await withUserTransaction(staff(t), (c) => revokeDelivery(c, staff(t), id, "de novo"))).toEqual({ ok: false, reason: "invalid_state" });
	});
});

describe("authorization and stalled orders", () => {
	const authorizationRows = (dossierId: string) =>
		rows<{ id: string; status: string; auth_code: string | null }>(
			`select s.id, s.status, s.auth_code from scr_authorizations s
			   join consultations c on c.scr_authorization_id = s.id where c.dossier_id = $1`,
			[dossierId],
		);

	it("expireScrRequests and cancelStalledOrders cancel and release", async () => {
		const t = await newTenant("ord stalled");

		// Recusa do Titular.
		const refused = await placeOnline(t, companyInput());
		await owner.query(
			`update scr_authorizations set status = 'not_authorized', refused_at = now()
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[refused],
		);
		// Pedido sem resposta no prazo.
		const expired = await placeOnline(t, companyInput());
		await owner.query(
			`update scr_authorizations set auth_code = 'ABC123', request_expires_at = now() - interval '1 minute'
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[expired],
		);
		// Balcão sem pagamento há mais de 7 dias.
		const unpaid = await placeCounter(t);
		await asReplica("update dossier_orders set created_at = now() - interval '8 days' where dossier_id = $1", [unpaid]);
		// Balcão recente: fica.
		const fresh = await placeCounter(t);
		expect(await clientWallet(t)).toEqual({ available: "100.00", reserved: "100.00" });

		expect(await withUserTransaction(staff(t), (c) => expireScrRequests(c, staff(t)))).toBe(1);
		expect(await authorizationRows(expired)).toEqual([expect.objectContaining({ status: "expired", auth_code: null })]);
		expect(await rows("select 1 from timeline_events where event_type = 'scr.expired' and bureau_id = $1", [t.bureau.id])).toHaveLength(1);
		expect(await withUserTransaction(staff(t), (c) => expireScrRequests(c, staff(t)))).toBe(0);

		expect(await withUserTransaction(staff(t), (c) => cancelStalledOrders(c, staff(t)))).toBe(3);
		expect(await orderOf(refused)).toMatchObject({ state: "cancelled", state_reason: "scr_refused" });
		expect(await orderOf(expired)).toMatchObject({ state: "cancelled", state_reason: "scr_expired" });
		expect(await orderOf(unpaid)).toMatchObject({ state: "cancelled", state_reason: "payment_timeout" });
		expect(await orderOf(fresh)).toMatchObject({ state: "awaiting_payment" });
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect(await bureauWallet(t)).toEqual({ available: "199.00", reserved: "1.00" });
		expect(await withUserTransaction(staff(t), (c) => cancelStalledOrders(c, staff(t)))).toBe(0);
	});

	it("expired authorization is re-requested in the same scope", async () => {
		const t = await newTenant("ord rerequest");
		const id = await placeOnline(t);
		const [pending] = await authorizationRows(id);
		const issued = await withUserTransaction(staff(t), (c) => listScrRequestsToIssue(c, staff(t), 10));
		expect(issued).toEqual([expect.objectContaining({ scrId: pending.id, type: "PF", phoneE164: null })]);
		expect(issued[0].email).toContain("@");

		// Com o código já emitido, a linha sai da lista.
		await owner.query("update scr_authorizations set auth_code = 'ABC123' where id = $1", [pending.id]);
		expect(await withUserTransaction(staff(t), (c) => listScrRequestsToIssue(c, staff(t), 10))).toEqual([]);

		await owner.query(
			"update scr_authorizations set status = 'authorized', authorized_at = now() - interval '2 days', expires_at = now() - interval '1 minute', auth_code = null where id = $1",
			[pending.id],
		);
		const again = await withUserTransaction(staff(t), (c) => listScrRequestsToIssue(c, staff(t), 10));
		expect(again).toHaveLength(1);
		expect(again[0].scrId).not.toBe(pending.id);
		expect(again[0].holderId).toBe(issued[0].holderId);
		expect(again[0].document).toBe(issued[0].document);

		const linked = await authorizationRows(id);
		expect(linked).toEqual([expect.objectContaining({ id: again[0].scrId, status: "pending" })]);
		const [scope] = await rows<{ client_profile_id: string; requested_by: string }>(
			"select client_profile_id, requested_by from scr_authorizations where id = $1",
			[again[0].scrId],
		);
		expect(scope.client_profile_id).toBe(t.client.userId);
		expect(scope.requested_by).toBe(t.operator.userId);
		// Repetir não abre outra linha.
		expect(await withUserTransaction(staff(t), (c) => listScrRequestsToIssue(c, staff(t), 10))).toHaveLength(1);
		expect(await rows("select 1 from scr_authorizations where holder_id = $1", [issued[0].holderId])).toHaveLength(2);
	});
});

describe("queue listings and views", () => {
	it("lists the work for the tick and shows the order to the staff", async () => {
		const t = await newTenant("ord views");
		const id = await placeOnline(t, ownInput());
		// Sem autorização o refresh não mudaria nada: o pedido ainda não é candidato.
		expect(await withUserTransaction(staff(t), (c) => listOrdersToPromote(c, 10))).toEqual([]);
		await authorizeAll(id);
		expect(await withUserTransaction(staff(t), (c) => listOrdersToPromote(c, 10))).toEqual([id]);

		const plan = await withUserTransaction(staff(t), (c) => getExecutionPlan(c, id));
		expect(plan?.order).toEqual({ dossierId: id, mode: "online", attempts: 0, kind: "PF" });
		expect(plan?.members).toEqual([
			expect.objectContaining({ type: "PF", document: onlyDigits(t.holder.document), isMain: true, status: "pending_authorization" }),
		]);
		expect(await withUserTransaction(staff(t), (c) => getExecutionPlan(c, crypto.randomUUID()))).toBeNull();

		await toCompleted(t, id);
		expect(await withUserTransaction(staff(t), (c) => listOrdersToPromote(c, 10))).toEqual([]);
		expect(await withUserTransaction(staff(t), (c) => listOrdersForAi(c, 10))).toEqual([{ dossierId: id, kind: "PF", aiAttempts: 0 }]);
		expect(await withUserTransaction(staff(t), (c) => listOnlineOrdersToRelease(c, 10))).toEqual([]);

		await withUserTransaction(staff(t), (c) => setAiStatus(c, staff(t), id, "done", 1));
		expect(await withUserTransaction(staff(t), (c) => listOrdersForAi(c, 10))).toEqual([]);
		expect(await withUserTransaction(staff(t), (c) => listOnlineOrdersToRelease(c, 10))).toEqual([id]);

		const view = await withUserTransaction(staff(t), (c) => getStaffOrder(c, id));
		expect(view).toMatchObject({
			dossierId: id,
			mode: "online",
			state: "completed",
			reason: null,
			productCode: "dossie_pf",
			aiStatus: "done",
			price: "50.00",
			paidTotal: null,
			releasedAt: null,
			revokedAt: null,
		});
		expect(view?.buyerName).toContain("client");
	});

	it("shows the paid total of a counter order and moves it by payments", async () => {
		const t = await newTenant("ord counter view");
		const id = await placeCounter(t);
		const pay = (amount: string) =>
			registerCounterPayment(staff(t), { dossierId: id, method: "pix", amount, note: null, receivedAt: new Date("2026-10-14T12:00:00Z") });
		await pay("20.00");
		expect(await withUserTransaction(staff(t), (c) => getStaffOrder(c, id))).toMatchObject({ state: "awaiting_payment", price: "50.00", paidTotal: "20.00", buyerName: null });
		await pay("30.00");
		expect((await orderOf(id)).state).toBe("awaiting_authorization");
	});
});

describe("tick candidates and AI claim", () => {
	const isDue = async (t: SeededTenant) =>
		(await rows<{ bureau_id: string }>("select bureau_id from due_order_bureaus() where bureau_id = $1", [t.bureau.id])).length === 1;

	it("listOrdersToPromote is not starved by older orders that cannot change state", async () => {
		const t = await newTenant("ord starve", { client: "2000.00" });
		for (let i = 0; i < 25; i += 1) {
			await placeOnline(t, companyInput());
			// O teto de 5 pedidos online por cliente em 24 h vale: os pedidos de carga saem da janela.
			await asReplica("update dossier_orders set created_at = created_at - interval '2 days' where client_profile_id = $1", [t.client.userId]);
		}
		const newest = await placeOnline(t, companyInput());
		await authorizeAll(newest);

		expect(await withUserTransaction(staff(t), (c) => listOrdersToPromote(c, 20))).toEqual([newest]);

		// Pronto que perdeu a autorização também é candidato (volta a esperar).
		await refresh(t, newest);
		await owner.query(
			`update scr_authorizations set expires_at = now() - interval '1 minute'
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[newest],
		);
		expect(await withUserTransaction(staff(t), (c) => listOrdersToPromote(c, 20))).toEqual([newest]);
	});

	it("open_order sets the request deadline when the pending row is created", async () => {
		const t = await newTenant("ord deadline");
		const id = await placeOnline(t, companyInput());

		const [row] = await rows<{ days: string }>(
			`select extract(epoch from s.request_expires_at - now()) / 86400 as days from scr_authorizations s
			  where s.id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[id],
		);
		expect(Number(row.days)).toBeGreaterThan(6.9);
		expect(Number(row.days)).toBeLessThanOrEqual(7);
	});

	it("renewal without a contact expires the authorization and the order is cancelled as scr_expired", async () => {
		const t = await newTenant("ord renew nocontact");
		const id = await placeOnline(t, companyInput());
		await authorizeAll(id);
		await owner.query(
			`update scr_authorizations set email = null, expires_at = now() - interval '1 minute'
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[id],
		);
		await owner.query("update consultations set scr_email = null where dossier_id = $1", [id]);
		const [holder] = await rows<{ holder_id: string }>("select holder_id from scr_authorizations where id in (select scr_authorization_id from consultations where dossier_id = $1)", [id]);

		expect(await withUserTransaction(staff(t), (c) => listScrRequestsToIssue(c, staff(t), 10))).toEqual([]);

		expect(await rows("select 1 from scr_authorizations where holder_id = $1", [holder.holder_id])).toHaveLength(1);
		expect(await rows("select status from scr_authorizations where holder_id = $1", [holder.holder_id])).toEqual([{ status: "expired" }]);
		expect(await withUserTransaction(staff(t), (c) => cancelStalledOrders(c, staff(t)))).toBe(1);
		expect(await orderOf(id)).toMatchObject({ state: "cancelled", state_reason: "scr_expired" });
	});

	it("renewed request carries the 7 day deadline", async () => {
		const t = await newTenant("ord renew deadline");
		const id = await placeOnline(t, companyInput());
		await authorizeAll(id);
		await owner.query(
			`update scr_authorizations set expires_at = now() - interval '1 minute'
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[id],
		);

		const [created] = await withUserTransaction(staff(t), (c) => listScrRequestsToIssue(c, staff(t), 10));

		const [row] = await rows<{ days: string }>(
			"select extract(epoch from request_expires_at - now()) / 86400 as days from scr_authorizations where id = $1",
			[created.scrId],
		);
		expect(Number(row.days)).toBeGreaterThan(6.9);
	});

	it("a Bureau whose only pending work is a revoked online order is not due", async () => {
		const t = await newTenant("ord due revoked");
		const id = await placeOnline(t);
		await toReleasable(t, id);
		expect(await isDue(t)).toBe(true);
		await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE));
		await withUserTransaction(staff(t), (c) => revokeDelivery(c, staff(t), id, "Titular errado"));

		expect(await isDue(t)).toBe(false);
	});

	it("claimOrderForAi counts the attempt first and a live lease blocks the next claim and the listing", async () => {
		const t = await newTenant("ord ai claim");
		const id = await placeOnline(t, ownInput());
		await toCompleted(t, id);

		expect(await withUserTransaction(staff(t), (c) => claimOrderForAi(c, staff(t), id))).toBe(1);

		expect(await rows("select ai_attempts, ai_status, (lease_until > now()) as leased from dossier_orders where dossier_id = $1", [id])).toEqual([
			{ ai_attempts: 1, ai_status: "pending", leased: true },
		]);
		expect(await withUserTransaction(staff(t), (c) => claimOrderForAi(c, staff(t), id))).toBeNull();
		expect(await withUserTransaction(staff(t), (c) => listOrdersForAi(c, 10))).toEqual([]);

		// Lease vencida (queda do tick): volta à fila com a tentativa já contada.
		await owner.query("update dossier_orders set lease_until = now() - interval '1 minute' where dossier_id = $1", [id]);
		expect(await withUserTransaction(staff(t), (c) => listOrdersForAi(c, 10))).toEqual([{ dossierId: id, kind: "PF", aiAttempts: 1 }]);
		expect(await withUserTransaction(staff(t), (c) => claimOrderForAi(c, staff(t), id))).toBe(2);
		expect(await rows("select 1 from audit_logs where action = 'order.ai_status' and record_id = $1", [id])).toHaveLength(2);
	});

	it("claimOrderForAi closes as failed when a crash ate the last attempt, and setAiStatus audits", async () => {
		const t = await newTenant("ord ai exhausted");
		const id = await placeOnline(t, ownInput());
		await toCompleted(t, id);
		await owner.query("update dossier_orders set ai_attempts = 3 where dossier_id = $1", [id]);

		expect(await withUserTransaction(staff(t), (c) => claimOrderForAi(c, staff(t), id))).toBeNull();

		expect(await orderOf(id)).toMatchObject({ state: "completed", ai_status: "failed", lease_until: null });
		await withUserTransaction(staff(t), (c) => setAiStatus(c, staff(t), id, "failed", 3));
		const audit = await rows<{ metadata: unknown }>("select metadata from audit_logs where action = 'order.ai_status' and record_id = $1 order by created_at", [id]);
		expect(audit.map((a) => a.metadata)).toEqual([
			{ status: "failed", attempts: 3 },
			{ status: "failed", attempts: 3 },
		]);
	});
});

describe("total por número de sócios (Dossiê Empresarial)", () => {
	const cnpj = () => Array.from({ length: 14 }, () => Math.floor(Math.random() * 10)).join("");
	const partner = (documentDigits = cpf()) => ({
		documentDigits,
		name: "Sócio",
		email: `socio-${crypto.randomUUID()}@example.com`,
		percentage: null,
		role: null,
	});
	// Venda 100,00 + 30,00 por sócio; o Bureau fica com 40% do preço bruto (a parte da plataforma é 60%).
	async function pricedTenant(label: string): Promise<SeededTenant> {
		const t = await seedTenant(owner, label);
		await owner.query("update products set active = true where code = 'dossie_empresarial'");
		const { rows: product } = await owner.query<{ id: string }>("select id from products where code = 'dossie_empresarial'");
		await seedBureauCost(owner, { bureauId: t.bureau.id, productId: product[0].id, cost: "60.00", costPerPartner: "20.00", setBy: t.bureauAdmin.userId });
		await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: product[0].id, salePrice: "100.00", salePricePerPartner: "30.00", updatedBy: t.bureauAdmin.userId });
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "1000.00", createdBy: t.bureauAdmin.userId });
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "1000.00", createdBy: t.bureauAdmin.userId });
		return t;
	}
	const companyWith = (partners: ReturnType<typeof partner>[], over: Partial<OpenOrderInput> = {}) =>
		companyInput({ partners, ...over });

	it("counter order reserves 60%, of the gross price, for 0, 1 and 3 partners", async () => {
		const t = await pricedTenant("ord total counter");
		let reserved = 0;
		for (const [partners, cost] of [[0, 60], [1, 78], [3, 114]] as const) {
			await placeCounter(t, companyWith(Array.from({ length: partners }, () => partner())));
			reserved += cost;
			expect(await bureauWallet(t)).toEqual({ available: (1000 - reserved).toFixed(2), reserved: reserved.toFixed(2) });
		}
	});

	it("the same CPF twice counts as one partner", async () => {
		const t = await pricedTenant("ord total dup");
		const repeated = partner();
		// A cotação do chamador conta os dois; o banco recalcula pelos membros do dossiê e recusa o total.
		const input = companyWith([repeated, { ...repeated, email: `outro-${crypto.randomUUID()}@example.com` }]);
		const stale = await placeOrder(staff(t), input, await quote(staff(t), "dossie_empresarial", 2));
		expect(stale).toEqual({ ok: false, reason: "price_mismatch" });
		const exact = await placeOrder(staff(t), input, await quote(staff(t), "dossie_empresarial", 1));
		expect(exact.ok).toBe(true);
		expect(await bureauWallet(t)).toEqual({ available: "922.00", reserved: "78.00" });
	});

	it("a partner with the company CNPJ or any 14 digits is invalid_input", async () => {
		const t = await pricedTenant("ord total cnpj");
		const company = cnpj();
		const base = companyInput({ subject: { type: "PJ", name: "Empresa", documentDigits: company } });
		for (const documentDigits of [company, cnpj()]) {
			const result = await placeOrder(staff(t), { ...base, partners: [partner(documentDigits)] }, await quote(staff(t), "dossie_empresarial", 1));
			expect(result).toEqual({ ok: false, reason: "invalid_input" });
		}
		expect(await bureauWallet(t)).toEqual({ available: "1000.00", reserved: "0.00" });
	});

	it("online order with 2 partners reserves 160 of sale price on the client wallet", async () => {
		const t = await pricedTenant("ord total online");
		const id = await placeOnline(t, companyWith([partner(), partner()]));
		expect(await clientWallet(t)).toEqual({ available: "840.00", reserved: "160.00" });
		const [settlement] = await rows("select price, cost from order_settlements where order_ref = $1", [id]);
		expect(settlement).toEqual({ price: "160.00", cost: "96.00" });
		const [stored] = await rows<{ quote: { lines: { part: string; quantity: number; priceCents: number }[] } }>(
			"select quote from order_settlements where order_ref = $1",
			[id],
		);
		expect(stored.quote.lines).toEqual([
			expect.objectContaining({ part: "base", quantity: 1, priceCents: 10000 }),
			expect.objectContaining({ part: "partner", quantity: 2, priceCents: 6000 }),
		]);
	});

	it("a total that differs from the order is price_mismatch (online) or cost_mismatch (counter) and reserves nothing", async () => {
		const t = await pricedTenant("ord total mismatch");
		const inputs = companyWith([partner()]);
		const q = await quote(staff(t), "dossie_empresarial", 1);
		const online = await placeOrder(buyerOf(t), inputs, { ...q, totalPriceCents: q.totalPriceCents - 1 });
		expect(online).toEqual({ ok: false, reason: "price_mismatch" });
		const counterPrice = await placeOrder(staff(t), inputs, { ...q, totalPriceCents: q.totalPriceCents + 100 });
		expect(counterPrice).toEqual({ ok: false, reason: "price_mismatch" });
		const counterCost = await placeOrder(staff(t), inputs, { ...q, platformShareCents: q.platformShareCents - 100 });
		expect(counterCost).toEqual({ ok: false, reason: "cost_mismatch" });
		expect(await clientWallet(t)).toEqual({ available: "1000.00", reserved: "0.00" });
		expect(await bureauWallet(t)).toEqual({ available: "1000.00", reserved: "0.00" });
		expect(await count("order_settlements", t)).toBe(0);
	});

	it("a failed order releases the whole reservation", async () => {
		const t = await pricedTenant("ord total release");
		const id = await placeOnline(t, companyWith([partner(), partner()]));
		await withUserTransaction(staff(t), (c) => cancelOrder(c, staff(t), id, "cancelled_by_staff"));
		expect(await clientWallet(t)).toEqual({ available: "1000.00", reserved: "0.00" });
	});
});

describe("balcão para o Titular do comprador (044)", () => {
	const buyerDigits = (t: SeededTenant) => onlyDigits(t.holder.document);
	const accountEmail = async (t: SeededTenant) =>
		(await rows<{ email: string }>("select email from profiles where id = $1", [t.client.userId]))[0].email.toLowerCase();
	const forBuyer = (t: SeededTenant, over: Partial<OpenOrderInput> = {}) =>
		thirdInput({ buyerProfileId: t.client.userId, ...over });
	const scrOf = async (dossierId: string) =>
		(await rows<{ email: string | null; scr_email: string | null }>(
			`select s.email, c.scr_email from consultations c join scr_authorizations s on s.id = c.scr_authorization_id
			  where c.dossier_id = $1 order by c.created_at, c.id`,
			[dossierId],
		))[0];

	it("accepts the buyer's own holder without contact and uses the account e-mail", async () => {
		const t = await newTenant("ord own counter");
		const subject = { type: "PF" as const, name: "Nome digitado", documentDigits: buyerDigits(t) };

		const id = await placeCounter(t, forBuyer(t, { subject, contact: { email: null, phoneE164: null } }));

		expect(await scrOf(id)).toEqual({ email: await accountEmail(t), scr_email: await accountEmail(t) });
		const [order] = await rows("select self_research, mode from dossier_orders where dossier_id = $1", [id]);
		expect(order).toEqual({ self_research: false, mode: "counter" });
		const [audit] = await rows("select metadata from audit_logs where action = 'order.open' and record_id = $1", [id]);
		expect(audit.metadata).toMatchObject({ mode: "counter", self_member: true });
	});

	it("ignores the typed contact for the buyer's own holder, even the buyer's e-mail", async () => {
		const t = await newTenant("ord own typed");
		const subject = { type: "PF" as const, name: "Fulano", documentDigits: buyerDigits(t) };
		const typedOther = await placeCounter(t, forBuyer(t, { subject, contact: { email: "outro@example.test", phoneE164: "+5511912345678" } }));
		const typedBuyer = await placeCounter(t, forBuyer(t, { subject, contact: { email: await accountEmail(t), phoneE164: null } }));

		for (const id of [typedOther, typedBuyer]) {
			expect(await scrOf(id)).toEqual({ email: await accountEmail(t), scr_email: await accountEmail(t) });
		}
		const [phone] = await rows("select phone_e164 from scr_authorizations where bureau_id = $1 and phone_e164 is not null", [t.bureau.id]);
		expect(phone).toBeUndefined();
	});

	it("still refuses a third party with the buyer's e-mail or without contact", async () => {
		const t = await newTenant("ord third counter");
		const sameEmail = await placeOrder(
			staff(t),
			forBuyer(t, { contact: { email: await accountEmail(t), phoneE164: null } }),
			await quote(staff(t), "dossie_pf"),
		);
		expect(sameEmail).toEqual({ ok: false, reason: "contact_is_buyer" });
		const noContact = await placeOrder(
			staff(t),
			forBuyer(t, { contact: { email: null, phoneE164: null } }),
			await quote(staff(t), "dossie_pf"),
		);
		expect(noContact).toEqual({ ok: false, reason: "invalid_input" });
	});

	it("lets a partner whose CPF is the buyer's holder use the buyer's e-mail; another partner still cannot", async () => {
		const t = await newTenant("ord partner counter");
		const email = await accountEmail(t);
		const base = (partners: OpenOrderInput["partners"]) =>
			companyInput({ buyerProfileId: t.client.userId, partners });
		const partner = (documentDigits: string, partnerEmail: string) => ({
			documentDigits,
			name: "Sócio",
			email: partnerEmail,
			percentage: null,
			role: null,
		});
		const q = await quote(staff(t), "dossie_empresarial", 1);

		const other = await placeOrder(staff(t), base([partner(cpf(), email)]), q);
		expect(other).toEqual({ ok: false, reason: "contact_is_buyer" });
		const own = await placeOrder(staff(t), base([partner(buyerDigits(t), email)]), q);
		expect(own.ok).toBe(true);
	});
});

describe("updateOrderContact (044)", () => {
	const CODE = "ABC234";
	const NEW_CODE = "XYZ789";
	const mailTo = () => `novo-${crypto.randomUUID()}@example.test`;

	async function member(dossierId: string) {
		return (await rows<{ consultation_id: string; scr_id: string; token: string }>(
			`select c.id as consultation_id, s.id as scr_id, s.public_token::text as token
			   from consultations c join scr_authorizations s on s.id = c.scr_authorization_id
			  where c.dossier_id = $1 order by c.created_at, c.id`,
			[dossierId],
		))[0];
	}

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

	// Emite o que a troca devolveu, como a action e o tick fazem.
	const issueRequestOf = (t: SeededTenant, request: { scrId: string; email: string; publicToken: string }, code: string) =>
		issueWith(t, request.scrId, request.email, code, request.publicToken);

	// Recua os instantes de troca para fora do intervalo de reenvio (continuam dentro das 24 h).
	const ageChanges = (scrId: string) =>
		owner.query(
			"update scr_authorizations set contact_changes_at = array(select t - interval '10 minutes' from unnest(contact_changes_at) t) where id = $1",
			[scrId],
		);

	const toAwaitingAuthorization = (dossierId: string) =>
		owner.query("update dossier_orders set state = 'awaiting_authorization' where dossier_id = $1", [dossierId]);

	const change = (identity: DbIdentity, dossierId: string, consultationId: string, email: string | null, phoneE164: string | null = null) =>
		withUserTransaction(identity, (c) => updateOrderContact(c, { dossierId, consultationId, email, phoneE164 }));

	const sentTo = (scrId: string) =>
		rows<{ status: string; recipient_masked: string }>(
			"select status, recipient_masked from notifications where reference = $1 and channel = 'email' order by created_at",
			[`scr_authorization:${scrId}`],
		);

	// Pedido que espera a autorização, com o link já enviado ao e-mail errado.
	async function sentToWrongEmail(t: SeededTenant) {
		const wrong = mailTo();
		const dossierId = await placeCounter(t, thirdInput({ contact: { email: wrong, phoneE164: null } }));
		await toAwaitingAuthorization(dossierId);
		const m = await member(dossierId);
		expect(await issueWith(t, m.scr_id, wrong, CODE)).toEqual({ ok: true });
		return { dossierId, m, wrong };
	}

	it("a new e-mail kills the old link, queues a new one and the new token works", async () => {
		const t = await newTenant("ord contact swap");
		const { dossierId, m, wrong } = await sentToWrongEmail(t);
		const right = mailTo();

		const result = await change(staff(t), dossierId, m.consultation_id, right);

		expect(result).toMatchObject({ ok: true, deferred: false, request: { scrId: m.scr_id, email: right } });
		const after = (await rows<{ public_token: string; auth_code: string | null; email: string; status: string }>(
			"select public_token::text, auth_code, email, status from scr_authorizations where id = $1",
			[m.scr_id],
		))[0];
		expect(after).toMatchObject({ auth_code: null, email: right, status: "pending" });
		expect(after.public_token).not.toBe(m.token);
		expect((await rows("select scr_email from consultations where id = $1", [m.consultation_id]))[0]).toEqual({ scr_email: right });
		// A notificação do e-mail errado ainda estava na fila: foi anulada.
		expect((await sentTo(m.scr_id)).map((n) => n.status)).toEqual(["suppressed"]);

		// Quem recebeu o e-mail errado não autoriza mais: nem com o token antigo e o código antigo.
		expect(await confirmPublicScrAuthorization(m.token, CODE, "authorize", "1.1.1.1")).toEqual({ status: "not_found" });

		// A emissão para o contato novo manda o link novo e o token novo confirma.
		if (!result.ok || !result.request) throw new Error("request expected");
		expect(result.request.publicToken).toBe(after.public_token);
		expect(await issueRequestOf(t, result.request, NEW_CODE)).toEqual({ ok: true });
		expect(await confirmPublicScrAuthorization(after.public_token, CODE, "authorize", "1.1.1.1")).toEqual({ status: "invalid_code" });
		expect(await confirmPublicScrAuthorization(after.public_token, NEW_CODE, "authorize", "1.1.1.1")).toEqual({ status: "authorized" });
		const sent = await sentTo(m.scr_id);
		expect(sent.map((n) => n.status)).toEqual(["suppressed", "pending"]);
		expect(sent[1].recipient_masked).not.toContain(wrong);
	});

	it("while the order awaits payment it saves the contact, rotates the token and sends nothing", async () => {
		const t = await newTenant("ord contact payment");
		const dossierId = await placeCounter(t, thirdInput());
		const m = await member(dossierId);
		const right = mailTo();

		const result = await change(staff(t), dossierId, m.consultation_id, right);

		expect(result).toEqual({ ok: true, request: null, deferred: true });
		const after = (await rows<{ public_token: string; email: string }>(
			"select public_token::text, email from scr_authorizations where id = $1",
			[m.scr_id],
		))[0];
		expect(after.email).toBe(right);
		expect(after.public_token).not.toBe(m.token);
		// O tick só emite em awaiting_authorization.
		expect(await withUserTransaction(staff(t), (c) => listScrRequestsToIssue(c, staff(t), 10))).toEqual([]);
		expect(await sentTo(m.scr_id)).toEqual([]);

		// Reenviar sem mudança não faz sentido antes do pagamento.
		await owner.query("update scr_authorizations set contact_changes_at = '{}' where id = $1", [m.scr_id]);
		expect(await change(staff(t), dossierId, m.consultation_id, null)).toEqual({ ok: false, reason: "invalid_state" });
	});

	it("resend to the same e-mail issues a new token and refuses a second change right away, with or without a sent link", async () => {
		const t = await newTenant("ord contact resend");
		const { dossierId, m, wrong } = await sentToWrongEmail(t);

		const resent = await change(staff(t), dossierId, m.consultation_id, wrong);
		expect(resent).toMatchObject({ ok: true, request: { email: wrong } });
		expect(await confirmPublicScrAuthorization(m.token, CODE, "authorize", null)).toEqual({ status: "not_found" });

		// O intervalo conta da troca, mesmo sem a emissão feita (código ainda nulo).
		expect(await change(staff(t), dossierId, m.consultation_id, null)).toEqual({ ok: false, reason: "resend_too_soon" });
		expect(await change(staff(t), dossierId, m.consultation_id, mailTo())).toEqual({ ok: false, reason: "resend_too_soon" });
		await ageChanges(m.scr_id);
		expect(await change(staff(t), dossierId, m.consultation_id, null)).toMatchObject({ ok: true });
	});

	it("allows 5 changes or resends per authorization in 24 h, resends included", async () => {
		const t = await newTenant("ord contact daily cap");
		const { dossierId, m } = await sentToWrongEmail(t);

		for (let i = 0; i < 5; i += 1) {
			expect(await change(staff(t), dossierId, m.consultation_id, null)).toMatchObject({ ok: true });
			await ageChanges(m.scr_id);
		}
		expect(await change(staff(t), dossierId, m.consultation_id, null)).toEqual({ ok: false, reason: "contact_limit_reached" });
		expect(await change(staff(t), dossierId, m.consultation_id, mailTo())).toEqual({ ok: false, reason: "contact_limit_reached" });

		// Fora das 24 h os instantes saem da conta.
		await owner.query("update scr_authorizations set contact_changes_at = array(select t - interval '25 hours' from unnest(contact_changes_at) t) where id = $1", [m.scr_id]);
		expect(await change(staff(t), dossierId, m.consultation_id, null)).toMatchObject({ ok: true });
	});

	it("an issue made before a newer change is superseded: only the last recipient gets a valid link", async () => {
		const t = await newTenant("ord contact race");
		const { dossierId, m } = await sentToWrongEmail(t);
		const first = mailTo();
		const last = mailTo();

		const a = await change(staff(t), dossierId, m.consultation_id, first);
		await ageChanges(m.scr_id);
		const b = await change(staff(t), dossierId, m.consultation_id, last);
		if (!a.ok || !a.request || !b.ok || !b.request) throw new Error("requests expected");

		// A emissão do primeiro operador chega depois da troca do segundo: não grava e não enfileira.
		expect(await issueRequestOf(t, a.request, "AAA111")).toEqual({ ok: false, reason: "superseded" });
		expect(await issueRequestOf(t, b.request, NEW_CODE)).toEqual({ ok: true });

		const after = (await rows<{ email: string; auth_code: string; public_token: string }>(
			"select email, auth_code, public_token::text from scr_authorizations where id = $1",
			[m.scr_id],
		))[0];
		expect(after).toMatchObject({ email: last, auth_code: NEW_CODE, public_token: b.request.publicToken });
		const sent = await sentTo(m.scr_id);
		expect(sent.map((n) => n.status)).toEqual(["suppressed", "pending"]);
		expect(sent[1].recipient_masked).toBe(maskRecipient(last));
		expect(await confirmPublicScrAuthorization(a.request.publicToken, "AAA111", "authorize", null)).toEqual({ status: "not_found" });
	});

	it("a tick that read the contact before the change cannot bring the old e-mail back", async () => {
		const t = await newTenant("ord contact tick race");
		const wrong = mailTo();
		const dossierId = await placeCounter(t, thirdInput({ contact: { email: wrong, phoneE164: null } }));
		await toAwaitingAuthorization(dossierId);
		const m = await member(dossierId);

		const [stale] = await withUserTransaction(staff(t), (c) => listScrRequestsToIssue(c, staff(t), 10));
		expect(stale).toMatchObject({ scrId: m.scr_id, email: wrong, publicToken: m.token });
		const right = mailTo();
		const changed = await change(staff(t), dossierId, m.consultation_id, right);
		if (!changed.ok || !changed.request) throw new Error("request expected");

		expect(await issueRequestOf(t, stale, "OLD111")).toEqual({ ok: false, reason: "superseded" });
		expect(await sentTo(m.scr_id)).toEqual([]);
		// O mesmo token só emite uma vez: um segundo emissor (tick e action juntos) não troca o código já enviado.
		expect(await issueRequestOf(t, changed.request, NEW_CODE)).toEqual({ ok: true });
		expect(await issueRequestOf(t, changed.request, "OTHER1")).toEqual({ ok: false, reason: "superseded" });
		expect((await rows("select email, auth_code from scr_authorizations where id = $1", [m.scr_id]))[0]).toEqual({ email: right, auth_code: NEW_CODE });
	});

	it("two changes at the same time: exactly one wins, the other waits and is refused by the interval", async () => {
		const t = await newTenant("ord contact concurrent");
		const { dossierId, m } = await sentToWrongEmail(t);
		const x = mailTo();
		const y = mailTo();

		const results = await Promise.all([
			change(staff(t), dossierId, m.consultation_id, x),
			change(staff(t), dossierId, m.consultation_id, y),
		]);

		const winners = results.filter((r) => r.ok);
		expect(winners).toHaveLength(1);
		expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "resend_too_soon" }]);
		const winner = winners[0];
		if (!winner.ok || !winner.request) throw new Error("request expected");
		expect(await issueRequestOf(t, winner.request, NEW_CODE)).toEqual({ ok: true });
		expect((await rows<{ email: string }>("select email from scr_authorizations where id = $1", [m.scr_id]))[0].email).toBe(winner.request.email);
	});

	it("audits in the same transaction with the masked e-mail, never the full address", async () => {
		const t = await newTenant("ord contact audit");
		const { dossierId, m, wrong } = await sentToWrongEmail(t);
		const right = mailTo();

		await change(staff(t), dossierId, m.consultation_id, right, "+5511912345678");

		const [audit] = await rows<{ metadata: Record<string, unknown>; user_id: string }>(
			"select metadata, user_id from audit_logs where action = 'order.update_contact' and record_id = $1",
			[dossierId],
		);
		expect(audit.user_id).toBe(t.operator.userId);
		expect(audit.metadata).toMatchObject({
			consultation_id: m.consultation_id,
			authorization_id: m.scr_id,
			previous_email_masked: maskRecipient(wrong),
			email_masked: maskRecipient(right),
			phone_set: true,
			resend_only: false,
			buyer_override: false,
		});
		expect(JSON.stringify(audit.metadata)).not.toContain(right);
		expect(JSON.stringify(audit.metadata)).not.toContain(wrong);

		await ageChanges(m.scr_id);
		await change(staff(t), dossierId, m.consultation_id, null);
		const resends = await rows<{ metadata: Record<string, unknown> }>(
			"select metadata from audit_logs where action = 'order.update_contact' and record_id = $1 order by created_at desc, id limit 1",
			[dossierId],
		);
		expect(resends[0].metadata).toMatchObject({ resend_only: true, email_masked: maskRecipient(right) });
	});

	it("writes one audit event per order that shares the authorization and skips the ones already answered", async () => {
		const t = await newTenant("ord contact shared");
		const subject = { type: "PF" as const, name: "Fulano de Tal", documentDigits: cpf() };
		const input = () => thirdInput({ buyerProfileId: t.client.userId, subject, contact: { email: mailTo(), phoneE164: null } });
		const first = await placeCounter(t, input());
		const second = await placeCounter(t, input());
		const m = await member(first);
		expect((await member(second)).scr_id).toBe(m.scr_id);
		await toAwaitingAuthorization(first);
		await owner.query("update dossier_orders set state = 'cancelled', state_reason = 'cancelled_by_staff' where dossier_id = $1", [second]);
		const third = await placeCounter(t, input());
		expect((await member(third)).scr_id).toBe(m.scr_id);

		expect(await change(staff(t), first, m.consultation_id, mailTo())).toMatchObject({ ok: true });

		const audited = async (id: string) =>
			rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where action = 'order.update_contact' and record_id = $1", [id]);
		expect(await audited(first)).toHaveLength(1);
		const shared = await audited(third);
		expect(shared).toHaveLength(1);
		expect(shared[0].metadata).toMatchObject({ authorization_id: m.scr_id, shared_from_dossier_id: first });
		// Pedido que não espera mais: fica de fora, sem erro.
		expect(await audited(second)).toHaveLength(0);
	});

	it("refuses the buyer's e-mail for a third party and audits the refusal without the contact", async () => {
		const t = await newTenant("ord contact d12");
		const buyerEmail = (await rows<{ email: string }>("select email from profiles where id = $1", [t.client.userId]))[0].email.toLowerCase();
		const third = await placeCounter(t, thirdInput({ buyerProfileId: t.client.userId }));
		await toAwaitingAuthorization(third);
		const thirdMember = await member(third);
		expect(await change(staff(t), third, thirdMember.consultation_id, buyerEmail)).toEqual({ ok: false, reason: "contact_is_buyer" });

		const [refused] = await rows<{ metadata: Record<string, unknown> }>(
			"select metadata from audit_logs where action = 'order.update_contact_refused' and record_id = $1",
			[third],
		);
		expect(refused.metadata).toMatchObject({ reason: "contact_is_buyer", authorization_id: thirdMember.scr_id, email_changed: true });
		expect(JSON.stringify(refused.metadata)).not.toContain(buyerEmail);
		// A recusa não gasta o limite de trocas.
		expect((await rows("select cardinality(contact_changes_at) as n from scr_authorizations where id = $1", [thirdMember.scr_id]))[0]).toEqual({ n: 0 });
	});

	it("keeps the account e-mail for the buyer's own holder and flags the discarded typed contact", async () => {
		const t = await newTenant("ord contact own holder");
		const buyerEmail = (await rows<{ email: string }>("select email from profiles where id = $1", [t.client.userId]))[0].email.toLowerCase();
		const own = await placeCounter(
			t,
			thirdInput({
				buyerProfileId: t.client.userId,
				subject: { type: "PF", name: "Comprador", documentDigits: onlyDigits(t.holder.document) },
				contact: { email: null, phoneE164: null },
			}),
		);
		await toAwaitingAuthorization(own);
		const ownMember = await member(own);

		const result = await change(staff(t), own, ownMember.consultation_id, "digitado@example.test", "+5511912345678");

		expect(result).toMatchObject({ ok: true, request: { email: buyerEmail, phoneE164: null } });
		const [audit] = await rows<{ metadata: Record<string, unknown> }>(
			"select metadata from audit_logs where action = 'order.update_contact' and record_id = $1",
			[own],
		);
		expect(audit.metadata).toMatchObject({ buyer_override: true, email_masked: maskRecipient(buyerEmail) });
		expect(JSON.stringify(audit.metadata)).not.toContain("digitado@example.test");
	});

	it("is invalid_input, not a SQL error, when the buyer's account e-mail is not usable", async () => {
		const t = await newTenant("ord contact bad account email");
		const own = await placeCounter(
			t,
			thirdInput({
				buyerProfileId: t.client.userId,
				subject: { type: "PF", name: "Comprador", documentDigits: onlyDigits(t.holder.document) },
				contact: { email: null, phoneE164: null },
			}),
		);
		await toAwaitingAuthorization(own);
		const ownMember = await member(own);
		await owner.query("update profiles set email = 'sem-arroba' where id = $1", [t.client.userId]);

		expect(await change(staff(t), own, ownMember.consultation_id, null)).toEqual({ ok: false, reason: "invalid_input" });
	});

	it("respects the recipient cap of new requests", async () => {
		const t = await newTenant("ord contact cap");
		const crowded = mailTo();
		for (let i = 0; i < 3; i += 1) await placeCounter(t, thirdInput({ contact: { email: crowded, phoneE164: null } }));
		const dossierId = await placeCounter(t, thirdInput());
		const m = await member(dossierId);

		expect(await change(staff(t), dossierId, m.consultation_id, crowded)).toEqual({ ok: false, reason: "too_many_requests" });
	});

	it("is invalid_state once the order is cancelled or the authorization was answered", async () => {
		const t = await newTenant("ord contact state");
		const answered = await placeCounter(t);
		const answeredMember = await member(answered);
		await authorizeAll(answered);
		expect(await change(staff(t), answered, answeredMember.consultation_id, mailTo())).toEqual({ ok: false, reason: "invalid_state" });

		const cancelled = await placeCounter(t);
		const cancelledMember = await member(cancelled);
		await withUserTransaction(staff(t), (c) => cancelOrder(c, staff(t), cancelled, "cancelled_by_staff"));
		expect(await change(staff(t), cancelled, cancelledMember.consultation_id, mailTo())).toEqual({ ok: false, reason: "invalid_state" });
	});

	it("another Bureau and the client role cannot change it", async () => {
		const t = await newTenant("ord contact owner");
		const other = await newTenant("ord contact other");
		const { dossierId, m, wrong } = await sentToWrongEmail(t);

		expect(await change(staff(other), dossierId, m.consultation_id, mailTo())).toEqual({ ok: false, reason: "not_found" });
		expect(await change(buyerOf(t), dossierId, m.consultation_id, mailTo())).toEqual({ ok: false, reason: "not_allowed" });
		// Consulta de outro pedido do mesmo Bureau também não vale.
		const sibling = await placeCounter(t);
		expect(await change(staff(t), sibling, m.consultation_id, mailTo())).toEqual({ ok: false, reason: "not_found" });

		const [row] = await rows("select email, auth_code from scr_authorizations where id = $1", [m.scr_id]);
		expect(row).toEqual({ email: wrong, auth_code: CODE });
		expect(await rows("select 1 from audit_logs where action = 'order.update_contact' and bureau_id = $1", [t.bureau.id])).toHaveLength(0);
	});
});
