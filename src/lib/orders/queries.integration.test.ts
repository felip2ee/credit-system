// Pedido (M6) contra um Postgres real, sob RLS: abertura com reserva, claim, transições, liberação e avisos.
// Cada teste usa um Bureau novo; o pool do dono prepara e confere, o pool da aplicação executa.
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	Object.assign(process.env, {
		DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://app_runtime:test@localhost:54329/credit_system",
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
	consulta_pf: "50.00",
	consulta_pj: "80.00",
	dossie_pj_completo: "200.00",
	parecer_ia: "20.00",
};

beforeAll(acquireClaimLock, 120_000);

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
	await releaseClaimLock();
});

// Preço de venda por código; custo fixo de 1,00.
async function sell(t: SeededTenant, prices: Partial<Record<string, string>>) {
	for (const code of ["consulta_pf", "consulta_pj", "dossie_pj_completo", "parecer_ia"]) {
		const price = prices[code];
		if (!price) continue;
		const { rows } = await owner.query<{ id: string }>("select id from products where code = $1", [code]);
		await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: "1.00", setBy: t.bureauAdmin.userId });
		await seedCatalogItem(owner, {
			bureauId: t.bureau.id,
			productId: rows[0].id,
			salePrice: price,
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
async function quote(identity: DbIdentity, code: OrderProductCode, withAi: boolean) {
	const q = await quoteOrder(identity, code, { withAi });
	if (!q.ok) throw new Error(`quote failed: ${q.reason}`);
	return q;
}

const ownInput = (over: Partial<OpenOrderInput> = {}): OpenOrderInput => ({
	productCode: "consulta_pf",
	withAi: false,
	self: true,
	subject: null,
	partners: [],
	contact: { email: null, phoneE164: null },
	buyerProfileId: null,
	...over,
});

const thirdInput = (over: Partial<OpenOrderInput> = {}): OpenOrderInput => ({
	productCode: "consulta_pf",
	withAi: false,
	self: false,
	subject: { type: "PF", name: "Fulano de Tal", documentDigits: cpf() },
	partners: [],
	contact: { email: `titular-${crypto.randomUUID()}@example.com`, phoneE164: null },
	buyerProfileId: null,
	...over,
});

async function placeOnline(t: SeededTenant, input: OpenOrderInput = ownInput()): Promise<string> {
	const result = await placeOrder(buyerOf(t), input, await quote(staff(t), input.productCode, input.withAi));
	if (!result.ok) throw new Error(`placeOrder failed: ${result.reason}`);
	return result.dossierId;
}

async function placeCounter(t: SeededTenant, input: OpenOrderInput = thirdInput()): Promise<string> {
	const result = await placeOrder(staff(t), input, await quote(staff(t), input.productCode, input.withAi));
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
	it("insufficient balance leaves no dossier, order or scr row", async () => {
		const t = await newTenant("ord broke", {});
		const online = await placeOrder(buyerOf(t), ownInput(), await quote(staff(t), "consulta_pf", false));
		expect(online).toEqual({ ok: false, reason: "insufficient_balance" });
		const counter = await placeOrder(staff(t), thirdInput(), await quote(staff(t), "consulta_pf", false));
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
			thirdInput({ productCode: "consulta_pj" }),
			await quote(staff(t), "consulta_pj", false),
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
	it("completeOrder captures and sets ai_status", async () => {
		const t = await newTenant("ord complete");
		const plain = await placeOnline(t);
		const withAi = await placeOnline(t, ownInput({ withAi: true }));
		await toCompleted(t, plain);
		await toCompleted(t, withAi);

		expect(await orderOf(plain)).toMatchObject({ state: "completed", ai_status: "none", lease_until: null });
		expect(await orderOf(withAi)).toMatchObject({ state: "completed", ai_status: "pending", lease_until: null });
		const [settlement] = await rows("select status from order_settlements where order_ref = $1", [plain]);
		expect(settlement.status).toBe("captured");
		expect(await clientWallet(t)).toEqual({ available: "80.00", reserved: "0.00" });
		const audit = await rows<{ metadata: unknown }>("select metadata from audit_logs where action = 'order.complete' and record_id = $1", [plain]);
		expect(audit).toHaveLength(1);
		const timeline = await rows("select 1 from timeline_events where event_type = 'order.completed' and bureau_id = $1", [t.bureau.id]);
		expect(timeline).toHaveLength(2);
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
		await toCompleted(t, emailOnly);
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
		await toCompleted(t, both);
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

		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE))).toEqual({ ok: false, reason: "no_buyer" });
		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), crypto.randomUUID(), SITE))).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect((await orderOf(id)).state).toBe("completed");
	});

	it("release of a pending ai order is invalid_state", async () => {
		const t = await newTenant("ord aipending");
		const id = await placeOnline(t, ownInput({ withAi: true }));
		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE))).toEqual({ ok: false, reason: "invalid_state" });
		await toCompleted(t, id);
		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE))).toEqual({ ok: false, reason: "invalid_state" });
		await withUserTransaction(staff(t), (c) => setAiStatus(c, staff(t), id, "failed", 3));
		expect(await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE))).toEqual({ ok: true });
	});

	it("release after revoke clears the revocation and the client reads the delivery again", async () => {
		const t = await newTenant("ord rerelease");
		const id = await placeOnline(t);
		await toCompleted(t, id);
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
		await toCompleted(t, id);
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
		const refused = await placeOnline(t, thirdInput());
		await owner.query(
			`update scr_authorizations set status = 'not_authorized', refused_at = now()
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[refused],
		);
		// Pedido sem resposta no prazo.
		const expired = await placeOnline(t, thirdInput());
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
		const id = await placeOnline(t, ownInput({ withAi: true }));
		// Sem autorização o refresh não mudaria nada: o pedido ainda não é candidato.
		expect(await withUserTransaction(staff(t), (c) => listOrdersToPromote(c, 10))).toEqual([]);
		await authorizeAll(id);
		expect(await withUserTransaction(staff(t), (c) => listOrdersToPromote(c, 10))).toEqual([id]);

		const plan = await withUserTransaction(staff(t), (c) => getExecutionPlan(c, id));
		expect(plan?.order).toEqual({ dossierId: id, mode: "online", withAi: true, attempts: 0, kind: "PF" });
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
			productCode: "consulta_pf",
			withAi: true,
			aiStatus: "done",
			price: "70.00",
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
		for (let i = 0; i < 25; i += 1) await placeOnline(t, thirdInput());
		const newest = await placeOnline(t, thirdInput());
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
		const id = await placeOnline(t, thirdInput());

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
		const id = await placeOnline(t, thirdInput());
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
		const id = await placeOnline(t, thirdInput());
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
		await toCompleted(t, id);
		expect(await isDue(t)).toBe(true);
		await withUserTransaction(staff(t), (c) => releaseDelivery(c, staff(t), id, SITE));
		await withUserTransaction(staff(t), (c) => revokeDelivery(c, staff(t), id, "Titular errado"));

		expect(await isDue(t)).toBe(false);
	});

	it("claimOrderForAi counts the attempt first and a live lease blocks the next claim and the listing", async () => {
		const t = await newTenant("ord ai claim");
		const id = await placeOnline(t, ownInput({ withAi: true }));
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
		const id = await placeOnline(t, ownInput({ withAi: true }));
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
