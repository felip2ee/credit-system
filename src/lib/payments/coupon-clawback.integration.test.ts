// Migração 050: o clawback do estorno de Pix conta coupon_cost e coupon_refund no saldo a repassar do Bureau.
// Postgres real, sob RLS. Preço de tabela 100, custo 60.
import { randomBytes, randomUUID } from "node:crypto";

import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { TEST_DATABASE_OWNER_URL, TEST_DATABASE_URL, TEST_DATABASE_WEBHOOK_URL } from "@/test/db-env";
import {
	seedClientWalletTopup,
	seedLegacyOnlineOrder,
	seedPayableEntry,
	seedPixCharge,
	seedTenant,
	type SeededTenant,
} from "@/test/seed";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const app = new Pool({ connectionString: TEST_DATABASE_URL, max: 4 });
const hook = new Pool({ connectionString: TEST_DATABASE_WEBHOOK_URL, max: 2 });

afterAll(async () => {
	await Promise.all([owner.end(), app.end(), hook.end()]);
});

type Ctx = { userId: string; role: string; bureauId: string };
const adminCtx = (t: SeededTenant): Ctx => ({ userId: t.bureauAdmin.userId, role: "bureau_admin", bureauId: t.bureau.id });

async function committed<T>(ctx: Ctx, work: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await app.connect();
	try {
		await client.query("begin");
		await client.query(
			`select set_config('app.user_id', $1, true), set_config('app.user_role', $2, true),
			        set_config('app.bureau_id', $3, true), set_config('app.support_session_id', '', true)`,
			[ctx.userId, ctx.role, ctx.bureauId],
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

// Cupom fixo de `couponValue` num pedido online de preço de tabela 100 e Bureau a 40% (custo 60), reservado antes da 072: o
// Bureau cobriu a falta (custo - preço pago) pelo valor a repassar (coupon_cost). Pedido novo não cria coupon_cost; o
// estorno ainda precisa tratar os que já existem. Captura o pedido.
async function placeAndCapture(t: SeededTenant, couponValue: string, paid: string) {
	const code = `C${randomBytes(4).toString("hex").toUpperCase()}`;
	const { rows } = await owner.query<{ id: string }>(
		`insert into coupons (bureau_id, code, kind, value, all_products, valid_from, active, created_by)
		 values ($1, $2, 'fixed', $3, true, now() - interval '1 hour', true, $4) returning id`,
		[t.bureau.id, code, couponValue, t.bureauAdmin.userId],
	);
	const orderRef = await seedLegacyOnlineOrder(owner, {
		bureauId: t.bureau.id,
		clientProfileId: t.client.userId,
		price: paid,
		commissionPct: "40",
		coupon: { couponId: rows[0].id, discount: couponValue, fundedPayable: Math.max(60 - Number(paid), 0).toFixed(2) },
	});
	const captured = await committed(adminCtx(t), (c) =>
		c.query<SettleRow>("select * from capture_order($1)", [orderRef]).then((r) => r.rows[0]),
	);
	expect(captured).toMatchObject({ ok: true, status: "captured" });
}

const refund = (asaasPaymentId: string) =>
	hook
		.query<{ apply_asaas_payment: string }>("select apply_asaas_payment($1, 'PAYMENT_REFUNDED', $2, '{}'::jsonb)", [
			`evt-${randomBytes(6).toString("hex")}`,
			asaasPaymentId,
		])
		.then((r) => r.rows[0].apply_asaas_payment);

const payableTotal = async (bureauId: string) =>
	(await owner.query<{ total: string }>(
		"select coalesce(sum(amount), 0)::text as total from bureau_payable_entries where bureau_id = $1",
		[bureauId],
	)).rows[0].total;
const payableKinds = async (bureauId: string) =>
	(await owner.query<{ kind: string; amount: string }>(
		"select kind, amount from bureau_payable_entries where bureau_id = $1 order by created_at, id",
		[bureauId],
	)).rows;
const chargeRow = async (id: string) =>
	(await owner.query<{ status: string; refund_shortfall: string }>(
		"select status, refund_shortfall from pix_charges where id = $1",
		[id],
	)).rows[0];

// Acréscimo antigo (já liberado) de 100 no repasse do Bureau.
const seedReleased = (t: SeededTenant) =>
	seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "accrual", amount: "100.00", createdAt: "2020-01-01T00:00:00Z" });

describe("estorno de Pix depois de um pedido com cupom parcial", () => {
	it("claws back only the real balance (after coupon_cost) and creates no debt", async () => {
		const t = await seedTenant(owner, "clawback cupom");
		await seedReleased(t);
		// Saldo do cliente 30, mas a cobrança paga é de 100: o estorno cai todo na falta.
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "30.00", createdBy: t.client.userId });
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id, requestedBy: t.client.userId, clientProfileId: t.client.userId, amount: "100.00", status: "paid",
		});
		// Cupom de 70: o cliente paga 30, o custo é 60, a falta de 30 sai do repasse (coupon_cost -30). Saldo real: 70.
		await placeAndCapture(t, "70.00", "30.00");
		expect(await payableTotal(t.bureau.id)).toBe("70.00");

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		// Antes da 050 o clawback era 100 (só accrual) e o saldo ficava em -30.
		expect(await payableTotal(t.bureau.id)).toBe("0.00");
		expect(await payableKinds(t.bureau.id)).toEqual([
			{ kind: "accrual", amount: "100.00" },
			{ kind: "coupon_cost", amount: "-30.00" },
			{ kind: "reversal", amount: "-70.00" },
		]);
		expect(await chargeRow(charge.id)).toEqual({ status: "refunded", refund_shortfall: "30.00" });
	});

	it("counts coupon_refund as balance: a returned coupon cost can be clawed back", async () => {
		const t = await seedTenant(owner, "clawback refund cupom");
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "10.00", createdBy: t.client.userId });
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id, requestedBy: t.client.userId, clientProfileId: t.client.userId, amount: "100.00", status: "paid",
		});
		// Só o repasse devolvido pelo cupom (coupon_refund +40) forma o saldo; sem ele o clawback seria 0.
		const orderRef = randomUUID();
		await owner.query(
			`insert into order_settlements (order_ref, bureau_id, mode, price, cost, status, closed_at)
			 values ($1, $2, 'counter', 1, 0, 'released', now())`,
			[orderRef, t.bureau.id],
		);
		await owner.query(
			`insert into bureau_payable_entries (bureau_id, kind, amount, order_ref, created_at)
			 values ($1, 'coupon_refund', 40.00, $2, '2020-01-01T00:00:00Z')`,
			[t.bureau.id, orderRef],
		);

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		expect(await payableTotal(t.bureau.id)).toBe("0.00");
		expect(await chargeRow(charge.id)).toEqual({ status: "refunded", refund_shortfall: "50.00" });
	});

	it("without coupon entries the clawback is the same as before", async () => {
		const t = await seedTenant(owner, "clawback sem cupom");
		await seedReleased(t);
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "30.00", createdBy: t.client.userId });
		const charge = await seedPixCharge(owner, {
			bureauId: t.bureau.id, requestedBy: t.client.userId, clientProfileId: t.client.userId, amount: "100.00", status: "paid",
		});

		expect(await refund(charge.asaasPaymentId)).toBe("refunded");

		// Carteira devolve 30; os 70 da falta saem do saldo de 100.
		expect(await payableKinds(t.bureau.id)).toEqual([
			{ kind: "accrual", amount: "100.00" },
			{ kind: "reversal", amount: "-70.00" },
		]);
		expect(await chargeRow(charge.id)).toEqual({ status: "refunded", refund_shortfall: "0.00" });
	});
});
