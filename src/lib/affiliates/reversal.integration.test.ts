// Estorno e chargeback da comissão sobre a entrada (073-074) contra um Postgres real, sob RLS: o webhook reverte os
// repasses que o split do Asaas não cobre, o saldo do afiliado pode ficar negativo e nada duplica.
import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
		ASAAS_DRIVER: "fake",
		ASAAS_WEBHOOK_TOKEN: "c".repeat(32),
		DATABASE_WEBHOOK_URL:
			process.env.TEST_DATABASE_WEBHOOK_URL ?? "postgres://app_webhook:test@localhost:54329/credit_system_test",
		PII_ENCRYPTION_KEY: `k1:${Buffer.alloc(32, 7).toString("base64")}`,
	});
});

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { POST } from "@/app/api/webhooks/asaas/route";
import {
	ASAAS_EVENT_PAYMENT_CHARGEBACK_REQUESTED,
	ASAAS_EVENT_PAYMENT_REFUNDED,
	ASAAS_WEBHOOK_TOKEN_HEADER,
} from "@/lib/asaas/client";
import { buildFakePaymentEvent, resetFakeChargeSplits, resetFakeCustomers } from "@/lib/asaas/fake";
import { pool } from "@/lib/db/pool";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { createPaymentLink, resolvePaymentLink } from "@/lib/payment-links/queries";
import { getOrCreateLinkPixCharge } from "@/lib/payment-links/pix";
import { runCheckout } from "@/lib/payments/checkout";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedClientProfile,
	seedOrderDossier,
	seedSuperadmin,
	seedTenant,
	type SeedSuperadmin,
	type SeededTenant,
} from "@/test/seed";

import { convertCommission } from "./withdrawals";
import { reverseCashInCommission } from "./reversal";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const TOKEN = "c".repeat(32);
const CPF = "52998224725";
const WALLET = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

let SA: SeedSuperadmin;

beforeAll(async () => {
	SA = await seedSuperadmin(owner);
});

// A soma das camadas olha todos os bureaus do banco: tira a configuração que estes testes deixaram.
afterAll(async () => {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		const mine = "(select id from bureaus where name like 'Reversal %')";
		await client.query(`delete from bureau_commission_rates where bureau_id in ${mine}`);
		await client.query(`delete from bureau_affiliate_settings where bureau_id in ${mine}`);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
	await Promise.all([owner.end(), pool.end(), getWebhookPool().end()]);
});

beforeEach(() => {
	resetFakeChargeSplits();
	resetFakeCustomers();
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
	await owner.query("delete from platform_partners");
	await owner.query("update settings set value = '0'::jsonb where key = 'affiliate_cash_in_hold_days'");
});

const addPartner = (pct: number, wallet: string) =>
	owner.query("insert into platform_partners (name, asaas_wallet_id, pct) values ($1, $2, $3)", [`Sócio ${wallet.slice(-1)}`, wallet, pct]);

const setBureauPct = (t: SeededTenant, pct: number) =>
	owner.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, $2, $3)", [t.bureau.id, pct, SA.userId]);

async function verifyPhone(profileId: string) {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		await client.query("update profiles set phone_e164 = '+5563999990000', phone_verified_at = now() where id = $1", [profileId]);
		await client.query("commit");
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}

async function withAffiliate(t: SeededTenant, o: { pct?: number; asaasWallet?: string } = {}) {
	const affiliate = await seedClientProfile(owner, t.bureau.id);
	await owner.query("insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)", [
		t.client.userId,
		affiliate.userId,
		t.bureau.id,
	]);
	await verifyPhone(t.client.userId);
	await verifyPhone(affiliate.userId);
	await owner.query("insert into bureau_affiliate_settings (bureau_id, default_pct, affiliate_enabled) values ($1, $2, true)", [t.bureau.id, o.pct ?? 10]);
	if (o.asaasWallet) {
		await owner.query("update affiliate_wallets set payout_method = 'asaas', asaas_wallet_id = $2 where profile_id = $1", [affiliate.userId, o.asaasWallet]);
	}
	return affiliate;
}

