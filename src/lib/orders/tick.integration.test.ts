// Tick dos pedidos (M6) contra um Postgres real, sob RLS e com o perfil de sistema de cada Bureau.
// DEPS e IA são os únicos pontos falsos. O tick lê todos os Bureaus devidos do banco: o teste o limita aos seus.
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
		DATABASE_WEBHOOK_URL: process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system_test",
	});
});

// Fora de uma requisição o id de correlação da auditoria cai para um uuid.
vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

const fakes = vi.hoisted(() => ({ consultPF: vi.fn(), generateParecer: vi.fn(), generateCompanyParecer: vi.fn() }));
vi.mock("@/lib/deps/client", () => ({ getDepsClient: () => ({ consultPF: fakes.consultPF, consultPJ: vi.fn() }) }));
vi.mock("@/lib/ai/opinion", () => ({ generateParecer: fakes.generateParecer, generateCompanyParecer: fakes.generateCompanyParecer }));

import { buildFakePaymentEvent } from "@/lib/asaas/fake";
import { quoteOrder } from "@/lib/catalog/quote";
import { pool } from "@/lib/db/pool";
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { DEPS_PRODUCT_PF } from "@/lib/deps/products";
import { acquireClaimLock, releaseClaimLock } from "@/lib/notifications/claim-lock.test-util";
import { applyAsaasPayment } from "@/lib/wallet/pix-charges";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	randomCpf,
	seedBureauCost,
	seedCatalogItem,
	seedClientWalletTopup,
	seedExpiredChallenge,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
} from "@/test/seed";

import pfCurrent from "../deps/__fixtures__/pf-current.json";
import { getMyDelivery } from "./client-queries";
import { cancelOrder, openOrder, placeOrder } from "./queries";
import { cancelStalledOrders } from "./tick-queries";
import { runOrdersTick, TICK_EXECUTION_LIMIT, type TickResult } from "./tick";
import type { OpenOrderInput, OrderProductCode } from "./types";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

const onlyDigits = (value: string) => value.replace(/\D/g, "");
const PRICES: Record<string, string> = { dossie_pf: "50.00" };
const COST = "1.00";
const parecer = {
	tipo_pessoa: "PF",
	classificacao_perfil: "Bom",
	apto: "apto",
	resumo_executivo: "Resumo do parecer de teste.",
	notas: { cadastro: 8, score: 7, scr: 7, relacionamento_bancario: 7, capacidade_financeira: 7, garantias: 6, risco: 7, potencial_aprovacao: 7, final: 7 },
	fatores_decisivos: { maior_positivo: "a", maior_negativo: "b", prioritario_intervencao: "c" },
	pontos_fortes: [],
	pontos_atencao: [],
	plano_acao: [],
	produtos_sugeridos: [],
	top_oportunidades_imediatas: [],
	limite_sugerido: null,
	limite_sugerido_notas: "",
	dados_faltantes: [],
	relatorio_markdown: "# Parecer",
	disclaimer: "Teste",
};

// Bureaus que o tick desta rodada pode enxergar: os outros arquivos de teste usam o mesmo banco.
const scope = new Set<string>();
const realQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<{ rows: { bureau_id: string }[] }>;

beforeAll(async () => {
	await acquireClaimLock();
	vi.spyOn(pool, "query").mockImplementation((async (...args: unknown[]) => {
		const result = await realQuery(...args);
		return String(args[0]).includes("due_order_bureaus")
			? { ...result, rows: result.rows.filter((row) => scope.has(row.bureau_id)) }
			: result;
	}) as never);
}, 120_000);

afterAll(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
	await releaseClaimLock();
});

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.clearAllMocks();
	scope.clear();
	fakes.consultPF.mockImplementation(async () => ({
		httpStatus: 200,
		product: DEPS_PRODUCT_PF,
		body: pfCurrent,
		receivedAt: "2026-10-15T12:00:00.000Z",
	}));
	fakes.generateParecer.mockResolvedValue({ parecer, model: "modelo-teste" });
});

