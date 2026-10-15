// Liquidação por pedido contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
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
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { getWallet } from "@/lib/wallet/queries";
import { getClientWallet } from "@/lib/wallet/client-queries";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedClientWalletTopup,
	seedOrderDossierForSession,
	seedTenant,
	seedWalletTopup,
	type SeededTenant,
} from "@/test/seed";

import { captureOrder, getSettlement, releaseOrder, reserveOrder as reserveOrderRaw } from "./queries";
import type { OrderQuote, ReserveOrderInput } from "./types";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

// reserve_order exige um Dossiê do Bureau com o id do pedido.
const reserveOrder = async (c: PoolClient, input: ReserveOrderInput) => {
	await seedOrderDossierForSession(owner, c, { orderRef: input.orderRef, clientProfileId: input.clientProfileId });
	return reserveOrderRaw(c, input);
};

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

function quoteOf(priceCents: number, costCents: number): OrderQuote {
	return {
		ok: true,
		lines: [
			{ productVersionId: randomUUID(), code: "smart_pf", costCents, priceCents },
		],
		totalCostCents: costCents,
		totalPriceCents: priceCents,
	};
}

async function setup(label: string, funds: { client?: string; bureau?: string } = {}) {
	const tenant: SeededTenant = await seedTenant(owner, label);
	if (funds.client) {
		await seedClientWalletTopup(owner, {
			clientProfileId: tenant.client.userId,
			amount: funds.client,
			createdBy: tenant.client.userId,
		});
	}
	if (funds.bureau) {
		await seedWalletTopup(owner, {
			bureauId: tenant.bureau.id,
			amount: funds.bureau,
			createdBy: tenant.bureauAdmin.userId,
		});
	}
	const client: DbIdentity = { ...tenant.client };
	const operator: DbIdentity = { ...tenant.operator };
	return { tenant, client, operator };
}

const clientBalance = (who: DbIdentity) =>
	withUserTransaction(who, (c) => getClientWallet(c, who.userId));
const bureauBalance = (who: DbIdentity) =>
	withUserTransaction(who, (c) => getWallet(c, who.bureauId as string));

async function auditRows(settlementId: string, action: string) {
	const { rows } = await owner.query<{ metadata: Record<string, unknown>; user_id: string }>(
		"select metadata, user_id from audit_logs where record_id = $1 and action = $2",
		[settlementId, action],
	);
	return rows;
}