function webhook(payload: unknown) {
	return POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers: new Headers({ "content-type": "application/json", [ASAAS_WEBHOOK_TOKEN_HEADER]: TOKEN }),
			body: JSON.stringify(payload),
		}),
	);
}

async function chargeEvent(chargeId: string, o: { event?: string; eventId?: string; split?: unknown[] } = {}) {
	const { rows } = await owner.query<{ asaas_payment_id: string; external_reference: string; amount: string }>(
		"select asaas_payment_id, external_reference, amount from pix_charges where id = $1",
		[chargeId],
	);
	const c = rows[0];
	const body = buildFakePaymentEvent({
		eventId: o.eventId ?? randomUUID(),
		asaasPaymentId: c.asaas_payment_id,
		externalReference: c.external_reference,
		value: Number(c.amount),
		...(o.event ? { event: o.event } : {}),
	});
	return webhook(o.split ? { ...body, payment: { ...body.payment, split: o.split } } : body);
}

const pay = (chargeId: string) => chargeEvent(chargeId);
const refund = (chargeId: string, o: { event?: string; eventId?: string; split?: unknown[] } = {}) =>
	chargeEvent(chargeId, { event: ASAAS_EVENT_PAYMENT_REFUNDED, ...o });

async function checkoutClientPix(t: SeededTenant, amount = "1000.00") {
	await owner.query("update holders set document = $2, zip_code = '01310100', address_number = '55' where id = $1", [t.holder.id, CPF]);
	const res = await runCheckout(
		t.client,
		{ kind: "client", clientProfileId: t.client.userId },
		{ amount, method: "PIX", payerKind: "owner", idempotencyKey: randomUUID() },
		{ remoteIp: "10.9.9.9", description: "Recarga" },
	);
	return (res as { id: string }).id;
}

const splitStatus = async (chargeId: string) =>
	(await owner.query<{ beneficiary_kind: string; status: string }>("select beneficiary_kind, status from charge_splits where pix_charge_id = $1 order by beneficiary_kind", [chargeId])).rows.map(
		(r) => [r.beneficiary_kind, r.status],
	);

const wallet = async (profileId: string) =>
	(await owner.query("select pending, available from affiliate_wallets where profile_id = $1", [profileId])).rows[0];

const count = async (sql: string, args: unknown[]) => Number((await owner.query(sql, args)).rows[0].n);

