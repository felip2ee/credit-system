// M3b / migration 015: liquidação por pedido (reserve_order, capture_order, release_order),
// valor a repassar (bureau_payable_entries) e pagamento de balcão (counter_payments).
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	TEST_DATABASE_OWNER_URL,
	TEST_DATABASE_URL,
	TEST_DATABASE_WEBHOOK_URL,
} from "@/test/db-env";
import {
	randomCpf,
	seedClientProfile,
	seedClientWalletTopup,
	seedDossier,
	seedOrderCatalog,
	seedOrderDossier,
	seedOrderDossierForSession,
	seedPixCharge,
	seedSuperadmin,
	seedTenant,
	seedWalletTopup,
	withDbContext,
	type SeededTenant,
	type SeedSuperadmin,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 12 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 2 });

let superadmin: SeedSuperadmin;

beforeAll(async () => {
	superadmin = await seedSuperadmin(owner);
});

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), hook.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string | null };
const ctxOf = (id: Ctx): Ctx => ({
	userId: id.userId,
	role: id.role,
	bureauId: id.bureauId,
});
const superadminCtx = (): Ctx => ({
	userId: superadmin.userId,
	role: "superadmin",
	bureauId: null,
});

// Como withDbContext, mas faz commit: as chamadas concorrentes precisam de transações reais.
async function committed<T>(
	ctx: Ctx,
	work: (client: PoolClient) => Promise<T>,
): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true),
              set_config('app.user_role', $2, true),
              set_config('app.bureau_id', $3, true),
              set_config('app.support_session_id', '', true)`,
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

type SettleRow = { ok: boolean; reason: string | null; status: string | null };
type Mode = "online" | "counter";

type ReserveInput = {
	orderRef: string;
	mode: Mode | string;
	clientId: string | null;
	price: string;
	cost: string;
	quote?: unknown;
};

// reserve_order exige um Dossiê do Bureau da sessão: cria o Dossiê do pedido antes de chamar (o caso sem Dossiê
// usa reserveRaw) e confere preço e custo no catálogo: sem `quote`, cria o produto que casa com preço e custo.
async function reserve(c: PoolClient, input: ReserveInput) {
	await seedOrderDossierForSession(owner, c, {
		orderRef: input.orderRef,
		clientProfileId: input.mode === "online" ? input.clientId : null,
	});
	return reserveWithCatalog(c, input);
}
// Como reserve, sem criar o Dossiê (o teste já o tem).
async function reserveWithCatalog(c: PoolClient, input: ReserveInput) {
	const quote = input.quote ?? (await seedOrderCatalog(owner, c, { productCode: "dossie_pf", price: input.price, cost: input.cost }));
	return reserveRaw(c, { ...input, quote });
}
const reserveRaw = (c: PoolClient, input: ReserveInput) =>
	c
		.query<SettleRow>(
			"select * from reserve_order($1, $2, $3, $4, $5, $6::jsonb)",
			[
				input.orderRef,
				input.mode,
				input.clientId,
				input.price,
				input.cost,
				JSON.stringify(input.quote ?? { lines: [] }),
			],
		)
		.then((r) => r.rows[0]);
const capture = (c: PoolClient, ref: string) =>
	c
		.query<SettleRow>("select * from capture_order($1)", [ref])
		.then((r) => r.rows[0]);
const release = (c: PoolClient, ref: string) =>
	c
		.query<SettleRow>("select * from release_order($1)", [ref])
		.then((r) => r.rows[0]);

const clientCtx = (t: SeededTenant) => ctxOf(t.client);
const adminCtx = (t: SeededTenant) => ctxOf(t.bureauAdmin);
const operatorCtx = (t: SeededTenant) => ctxOf(t.operator);

async function clientBalance(clientId: string) {
	const { rows } = await owner.query<{ available: string; reserved: string }>(
		"select available, reserved from client_wallets where client_profile_id = $1",
		[clientId],
	);
	return rows[0];
}
async function bureauBalance(bureauId: string) {
	const { rows } = await owner.query<{ available: string; reserved: string }>(
		"select available, reserved from wallets where bureau_id = $1",
		[bureauId],
	);
	return rows[0];
}
async function settlement(orderRef: string) {
	const { rows } = await owner.query<{
		status: string;
		price: string;
		cost: string;
		mode: string;
		closed_at: Date | null;
		quote: unknown;
	}>(
		"select status, price, cost, mode, closed_at, quote from order_settlements where order_ref = $1",
		[orderRef],
	);
	return rows[0];
}
async function accruals(orderRef: string) {
	const { rows } = await owner.query<{ kind: string; amount: string }>(
		"select kind, amount from bureau_payable_entries where order_ref = $1 order by created_at, id",
		[orderRef],
	);
	return rows;
}
const orderEntryCount = async (orderRef: string) =>
	Number(
		(
			await owner.query<{ n: string }>(
				`select (select count(*) from client_ledger_entries where reference = $1)
              + (select count(*) from ledger_entries where reference = $1) as n`,
				[`order:${orderRef}`],
			)
		).rows[0].n,
	);

// Cliente com saldo e Bureau com saldo.
async function setup(clientFunds = "100.00", bureauFunds = "100.00") {
	const t = await seedTenant(owner, "Liquidacao");
	if (clientFunds !== "0") {
		await seedClientWalletTopup(owner, {
			clientProfileId: t.client.userId,
			amount: clientFunds,
			createdBy: t.client.userId,
		});
	}
	if (bureauFunds !== "0") {
		await seedWalletTopup(owner, {
			bureauId: t.bureau.id,
			amount: bureauFunds,
			createdBy: t.bureauAdmin.userId,
		});
	}
	return t;
}

const online = (
	t: SeededTenant,
	price = "50.00",
	cost = "30.00",
	orderRef: string = randomUUID(),
) => ({
	orderRef,
	mode: "online" as const,
	clientId: t.client.userId,
	price,
	cost,
});
const counter = (price = "50.00", cost = "30.00", orderRef: string = randomUUID()) => ({
	orderRef,
	mode: "counter" as const,
	clientId: null,
	price,
	cost,
});

describe("reserve_order / capture_order / release_order (online)", () => {
	it("reserves the price from the client wallet, captures it and accrues price minus cost", async () => {
		const t = await setup("100.00", "0");
		const order = online(t, "50.00", "30.00");

		const reserved = await committed(clientCtx(t), (c) => reserve(c, order));
		expect(reserved).toEqual({ ok: true, reason: null, status: "reserved" });
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "50.00",
			reserved: "50.00",
		});
		expect(await settlement(order.orderRef)).toMatchObject({
			status: "reserved",
			price: "50.00",
			cost: "30.00",
			mode: "online",
		});
		expect(await accruals(order.orderRef)).toEqual([]);

		const captured = await committed(adminCtx(t), (c) =>
			capture(c, order.orderRef),
		);
		expect(captured).toEqual({ ok: true, reason: null, status: "captured" });
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "50.00",
			reserved: "0.00",
		});
		expect(await accruals(order.orderRef)).toEqual([
			{ kind: "accrual", amount: "20.00" },
		]);
		expect((await settlement(order.orderRef)).closed_at).not.toBeNull();
		// A carteira do Bureau não se mexe no modo online.
		expect(await bureauBalance(t.bureau.id)).toEqual({
			available: "0.00",
			reserved: "0.00",
		});
	});

	it("releases the reservation without an accrual", async () => {
		const t = await setup("100.00", "0");
		const order = online(t);
		await committed(clientCtx(t), (c) => reserve(c, order));

		const released = await committed(clientCtx(t), (c) =>
			release(c, order.orderRef),
		);
		expect(released).toEqual({ ok: true, reason: null, status: "released" });
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
		expect(await accruals(order.orderRef)).toEqual([]);
	});

	it("records no accrual when price equals cost", async () => {
		const t = await setup("100.00", "0");
		const order = online(t, "30.00", "30.00");
		await committed(clientCtx(t), (c) => reserve(c, order));
		await committed(adminCtx(t), (c) => capture(c, order.orderRef));
		expect(await accruals(order.orderRef)).toEqual([]);
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "70.00",
			reserved: "0.00",
		});
	});

	it("stores the quote the database built from the catalog, not the caller's", async () => {
		const t = await setup("100.00", "0");
		const order = {
			...online(t),
			quote: { lines: [{ code: "ignored" }], total: "999.00", note: "caller field" },
		};
		const code = await committed(clientCtx(t), async (c) => {
			const { lines } = await seedOrderCatalog(owner, c, { productCode: "dossie_pf", price: order.price, cost: order.cost });
			await seedOrderDossierForSession(owner, c, { orderRef: order.orderRef, clientProfileId: t.client.userId });
			await reserveRaw(c, { ...order, quote: { lines: [{ code: lines[0].code, costCents: 1, priceCents: 1 }] } });
			return lines[0].code;
		});
		expect((await settlement(order.orderRef)).quote).toEqual({
			lines: [
				{
					productVersionId: expect.any(String),
					code,
					part: "base",
					quantity: 1,
					unitPriceCents: 5000,
					unitCostCents: 3000,
					priceCents: 5000,
					costCents: 3000,
				},
			],
		});
	});
});

describe("reserve_order / capture_order / release_order (balcão)", () => {
	it("reserves the cost from the Bureau wallet, captures it and records no accrual", async () => {
		const t = await setup("0", "100.00");
		const order = counter("50.00", "30.00");

		expect(await committed(operatorCtx(t), (c) => reserve(c, order))).toEqual({
			ok: true,
			reason: null,
			status: "reserved",
		});
		expect(await bureauBalance(t.bureau.id)).toEqual({
			available: "70.00",
			reserved: "30.00",
		});

		expect(
			await committed(operatorCtx(t), (c) => capture(c, order.orderRef)),
		).toEqual({
			ok: true,
			reason: null,
			status: "captured",
		});
		expect(await bureauBalance(t.bureau.id)).toEqual({
			available: "70.00",
			reserved: "0.00",
		});
		expect(await accruals(order.orderRef)).toEqual([]);
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "0.00",
			reserved: "0.00",
		});
	});

	it("releases the cost back to the Bureau", async () => {
		const t = await setup("0", "100.00");
		const order = counter();
		await committed(adminCtx(t), (c) => reserve(c, order));
		expect(
			await committed(adminCtx(t), (c) => release(c, order.orderRef)),
		).toMatchObject({ ok: true, status: "released" });
		expect(await bureauBalance(t.bureau.id)).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
	});
});

describe("regras de reserva", () => {
	it("refuses a price below cost", async () => {
		const t = await setup();
		for (const order of [
			online(t, "29.99", "30.00"),
			counter("29.99", "30.00"),
		]) {
			const ctx = order.mode === "online" ? clientCtx(t) : operatorCtx(t);
			expect(await committed(ctx, (c) => reserve(c, order))).toEqual({
				ok: false,
				reason: "price_below_cost",
				status: null,
			});
			expect(await settlement(order.orderRef)).toBeUndefined();
		}
	});

	it("refuses invalid amounts", async () => {
		const t = await setup();
		const cases: Array<[string, string]> = [
			["0", "0"],
			["-1.00", "0"],
			["10.001", "5.00"],
			["10.00", "-1.00"],
			["10.00", "5.005"],
			["100000000.00", "1.00"],
		];
		for (const [price, cost] of cases) {
			const order = online(t, price, cost);
			expect(
				await committed(clientCtx(t), (c) => reserve(c, order)),
				`${price}/${cost}`,
			).toMatchObject({
				ok: false,
				reason: "invalid_amount",
			});
		}
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
	});

	it("refuses an order without balance and leaves no settlement behind", async () => {
		const t = await setup("20.00", "10.00");
		const onlineOrder = online(t, "50.00", "30.00");
		expect(
			await committed(clientCtx(t), (c) => reserve(c, onlineOrder)),
		).toEqual({
			ok: false,
			reason: "insufficient_balance",
			status: null,
		});
		const counterOrder = counter("50.00", "30.00");
		expect(
			await committed(operatorCtx(t), (c) => reserve(c, counterOrder)),
		).toMatchObject({
			ok: false,
			reason: "insufficient_balance",
		});
		expect(await settlement(onlineOrder.orderRef)).toBeUndefined();
		expect(await settlement(counterOrder.orderRef)).toBeUndefined();
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "20.00",
			reserved: "0.00",
		});
		expect(await bureauBalance(t.bureau.id)).toEqual({
			available: "10.00",
			reserved: "0.00",
		});

		// Depois de recarregar, o mesmo pedido passa.
		await seedClientWalletTopup(owner, {
			clientProfileId: t.client.userId,
			amount: "40.00",
			createdBy: t.client.userId,
		});
		expect(
			await committed(clientCtx(t), (c) => reserve(c, onlineOrder)),
		).toMatchObject({ ok: true, status: "reserved" });
	});

	it("refuses identities that do not match the order", async () => {
		const t = await setup();
		const other = await seedClientProfile(owner, t.bureau.id);
		await seedClientWalletTopup(owner, {
			clientProfileId: other.userId,
			amount: "100.00",
			createdBy: other.userId,
		});
		const foreign = await setup();

		const denied: Array<[string, Ctx, ReturnType<typeof online>]> = [
			["staff reserves online funds of a client", operatorCtx(t), online(t)],
			["admin reserves online funds of a client", adminCtx(t), online(t)],
			[
				"client reserves another client",
				clientCtx(t),
				{ ...online(t), clientId: other.userId },
			],
			["client from another Bureau", ctxOf(foreign.client), online(t)],
			[
				"client orders counter mode",
				clientCtx(t),
				{ ...counter(), clientId: null } as never,
			],
			["superadmin without support", superadminCtx(), online(t)],
			[
				"online without client",
				operatorCtx(t),
				{ ...online(t), clientId: null } as never,
			],
			[
				"counter with client",
				operatorCtx(t),
				{ ...counter(), clientId: t.client.userId } as never,
			],
			[
				"unknown mode",
				operatorCtx(t),
				{ ...counter(), mode: "other" } as never,
			],
		];
		for (const [label, ctx, order] of denied) {
			expect(
				await committed(ctx, (c) => reserve(c, order)),
				label,
			).toMatchObject({ ok: false, reason: "not_allowed" });
			expect(await settlement(order.orderRef), label).toBeUndefined();
		}
		await expect(
			owner.query(
				"select * from reserve_order($1, 'counter', null, 5, 1, '{}'::jsonb)",
				[randomUUID()],
			),
		).resolves.toMatchObject({
			rows: [{ ok: false, reason: "not_allowed" }],
		});
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
		expect(await clientBalance(other.userId)).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
	});

	it("refuses capture and release by an unrelated client or a stranger Bureau", async () => {
		const t = await setup();
		const other = await seedClientProfile(owner, t.bureau.id);
		const foreign = await setup();
		const order = online(t);
		await committed(clientCtx(t), (c) => reserve(c, order));

		expect(
			await committed(ctxOf(other), (c) => capture(c, order.orderRef)),
		).toMatchObject({ ok: false, reason: "not_allowed" });
		expect(
			await committed(ctxOf(other), (c) => release(c, order.orderRef)),
		).toMatchObject({ ok: false, reason: "not_allowed" });
		expect(
			await committed(adminCtx(foreign), (c) => capture(c, order.orderRef)),
		).toMatchObject({ ok: false, reason: "not_found" });
		expect(
			await committed(adminCtx(foreign), (c) => release(c, order.orderRef)),
		).toMatchObject({ ok: false, reason: "not_found" });
		expect(
			await committed(superadminCtx(), (c) => capture(c, order.orderRef)),
		).toMatchObject({ ok: false, reason: "not_allowed" });
		expect(
			await committed(adminCtx(t), (c) => capture(c, randomUUID())),
		).toMatchObject({ ok: false, reason: "not_found" });
		expect((await settlement(order.orderRef)).status).toBe("reserved");
	});
});

describe("idempotência e estados", () => {
	it("repeats reserve, capture and release without touching balances or entries", async () => {
		const t = await setup("100.00", "100.00");
		for (const mode of ["online", "counter"] as const) {
			const order = mode === "online" ? online(t) : counter();
			const ctx = mode === "online" ? clientCtx(t) : operatorCtx(t);

			const first = await committed(ctx, (c) => reserve(c, order));
			const again = await committed(ctx, (c) => reserve(c, order));
			expect(again).toEqual(first);
			const afterReserve = [
				await clientBalance(t.client.userId),
				await bureauBalance(t.bureau.id),
				await orderEntryCount(order.orderRef),
			];

			expect(
				await committed(adminCtx(t), (c) => capture(c, order.orderRef)),
			).toMatchObject({ ok: true, status: "captured" });
			const afterCapture = [
				await clientBalance(t.client.userId),
				await bureauBalance(t.bureau.id),
				await orderEntryCount(order.orderRef),
			];
			const accrualCount = (await accruals(order.orderRef)).length;
			expect(
				await committed(adminCtx(t), (c) => capture(c, order.orderRef)),
			).toEqual({ ok: true, reason: null, status: "captured" });
			expect([
				await clientBalance(t.client.userId),
				await bureauBalance(t.bureau.id),
				await orderEntryCount(order.orderRef),
			]).toEqual(afterCapture);
			expect((await accruals(order.orderRef)).length).toBe(accrualCount);
			expect(afterCapture).not.toEqual(afterReserve);
		}

		const toRelease = online(t);
		await committed(clientCtx(t), (c) => reserve(c, toRelease));
		await committed(clientCtx(t), (c) => release(c, toRelease.orderRef));
		const snapshot = [
			await clientBalance(t.client.userId),
			await orderEntryCount(toRelease.orderRef),
		];
		expect(
			await committed(clientCtx(t), (c) => release(c, toRelease.orderRef)),
		).toEqual({ ok: true, reason: null, status: "released" });
		expect([
			await clientBalance(t.client.userId),
			await orderEntryCount(toRelease.orderRef),
		]).toEqual(snapshot);
	});

	it("returns the current state when reserve repeats with the same data, and already_exists with different data", async () => {
		const t = await setup();
		const order = online(t, "50.00", "30.00");
		await committed(clientCtx(t), (c) => reserve(c, order));
		await committed(adminCtx(t), (c) => capture(c, order.orderRef));

		expect(await committed(clientCtx(t), (c) => reserve(c, order))).toEqual({
			ok: true,
			reason: null,
			status: "captured",
		});
		// O custo do chamador não conta no modo online: repetir com outro custo devolve o mesmo que repetir igual.
		expect(
			await committed(clientCtx(t), (c) => reserve(c, { ...order, cost: "29.00" })),
		).toEqual({ ok: true, reason: null, status: "captured" });
		expect(
			await committed(clientCtx(t), (c) => reserve(c, { ...order, price: "51.00" })),
		).toEqual({ ok: false, reason: "already_exists", status: null });
		// O pedido (dossier_orders) é online: o modo balcão não o encontra (022).
		expect(
			await committed(operatorCtx(t), (c) =>
				reserve(c, { ...order, mode: "counter" as const, clientId: null }),
			),
		).toEqual({ ok: false, reason: "not_found", status: null });
		// Outro Bureau com o mesmo order_ref não tem esse Dossiê: não vê nem toca o pedido.
		const foreign = await setup();
		expect(
			await committed(clientCtx(foreign), (c) =>
				reserve(c, { ...online(foreign), orderRef: order.orderRef }),
			),
		).toMatchObject({
			ok: false,
			reason: "not_found",
		});
	});

	it("returns invalid_state when capturing a released order and when releasing a captured one", async () => {
		const t = await setup("100.00", "100.00");
		for (const mode of ["online", "counter"] as const) {
			const ctx = mode === "online" ? clientCtx(t) : operatorCtx(t);
			const make = () => (mode === "online" ? online(t) : counter());

			const toRelease = make();
			await committed(ctx, (c) => reserve(c, toRelease));
			await committed(ctx, (c) => release(c, toRelease.orderRef));
			const beforeA = [
				await clientBalance(t.client.userId),
				await bureauBalance(t.bureau.id),
			];
			expect(
				await committed(adminCtx(t), (c) => capture(c, toRelease.orderRef)),
			).toEqual({
				ok: false,
				reason: "invalid_state",
				status: "released",
			});

			const toCapture = make();
			await committed(ctx, (c) => reserve(c, toCapture));
			await committed(adminCtx(t), (c) => capture(c, toCapture.orderRef));
			const beforeB = [
				await clientBalance(t.client.userId),
				await bureauBalance(t.bureau.id),
			];
			expect(
				await committed(adminCtx(t), (c) => release(c, toCapture.orderRef)),
			).toEqual({
				ok: false,
				reason: "invalid_state",
				status: "captured",
			});

			expect([
				await clientBalance(t.client.userId),
				await bureauBalance(t.bureau.id),
			]).toEqual(beforeB);
			expect(beforeA).toBeDefined();
			expect((await settlement(toRelease.orderRef)).status).toBe("released");
			expect((await settlement(toCapture.orderRef)).status).toBe("captured");
		}
	});
});

describe("concorrência", () => {
	it("concurrent capture and release of one order resolve to a single state", async () => {
		const t = await setup("1000.00", "0");
		for (let round = 0; round < 8; round++) {
			const order = online(t, "50.00", "30.00");
			await committed(clientCtx(t), (c) => reserve(c, order));
			const before = await clientBalance(t.client.userId);

			const results = await Promise.all([
				committed(adminCtx(t), (c) => capture(c, order.orderRef)),
				committed(clientCtx(t), (c) => release(c, order.orderRef)),
			]);

			expect(
				results.filter((r) => r.ok),
				`round ${round}`,
			).toHaveLength(1);
			const loser = results.find((r) => !r.ok)!;
			expect(loser).toMatchObject({ reason: "invalid_state" });
			const final = (await settlement(order.orderRef)).status;
			expect(["captured", "released"]).toContain(final);
			const balance = await clientBalance(t.client.userId);
			if (final === "captured") {
				expect(Number(before.reserved) - Number(balance.reserved)).toBe(50);
				expect(Number(balance.available)).toBe(Number(before.available));
				expect(await accruals(order.orderRef)).toEqual([
					{ kind: "accrual", amount: "20.00" },
				]);
			} else {
				expect(Number(balance.available) - Number(before.available)).toBe(50);
				expect(await accruals(order.orderRef)).toEqual([]);
			}
		}
	});

	it("never captures twice when two captures race", async () => {
		const t = await setup("200.00", "0");
		const order = online(t, "60.00", "10.00");
		await committed(clientCtx(t), (c) => reserve(c, order));

		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				committed(adminCtx(t), (c) => capture(c, order.orderRef)),
			),
		);
		expect(results.every((r) => r.ok && r.status === "captured")).toBe(true);
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "140.00",
			reserved: "0.00",
		});
		expect(await accruals(order.orderRef)).toEqual([
			{ kind: "accrual", amount: "50.00" },
		]);
	});

	it("never lets the client wallet go negative with concurrent reservations", async () => {
		const t = await setup("100.00", "0");
		const orders = Array.from({ length: 6 }, () => online(t, "30.00", "10.00"));

		const results = await Promise.all(
			orders.map((order) => committed(clientCtx(t), (c) => reserve(c, order))),
		);

		expect(results.filter((r) => r.ok)).toHaveLength(3);
		expect(
			results
				.filter((r) => !r.ok)
				.every((r) => r.reason === "insufficient_balance"),
		).toBe(true);
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "10.00",
			reserved: "90.00",
		});
		const rows = await owner.query(
			"select 1 from order_settlements where order_ref = any($1)",
			[orders.map((o) => o.orderRef)],
		);
		expect(rows.rowCount).toBe(3);
	});

	it("reserves one order once when the same reservation races", async () => {
		const t = await setup("100.00", "0");
		const order = online(t, "40.00", "10.00");
		const results = await Promise.all(
			Array.from({ length: 4 }, () =>
				committed(clientCtx(t), (c) => reserve(c, order)),
			),
		);
		expect(results.every((r) => r.ok && r.status === "reserved")).toBe(true);
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "60.00",
			reserved: "40.00",
		});
	});
});

describe("valores gravados na reserva", () => {
	it("capture uses the values stored at reservation", async () => {
		const t = await setup("100.00", "0");
		const order = online(t, "50.00", "30.00");
		await committed(clientCtx(t), (c) => reserve(c, order));

		// capture_order e release_order só recebem o order_ref: preço e custo não entram de novo.
		const { rows } = await owner.query<{ proname: string; pronargs: number }>(
			"select proname, pronargs from pg_proc where proname in ('capture_order', 'release_order') order by proname",
		);
		expect(rows).toEqual([
			{ proname: "capture_order", pronargs: 1 },
			{ proname: "release_order", pronargs: 1 },
		]);
		// A liquidação reservada não aceita mudar preço nem custo, nem para o dono.
		await expect(
			owner.query(
				"update order_settlements set price = 1 where order_ref = $1",
				[order.orderRef],
			),
		).rejects.toThrow(/order_settlements/);
		await expect(
			owner.query(
				"update order_settlements set cost = 1 where order_ref = $1",
				[order.orderRef],
			),
		).rejects.toThrow(/order_settlements/);

		await committed(adminCtx(t), (c) => capture(c, order.orderRef));
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "50.00",
			reserved: "0.00",
		});
		expect(await accruals(order.orderRef)).toEqual([
			{ kind: "accrual", amount: "20.00" },
		]);
	});

	it("keeps settlements append-only except for the close transition", async () => {
		const t = await setup("100.00", "0");
		const order = online(t);
		await committed(clientCtx(t), (c) => reserve(c, order));

		await expect(
			owner.query("delete from order_settlements where order_ref = $1", [
				order.orderRef,
			]),
		).rejects.toThrow(/order_settlements/);
		// O TRUNCATE já falha antes do gatilho: a tabela é referenciada por bureau_payable_entries.
		await expect(owner.query("truncate order_settlements")).rejects.toThrow(
			/truncate/,
		);
		await expect(
			owner.query(
				"update order_settlements set status = 'captured' where order_ref = $1",
				[order.orderRef],
			),
		).rejects.toThrow(/check constraint|order_settlements/);
		await committed(clientCtx(t), (c) => release(c, order.orderRef));
		await expect(
			owner.query(
				"update order_settlements set status = 'captured', closed_at = now() where order_ref = $1",
				[order.orderRef],
			),
		).rejects.toThrow(/order_settlements/);
	});

	it("enforces the schema rules of a settlement", async () => {
		const t = await setup("100.00", "0");
		const insert = (
			mode: string,
			clientId: string | null,
			price: string,
			cost: string,
		) =>
			owner.query(
				"insert into order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost) values ($1, $2, $3, $4, $5, $6)",
				[randomUUID(), t.bureau.id, mode, clientId, price, cost],
			);
		await expect(
			insert("online", t.client.userId, "10.00", "20.00"),
		).rejects.toThrow(/check constraint/);
		await expect(insert("online", null, "30.00", "20.00")).rejects.toThrow(
			/check constraint/,
		);
		await expect(
			insert("counter", t.client.userId, "30.00", "20.00"),
		).rejects.toThrow(/check constraint/);
		await expect(insert("other", null, "30.00", "20.00")).rejects.toThrow(
			/check constraint/,
		);
		await expect(
			insert("counter", null, "30.00", "20.00"),
		).resolves.toBeDefined();
		const foreign = await seedClientProfile(
			owner,
			(await seedTenant(owner, "OutroB")).bureau.id,
		);
		await expect(
			insert("online", foreign.userId, "30.00", "20.00"),
		).rejects.toThrow(/foreign key/);
	});
});

describe("conciliação", () => {
	it("keeps the sum of client entries equal to available plus reserved and the payable sum equal to the accruals", async () => {
		const t = await setup("500.00", "0");
		const orders = [
			online(t, "50.00", "30.00"),
			online(t, "80.50", "20.25"),
			online(t, "10.00", "10.00"),
			online(t, "40.00", "5.00"),
		];
		for (const order of orders)
			await committed(clientCtx(t), (c) => reserve(c, order));
		await committed(adminCtx(t), (c) => capture(c, orders[0].orderRef));
		await committed(adminCtx(t), (c) => capture(c, orders[1].orderRef));
		await committed(adminCtx(t), (c) => capture(c, orders[2].orderRef));
		await committed(clientCtx(t), (c) => release(c, orders[3].orderRef));

		const { rows } = await owner.query<{ net: string; total: string }>(
			`select
         (select sum(case kind when 'topup' then amount when 'capture' then -amount
                                when 'reversal' then -amount else 0 end)
            from client_ledger_entries where client_profile_id = $1) as net,
         w.available + w.reserved as total
       from client_wallets w where w.client_profile_id = $1`,
			[t.client.userId],
		);
		expect(rows[0]).toEqual({ net: "359.50", total: "359.50" });
		// 500 - 50 - 80.50 - 10.00 = 359.50; acréscimos 20 + 60.25 + 0.
		const payable = await owner.query<{ balance: string }>(
			"select coalesce(sum(amount), 0) as balance from bureau_payable_entries where bureau_id = $1",
			[t.bureau.id],
		);
		expect(payable.rows[0].balance).toBe("80.25");
	});

	it("balances the Bureau wallet with counter orders", async () => {
		const t = await setup("0", "300.00");
		const orders = [
			counter("50.00", "30.00"),
			counter("70.00", "45.50"),
			counter("20.00", "20.00"),
		];
		for (const order of orders)
			await committed(operatorCtx(t), (c) => reserve(c, order));
		await committed(operatorCtx(t), (c) => capture(c, orders[0].orderRef));
		await committed(operatorCtx(t), (c) => release(c, orders[1].orderRef));

		const { rows } = await owner.query<{ net: string; total: string }>(
			`select
         (select sum(case kind when 'topup' then amount when 'capture' then -amount
                                when 'reversal' then -amount when 'adjustment' then amount else 0 end)
            from ledger_entries where bureau_id = $1) as net,
         w.available + w.reserved as total
       from wallets w where w.bureau_id = $1`,
			[t.bureau.id],
		);
		expect(rows[0]).toEqual({ net: "270.00", total: "270.00" });
	});
});

describe("bureau_payable_entries", () => {
	it("blocks UPDATE, DELETE and TRUNCATE for every role", async () => {
		const t = await setup("100.00", "0");
		const order = online(t);
		await committed(clientCtx(t), (c) => reserve(c, order));
		await committed(adminCtx(t), (c) => capture(c, order.orderRef));

		for (const sql of [
			"update bureau_payable_entries set amount = 1 where order_ref = $1",
			"delete from bureau_payable_entries where order_ref = $1",
		]) {
			await expect(
				withDbContext(app, adminCtx(t), (c) => c.query(sql, [order.orderRef])),
			).rejects.toThrow(/permission denied/);
			await expect(owner.query(sql, [order.orderRef])).rejects.toThrow(
				/immutable/,
			);
		}
		await expect(
			owner.query("truncate bureau_payable_entries"),
		).rejects.toThrow(/immutable/);
	});

	it("allows one accrual per order and checks the sign of each kind", async () => {
		const t = await setup("100.00", "0");
		const order = online(t);
		await committed(clientCtx(t), (c) => reserve(c, order));
		await committed(adminCtx(t), (c) => capture(c, order.orderRef));
		const insert = (kind: string, amount: string, orderRef: string | null) =>
			owner.query(
				"insert into bureau_payable_entries (bureau_id, kind, amount, order_ref) values ($1, $2, $3, $4)",
				[t.bureau.id, kind, amount, orderRef],
			);
		await expect(insert("accrual", "1.00", order.orderRef)).rejects.toThrow(
			/unique|duplicate/,
		);
		await expect(insert("accrual", "-1.00", null)).rejects.toThrow(
			/check constraint/,
		);
		await expect(insert("reversal", "1.00", order.orderRef)).rejects.toThrow(
			/check constraint/,
		);
		await expect(insert("payout", "1.00", null)).rejects.toThrow(
			/check constraint/,
		);
		await expect(insert("other", "-1.00", null)).rejects.toThrow(
			/check constraint/,
		);
		await expect(
			insert("reversal", "-5.00", order.orderRef),
		).resolves.toBeDefined();
		// O repasse pago sempre aponta para o repasse (payout_id): sem ele o lançamento não entra.
		await expect(insert("payout", "-5.00", null)).rejects.toThrow(
			/bureau_payable_entries_payout_required/,
		);
		await expect(insert("accrual", "5.00", null)).rejects.toThrow(
			/bureau_payable_entries_accrual_order/,
		);
	});

	it("shows entries to the admin and operator of the Bureau and to the superadmin, never to a client or another Bureau", async () => {
		const a = await setup("100.00", "0");
		const b = await setup("100.00", "0");
		const orderA = online(a);
		const orderB = online(b);
		await committed(clientCtx(a), (c) => reserve(c, orderA));
		await committed(adminCtx(a), (c) => capture(c, orderA.orderRef));
		await committed(clientCtx(b), (c) => reserve(c, orderB));
		await committed(adminCtx(b), (c) => capture(c, orderB.orderRef));

		for (const ctx of [adminCtx(a), operatorCtx(a)]) {
			await withDbContext(app, ctx, async (c) => {
				const rows = await c.query(
					"select distinct bureau_id from bureau_payable_entries",
				);
				expect(rows.rows.map((r) => r.bureau_id)).toEqual([a.bureau.id]);
			});
		}
		await withDbContext(app, clientCtx(a), async (c) => {
			expect(
				(await c.query("select 1 from bureau_payable_entries")).rowCount,
			).toBe(0);
		});
		await withDbContext(app, superadminCtx(), async (c) => {
			const rows = await c.query(
				"select distinct bureau_id from bureau_payable_entries where bureau_id = any($1)",
				[[a.bureau.id, b.bureau.id]],
			);
			expect(rows.rowCount).toBe(2);
			// A exceção é só desta tabela.
			expect((await c.query("select 1 from order_settlements")).rowCount).toBe(
				0,
			);
			expect((await c.query("select 1 from counter_payments")).rowCount).toBe(
				0,
			);
		});
	});

	it("keeps the app role from writing entries directly", async () => {
		const t = await setup("100.00", "0");
		await expect(
			withDbContext(app, adminCtx(t), (c) =>
				c.query(
					"insert into bureau_payable_entries (bureau_id, kind, amount) values ($1, 'accrual', 5)",
					[t.bureau.id],
				),
			),
		).rejects.toThrow(/permission denied/);
	});
});

describe("RLS da liquidação", () => {
	it("isolates settlements between Bureaus and between clients", async () => {
		const a = await setup("100.00", "100.00");
		const other = await seedClientProfile(owner, a.bureau.id);
		await seedClientWalletTopup(owner, {
			clientProfileId: other.userId,
			amount: "100.00",
			createdBy: other.userId,
		});
		// O pedido online do outro cliente precisa de um titular dele.
		await owner.query(
			`insert into holders (bureau_id, type, name, document, created_by, client_profile_id)
       values ($1, 'PF', 'Outro titular', $2, $3, $4)`,
			[a.bureau.id, randomCpf(), a.bureauAdmin.userId, other.userId],
		);
		const b = await setup("100.00", "100.00");
		const mine = online(a);
		const theirs = { ...online(a), clientId: other.userId };
		const counterOrder = counter();
		const foreign = online(b);
		await committed(clientCtx(a), (c) => reserve(c, mine));
		await committed(ctxOf(other), (c) => reserve(c, theirs));
		await committed(operatorCtx(a), (c) => reserve(c, counterOrder));
		await committed(clientCtx(b), (c) => reserve(c, foreign));

		const refs = async (ctx: Ctx) =>
			withDbContext(app, ctx, async (c) => {
				const { rows } = await c.query<{ order_ref: string }>(
					"select order_ref from order_settlements",
				);
				return new Set(rows.map((r) => r.order_ref));
			});
		expect(await refs(clientCtx(a))).toEqual(new Set([mine.orderRef]));
		expect(await refs(ctxOf(other))).toEqual(new Set([theirs.orderRef]));
		expect(await refs(adminCtx(a))).toEqual(
			new Set([mine.orderRef, theirs.orderRef, counterOrder.orderRef]),
		);
		expect(await refs(operatorCtx(a))).toEqual(
			new Set([mine.orderRef, theirs.orderRef, counterOrder.orderRef]),
		);
		expect(await refs(adminCtx(b))).toEqual(new Set([foreign.orderRef]));
		expect(await refs(superadminCtx())).toEqual(new Set());
	});

	it("keeps the app role from writing settlements directly and the operator from superadmin functions", async () => {
		const t = await setup("100.00", "100.00");
		const order = online(t);
		await committed(clientCtx(t), (c) => reserve(c, order));
		const attempts = [
			`insert into order_settlements (order_ref, bureau_id, mode, price, cost) values (gen_random_uuid(), '${t.bureau.id}', 'counter', 5, 1)`,
			`update order_settlements set status = 'captured', closed_at = now() where order_ref = '${order.orderRef}'`,
			`delete from order_settlements where order_ref = '${order.orderRef}'`,
		];
		for (const ctx of [clientCtx(t), adminCtx(t), operatorCtx(t)]) {
			for (const sql of attempts) {
				await expect(
					withDbContext(app, ctx, (c) => c.query(sql)),
					`${ctx.role}: ${sql}`,
				).rejects.toThrow(/permission denied/);
			}
		}
		// O ajuste de saldo é função de superadmin: o operador recebe not_allowed.
		const adjust = await committed(
			operatorCtx(t),
			async (c) =>
				(
					await c.query<{ ok: boolean; reason: string }>(
						"select * from wallet_apply($1, 'adjustment', 5, $2, null, 'x')",
						[t.bureau.id, `k-${randomBytes(4).toString("hex")}`],
					)
				).rows[0],
		);
		expect(adjust).toMatchObject({ ok: false, reason: "not_allowed" });
	});

	it("lets app_runtime execute the three settlement functions and nothing internal", async () => {
		const exec = async (fn: string, role: string) =>
			(
				await owner.query<{ ok: boolean }>(
					"select has_function_privilege($1, $2, 'execute') as ok",
					[role, fn],
				)
			).rows[0].ok;
		for (const fn of [
			"public.reserve_order(uuid, text, uuid, numeric, numeric, jsonb, text)",
			"public.capture_order(uuid)",
			"public.release_order(uuid)",
			"public.void_counter_payment(uuid, text)",
		]) {
			expect(await exec(fn, "app_runtime"), fn).toBe(true);
			expect(await exec(fn, "public"), fn).toBe(false);
			expect(await exec(fn, "app_webhook"), fn).toBe(false);
		}
	});
});

describe("counter_payments", () => {
	async function setupCounter() {
		const t = await setup("0", "0");
		const dossierId = await seedDossier(owner, {
			bureauId: t.bureau.id,
			holderId: t.holder.id,
			createdBy: t.bureauAdmin.userId,
		});
		return { t, dossierId };
	}

	const insertPayment = (
		ctx: Ctx,
		input: {
			bureauId: string;
			dossierId: string;
			amount?: string;
			method?: string;
			registeredBy?: string;
		},
	) =>
		committed(
			ctx,
			async (c) =>
				(
					await c.query<{ id: string }>(
						`insert into counter_payments (bureau_id, dossier_id, method, amount, registered_by, note)
           values ($1, $2, $3, $4, $5, 'nota') returning id`,
						[
							input.bureauId,
							input.dossierId,
							input.method ?? "cash",
							input.amount ?? "25.00",
							input.registeredBy ?? ctx.userId,
						],
					)
				).rows[0].id,
		);

	async function register(
		ctx: Ctx,
		t: SeededTenant,
		dossierId: string,
		amount = "25.00",
	) {
		return committed(
			ctx,
			async (c) =>
				(
					await c.query<{ id: string }>(
						`insert into counter_payments (bureau_id, dossier_id, method, amount, registered_by)
           values ($1, $2, 'pix', $3, $4) returning id`,
						[t.bureau.id, dossierId, amount, ctx.userId],
					)
				).rows[0].id,
		);
	}

	const voidPayment = (ctx: Ctx, id: string, reason: string | null) =>
		committed(
			ctx,
			async (c) =>
				(
					await c.query<{ ok: boolean; reason: string | null }>(
						"select * from void_counter_payment($1, $2)",
						[id, reason],
					)
				).rows[0],
		);

	it("lets the operator and the admin register payments, with several payments per dossier", async () => {
		const { t, dossierId } = await setupCounter();
		await expect(
			insertPayment(operatorCtx(t), { bureauId: t.bureau.id, dossierId }),
		).resolves.toBeDefined();
		await expect(
			insertPayment(adminCtx(t), {
				bureauId: t.bureau.id,
				dossierId,
				amount: "10.50",
				method: "card_machine",
			}),
		).resolves.toBeDefined();
		const { rows } = await owner.query(
			"select 1 from counter_payments where dossier_id = $1",
			[dossierId],
		);
		expect(rows).toHaveLength(2);
	});

	it("refuses clients, other Bureaus, foreign dossiers, another author and invalid values", async () => {
		const { t, dossierId } = await setupCounter();
		const b = await setup("0", "0");
		const foreignDossier = await seedDossier(owner, {
			bureauId: b.bureau.id,
			holderId: b.holder.id,
			createdBy: b.bureauAdmin.userId,
		});
		const base = { bureauId: t.bureau.id, dossierId };

		await expect(insertPayment(clientCtx(t), base)).rejects.toThrow(
			/row-level security/,
		);
		await expect(insertPayment(superadminCtx(), base)).rejects.toThrow(
			/row-level security/,
		);
		await expect(insertPayment(adminCtx(b), base)).rejects.toThrow(
			/row-level security/,
		);
		await expect(
			insertPayment(operatorCtx(t), {
				...base,
				registeredBy: t.bureauAdmin.userId,
			}),
		).rejects.toThrow(/row-level security/);
		await expect(
			insertPayment(operatorCtx(t), { ...base, dossierId: foreignDossier }),
		).rejects.toThrow(/foreign key/);
		await expect(
			insertPayment(operatorCtx(t), { ...base, amount: "0" }),
		).rejects.toThrow(/check constraint/);
		await expect(
			insertPayment(operatorCtx(t), { ...base, amount: "-5.00" }),
		).rejects.toThrow(/check constraint/);
		await expect(
			insertPayment(operatorCtx(t), { ...base, method: "boleto" }),
		).rejects.toThrow(/check constraint/);
		// Ao inserir, a anulação não pode vir preenchida.
		await expect(
			withDbContext(app, operatorCtx(t), (c) =>
				c.query(
					`insert into counter_payments (bureau_id, dossier_id, method, amount, registered_by, voided_at)
           values ($1, $2, 'cash', 5, $3, now())`,
					[t.bureau.id, dossierId, t.operator.userId],
				),
			),
		).rejects.toThrow(/permission denied|row-level security/);
	});

	it("isolates reads between Bureaus and hides payments from clients", async () => {
		const { t, dossierId } = await setupCounter();
		const b = await setup("0", "0");
		const id = await register(operatorCtx(t), t, dossierId);

		for (const ctx of [adminCtx(t), operatorCtx(t)]) {
			await withDbContext(app, ctx, async (c) => {
				expect((await c.query("select id from counter_payments")).rows).toEqual(
					[{ id }],
				);
			});
		}
		for (const ctx of [adminCtx(b), clientCtx(t), superadminCtx()]) {
			await withDbContext(app, ctx, async (c) => {
				expect(
					(await c.query("select 1 from counter_payments")).rowCount,
					ctx.role,
				).toBe(0);
			});
		}
	});

	it("blocks UPDATE of the amount and DELETE", async () => {
		const { t, dossierId } = await setupCounter();
		const id = await register(operatorCtx(t), t, dossierId);

		for (const ctx of [operatorCtx(t), adminCtx(t)]) {
			for (const sql of [
				"update counter_payments set amount = 1 where id = $1",
				"update counter_payments set voided_at = now(), voided_by = app_user_id(), void_reason = 'x' where id = $1",
				"delete from counter_payments where id = $1",
			]) {
				await expect(
					withDbContext(app, ctx, (c) => c.query(sql, [id])),
					sql,
				).rejects.toThrow(/permission denied/);
			}
		}
		// Nem o dono altera o valor, apaga ou esvazia a tabela.
		await expect(
			owner.query("update counter_payments set amount = 1 where id = $1", [id]),
		).rejects.toThrow(/counter_payments/);
		await expect(
			owner.query("update counter_payments set method = 'cash' where id = $1", [
				id,
			]),
		).rejects.toThrow(/counter_payments/);
		await expect(
			owner.query("delete from counter_payments where id = $1", [id]),
		).rejects.toThrow(/counter_payments/);
		await expect(owner.query("truncate counter_payments")).rejects.toThrow(
			/counter_payments/,
		);
		const { rows } = await owner.query(
			"select amount, voided_at from counter_payments where id = $1",
			[id],
		);
		expect(rows).toEqual([{ amount: "25.00", voided_at: null }]);
	});

	it("voids with a reason, once, without changing the amount", async () => {
		const { t, dossierId } = await setupCounter();
		const id = await register(operatorCtx(t), t, dossierId, "42.10");

		for (const reason of [null, "", "   "]) {
			expect(
				await voidPayment(operatorCtx(t), id, reason),
				String(reason),
			).toEqual({ ok: false, reason: "reason_required" });
		}
		expect(
			await voidPayment(operatorCtx(t), id, "valor digitado errado"),
		).toEqual({ ok: true, reason: null });

		const { rows } = await owner.query(
			"select amount, voided_by, void_reason, voided_at is not null as voided from counter_payments where id = $1",
			[id],
		);
		expect(rows).toEqual([
			{
				amount: "42.10",
				voided_by: t.operator.userId,
				void_reason: "valor digitado errado",
				voided: true,
			},
		]);

		expect(await voidPayment(adminCtx(t), id, "outra razão")).toEqual({
			ok: false,
			reason: "already_voided",
		});
		const again = await owner.query(
			"select void_reason, voided_by from counter_payments where id = $1",
			[id],
		);
		expect(again.rows).toEqual([
			{ void_reason: "valor digitado errado", voided_by: t.operator.userId },
		]);

		// Depois de anulado nem o dono muda a anulação.
		await expect(
			owner.query(
				"update counter_payments set void_reason = 'x' where id = $1",
				[id],
			),
		).rejects.toThrow(/counter_payments/);
	});

	it("refuses a void by a client, a stranger Bureau or without a session, and for an unknown payment", async () => {
		const { t, dossierId } = await setupCounter();
		const b = await setup("0", "0");
		const id = await register(operatorCtx(t), t, dossierId);

		expect(await voidPayment(clientCtx(t), id, "motivo")).toEqual({
			ok: false,
			reason: "not_allowed",
		});
		expect(await voidPayment(superadminCtx(), id, "motivo")).toEqual({
			ok: false,
			reason: "not_allowed",
		});
		expect(await voidPayment(adminCtx(b), id, "motivo")).toEqual({
			ok: false,
			reason: "not_found",
		});
		expect(await voidPayment(adminCtx(t), randomUUID(), "motivo")).toEqual({
			ok: false,
			reason: "not_found",
		});
		const noSession = await owner.query(
			"select * from void_counter_payment($1, 'motivo')",
			[id],
		);
		expect(noSession.rows).toEqual([{ ok: false, reason: "not_allowed" }]);
		const { rows } = await owner.query(
			"select voided_at from counter_payments where id = $1",
			[id],
		);
		expect(rows).toEqual([{ voided_at: null }]);
	});

	it("keeps the voided_by author inside the Bureau", async () => {
		const { t, dossierId } = await setupCounter();
		const id = await register(operatorCtx(t), t, dossierId);
		const b = await seedTenant(owner, "OutroAutor");
		await expect(
			owner.query(
				"update counter_payments set voided_at = now(), voided_by = $2, void_reason = 'x' where id = $1",
				[id, b.bureauAdmin.userId],
			),
		).rejects.toThrow(/foreign key/);
	});
});

describe("018: custo fora do alcance do cliente", () => {
	it("denies the cost and quote columns to app_runtime for every role, while price and status stay readable", async () => {
		const t = await setup("100.00", "100.00");
		const order = online(t, "50.00", "30.00");
		await committed(clientCtx(t), (c) => reserve(c, order));

		for (const ctx of [
			clientCtx(t),
			adminCtx(t),
			operatorCtx(t),
			superadminCtx(),
		]) {
			for (const sql of [
				"select cost from order_settlements",
				"select quote from order_settlements",
				"select * from order_settlements",
				"select (order_settlements.*)::text from order_settlements",
			]) {
				await expect(
					withDbContext(app, ctx, (c) => c.query(sql)),
					`${ctx.role}: ${sql}`,
				).rejects.toThrow(/permission denied/);
			}
		}
		await withDbContext(app, clientCtx(t), async (c) => {
			const { rows } = await c.query(
				"select order_ref, price, status from order_settlements",
			);
			expect(rows).toEqual([
				{ order_ref: order.orderRef, price: "50.00", status: "reserved" },
			]);
		});
	});

	it("returns cost and quote only to the staff of the Bureau and to the superadmin", async () => {
		const t = await setup("100.00", "100.00");
		const foreign = await setup("0", "0");
		const order = online(t, "50.00", "30.00");
		await committed(clientCtx(t), (c) => reserve(c, order));
		const { rows: stored } = await owner.query<{ quote: unknown }>(
			"select quote from order_settlements where order_ref = $1",
			[order.orderRef],
		);
		const quote = stored[0].quote;

		const read = (ctx: Ctx) =>
			withDbContext(app, ctx, async (c) =>
				(
					await c.query<{ cost: string; quote: unknown }>(
						"select * from order_settlement_cost($1)",
						[order.orderRef],
					)
				).rows,
			);
		for (const ctx of [adminCtx(t), operatorCtx(t), superadminCtx()]) {
			expect(await read(ctx), ctx.role).toEqual([{ cost: "30.00", quote }]);
		}
		for (const ctx of [clientCtx(t), adminCtx(foreign), operatorCtx(foreign), ctxOf(foreign.client)]) {
			expect(await read(ctx), ctx.role).toEqual([]);
		}
		expect(
			(
				await app.query("select * from order_settlement_cost($1)", [
					order.orderRef,
				])
			).rows,
		).toEqual([]);
	});

	it("keeps the cost function away from public, app_webhook and the web roles other than app_runtime", async () => {
		const exec = async (role: string) =>
			(
				await owner.query<{ ok: boolean }>(
					"select has_function_privilege($1, 'public.order_settlement_cost(uuid)', 'execute') as ok",
					[role],
				)
			).rows[0].ok;
		expect(await exec("app_runtime")).toBe(true);
		expect(await exec("public")).toBe(false);
		expect(await exec("app_webhook")).toBe(false);
	});
});

describe("018: o pedido é um Dossiê do Bureau", () => {
	it("refuses an order_ref that is no dossier, a dossier of another Bureau and, online, a dossier of another client", async () => {
		const t = await setup();
		const other = await seedClientProfile(owner, t.bureau.id);
		await seedClientWalletTopup(owner, {
			clientProfileId: other.userId,
			amount: "100.00",
			createdBy: other.userId,
		});
		const foreign = await setup();
		const foreignDossier = await seedDossier(owner, {
			bureauId: foreign.bureau.id,
			holderId: foreign.holder.id,
			createdBy: foreign.bureauAdmin.userId,
		});
		// Dossiê do titular que é do cliente `t.client`, não do `other`.
		const ownDossier = await seedDossier(owner, {
			bureauId: t.bureau.id,
			holderId: t.holder.id,
			createdBy: t.bureauAdmin.userId,
		});
		await seedOrderDossier(owner, { orderRef: ownDossier, bureauId: t.bureau.id, clientProfileId: t.client.userId });
		const notFound = { ok: false, reason: "not_found", status: null };

		expect(
			await committed(clientCtx(t), (c) => reserveRaw(c, online(t))),
			"no dossier",
		).toEqual(notFound);
		expect(
			await committed(operatorCtx(t), (c) => reserveRaw(c, counter())),
			"no dossier (counter)",
		).toEqual(notFound);
		expect(
			await committed(clientCtx(t), (c) =>
				reserveRaw(c, online(t, "50.00", "30.00", foreignDossier)),
			),
			"dossier of another Bureau",
		).toEqual(notFound);
		expect(
			await committed(operatorCtx(t), (c) =>
				reserveRaw(c, counter("50.00", "30.00", foreignDossier)),
			),
			"dossier of another Bureau (counter)",
		).toEqual(notFound);
		expect(
			await committed(ctxOf(other), (c) =>
				reserveRaw(c, {
					...online(t, "50.00", "30.00", ownDossier),
					clientId: other.userId,
				}),
			),
			"dossier of a holder of another client",
		).toEqual(notFound);
		expect(await settlement(ownDossier)).toBeUndefined();
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "100.00",
			reserved: "0.00",
		});

		expect(
			await committed(clientCtx(t), (c) =>
				reserveWithCatalog(c, online(t, "50.00", "30.00", ownDossier)),
			),
		).toEqual({ ok: true, reason: null, status: "reserved" });
	});

	it("lets the counter staff reserve on any dossier of the Bureau", async () => {
		const t = await setup("0", "100.00");
		const dossier = await seedDossier(owner, {
			bureauId: t.bureau.id,
			holderId: t.holder.id,
			createdBy: t.bureauAdmin.userId,
		});
		await seedOrderDossier(owner, { orderRef: dossier, bureauId: t.bureau.id, clientProfileId: null });
		expect(
			await committed(operatorCtx(t), (c) =>
				reserveWithCatalog(c, counter("50.00", "30.00", dossier)),
			),
		).toEqual({ ok: true, reason: null, status: "reserved" });
	});
});

describe("018: balcão com custo zero", () => {
	it("records the settlement and makes capture and release no-ops on the Bureau wallet", async () => {
		const t = await setup("0", "100.00");
		const toCapture = counter("50.00", "0.00");
		const toRelease = counter("50.00", "0.00");

		for (const order of [toCapture, toRelease]) {
			expect(
				await committed(operatorCtx(t), (c) => reserve(c, order)),
			).toEqual({ ok: true, reason: null, status: "reserved" });
			// Repetir devolve o mesmo resultado.
			expect(
				await committed(operatorCtx(t), (c) => reserve(c, order)),
			).toEqual({ ok: true, reason: null, status: "reserved" });
		}
		expect(await bureauBalance(t.bureau.id)).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
		expect(await settlement(toCapture.orderRef)).toMatchObject({
			status: "reserved",
			cost: "0.00",
			price: "50.00",
			mode: "counter",
		});

		expect(
			await committed(operatorCtx(t), (c) => capture(c, toCapture.orderRef)),
		).toEqual({ ok: true, reason: null, status: "captured" });
		expect(
			await committed(operatorCtx(t), (c) => release(c, toRelease.orderRef)),
		).toEqual({ ok: true, reason: null, status: "released" });
		expect(await bureauBalance(t.bureau.id)).toEqual({
			available: "100.00",
			reserved: "0.00",
		});
		expect(await orderEntryCount(toCapture.orderRef)).toBe(0);
		expect(await orderEntryCount(toRelease.orderRef)).toBe(0);
		expect(await accruals(toCapture.orderRef)).toEqual([]);
	});

	it("still refuses a negative cost and a price below cost", async () => {
		const t = await setup("0", "100.00");
		expect(
			await committed(operatorCtx(t), (c) =>
				reserve(c, counter("10.00", "-0.01")),
			),
		).toMatchObject({ ok: false, reason: "invalid_amount" });
		expect(
			await committed(operatorCtx(t), (c) =>
				reserve(c, counter("0.00", "0.00")),
			),
		).toMatchObject({ ok: false, reason: "invalid_amount" });
	});
});

describe("018: estorno de PIX cobre a reserva", () => {
	const refund = (asaasPaymentId: string) =>
		hook
			.query<{ apply_asaas_payment: string }>(
				"select apply_asaas_payment($1, 'PAYMENT_REFUNDED', $2, '{}'::jsonb)",
				[`evt-${randomBytes(6).toString("hex")}`, asaasPaymentId],
			)
			.then((r) => r.rows[0].apply_asaas_payment);
	const shortfallOf = async (chargeId: string) =>
		(
			await owner.query<{ status: string; refund_shortfall: string }>(
				"select status, refund_shortfall from pix_charges where id = $1",
				[chargeId],
			)
		).rows[0];
	const clientNet = async (clientId: string) =>
		(
			await owner.query<{ net: string; total: string }>(
				`select
           (select sum(case kind when 'topup' then amount when 'capture' then -amount
                                  when 'reversal' then -amount else 0 end)
              from client_ledger_entries where client_profile_id = $1) as net,
           w.available + w.reserved as total
         from client_wallets w where w.client_profile_id = $1`,
				[clientId],
			)
		).rows[0];
	const lastClientEntry = async (clientId: string) =>
		(
			await owner.query(
				`select kind, amount, available_after, reserved_after from client_ledger_entries
          where client_profile_id = $1 order by seq desc limit 1`,
				[clientId],
			)
		).rows[0];

	it("takes the reservation back when the refund finds funds only in reserved, and then closes the order on capture", async () => {
		const t = await setup("1000.00", "0");
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.client.userId,
			clientProfileId: t.client.userId,
			amount: "1000.00",
			status: "paid",
		});
		const order = online(t, "1000.00", "600.00");
		const toRelease = order;
		await committed(clientCtx(t), (c) => reserve(c, order));
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "0.00",
			reserved: "1000.00",
		});

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect(await clientBalance(t.client.userId)).toEqual({
			available: "0.00",
			reserved: "0.00",
		});
		expect(await shortfallOf(charge.id)).toEqual({
			status: "refunded",
			refund_shortfall: "0.00",
		});
		expect(await lastClientEntry(t.client.userId)).toEqual({
			kind: "reversal",
			amount: "1000.00",
			available_after: "0.00",
			reserved_after: "0.00",
		});

		// A captura não captura: fecha o pedido como liberado, sem valor a repassar.
		expect(
			await committed(adminCtx(t), (c) => capture(c, order.orderRef)),
		).toEqual({ ok: false, reason: "reservation_clawed_back", status: "released" });
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "0.00",
			reserved: "0.00",
		});
		expect(await accruals(order.orderRef)).toEqual([]);
		const closed = await settlement(order.orderRef);
		expect(closed.status).toBe("released");
		expect(closed.closed_at).not.toBeNull();
		expect(await clientNet(t.client.userId)).toEqual({ net: "0.00", total: "0.00" });
		// Sem reserva sobrando não há lançamento de liberação: só o da reserva.
		expect(await orderEntryCount(order.orderRef)).toBe(1);

		// Repetição: o pedido já está fechado.
		expect(
			await committed(adminCtx(t), (c) => capture(c, order.orderRef)),
		).toEqual({ ok: false, reason: "invalid_state", status: "released" });
		expect(
			await committed(clientCtx(t), (c) => release(c, toRelease.orderRef)),
		).toEqual({ ok: true, reason: null, status: "released" });
		expect(await orderEntryCount(order.orderRef)).toBe(1);
	});

	it("closes the order as released on release when the refund took the whole reservation", async () => {
		const t = await setup("1000.00", "0");
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.client.userId,
			clientProfileId: t.client.userId,
			amount: "1000.00",
			status: "paid",
		});
		const order = online(t, "1000.00", "600.00");
		await committed(clientCtx(t), (c) => reserve(c, order));
		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect(
			await committed(clientCtx(t), (c) => release(c, order.orderRef)),
		).toEqual({ ok: true, reason: null, status: "released" });
		expect((await settlement(order.orderRef)).status).toBe("released");
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "0.00",
			reserved: "0.00",
		});
		expect(await orderEntryCount(order.orderRef)).toBe(1);
		expect(
			await committed(clientCtx(t), (c) => release(c, order.orderRef)),
		).toEqual({ ok: true, reason: null, status: "released" });
	});

	it("takes the available balance first and the reservation for the rest", async () => {
		const t = await setup("1000.00", "0");
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.client.userId,
			clientProfileId: t.client.userId,
			amount: "600.00",
			status: "paid",
		});
		const order = online(t, "700.00", "400.00");
		await committed(clientCtx(t), (c) => reserve(c, order));
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "300.00",
			reserved: "700.00",
		});

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect(await clientBalance(t.client.userId)).toEqual({
			available: "0.00",
			reserved: "400.00",
		});
		expect(await shortfallOf(charge.id)).toMatchObject({ refund_shortfall: "0.00" });
		expect(await lastClientEntry(t.client.userId)).toMatchObject({
			kind: "reversal",
			amount: "600.00",
			available_after: "0.00",
			reserved_after: "400.00",
		});
		// A reserva restante (400) não cobre o pedido de 700: a liberação devolve os 400 e fecha o pedido.
		expect(
			await committed(clientCtx(t), (c) => release(c, order.orderRef)),
		).toEqual({ ok: true, reason: null, status: "released" });
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "400.00",
			reserved: "0.00",
		});
		expect(await lastClientEntry(t.client.userId)).toMatchObject({
			kind: "release",
			amount: "400.00",
			available_after: "400.00",
			reserved_after: "0.00",
		});
		expect(await clientNet(t.client.userId)).toEqual({ net: "400.00", total: "400.00" });
		// Repetição: nenhum lançamento novo.
		expect(
			await committed(clientCtx(t), (c) => release(c, order.orderRef)),
		).toEqual({ ok: true, reason: null, status: "released" });
		expect(await orderEntryCount(order.orderRef)).toBe(2);
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "400.00",
			reserved: "0.00",
		});
	});

	it("releases what is left of the reservation on capture, closes the order and accrues nothing", async () => {
		const t = await setup("1000.00", "0");
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.client.userId,
			clientProfileId: t.client.userId,
			amount: "600.00",
			status: "paid",
		});
		const order = online(t, "700.00", "400.00");
		await committed(clientCtx(t), (c) => reserve(c, order));
		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect(
			await committed(adminCtx(t), (c) => capture(c, order.orderRef)),
		).toEqual({ ok: false, reason: "reservation_clawed_back", status: "released" });
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "400.00",
			reserved: "0.00",
		});
		expect(await lastClientEntry(t.client.userId)).toMatchObject({ kind: "release", amount: "400.00" });
		expect(await accruals(order.orderRef)).toEqual([]);
		expect((await settlement(order.orderRef)).status).toBe("released");
		expect(await clientNet(t.client.userId)).toEqual({ net: "400.00", total: "400.00" });

		expect(
			await committed(adminCtx(t), (c) => capture(c, order.orderRef)),
		).toEqual({ ok: false, reason: "invalid_state", status: "released" });
		expect(await orderEntryCount(order.orderRef)).toBe(2);
	});

	it("records as shortfall only what neither the available balance nor the reservation covers", async () => {
		const t = await setup("100.00", "0");
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.client.userId,
			clientProfileId: t.client.userId,
			amount: "100.00",
			status: "paid",
		});
		// O cliente gastou 70 (reserva + captura): sobram 30 e nada reservado. Preço igual ao custo: sem valor a repassar.
		const order = online(t, "70.00", "70.00");
		await committed(clientCtx(t), (c) => reserve(c, order));
		await committed(adminCtx(t), (c) => capture(c, order.orderRef));

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect(await shortfallOf(charge.id)).toEqual({
			status: "refunded",
			refund_shortfall: "70.00",
		});
		expect(await clientBalance(t.client.userId)).toEqual({
			available: "0.00",
			reserved: "0.00",
		});
		expect(await clientNet(t.client.userId)).toEqual({ net: "0.00", total: "0.00" });
	});

	it("applies the same rule to the Bureau wallet reserved for a counter order", async () => {
		const t = await setup("0", "1000.00");
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.bureauAdmin.userId,
			amount: "1000.00",
			status: "paid",
		});
		const order = counter("1500.00", "1000.00");
		await committed(operatorCtx(t), (c) => reserve(c, order));
		expect(await bureauBalance(t.bureau.id)).toEqual({
			available: "0.00",
			reserved: "1000.00",
		});

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect(await bureauBalance(t.bureau.id)).toEqual({
			available: "0.00",
			reserved: "0.00",
		});
		expect(await shortfallOf(charge.id)).toMatchObject({ refund_shortfall: "0.00" });
		expect(
			await committed(operatorCtx(t), (c) => capture(c, order.orderRef)),
		).toEqual({ ok: false, reason: "reservation_clawed_back", status: "released" });
		expect((await settlement(order.orderRef)).status).toBe("released");
		expect(
			await committed(operatorCtx(t), (c) => release(c, order.orderRef)),
		).toEqual({ ok: true, reason: null, status: "released" });
		const { rows } = await owner.query<{ net: string; total: string }>(
			`select
         (select sum(case kind when 'topup' then amount when 'capture' then -amount
                                when 'reversal' then -amount when 'adjustment' then amount else 0 end)
            from ledger_entries where bureau_id = $1) as net,
         w.available + w.reserved as total
       from wallets w where w.bureau_id = $1`,
			[t.bureau.id],
		);
		expect(rows[0]).toEqual({ net: "0.00", total: "0.00" });
	});

	it("releases the rest of the Bureau reservation when the refund took only part of it", async () => {
		const t = await setup("0", "1000.00");
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id,
			requestedBy: t.bureauAdmin.userId,
			amount: "600.00",
			status: "paid",
		});
		const order = counter("1500.00", "1000.00");
		await committed(operatorCtx(t), (c) => reserve(c, order));

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");
		expect(await bureauBalance(t.bureau.id)).toEqual({ available: "0.00", reserved: "400.00" });

		expect(
			await committed(operatorCtx(t), (c) => release(c, order.orderRef)),
		).toEqual({ ok: true, reason: null, status: "released" });
		expect(await bureauBalance(t.bureau.id)).toEqual({ available: "400.00", reserved: "0.00" });
		expect((await settlement(order.orderRef)).status).toBe("released");
		expect(
			await committed(operatorCtx(t), (c) => release(c, order.orderRef)),
		).toEqual({ ok: true, reason: null, status: "released" });
		expect(await bureauBalance(t.bureau.id)).toEqual({ available: "400.00", reserved: "0.00" });
	});
});