describe("online settlement", () => {
	it("reserves the price, captures it and accrues price minus cost", async () => {
		const { tenant, client, operator } = await setup("Settle O1", { client: "100.00" });
		const orderRef = randomUUID();

		const reserved = await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote: quoteOf(5000, 3000) }),
		);
		expect(reserved).toEqual({ ok: true, status: "reserved" });
		expect(await clientBalance(client)).toEqual({ available: "50.00", reserved: "50.00" });

		const captured = await withUserTransaction(operator, (c) => captureOrder(c, orderRef));
		expect(captured).toEqual({ ok: true, status: "captured" });
		expect(await clientBalance(client)).toEqual({ available: "50.00", reserved: "0.00" });

		const { rows } = await owner.query<{ kind: string; amount: string }>(
			"select kind, amount from bureau_payable_entries where bureau_id = $1",
			[tenant.bureau.id],
		);
		expect(rows).toEqual([{ kind: "accrual", amount: "20.00" }]);
	});

	it("releases the reservation without accrual", async () => {
		const { tenant, client } = await setup("Settle O2", { client: "100.00" });
		const orderRef = randomUUID();
		await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote: quoteOf(5000, 3000) }),
		);

		const released = await withUserTransaction(client, (c) => releaseOrder(c, orderRef));
		expect(released).toEqual({ ok: true, status: "released" });
		expect(await clientBalance(client)).toEqual({ available: "100.00", reserved: "0.00" });
		const { rows } = await owner.query("select 1 from bureau_payable_entries where bureau_id = $1", [tenant.bureau.id]);
		expect(rows).toHaveLength(0);
	});

	it("stores price, cost and the quote lines intact", async () => {
		const { client, operator } = await setup("Settle O3", { client: "100.00" });
		const orderRef = randomUUID();
		const quote = quoteOf(4590, 1230);
		await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote }),
		);

		const stored = await withUserTransaction(operator, (c) => getSettlement(c, orderRef));
		expect(stored).toMatchObject({
			orderRef,
			mode: "online",
			clientProfileId: client.userId,
			price: "45.90",
			cost: "12.30",
			status: "reserved",
			quote: { lines: quote.lines },
		});
	});

	it("hides cost and quote from the client and shows them to the Bureau staff and the superadmin", async () => {
		const { tenant, client, operator } = await setup("Settle O3b", { client: "100.00" });
		const orderRef = randomUUID();
		const quote = quoteOf(4590, 1230);
		await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote }),
		);

		const asClient = await withUserTransaction(client, (c) => getSettlement(c, orderRef));
		expect(asClient).toMatchObject({ orderRef, price: "45.90", status: "reserved", cost: null, quote: null });
		const asAdmin = await withUserTransaction({ ...tenant.bureauAdmin }, (c) => getSettlement(c, orderRef));
		expect(asAdmin).toMatchObject({ cost: "12.30", quote: { lines: quote.lines } });
		const asOperator = await withUserTransaction(operator, (c) => getSettlement(c, orderRef));
		expect(asOperator).toMatchObject({ cost: "12.30" });
		const outsider = await setup("Settle O3c");
		expect(await withUserTransaction(outsider.operator, (c) => getSettlement(c, orderRef))).toBeNull();
	});

	it("repeats are idempotent and move money once", async () => {
		const { client, operator } = await setup("Settle O4", { client: "100.00" });
		const orderRef = randomUUID();
		const input = { orderRef, mode: "online" as const, clientProfileId: client.userId, quote: quoteOf(5000, 3000) };

		await withUserTransaction(client, (c) => reserveOrder(c, input));
		expect(await withUserTransaction(client, (c) => reserveOrder(c, input))).toEqual({ ok: true, status: "reserved" });
		expect(await clientBalance(client)).toEqual({ available: "50.00", reserved: "50.00" });

		await withUserTransaction(operator, (c) => captureOrder(c, orderRef));
		expect(await withUserTransaction(operator, (c) => captureOrder(c, orderRef))).toEqual({ ok: true, status: "captured" });
		expect(await clientBalance(client)).toEqual({ available: "50.00", reserved: "0.00" });
		const { rows } = await owner.query("select 1 from client_ledger_entries where client_profile_id = $1 and kind = 'capture'", [client.userId]);
		expect(rows).toHaveLength(1);
	});

	it("rejects reuse of an order_ref with other values", async () => {
		const { client } = await setup("Settle O5", { client: "100.00" });
		const orderRef = randomUUID();
		const base = { orderRef, mode: "online" as const, clientProfileId: client.userId };
		await withUserTransaction(client, (c) => reserveOrder(c, { ...base, quote: quoteOf(5000, 3000) }));

		const other = await withUserTransaction(client, (c) => reserveOrder(c, { ...base, quote: quoteOf(6000, 3000) }));
		expect(other).toEqual({ ok: false, reason: "already_exists" });
	});

	it("captures with the values stored at reservation", async () => {
		const { client, operator } = await setup("Settle O6", { client: "100.00" });
		const orderRef = randomUUID();
		await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote: quoteOf(5000, 3000) }),
		);
		// Um preço novo no catálogo não muda a liquidação: a captura nem recebe valores.
		await withUserTransaction(operator, (c) => captureOrder(c, orderRef));
		expect(await clientBalance(client)).toEqual({ available: "50.00", reserved: "0.00" });
	});

	it("returns insufficient_balance and leaves no settlement row", async () => {
		const { client } = await setup("Settle O7", { client: "5.00" });
		const orderRef = randomUUID();
		const result = await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote: quoteOf(5000, 3000) }),
		);
		expect(result).toEqual({ ok: false, reason: "insufficient_balance" });
		expect(await withUserTransaction(client, (c) => getSettlement(c, orderRef))).toBeNull();
		expect(await clientBalance(client)).toEqual({ available: "5.00", reserved: "0.00" });
	});

	it("returns price_below_cost", async () => {
		const { client } = await setup("Settle O8", { client: "100.00" });
		const result = await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef: randomUUID(), mode: "online", clientProfileId: client.userId, quote: quoteOf(1000, 2000) }),
		);
		expect(result).toEqual({ ok: false, reason: "price_below_cost" });
	});

	it("returns invalid_amount for a zero price", async () => {
		const { client } = await setup("Settle O9", { client: "100.00" });
		const result = await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef: randomUUID(), mode: "online", clientProfileId: client.userId, quote: quoteOf(0, 0) }),
		);
		expect(result).toEqual({ ok: false, reason: "invalid_amount" });
	});

	it("refuses an online reserve by staff and by another client", async () => {
		const { client, operator } = await setup("Settle O10", { client: "100.00" });
		const other = await setup("Settle O10b", { client: "100.00" });
		const input = { mode: "online" as const, clientProfileId: client.userId, quote: quoteOf(5000, 3000) };

		const byStaff = await withUserTransaction(operator, (c) => reserveOrder(c, { ...input, orderRef: randomUUID() }));
		expect(byStaff).toEqual({ ok: false, reason: "not_allowed" });
		const byOther = await withUserTransaction(other.client, (c) => reserveOrder(c, { ...input, orderRef: randomUUID() }));
		expect(byOther).toEqual({ ok: false, reason: "not_allowed" });
	});

	it("does not see an order of another tenant", async () => {
		const { client } = await setup("Settle O11", { client: "100.00" });
		const outsider = await setup("Settle O11b", { client: "100.00" });
		const orderRef = randomUUID();
		await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote: quoteOf(5000, 3000) }),
		);

		expect(await withUserTransaction(outsider.client, (c) => captureOrder(c, orderRef))).toEqual({ ok: false, reason: "not_found" });
		expect(await withUserTransaction(outsider.operator, (c) => releaseOrder(c, orderRef))).toEqual({ ok: false, reason: "not_found" });
		expect(await withUserTransaction(outsider.operator, (c) => getSettlement(c, orderRef))).toBeNull();
	});

	it("returns invalid_state when closing an order closed the other way", async () => {
		const { client, operator } = await setup("Settle O12", { client: "100.00" });
		const released = randomUUID();
		const captured = randomUUID();
		for (const orderRef of [released, captured]) {
			await withUserTransaction(client, (c) =>
				reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote: quoteOf(2000, 1000) }),
			);
		}
		await withUserTransaction(operator, (c) => releaseOrder(c, released));
		await withUserTransaction(operator, (c) => captureOrder(c, captured));

		expect(await withUserTransaction(operator, (c) => captureOrder(c, released))).toEqual({ ok: false, reason: "invalid_state" });
		expect(await withUserTransaction(operator, (c) => releaseOrder(c, captured))).toEqual({ ok: false, reason: "invalid_state" });
	});

	it("returns not_found for an unknown order", async () => {
		const { operator } = await setup("Settle O13");
		expect(await withUserTransaction(operator, (c) => captureOrder(c, randomUUID()))).toEqual({ ok: false, reason: "not_found" });
	});
});