describe("estorno em modo Pix", () => {
	it("comissão liberada vira clawback; o saldo fica negativo, saque é recusado e a próxima comissão abate", async () => {
		const t = await seedTenant(owner, "Reversal Pix");
		await setBureauPct(t, 0);
		const affiliate = await withAffiliate(t, { pct: 10 });
		const first = await checkoutClientPix(t);
		await pay(first);
		expect(await wallet(affiliate.userId)).toMatchObject({ pending: "0.00", available: "100.00" });

		// O afiliado já gastou os R$ 100 (o dono do banco grava o saque; o livro é append-only).
		await owner.query("select * from affiliate_wallet_post_entry($1, 'withdrawal_hold', 100, 'test:spent', 'test', $1)", [affiliate.userId]);
		expect(await wallet(affiliate.userId)).toMatchObject({ available: "0.00" });

		expect((await refund(first)).status).toBe(200);

		expect(await wallet(affiliate.userId)).toMatchObject({ pending: "0.00", available: "-100.00" });
		const ledger = await owner.query("select kind, origin, amount, available_after from affiliate_ledger_entries where profile_id = $1 order by seq", [affiliate.userId]);
		expect(ledger.rows.at(-1)).toEqual({ kind: "commission_clawback", origin: "cash_in", amount: "100.00", available_after: "-100.00" });
		expect((await owner.query("select status, reversed_amount from affiliate_commissions where order_ref = $1", [first])).rows[0]).toEqual({ status: "reversed", reversed_amount: "100.00" });
		expect(await splitStatus(first)).toEqual([["affiliate", "refunded"]]);
		expect(await count("select count(*)::int as n from audit_logs where action = 'affiliate.commission_reversal' and metadata ->> 'pix_charge_id' = $1", [first])).toBe(1);

		// Saldo <= 0: saque e conversão recusados.
		const hold = await owner.query("select ok, reason from affiliate_wallet_post_entry($1, 'withdrawal_hold', 1, 'test:more', 'test', $1)", [affiliate.userId]);
		expect(hold.rows[0]).toEqual({ ok: false, reason: "insufficient_funds" });
		const converted = await convertCommission(affiliate, { amount: "1.00", requestId: randomUUID() });
		expect(converted.ok).toBe(false);

		// A próxima comissão (R$ 50) é abatida do negativo; nada cai em saldo disponível.
		const second = await checkoutClientPix(t, "500.00");
		await pay(second);
		expect(await wallet(affiliate.userId)).toMatchObject({ pending: "0.00", available: "-50.00" });
	});

	it("estorno repetido não duplica; reprocesso pelo TypeScript também não", async () => {
		const t = await seedTenant(owner, "Reversal Pix Dup");
		await setBureauPct(t, 0);
		const affiliate = await withAffiliate(t, { pct: 10 });
		const id = await checkoutClientPix(t);
		await pay(id);

		const eventId = randomUUID();
		await refund(id, { eventId });
		await refund(id, { eventId });
		await refund(id);
		expect(await reverseCashInCommission({ pixChargeId: id })).toBe(0);

		expect(await count("select count(*)::int as n from affiliate_ledger_entries where profile_id = $1 and kind = 'commission_clawback'", [affiliate.userId])).toBe(1);
		expect((await owner.query("select status from pix_charges where id = $1", [id])).rows[0].status).toBe("refunded");
		// O cliente não gastou o saldo: o estorno tira os R$ 1000 dele, a comissão é revertida por inteiro.
		expect(await wallet(affiliate.userId)).toMatchObject({ pending: "0.00", available: "0.00" });
	});

	it("comissão com carência: estorno antes da liberação tira do pendente e a liberação posterior ignora a comissão", async () => {
		const t = await seedTenant(owner, "Reversal Hold");
		await setBureauPct(t, 0);
		const affiliate = await withAffiliate(t, { pct: 10 });
		await owner.query("update settings set value = '3'::jsonb where key = 'affiliate_cash_in_hold_days'");
		const id = await checkoutClientPix(t);
		await pay(id);
		expect(await wallet(affiliate.userId)).toMatchObject({ pending: "100.00", available: "0.00" });

		await refund(id);

		expect(await wallet(affiliate.userId)).toMatchObject({ pending: "0.00", available: "0.00" });
		const ledger = await owner.query("select kind, origin from affiliate_ledger_entries where profile_id = $1 order by seq", [affiliate.userId]);
		expect(ledger.rows).toEqual([
			{ kind: "commission", origin: "cash_in" },
			{ kind: "commission_reversal", origin: "cash_in" },
		]);
		await owner.query("update affiliate_commissions set release_at = now() - interval '1 day' where order_ref = $1", [id]);
		expect((await pool.query("select release_due_commissions() as n")).rows[0].n).toBe(0);
	});
});