async function newTenant(label: string): Promise<SeededTenant> {
	const t = await seedTenant(owner, label);
	// O pedido online de terceiro (Dossiê Pessoa Física) é da conta PJ: o Titular da conta vira uma empresa.
	await owner.query("update holders set type = 'PJ', document = $2 where id = $1", [
		t.holder.id,
		Array.from({ length: 14 }, () => Math.floor(Math.random() * 10)).join(""),
	]);
	for (const code of Object.keys(PRICES)) {
		// O seed do catálogo deixa os produtos inativos.
		await owner.query("update products set active = true where code = $1", [code]);
		const { rows } = await owner.query<{ id: string }>("select id from products where code = $1", [code]);
		await seedBureauCost(owner, { bureauId: t.bureau.id, productId: rows[0].id, cost: COST, setBy: t.bureauAdmin.userId });
		await seedCatalogItem(owner, { bureauId: t.bureau.id, productId: rows[0].id, salePrice: PRICES[code], updatedBy: t.bureauAdmin.userId });
	}
	await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "200.00", createdBy: t.bureauAdmin.userId });
	await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "200.00", createdBy: t.bureauAdmin.userId });
	scope.add(t.bureau.id);
	return t;
}

const staff = (t: SeededTenant): DbIdentity => ({ ...t.operator });

// O teto de 5 pedidos online por cliente em 24 h vale: os pedidos de carga saem da janela, em ordem de criação.
// created_at é imutável sob o gatilho do pedido: o teste o desliga só nesta transação.
async function outOfDailyWindow(t: SeededTenant) {
	const c = await owner.connect();
	try {
		await c.query("begin");
		await c.query("set local session_replication_role = replica");
		await c.query("update dossier_orders set created_at = created_at - interval '2 days' where client_profile_id = $1", [t.client.userId]);
		await c.query("commit");
	} catch (error) {
		await c.query("rollback");
		throw error;
	} finally {
		c.release();
	}
}
const buyerOf = (t: SeededTenant): DbIdentity => ({ ...t.client });

const thirdInput = (over: Partial<OpenOrderInput> = {}): OpenOrderInput => ({
	productCode: "dossie_pf",
	self: false,
	subject: { type: "PF", name: "Fulano de Tal", documentDigits: onlyDigits(randomCpf()) },
	partners: [],
	contact: { email: `titular-${crypto.randomUUID()}@example.com`, phoneE164: null },
	buyerProfileId: null,
	...over,
});

async function place(who: DbIdentity, t: SeededTenant, input: OpenOrderInput): Promise<string> {
	const quote = await quoteOrder(staff(t), input.productCode as OrderProductCode, { partnerCount: input.partners.length });
	if (!quote.ok) throw new Error(`quote failed: ${quote.reason}`);
	const result = await placeOrder(who, input, quote);
	if (!result.ok) throw new Error(`placeOrder failed: ${result.reason}`);
	return result.dossierId;
}

async function rows<R extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<R[]> {
	return (await owner.query<R>(sql, params)).rows;
}

const orderOf = async (id: string) =>
	(await rows<{ state: string; state_reason: string | null; ai_status: string }>(
		"select state, state_reason, ai_status from dossier_orders where dossier_id = $1",
		[id],
	))[0];
const clientWallet = async (t: SeededTenant) =>
	(await rows("select available, reserved from client_wallets where client_profile_id = $1", [t.client.userId]))[0];
const bureauWallet = async (t: SeededTenant) =>
	(await rows("select available, reserved from wallets where bureau_id = $1", [t.bureau.id]))[0];
const scrOf = async (dossierId: string) =>
	(await rows<{ id: string; public_token: string; auth_code: string | null; status: string }>(
		`select s.id, s.public_token::text, s.auth_code, s.status from scr_authorizations s
		  where s.id in (select scr_authorization_id from consultations where dossier_id = $1)`,
		[dossierId],
	))[0];