describe("counter settlement", () => {
	const counterInput = (orderRef: string, priceCents = 5000, costCents = 3000) => ({
		orderRef,
		mode: "counter" as const,
		clientProfileId: null,
		quote: quoteOf(priceCents, costCents),
	});

	it("reserves and captures the cost on the Bureau wallet with no accrual", async () => {
		const { tenant, operator } = await setup("Settle C1", { bureau: "100.00" });
		const orderRef = randomUUID();

		expect(await withUserTransaction(operator, (c) => reserveOrder(c, counterInput(orderRef)))).toEqual({ ok: true, status: "reserved" });
		expect(await bureauBalance(operator)).toEqual({ available: "70.00", reserved: "30.00" });

		expect(await withUserTransaction(operator, (c) => captureOrder(c, orderRef))).toEqual({ ok: true, status: "captured" });
		expect(await bureauBalance(operator)).toEqual({ available: "70.00", reserved: "0.00" });
		const { rows } = await owner.query("select 1 from bureau_payable_entries where bureau_id = $1", [tenant.bureau.id]);
		expect(rows).toHaveLength(0);
	});

	it("releases the cost back to the Bureau wallet", async () => {
		const { operator } = await setup("Settle C2", { bureau: "100.00" });
		const orderRef = randomUUID();
		await withUserTransaction(operator, (c) => reserveOrder(c, counterInput(orderRef)));

		expect(await withUserTransaction(operator, (c) => releaseOrder(c, orderRef))).toEqual({ ok: true, status: "released" });
		expect(await bureauBalance(operator)).toEqual({ available: "100.00", reserved: "0.00" });
	});

	it("returns insufficient_balance when the Bureau wallet lacks the cost", async () => {
		const { operator } = await setup("Settle C3", { bureau: "10.00" });
		const result = await withUserTransaction(operator, (c) => reserveOrder(c, counterInput(randomUUID())));
		expect(result).toEqual({ ok: false, reason: "insufficient_balance" });
	});

	it("refuses a counter reserve by a client", async () => {
		const { client } = await setup("Settle C4", { client: "100.00", bureau: "100.00" });
		expect(await withUserTransaction(client, (c) => reserveOrder(c, counterInput(randomUUID())))).toEqual({ ok: false, reason: "not_allowed" });
	});

	it("accepts a counter order with zero cost and leaves the Bureau wallet alone", async () => {
		const { operator } = await setup("Settle C5", { bureau: "100.00" });
		const orderRef = randomUUID();
		expect(await withUserTransaction(operator, (c) => reserveOrder(c, counterInput(orderRef, 5000, 0)))).toEqual({ ok: true, status: "reserved" });
		expect(await withUserTransaction(operator, (c) => captureOrder(c, orderRef))).toEqual({ ok: true, status: "captured" });
		expect(await bureauBalance(operator)).toEqual({ available: "100.00", reserved: "0.00" });
	});
});