describe("liberação da comissão cash_in", () => {
	it("release_due_commissions grava o lançamento com origin cash_in", async () => {
		const t = await seedTenant(owner, "Reversal Release");
		await setBureauPct(t, 0);
		const affiliate = await withAffiliate(t, { pct: 10 });
		await owner.query("update settings set value = '3'::jsonb where key = 'affiliate_cash_in_hold_days'");
		const id = await checkoutClientPix(t);
		await pay(id);
		await owner.query("update affiliate_commissions set release_at = now() - interval '1 day' where order_ref = $1", [id]);

		expect((await pool.query("select release_due_commissions() as n")).rows[0].n).toBeGreaterThanOrEqual(1);

		const ledger = await owner.query("select kind, origin from affiliate_ledger_entries where profile_id = $1 order by seq", [affiliate.userId]);
		expect(ledger.rows).toEqual([
			{ kind: "commission", origin: "cash_in" },
			{ kind: "commission_release", origin: "cash_in" },
		]);
		expect(await wallet(affiliate.userId)).toMatchObject({ pending: "0.00", available: "100.00" });
		// Depois de liberada, o estorno vira clawback.
		await refund(id);
		expect(await wallet(affiliate.userId)).toMatchObject({ pending: "0.00", available: "0.00" });
	});
});

describe("estorno do accrual do bureau sem walletId", () => {
	it("estorno grava um reversal ligado ao accrual, uma vez; chargeback depois não duplica", async () => {
		const t = await seedTenant(owner, "Reversal Accrual");
		await setBureauPct(t, 20);
		const id = await checkoutClientPix(t);
		await pay(id);
		expect((await owner.query("select kind, amount from bureau_payable_entries where pix_charge_id = $1", [id])).rows).toEqual([{ kind: "accrual", amount: "200.00" }]);

		await refund(id);
		await chargeEvent(id, { event: ASAAS_EVENT_PAYMENT_CHARGEBACK_REQUESTED });

		const rows = await owner.query<{ kind: string; amount: string; linked: boolean }>(
			"select kind, amount, reverses_entry_id is not null as linked from bureau_payable_entries where pix_charge_id = $1 order by amount",
			[id],
		);
		expect(rows.rows).toEqual([
			{ kind: "reversal", amount: "-200.00", linked: true },
			{ kind: "accrual", amount: "200.00", linked: false },
		]);
		expect(await splitStatus(id)).toEqual([["bureau", "refunded"]]);
		expect(await count("select count(*)::int as n from audit_logs where action = 'payable.cash_in_reversal' and metadata ->> 'pix_charge_id' = $1", [id])).toBe(1);
		// O estorno do accrual entra no saldo lido pelo clawback: o líquido a repassar é zero, sem desconto em dobro.
		const net = await owner.query("select coalesce(sum(amount), 0) as s from bureau_payable_entries where bureau_id = $1", [t.bureau.id]);
		expect(net.rows[0].s).toBe("0.00");
	});

	it("chargeback chega primeiro: reverte e grava o evento na auditoria", async () => {
		const t = await seedTenant(owner, "Reversal Chargeback");
		await setBureauPct(t, 10);
		const id = await checkoutClientPix(t);
		await pay(id);

		await chargeEvent(id, { event: ASAAS_EVENT_PAYMENT_CHARGEBACK_REQUESTED });

		expect(await splitStatus(id)).toEqual([["bureau", "refunded"]]);
		const audit = await owner.query("select metadata ->> 'event' as event from audit_logs where action = 'charge_split.refunded' and metadata ->> 'pix_charge_id' = $1", [id]);
		expect(audit.rows).toEqual([{ event: ASAAS_EVENT_PAYMENT_CHARGEBACK_REQUESTED }]);
	});

	it("cobrança de link estornada reverte o accrual", async () => {
		const t = await seedTenant(owner, "Reversal Link");
		await setBureauPct(t, 20);
		const orderId = randomUUID();
		await seedOrderDossier(owner, { orderRef: orderId, bureauId: t.bureau.id, clientProfileId: null, members: 1 });
		await owner.query("insert into order_settlements (order_ref, bureau_id, mode, price, cost) values ($1, $2, 'counter', 300, 120)", [orderId, t.bureau.id]);
		await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [orderId]);
		const link = await createPaymentLink(t.bureauAdmin, orderId);
		if (!link.ok) throw new Error("expected link");
		const resolved = await resolvePaymentLink(link.token);
		if (!resolved.ok) throw new Error("expected resolved link");
		await getOrCreateLinkPixCharge(resolved.link.id);
		const id = (await owner.query<{ id: string }>("select id from pix_charges where payment_link_id = $1", [resolved.link.id])).rows[0].id;
		await pay(id);

		await refund(id);
		await refund(id);

		expect((await owner.query("select kind, amount from bureau_payable_entries where pix_charge_id = $1 order by amount", [id])).rows).toEqual([
			{ kind: "reversal", amount: "-60.00" },
			{ kind: "accrual", amount: "60.00" },
		]);
		expect(await splitStatus(id)).toEqual([["bureau", "refunded"]]);
	});
});