// Pedido online aguardando PIX (sem reserva), com a cotação e, se pedido, uma cobrança do pedido.
// created_at é imutável sob o gatilho do pedido: o teste o desliga só nesta transação.
async function awaitingPixOrder(
	t: SeededTenant,
	opts: { orderAgeMin?: number; charge?: { status?: "pending" | "paid"; expiresInMin: number } } = {},
) {
	const dossierId = await withUserTransaction(buyerOf(t), async (client) => {
		const opened = await openOrder(client, thirdInput());
		if (!opened.ok) throw new Error(`open failed: ${opened.reason}`);
		return opened.dossierId;
	});
	expect((await orderOf(dossierId)).state).toBe("awaiting_payment");
	await owner.query("insert into order_pix_quotes (dossier_id, bureau_id, client_profile_id, price) values ($1, $2, $3, '50.00')", [
		dossierId,
		t.bureau.id,
		t.client.userId,
	]);
	const paymentId = `pay_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
	let chargeId: string | null = null;
	if (opts.charge) {
		const inserted = await owner.query<{ id: string }>(
			`insert into pix_charges (bureau_id, asaas_payment_id, amount, fee_amount, total_charged, status, pix_payload, expires_at, requested_by, client_profile_id, order_id, billing_type)
			 values ($1, $2, '50.00', '0.99', '50.99', 'pending', 'pix-copia-e-cola-teste', now() + make_interval(mins => $3), $4, $4, $5, 'PIX') returning id`,
			[t.bureau.id, paymentId, opts.charge.expiresInMin, t.client.userId, dossierId],
		);
		chargeId = inserted.rows[0].id;
		if (opts.charge.status === "paid") await owner.query("update pix_charges set status = 'paid' where id = $1", [chargeId]);
	}
	if (opts.orderAgeMin) {
		const c = await owner.connect();
		try {
			await c.query("begin");
			await c.query("set local session_replication_role = replica");
			await c.query("update dossier_orders set created_at = now() - make_interval(mins => $2) where dossier_id = $1", [dossierId, opts.orderAgeMin]);
			await c.query("commit");
		} finally {
			c.release();
		}
	}
	return { dossierId, paymentId };
}

const payOrder = (paymentId: string) =>
	applyAsaasPayment({
		eventId: crypto.randomUUID(),
		eventType: "PAYMENT_RECEIVED",
		asaasPaymentId: paymentId,
		payload: buildFakePaymentEvent({ eventId: "x", asaasPaymentId: paymentId, value: 50.99 }),
	});

const cancelTick = (t: SeededTenant) => withUserTransaction(staff(t), (client) => cancelStalledOrders(client, staff(t)));

// O Titular responde fora do sistema, com o código recebido por e-mail.
const confirmScr = async (token: string, code: string) =>
	(await pool.query<{ r: string }>("select confirm_public_scr_authorization($1, 'internal', $2, 'authorize', '203.0.113.9') as r", [token, code])).rows[0].r;

// `purged` é global (varredura LGPD sem tenant): o banco compartilhado pode ter linhas vencidas de outros arquivos.
const ZERO: TickResult = {
	bureaus: 1,
	expired: 0,
	cancelled: 0,
	requested: 0,
	promoted: 0,
	executed: 0,
	ai: 0,
	released: 0,
	// Global como purged: o banco compartilhado pode ter comissão vencida de outros arquivos.
	commissionsReleased: expect.any(Number) as number,
	skipped: 0,
	errors: 0,
	purged: expect.any(Object) as Record<string, number>,
};

describe("runOrdersTick", () => {
	it("online order end to end debits P from the client and accrues nothing at capture (commission comes from the cash-in split)", async () => {
		const t = await newTenant("tick e2e");
		const id = await place(buyerOf(t), t, thirdInput());
		// Sem nenhuma opção de IA no pedido: o parecer entra pendente e o tick o gera.
		expect((await orderOf(id)).ai_status).toBe("pending");
		const [settlement] = await rows("select price::text, cost::text from order_settlements where order_ref = $1", [id]);
		expect(settlement).toEqual({ price: "50.00", cost: "0.00" });
		expect(await clientWallet(t)).toEqual({ available: "150.00", reserved: "50.00" });

		// Tick 1: emite o pedido de autorização SCR por e-mail.
		expect(await runOrdersTick()).toEqual({ ...ZERO, requested: 1 });
		const scr = await scrOf(id);
		expect(scr.status).toBe("pending");
		expect(scr.auth_code).toMatch(/^[A-Z2-9]{6}$/);
		expect(await rows("select channel, status from notifications where reference = $1", [`scr_authorization:${scr.id}`])).toEqual([
			{ channel: "email", status: "pending" },
		]);

		// O Titular autoriza com o código do e-mail.
		expect(await confirmScr(scr.public_token, scr.auth_code as string)).toBe("authorized");

		// Tick 2: promove, executa, captura, gera o parecer e libera.
		expect(await runOrdersTick()).toEqual({ ...ZERO, promoted: 1, executed: 1, ai: 1, released: 1 });
		expect(fakes.consultPF).toHaveBeenCalledOnce();
		expect(fakes.generateParecer).toHaveBeenCalledOnce();
		expect(await orderOf(id)).toEqual({ state: "released", state_reason: null, ai_status: "done" });
		expect(await clientWallet(t)).toEqual({ available: "150.00", reserved: "0.00" });
		expect(await bureauWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect(await rows("select kind, amount::text from bureau_payable_entries where bureau_id = $1", [t.bureau.id])).toEqual([]);
		expect(await rows("select channel, status from notifications where reference = $1", [`order:${id}`])).toEqual([
			{ channel: "email", status: "pending" },
		]);
		const [released] = await rows<{ key: string }>("select idempotency_key as key from notifications where reference = $1", [`order:${id}`]);
		expect(released.key).toMatch(new RegExp(`^research_released:email:${id}:\\d+$`));

		const delivery = await withUserTransaction(buyerOf(t), (c) => getMyDelivery(c, id));
		expect(delivery?.order).toMatchObject({ dossierId: id, state: "released" });
		expect(delivery?.members).toHaveLength(1);
		expect(delivery?.members[0]).toMatchObject({ status: "completed", canonical: expect.any(Object), opinion: expect.objectContaining({ resumo_executivo: parecer.resumo_executivo }) });
		expect(await rows("select status::text from dossiers where id = $1", [id])).toEqual([{ status: "completed" }]);

		// Nada devido: o Bureau fica de fora e o tick seguinte não faz nada.
		expect(await runOrdersTick()).toEqual({ ...ZERO, bureaus: 0 });
	});

	it("tick purges expired challenges", async () => {
		const t = await newTenant("tick purge");
		const old = await seedExpiredChallenge(owner, { profileId: t.client.userId, expiresAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
		const fresh = await seedExpiredChallenge(owner, { profileId: t.client.userId, expiresAt: new Date(Date.now() - 60 * 60 * 1000) });

		const result = await runOrdersTick();

		expect(result.purged.verification_challenges).toBeGreaterThanOrEqual(1);
		expect(result.errors).toBe(0);
		const left = await rows<{ id: string }>("select id from verification_challenges where id = any($1)", [[old, fresh]]);
		expect(left).toEqual([{ id: fresh }]);
	});

	// A varredura de 5 anos vale para todo Bureau do banco compartilhado: marca os de fora do escopo como já varridos.
	async function enableSweepFor(t: SeededTenant): Promise<void> {
		vi.stubEnv("LGPD_PURGE_ENABLED", "1");
		await owner.query(
			"insert into audit_logs (bureau_id, action) select id, 'lgpd.purge_bureau' from bureaus where id <> $1",
			[t.bureau.id],
		);
	}

	const insertOldScr = async (t: SeededTenant) =>
		(
			await owner.query<{ id: string }>(
				`insert into scr_authorizations (bureau_id, document, type, holder_id, status, channel, expires_at)
         values ($1, $2, 'PF', $3, 'authorized', 'internal', now() - interval '5 years 1 day') returning id`,
				[t.bureau.id, randomCpf(), t.holder.id],
			)
		).rows[0].id;

	it("the bureau sweep is off unless LGPD_PURGE_ENABLED is 1", async () => {
		const t = await newTenant("tick sweep off");
		const old = await insertOldScr(t);

		const result = await runOrdersTick();

		expect(result.errors).toBe(0);
		expect(await rows("select 1 from scr_authorizations where id = $1", [old])).toHaveLength(1);
		expect(await rows("select 1 from audit_logs where bureau_id = $1 and action = 'lgpd.purge_bureau'", [t.bureau.id])).toEqual([]);
	});

	it("tick purges a bureau with no pending orders", async () => {
		const t = await newTenant("tick purge idle");
		await enableSweepFor(t);
		const old = await insertOldScr(t);

		// Sem pedido devido: o Bureau fica fora de due_order_bureaus() e mesmo assim é varrido.
		const result = await runOrdersTick();

		expect(result.bureaus).toBe(0);
		expect(result.errors).toBe(0);
		expect(result.purged.scr_authorizations).toBe(1);
		expect(await rows("select 1 from scr_authorizations where id = $1", [old])).toEqual([]);
	});

	it("sweep runs once within 24h", async () => {
		const t = await newTenant("tick sweep daily");
		await enableSweepFor(t);
		const first = await insertOldScr(t);
		await runOrdersTick();
		expect(await rows("select 1 from scr_authorizations where id = $1", [first])).toEqual([]);

		const second = await insertOldScr(t);
		await runOrdersTick();
		expect(await rows("select 1 from scr_authorizations where id = $1", [second])).toHaveLength(1);

		// Audit é append-only para o app; o dono volta a data 25 h sem triggers.
		const c = await owner.connect();
		try {
			await c.query("begin");
			await c.query("set local session_replication_role = replica");
			await c.query("update audit_logs set created_at = now() - interval '25 hours' where bureau_id = $1 and action = 'lgpd.purge_bureau'", [t.bureau.id]);
			await c.query("commit");
		} finally {
			c.release();
		}
		await runOrdersTick();
		expect(await rows("select 1 from scr_authorizations where id = $1", [second])).toEqual([]);
	});

	it("expired request cancels and releases on the tick", async () => {
		const t = await newTenant("tick expired");
		const id = await place(buyerOf(t), t, thirdInput());
		await runOrdersTick();
		const scr = await scrOf(id);
		expect(scr.status).toBe("pending");
		await owner.query("update scr_authorizations set request_expires_at = now() - interval '1 minute' where id = $1", [scr.id]);

		expect(await runOrdersTick()).toEqual({ ...ZERO, expired: 1, cancelled: 1 });

		expect(await orderOf(id)).toEqual({ state: "cancelled", state_reason: "scr_expired", ai_status: "pending" });
		expect((await scrOf(id)).status).toBe("expired");
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect(fakes.consultPF).not.toHaveBeenCalled();
		expect(await rows("select kind from bureau_payable_entries where bureau_id = $1", [t.bureau.id])).toEqual([]);
	});

	it("DEPS without data fails the order, releases the reservation and closes the dossier", async () => {
		const t = await newTenant("tick nodata");
		const id = await place(buyerOf(t), t, thirdInput());
		await owner.query(
			`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days', auth_code = null
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[id],
		);
		fakes.consultPF.mockResolvedValue({
			httpStatus: 200,
			product: DEPS_PRODUCT_PF,
			body: { mix: { score: { data: { valor: 700 } } } },
			receivedAt: "2026-10-15T12:00:00.000Z",
		});

		expect(await runOrdersTick()).toEqual({ ...ZERO, promoted: 1, executed: 1 });

		expect(await orderOf(id)).toEqual({ state: "failed", state_reason: "deps_no_data", ai_status: "pending" });
		expect(await clientWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
		expect(await rows("select status::text, error_message from consultations where dossier_id = $1", [id])).toEqual([
			{ status: "error", error_message: "Sem dados na DEPS." },
		]);
		expect(await rows("select status::text from dossiers where id = $1", [id])).toEqual([{ status: "completed_with_errors" }]);
		expect(await rows("select 1 from bureau_payable_entries where bureau_id = $1", [t.bureau.id])).toEqual([]);
	});

	it("counter order without payment for 7 days is cancelled", async () => {
		const t = await newTenant("tick counter");
		const id = await place(staff(t), t, thirdInput());
		expect(await bureauWallet(t)).toEqual({ available: "199.00", reserved: "1.00" });
		expect((await orderOf(id)).state).toBe("awaiting_payment");

		// Dentro do prazo o Bureau nem é devido.
		expect(await runOrdersTick()).toEqual({ ...ZERO, bureaus: 0 });

		const client = await owner.connect();
		try {
			await client.query("begin");
			await client.query("set local session_replication_role = replica");
			await client.query("update dossier_orders set created_at = now() - interval '8 days' where dossier_id = $1", [id]);
			await client.query("commit");
		} finally {
			client.release();
		}

		expect(await runOrdersTick()).toEqual({ ...ZERO, cancelled: 1 });

		expect(await orderOf(id)).toEqual({ state: "cancelled", state_reason: "payment_timeout", ai_status: "pending" });
		expect(await bureauWallet(t)).toEqual({ available: "200.00", reserved: "0.00" });
	});

	it("cancels an online order whose PIX expired", async () => {
		const t = await newTenant("tick pix expired");
		const { dossierId } = await awaitingPixOrder(t, { orderAgeMin: 60, charge: { expiresInMin: -16 } });
		const before = await clientWallet(t);

		expect(await cancelTick(t)).toBe(1);

		expect(await orderOf(dossierId)).toMatchObject({ state: "cancelled", state_reason: "payment_timeout" });
		expect(await clientWallet(t)).toEqual(before);
		expect(await rows("select 1 from client_ledger_entries where client_profile_id = $1 and kind <> 'topup'", [t.client.userId])).toEqual([]);
	});

	it("keeps an online order with a live PIX", async () => {
		const t = await newTenant("tick pix live");
		const { dossierId } = await awaitingPixOrder(t, { orderAgeMin: 20, charge: { expiresInMin: 10 } });

		expect(await cancelTick(t)).toBe(0);

		expect((await orderOf(dossierId)).state).toBe("awaiting_payment");
	});

	it("keeps an online order inside the grace window", async () => {
		const t = await newTenant("tick pix grace");
		const { dossierId } = await awaitingPixOrder(t, { orderAgeMin: 60, charge: { expiresInMin: -5 } });

		expect(await cancelTick(t)).toBe(0);

		expect((await orderOf(dossierId)).state).toBe("awaiting_payment");
	});

	it("cancels an online order without any charge after 45 minutes", async () => {
		const young = await newTenant("tick pix nocharge young");
		const youngOrder = await awaitingPixOrder(young, { orderAgeMin: 44 });
		expect(await cancelTick(young)).toBe(0);
		expect((await orderOf(youngOrder.dossierId)).state).toBe("awaiting_payment");

		const t = await newTenant("tick pix nocharge");
		const { dossierId } = await awaitingPixOrder(t, { orderAgeMin: 46 });
		expect(await cancelTick(t)).toBe(1);
		expect(await orderOf(dossierId)).toMatchObject({ state: "cancelled", state_reason: "payment_timeout" });
	});

	it("cancels a paid order whose reservation failed", async () => {
		const t = await newTenant("tick pix paid");
		const { dossierId } = await awaitingPixOrder(t, { charge: { status: "paid", expiresInMin: 10 } });
		const before = await clientWallet(t);

		expect(await cancelTick(t)).toBe(1);

		expect(await orderOf(dossierId)).toMatchObject({ state: "cancelled", state_reason: "payment_not_reserved" });
		expect(await clientWallet(t)).toEqual(before);
		expect(await rows("select 1 from order_settlements where order_ref = $1", [dossierId])).toEqual([]);
	});

	it("tick cancel and webhook payment never leave a reservation on a cancelled order", async () => {
		// Tick primeiro: o webhook espera a trava do pedido e, depois do commit, o pedido já está cancelado.
		const t = await newTenant("tick pix race");
		const { dossierId, paymentId } = await awaitingPixOrder(t, { orderAgeMin: 60, charge: { expiresInMin: -16 } });
		const before = await clientWallet(t);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		let cancelledByTick = 0;
		const tick = withUserTransaction(staff(t), async (client) => {
			cancelledByTick = await cancelStalledOrders(client, staff(t));
			await gate;
		});
		await new Promise((r) => setTimeout(r, 300));
		const webhook = payOrder(paymentId);
		for (let i = 0; i < 100; i += 1) {
			const waiting = await rows("select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%apply_asaas_payment%'", []);
			if (waiting.length) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		release();
		await tick;

		expect(cancelledByTick).toBe(1);
		expect(await webhook).toBe("order_not_payable");
		expect(await orderOf(dossierId)).toMatchObject({ state: "cancelled", state_reason: "payment_timeout" });
		expect(await rows("select 1 from order_settlements where order_ref = $1", [dossierId])).toEqual([]);
		const after = await clientWallet(t);
		expect(Number(after.available)).toBe(Number(before.available) + 50);
		expect(after.reserved).toBe(before.reserved);

		// Webhook primeiro: o pedido avança e o tick não o cancela.
		const t2 = await newTenant("tick pix race 2");
		const second = await awaitingPixOrder(t2, { orderAgeMin: 60, charge: { expiresInMin: -16 } });
		expect(await payOrder(second.paymentId)).toBe("order_paid");
		expect(await cancelTick(t2)).toBe(0);
		expect((await orderOf(second.dossierId)).state).toBe("awaiting_authorization");
		expect(await rows("select status from order_settlements where order_ref = $1", [second.dossierId])).toEqual([{ status: "reserved" }]);
	});

	it("skips an order locked by another transaction", async () => {
		const t = await newTenant("tick pix locked");
		const { dossierId } = await awaitingPixOrder(t, { orderAgeMin: 60, charge: { expiresInMin: -16 } });
		const holder = await owner.connect();
		try {
			await holder.query("begin");
			await holder.query("select 1 from dossier_orders where dossier_id = $1 for update", [dossierId]);
			expect(await cancelTick(t)).toBe(0);
		} finally {
			await holder.query("rollback");
			holder.release();
		}
		expect((await orderOf(dossierId)).state).toBe("awaiting_payment");
	});

	it("staff cancel of an online order awaiting payment works", async () => {
		const t = await newTenant("tick pix staff");
		const { dossierId } = await awaitingPixOrder(t, { charge: { expiresInMin: 10 } });

		const result = await withUserTransaction(staff(t), (client) => cancelOrder(client, staff(t), dossierId, "cancelled_by_staff"));

		expect(result).toEqual({ ok: true });
		expect(await orderOf(dossierId)).toMatchObject({ state: "cancelled", state_reason: "cancelled_by_staff" });
	});

	it("a failing Bureau does not stop the other one", async () => {
		const bad = await newTenant("tick bad");
		const good = await newTenant("tick good");
		const badId = await place(buyerOf(bad), bad, thirdInput());
		const goodId = await place(buyerOf(good), good, thirdInput());
		// E-mail inválido: a emissão do Bureau ruim falha ao enfileirar o aviso.
		await owner.query(
			"update scr_authorizations set email = 'sem-arroba' where id in (select scr_authorization_id from consultations where dossier_id = $1)",
			[badId],
		);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await runOrdersTick();

		expect(result).toEqual({ ...ZERO, bureaus: 2, requested: 1, errors: 1 });
		expect((await scrOf(goodId)).auth_code).toMatch(/^[A-Z2-9]{6}$/);
		expect((await scrOf(badId)).auth_code).toBeNull();
		expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/titular-.*@example\.com|sem-arroba/);
		errorLog.mockRestore();
	});

	it("executes at most TICK_EXECUTION_LIMIT orders in the whole tick", async () => {
		const t = await newTenant("tick limit");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "1000.00", createdBy: t.bureauAdmin.userId });
		const ids: string[] = [];
		for (let i = 0; i < TICK_EXECUTION_LIMIT + 1; i += 1) {
			ids.push(await place(buyerOf(t), t, thirdInput()));
			await outOfDailyWindow(t);
		}
		await owner.query(
			`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days', auth_code = null
			  where id in (select scr_authorization_id from consultations where dossier_id = any($1::uuid[]))`,
			[ids],
		);

		const first = await runOrdersTick();
		expect(first).toMatchObject({ promoted: TICK_EXECUTION_LIMIT + 1, executed: TICK_EXECUTION_LIMIT, released: TICK_EXECUTION_LIMIT });
		expect(await runOrdersTick()).toMatchObject({ executed: 1, released: 1 });
	});

	it("two overlapping ticks pay the AI opinion once and the second skips the Bureau", async () => {
		const t = await newTenant("tick overlap");
		const id = await place(buyerOf(t), t, thirdInput());
		await owner.query(
			`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days', auth_code = null
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[id],
		);
		// Parecer lento: o segundo tick chega com o primeiro ainda dentro da chamada ao modelo.
		fakes.generateParecer.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			return { parecer, model: "modelo-teste" };
		});

		const [a, b] = await Promise.all([runOrdersTick(), runOrdersTick()]);

		expect(fakes.generateParecer).toHaveBeenCalledOnce();
		expect([a.skipped, b.skipped].sort()).toEqual([0, 1]);
		expect(a.ai + b.ai).toBe(1);
		expect(await orderOf(id)).toEqual({ state: "released", state_reason: null, ai_status: "done" });
		expect(await rows("select ai_attempts from dossier_orders where dossier_id = $1", [id])).toEqual([{ ai_attempts: 1 }]);
	});

	it("an authorized order is promoted on the first tick even behind 25 older waiting orders", async () => {
		const t = await newTenant("tick starve");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "2000.00", createdBy: t.bureauAdmin.userId });
		for (let i = 0; i < 25; i += 1) {
			await place(buyerOf(t), t, thirdInput());
			await outOfDailyWindow(t);
		}
		const newest = await place(buyerOf(t), t, thirdInput());
		await owner.query(
			`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days', auth_code = null
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[newest],
		);

		const result = await runOrdersTick();

		expect(result).toMatchObject({ promoted: 1, executed: 1, released: 1 });
		expect(await orderOf(newest)).toMatchObject({ state: "released" });
	});

	it("an order reclaimed past the attempt limit fails without calling the DEPS", async () => {
		const t = await newTenant("tick exhausted");
		const id = await place(buyerOf(t), t, thirdInput());
		await owner.query(
			`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days', auth_code = null
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[id],
		);
		await runOrdersTick();
		expect((await orderOf(id)).state).toBe("released");
		// Reconstrói o caso: pedido preso em consulta, lease vencida e cinco tentativas já gastas.
		const second = await place(buyerOf(t), t, thirdInput());
		await owner.query(
			`update scr_authorizations set status = 'authorized', authorized_at = now(), expires_at = now() + interval '30 days', auth_code = null
			  where id in (select scr_authorization_id from consultations where dossier_id = $1)`,
			[second],
		);
		const client = await owner.connect();
		try {
			await client.query("begin");
			await client.query("set local session_replication_role = replica");
			await client.query(
				"update dossier_orders set state = 'executing', attempts = 5, lease_until = now() - interval '1 minute' where dossier_id = $1",
				[second],
			);
			await client.query("commit");
		} finally {
			client.release();
		}
		fakes.consultPF.mockClear();

		await runOrdersTick();

		expect(fakes.consultPF).not.toHaveBeenCalled();
		expect(await orderOf(second)).toEqual({ state: "failed", state_reason: "deps_unavailable", ai_status: "pending" });
		expect(await clientWallet(t)).toEqual({ available: "150.00", reserved: "0.00" });
	});
});