describe("settlement audit", () => {
	it("writes one event per transition without sensitive data and not on replay", async () => {
		const { tenant, client, operator } = await setup("Settle A1", { client: "100.00" });
		const orderRef = randomUUID();
		const input = { orderRef, mode: "online" as const, clientProfileId: client.userId, quote: quoteOf(5000, 3000) };
		await withUserTransaction(client, (c) => reserveOrder(c, input));
		await withUserTransaction(client, (c) => reserveOrder(c, input));
		await withUserTransaction(operator, (c) => captureOrder(c, orderRef));
		await withUserTransaction(operator, (c) => captureOrder(c, orderRef));
		const id = (await withUserTransaction(client, (c) => getSettlement(c, orderRef)))?.id as string;

		const reserve = await auditRows(id, "settlement.reserve");
		const capture = await auditRows(id, "settlement.capture");
		expect(reserve).toHaveLength(1);
		expect(capture).toHaveLength(1);
		expect(reserve[0].user_id).toBe(client.userId);
		expect(capture[0].user_id).toBe(operator.userId);
		expect(capture[0].metadata).toMatchObject({ order_ref: orderRef, status: "captured", price: "50.00", cost: "30.00" });
		const raw = JSON.stringify([reserve, capture]);
		expect(raw).not.toContain(tenant.holder.document);
		expect(raw).not.toContain(tenant.holder.document.replace(/\D/g, ""));
	});

	it("writes settlement.release", async () => {
		const { client } = await setup("Settle A2", { client: "100.00" });
		const orderRef = randomUUID();
		await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote: quoteOf(5000, 3000) }),
		);
		await withUserTransaction(client, (c) => releaseOrder(c, orderRef));
		const id = (await withUserTransaction(client, (c) => getSettlement(c, orderRef)))?.id as string;
		expect(await auditRows(id, "settlement.release")).toHaveLength(1);
	});

	it("closes the order and audits settlement.release when a refund took the reservation back", async () => {
		const { client } = await setup("Settle A3", { client: "100.00" });
		const orderRef = randomUUID();
		await withUserTransaction(client, (c) =>
			reserveOrder(c, { orderRef, mode: "online", clientProfileId: client.userId, quote: quoteOf(5000, 3000) }),
		);
		await owner.query("select * from client_wallet_post_entry($1, 'reversal', 100, $2, null, null, $1)", [
			client.userId,
			randomUUID(),
		]);

		const result = await withUserTransaction(client, (c) => captureOrder(c, orderRef));

		expect(result).toEqual({ ok: false, reason: "reservation_clawed_back" });
		const settlement = await withUserTransaction(client, (c) => getSettlement(c, orderRef));
		expect(settlement?.status).toBe("released");
		expect(await auditRows(settlement?.id as string, "settlement.release")).toHaveLength(1);
		expect(await auditRows(settlement?.id as string, "settlement.capture")).toHaveLength(0);
	});
});