// Clawback antigo do valor a repassar (055/058): só vale para o que o Bureau recebeu na captura, isto é, pedido reservado
// antes da 072 (commission_on_cash_in falso). Pedido novo não gera accrual na captura: o Bureau só perde o que recebeu na
// entrada (o estorno ligado ao accrual).
describe("clawback do valor a repassar no estorno de cobrança de cliente", () => {
	// Cliente recarrega 1000 (Bureau a 20% recebe 200 de accrual) e gasta tudo em pedidos já capturados: carteira zerada.
	// O Bureau ainda tem 500 de outro accrual em aberto.
	async function spentClient(name: string, orders: { price: number; onCashIn: boolean }[]) {
		const t = await seedTenant(owner, name);
		await setBureauPct(t, 20);
		const id = await checkoutClientPix(t);
		await pay(id);
		const client = await owner.connect();
		try {
			await client.query("begin");
			await client.query("set local session_replication_role = replica");
			await client.query("update client_wallets set available = 0, reserved = 0 where client_profile_id = $1", [t.client.userId]);
			const refs: string[] = [];
			for (const o of orders) {
				const ref = randomUUID();
				refs.push(ref);
				await client.query(
					`insert into order_settlements (order_ref, bureau_id, mode, client_profile_id, price, cost, status, closed_at, commission_on_cash_in)
					 values ($1, $2, 'online', $3, $4, 0, 'captured', now(), $5)`,
					[ref, t.bureau.id, t.client.userId, o.price, o.onCashIn],
				);
			}
			await client.query("insert into bureau_payable_entries (bureau_id, kind, amount, order_ref) values ($1, 'accrual', 500, $2)", [t.bureau.id, refs[0]]);
			await client.query("commit");
		} catch (error) {
			await client.query("rollback");
			throw error;
		} finally {
			client.release();
		}
		return { t, id };
	}
	const entries = async (bureauId: string, chargeId: string) =>
		(await owner.query<{ kind: string; amount: string; linked: boolean }>(
			"select kind, amount, reverses_entry_id is not null as linked from bureau_payable_entries where bureau_id = $1 and pix_charge_id = $2 and kind = 'reversal' order by amount",
			[bureauId, chargeId],
		)).rows;
	const net = async (bureauId: string) =>
		(await owner.query("select sum(amount) as s from bureau_payable_entries where bureau_id = $1", [bureauId])).rows[0].s;

	it("pedido da entrada (commission_on_cash_in): o Bureau perde só o accrual da recarga, sem clawback", async () => {
		const { t, id } = await spentClient("Reversal Clawback Novo", [{ price: 1000, onCashIn: true }]);

		await refund(id);

		expect(await entries(t.bureau.id, id)).toEqual([{ kind: "reversal", amount: "-200.00", linked: true }]);
		expect(await net(t.bureau.id)).toBe("500.00");
		expect((await owner.query("select refund_shortfall from pix_charges where id = $1", [id])).rows[0].refund_shortfall).toBe("1000.00");
	});

	it("pedido reservado antes da 072: mantém o clawback antigo, até o valor a repassar", async () => {
		const { t, id } = await spentClient("Reversal Clawback Antigo", [{ price: 1000, onCashIn: false }]);

		await refund(id);

		expect(await entries(t.bureau.id, id)).toEqual([
			{ kind: "reversal", amount: "-500.00", linked: false },
			{ kind: "reversal", amount: "-200.00", linked: true },
		]);
		expect(await net(t.bureau.id)).toBe("0.00");
	});

	it("cliente com pedido antigo e novo: o clawback não passa do que foi gasto em pedido antigo", async () => {
		const { t, id } = await spentClient("Reversal Clawback Misto", [
			{ price: 300, onCashIn: false },
			{ price: 700, onCashIn: true },
		]);

		await refund(id);

		expect(await entries(t.bureau.id, id)).toEqual([
			{ kind: "reversal", amount: "-300.00", linked: false },
			{ kind: "reversal", amount: "-200.00", linked: true },
		]);
		expect(await net(t.bureau.id)).toBe("200.00");
	});
});

describe("estorno em modo asaas", () => {
	it("só atualiza o status: REFUNDED vira refunded; DONE no evento de estorno vira reversal_failed com auditoria", async () => {
		const t = await seedTenant(owner, "Reversal Asaas");
		await setBureauPct(t, 0);
		await addPartner(10, WALLET(1));
		await withAffiliate(t, { pct: 5, asaasWallet: WALLET(3) });
		const id = await checkoutClientPix(t);
		await pay(id);
		expect(await splitStatus(id)).toEqual([["affiliate", "pending"], ["partner", "pending"]]);

		await refund(id, {
			split: [
				{ id: "split_p", walletId: WALLET(1), status: "REFUNDED" },
				{ id: "split_a", walletId: WALLET(3), status: "DONE" },
			],
		});

		expect(await splitStatus(id)).toEqual([["affiliate", "reversal_failed"], ["partner", "refunded"]]);
		const failed = await owner.query("select metadata ->> 'wallet' as wallet, metadata ->> 'event' as event from audit_logs where action = 'charge_split.reversal_failed' and metadata ->> 'pix_charge_id' = $1", [id]);
		expect(failed.rows).toEqual([{ wallet: "***0003", event: ASAAS_EVENT_PAYMENT_REFUNDED }]);
		// Nenhum lançamento local: o Asaas é quem reverte.
		expect(await count("select count(*)::int as n from affiliate_ledger_entries where bureau_id = $1", [t.bureau.id])).toBe(0);
	});

	it("estorno sem payment.split não muda o status das linhas do Asaas", async () => {
		const t = await seedTenant(owner, "Reversal Asaas Bare");
		await setBureauPct(t, 0);
		await addPartner(10, WALLET(1));
		const id = await checkoutClientPix(t);
		await pay(id);

		await refund(id);

		expect(await splitStatus(id)).toEqual([["partner", "pending"]]);
	});
});

// Correções 078: o Asaas reverte o split de forma assíncrona; a cobrança estornada nunca vira 'refused'; parcelas e
// cobrança ainda sem o id do pagamento não perdem o evento de split.
describe("status do split no estorno (078)", () => {
	const item = (status: string, id = "split_x") => [{ id, walletId: WALLET(1), status }];
	const splitEvent = (chargeId: string, event: string, status: string) => chargeEvent(chargeId, { event, split: item(status) });
	const actions = async (chargeId: string) =>
		(await owner.query<{ action: string }>("select action from audit_logs where table_name = 'charge_splits' and metadata ->> 'pix_charge_id' = $1 order by created_at", [chargeId])).rows.map((r) => r.action);

	async function paidPartnerCharge(name: string) {
		const t = await seedTenant(owner, name);
		await setBureauPct(t, 0);
		await addPartner(10, WALLET(1));
		const id = await checkoutClientPix(t);
		await pay(id);
		return { t, id };
	}

	it.each(["REFUNDED", "CANCELLED"])("reversal_failed vira refunded quando um evento posterior traz %s", async (later) => {
		const { id } = await paidPartnerCharge("Reversal Async");
		await splitEvent(id, "PAYMENT_SPLIT_DONE", "DONE");
		await splitEvent(id, ASAAS_EVENT_PAYMENT_REFUNDED, "DONE");
		expect(await splitStatus(id)).toEqual([["partner", "reversal_failed"]]);

		await splitEvent(id, "PAYMENT_SPLIT_CANCELLED", later);

		expect(await splitStatus(id)).toEqual([["partner", "refunded"]]);
		expect(await actions(id)).toEqual(["charge_split.done", "charge_split.reversal_failed", "charge_split.refunded"]);
	});

	it("pedido de chargeback com item DONE não declara falha; o REFUNDED posterior estorna", async () => {
		const { id } = await paidPartnerCharge("Reversal CB Async");

		await splitEvent(id, ASAAS_EVENT_PAYMENT_CHARGEBACK_REQUESTED, "DONE");
		expect(await splitStatus(id)).toEqual([["partner", "done"]]);

		await splitEvent(id, ASAAS_EVENT_PAYMENT_REFUNDED, "REFUNDED");
		expect(await splitStatus(id)).toEqual([["partner", "refunded"]]);
		expect(await actions(id)).not.toContain("charge_split.reversal_failed");
	});

	it.each(["CANCELLED", "REFUSED"])("item %s no próprio evento de estorno vira refunded", async (status) => {
		const { id } = await paidPartnerCharge("Reversal Cancel Event");

		await splitEvent(id, ASAAS_EVENT_PAYMENT_REFUNDED, status);

		expect(await splitStatus(id)).toEqual([["partner", "refunded"]]);
		expect(await actions(id)).toEqual(["charge_split.refunded"]);
	});

	it("CANCELLED depois do estorno vira refunded", async () => {
		const { id } = await paidPartnerCharge("Reversal Cancel After");
		await refund(id, { split: item("PENDING") });

		await splitEvent(id, "PAYMENT_SPLIT_CANCELLED", "CANCELLED");

		expect(await splitStatus(id)).toEqual([["partner", "refunded"]]);
	});

	it("CANCELLED antes do estorno: a linha recusada vira refunded quando a cobrança é estornada", async () => {
		const { id } = await paidPartnerCharge("Reversal Cancel Before");
		await splitEvent(id, "PAYMENT_SPLIT_CANCELLED", "CANCELLED");
		expect(await splitStatus(id)).toEqual([["partner", "refused"]]);

		await refund(id);

		expect(await splitStatus(id)).toEqual([["partner", "refunded"]]);
		expect(await actions(id)).toEqual(["charge_split.refused", "charge_split.refunded"]);
	});

	it("Pix de link estornado (status segue paid): CANCELLED posterior vira refunded", async () => {
		const t = await seedTenant(owner, "Reversal Link Cancel");
		await setBureauPct(t, 0);
		await addPartner(10, WALLET(1));
		const orderId = randomUUID();
		await seedOrderDossier(owner, { orderRef: orderId, bureauId: t.bureau.id, clientProfileId: null, members: 1 });
		await owner.query("insert into order_settlements (order_ref, bureau_id, mode, price, cost) values ($1, $2, 'counter', 300, 120)", [orderId, t.bureau.id]);
		await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [orderId]);
		const link = await createPaymentLink(t.bureauAdmin, orderId);
		if (!link.ok) throw new Error("expected link");
		const resolved = await resolvePaymentLink(link.token);
		if (!resolved.ok) throw new Error("expected resolved link");
		await getOrCreateLinkPixCharge(resolved.link.id);
		const id = (await owner.query<{ id: string }>("select id from pix_charges where payment_link_id = $1", [resolved.link.id])).rows[0].id;
		await pay(id);
		await refund(id);

		await splitEvent(id, "PAYMENT_SPLIT_CANCELLED", "CANCELLED");

		expect(await splitStatus(id)).toEqual([["partner", "refunded"]]);
	});

	it("parcela 2 do cartão atualiza a linha pelo asaas_installment_id, no split e no estorno", async () => {
		const t = await seedTenant(owner, "Reversal Installments");
		await setBureauPct(t, 0);
		await addPartner(10, WALLET(1));
		const id = await checkoutClientPix(t, "900.00");
		const installment = `ins_${randomUUID()}`;
		await owner.query("update pix_charges set billing_type = 'CREDIT_CARD', installments = 3, asaas_installment_id = $2, total_charged = null, pix_payload = null where id = $1", [id, installment]);
		const { rows } = await owner.query("select asaas_payment_id from pix_charges where id = $1", [id]);
		const send = (paymentId: string, event: string, split: unknown[]) => {
			const body = buildFakePaymentEvent({ eventId: randomUUID(), asaasPaymentId: paymentId, value: 300, event, installment });
			return webhook({ ...body, payment: { ...body.payment, split } });
		};
		await send(rows[0].asaas_payment_id, "PAYMENT_CONFIRMED", []);
		await send(rows[0].asaas_payment_id, "PAYMENT_SPLIT_DONE", item("PENDING", "spl_1"));
		const second = `pay_${randomUUID()}`;

		await send(second, "PAYMENT_SPLIT_DONE", item("DONE", "spl_2"));
		expect(await splitStatus(id)).toEqual([["partner", "done"]]);

		await send(second, ASAAS_EVENT_PAYMENT_REFUNDED, item("DONE", "spl_2"));
		expect(await splitStatus(id)).toEqual([["partner", "reversal_failed"]]);

		await send(second, "PAYMENT_SPLIT_CANCELLED", item("REFUNDED", "spl_2"));
		expect(await splitStatus(id)).toEqual([["partner", "refunded"]]);
		// O id gravado é o da primeira parcela.
		expect((await owner.query("select asaas_split_id from charge_splits where pix_charge_id = $1", [id])).rows[0].asaas_split_id).toBe("spl_1");
	});

	it("evento de split antes de gravar o id do pagamento pede reenvio; cobrança de fora do sistema responde 200", async () => {
		const t = await seedTenant(owner, "Reversal Unbound");
		await setBureauPct(t, 0);
		await addPartner(10, WALLET(1));
		const id = await checkoutClientPix(t);
		const { rows } = await owner.query<{ asaas_payment_id: string; external_reference: string }>("select asaas_payment_id, external_reference from pix_charges where id = $1", [id]);
		const { asaas_payment_id: paymentId, external_reference: reference } = rows[0];
		const send = (externalReference?: string, asaasPaymentId = paymentId) => {
			const body = buildFakePaymentEvent({ eventId: randomUUID(), asaasPaymentId, value: 1000, event: "PAYMENT_SPLIT_DONE", externalReference });
			return webhook({ ...body, payment: { ...body.payment, split: item("DONE") } });
		};
		// Bind ainda não gravado.
		await owner.query("update pix_charges set asaas_payment_id = null, pix_payload = null where id = $1", [id]);

		expect((await send(reference)).status).toBe(500);
		expect((await send(randomUUID())).status).toBe(200);
		expect((await send("pedido-de-outro-sistema")).status).toBe(200);
		expect((await send()).status).toBe(200);

		// Gravado o id, o reenvio aplica. Outro pagamento com a mesma referência não pede reenvio (Pix não troca de id).
		await owner.query("update pix_charges set asaas_payment_id = $2 where id = $1", [id, paymentId]);
		expect((await send(reference)).status).toBe(200);
		expect(await splitStatus(id)).toEqual([["partner", "done"]]);
		expect((await send(reference, `pay_${randomUUID()}`)).status).toBe(200);
	});
});
