// Split na entrada (073-075) contra um Postgres real, sob RLS, com o driver Asaas fake: o plano nasce com a cobrança, o
// webhook de pagamento lança o que o split do Asaas não cobre, e nada duplica.
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
import { ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";
import { buildFakePaymentEvent, getFakeChargeSplit, resetFakeChargeSplits, resetFakeCustomers } from "@/lib/asaas/fake";
import { SplitOver100Error } from "@/lib/commission/queries";
import { buildSplitPlan } from "@/lib/commission/split-plan";
import { pool } from "@/lib/db/pool";
import { withUserTransaction } from "@/lib/db/transaction";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import { createPaymentLink, resolvePaymentLink } from "@/lib/payment-links/queries";
import { getOrCreateLinkPixCharge } from "@/lib/payment-links/pix";
import { runCheckout } from "@/lib/payments/checkout";
import { reserveCharge } from "@/lib/wallet/pix-charges";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import {
	seedClientProfile,
	seedClientWalletTopup,
	seedOrderDossier,
	seedSuperadmin,
	seedTenant,
	seedWalletTopup,
	type SeedSuperadmin,
	type SeededTenant,
} from "@/test/seed";

import { recordCashInCommission } from "./cash-in";
import { getMyAffiliateSummary } from "./queries";
import { setBureauDefaultPct } from "./rates";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const TOKEN = "c".repeat(32);
const CPF = "52998224725";
const WALLET = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

let SA: SeedSuperadmin;

beforeAll(async () => {
	SA = await seedSuperadmin(owner);
});

// A soma das camadas (assertSplitWithin100) olha todos os bureaus do banco: tira a configuração que estes testes deixaram
// (percentual do bureau, indicação, afiliados) para não atrapalhar os testes de sócios. Gatilhos append-only ficam de fora.
afterAll(async () => {
	const client = await owner.connect();
	try {
		await client.query("begin");
		await client.query("set local session_replication_role = replica");
		const mine = "(select id from bureaus where name like 'Split %' or name like 'Cash In%' or name like 'Link Split%')";
		await client.query(`delete from bureau_commission_rates where bureau_id in ${mine}`);
		await client.query(`delete from bureau_referrals where referred_bureau_id in ${mine} or referrer_bureau_id in ${mine}`);
		await client.query(`delete from bureau_affiliate_settings where bureau_id in ${mine}`);
		await client.query(`delete from affiliate_rates where bureau_id in ${mine}`);
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
	if (!process.env.T3_DEBUG) vi.spyOn(console, "error").mockImplementation(() => {});
});

// Sócios são globais: cada teste os apaga para não vazar para as cobranças dos outros.
afterEach(async () => {
	await owner.query("delete from platform_partners");
	await owner.query("update settings set value = '0'::jsonb where key = 'affiliate_cash_in_hold_days'");
});

const addPartner = (pct: number, wallet: string) =>
	owner.query("insert into platform_partners (name, asaas_wallet_id, pct) values ($1, $2, $3)", [`Sócio ${wallet.slice(-1)}`, wallet, pct]);

const setBureauPct = (t: SeededTenant, pct: number) =>
	owner.query("insert into bureau_commission_rates (bureau_id, pct, set_by) values ($1, $2, $3)", [t.bureau.id, pct, SA.userId]);

const setBureauWallet = (t: SeededTenant, wallet: string) =>
	owner.query(
		"insert into bureau_asaas_wallets (bureau_id, asaas_wallet_id) values ($1, $2) on conflict (bureau_id) do update set asaas_wallet_id = excluded.asaas_wallet_id",
		[t.bureau.id, wallet],
	);

// Dono (superusuário) escreve o telefone: o trigger protect_profile_contact só libera as funções da conta.
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

// Cliente do tenant indicado por um afiliado do mesmo bureau.
async function withAffiliate(t: SeededTenant, o: { pct?: number; enabled?: boolean; asaasWallet?: string } = {}) {
	const affiliate = await seedClientProfile(owner, t.bureau.id);
	await owner.query("insert into affiliate_referrals (referred_profile_id, affiliate_profile_id, bureau_id) values ($1, $2, $3)", [
		t.client.userId,
		affiliate.userId,
		t.bureau.id,
	]);
	await verifyPhone(t.client.userId);
	await owner.query("insert into bureau_affiliate_settings (bureau_id, default_pct, affiliate_enabled) values ($1, $2, $3)", [
		t.bureau.id,
		o.pct ?? 10,
		o.enabled ?? true,
	]);
	if (o.asaasWallet) {
		await owner.query("update affiliate_wallets set payout_method = 'asaas', asaas_wallet_id = $2 where profile_id = $1", [affiliate.userId, o.asaasWallet]);
	}
	return affiliate;
}

async function reservePlan(t: SeededTenant, scope: "bureau" | "client", amount = "1000.00") {
	const identity = scope === "client" ? t.client : t.bureauAdmin;
	return withUserTransaction(identity, async (c) => {
		const r = await reserveCharge(c, identity, {
			scope: scope === "client" ? { kind: "client", clientProfileId: t.client.userId } : { kind: "bureau", bureauId: t.bureau.id },
			externalReference: randomUUID(),
			amount,
			billingType: "PIX",
			installments: 1,
			feeAmount: "0.00",
			totalCharged: null,
			payerKind: "owner",
			payerDocumentMasked: "***.982.***-**",
		});
		if (!r.ok) throw new Error(r.reason);
		return { id: r.id, plan: await buildSplitPlan(c, r.id) };
	});
}

const splitRows = async (chargeId: string) =>
	(
		await owner.query<{ beneficiary_kind: string; payout_method: string; pct: string; amount_cents: string; status: string }>(
			"select beneficiary_kind, payout_method, pct, amount_cents::text, status from charge_splits where pix_charge_id = $1 order by beneficiary_kind",
			[chargeId],
		)
	).rows;

function webhook(payload: unknown) {
	return POST(
		new Request("http://localhost/api/webhooks/asaas", {
			method: "POST",
			headers: new Headers({ "content-type": "application/json", [ASAAS_WEBHOOK_TOKEN_HEADER]: TOKEN }),
			body: JSON.stringify(payload),
		}),
	);
}

async function pay(chargeId: string, eventId = randomUUID()) {
	const { rows } = await owner.query<{ asaas_payment_id: string; external_reference: string; amount: string }>(
		"select asaas_payment_id, external_reference, amount from pix_charges where id = $1",
		[chargeId],
	);
	const c = rows[0];
	return webhook(
		buildFakePaymentEvent({ eventId, asaasPaymentId: c.asaas_payment_id, externalReference: c.external_reference, value: Number(c.amount) }),
	);
}

async function checkoutPix(t: SeededTenant, scope: "bureau" | "client", amount = "1000.00") {
	if (scope === "client") {
		await owner.query("update holders set document = $2, zip_code = '01310100', address_number = '55' where id = $1", [t.holder.id, CPF]);
	}
	const key = randomUUID();
	const res = await runCheckout(
		scope === "client" ? t.client : t.bureauAdmin,
		scope === "client" ? { kind: "client", clientProfileId: t.client.userId } : { kind: "bureau", bureauId: t.bureau.id },
		{
			amount,
			method: "PIX",
			payerKind: "owner",
			idempotencyKey: key,
			...(scope === "bureau" ? { payer: { name: "Bureau Ltda", document: CPF } } : {}),
		},
		{ remoteIp: "10.9.9.9", description: "Recarga" },
	);
	return { res, key, asaasPaymentId: `pay_fake_${key}` };
}

describe("plano de split da cobrança", () => {
	it("recarga do próprio bureau: só sócios, mesmo com percentual e walletId do bureau (C1)", async () => {
		const t = await seedTenant(owner, "Split Topup");
		await addPartner(10, WALLET(1));
		await setBureauPct(t, 20);
		await setBureauWallet(t, WALLET(2));

		const { id, plan } = await reservePlan(t, "bureau");

		expect(plan.asaasSplit).toEqual([{ walletId: WALLET(1), percentualValue: 10 }]);
		expect(plan.pixLines).toEqual([]);
		expect(plan.accrualLines).toEqual([]);
		expect(await splitRows(id)).toEqual([{ beneficiary_kind: "partner", payout_method: "asaas", pct: "10.00", amount_cents: "10000", status: "pending" }]);
	});

	it("cliente: sócios, bureau com walletId e afiliado em modo asaas vão ao split; centavos somam no máximo o líquido", async () => {
		const t = await seedTenant(owner, "Split Full");
		await addPartner(10.5, WALLET(1));
		await setBureauPct(t, 20);
		await setBureauWallet(t, WALLET(2));
		await withAffiliate(t, { pct: 7, asaasWallet: WALLET(3) });

		const { plan } = await reservePlan(t, "client", "333.33");

		expect(plan.asaasSplit).toEqual([
			{ walletId: WALLET(3), percentualValue: 7 },
			{ walletId: WALLET(2), percentualValue: 20 },
			{ walletId: WALLET(1), percentualValue: 10.5 },
		]);
		expect([...plan.pixLines, ...plan.accrualLines]).toEqual([]);
		// 33333 centavos: floor por linha, a sobra fica com a plataforma.
		const rows = await owner.query<{ amount_cents: string }>("select amount_cents from charge_splits where pix_charge_id = (select id from pix_charges where bureau_id = $1)", [t.bureau.id]);
		const sum = rows.rows.reduce((s, r) => s + Number(r.amount_cents), 0);
		expect(sum).toBeLessThanOrEqual(33333);
		expect(sum).toBe(Math.floor((33333 * 10.5) / 100) + Math.floor((33333 * 20) / 100) + Math.floor((33333 * 7) / 100));
	});

	it("bureau indicador sem walletId vira accrual e com walletId vai ao split; indicação inativa é ignorada", async () => {
		const t = await seedTenant(owner, "Split Ref");
		const referrer = await seedTenant(owner, "Split Referrer");
		await owner.query("insert into bureau_referrals (referrer_bureau_id, referred_bureau_id, pct) values ($1, $2, 5)", [referrer.bureau.id, t.bureau.id]);

		const accrual = (await reservePlan(t, "client")).plan;
		expect(accrual.accrualLines).toMatchObject([{ kind: "bureau_referrer", beneficiaryId: referrer.bureau.id, pct: 5, amountCents: 5000 }]);
		expect(accrual.asaasSplit).toEqual([]);

		await setBureauWallet(referrer, WALLET(4));
		const asaas = (await reservePlan(t, "client")).plan;
		expect(asaas.asaasSplit).toEqual([{ walletId: WALLET(4), percentualValue: 5 }]);

		await owner.query("update bureau_referrals set active = false where referred_bureau_id = $1", [t.bureau.id]);
		expect((await reservePlan(t, "client")).plan).toEqual({ asaasSplit: [], asaasSplitWithoutAffiliate: [], pixLines: [], accrualLines: [] });
	});

	it("afiliado com o recurso desligado é ignorado; modo pix vira linha de confirmação", async () => {
		const off = await seedTenant(owner, "Split Aff Off");
		await withAffiliate(off, { enabled: false });
		expect((await reservePlan(off, "client")).plan).toEqual({ asaasSplit: [], asaasSplitWithoutAffiliate: [], pixLines: [], accrualLines: [] });

		const on = await seedTenant(owner, "Split Aff On");
		const affiliate = await withAffiliate(on, { pct: 10 });
		const { plan } = await reservePlan(on, "client");
		expect(plan.pixLines).toMatchObject([{ kind: "affiliate", beneficiaryId: affiliate.userId, payoutMethod: "pix", pct: 10, amountCents: 10000 }]);
		expect(plan.asaasSplit).toEqual([]);
	});

	it("bureau sem walletId gera accrual; bureau sem percentual gera zero", async () => {
		const t = await seedTenant(owner, "Split Bureau");
		expect((await reservePlan(t, "client")).plan).toEqual({ asaasSplit: [], asaasSplitWithoutAffiliate: [], pixLines: [], accrualLines: [] });

		await setBureauPct(t, 15);
		expect((await reservePlan(t, "client")).plan.accrualLines).toMatchObject([{ kind: "bureau", beneficiaryId: t.bureau.id, pct: 15, amountCents: 15000 }]);
	});

	it("soma acima de 100%: lança SplitOver100Error e a linha da cobrança também desfaz", async () => {
		const t = await seedTenant(owner, "Split Over");
		await addPartner(60, WALLET(1));
		await addPartner(30, WALLET(2));
		await setBureauPct(t, 20);

		await expect(reservePlan(t, "client")).rejects.toBeInstanceOf(SplitOver100Error);
		expect(Number((await owner.query("select count(*)::int as n from pix_charges where bureau_id = $1", [t.bureau.id])).rows[0].n)).toBe(0);
		expect(Number((await owner.query("select count(*)::int as n from charge_splits where bureau_id = $1", [t.bureau.id])).rows[0].n)).toBe(0);
	});

	it("o teto aceita uma configuração só se todo plano fica em 100%, e o plano não passa do que o teto somou (affiliate_rates legado ignorado)", async () => {
		const t = await seedTenant(owner, "Split Guard");
		await addPartner(10, WALLET(1));
		await setBureauPct(t, 30);
		await withAffiliate(t, { pct: 10 });
		// Linha antiga de affiliate_rates (só leitura desde a 055): o plano não a enxerga, o teto também não.
		await owner.query("insert into affiliate_rates (bureau_id, affiliate_profile_id, pct) values ($1, (select affiliate_profile_id from affiliate_referrals where referred_profile_id = $2), 90)", [
			t.bureau.id,
			t.client.userId,
		]);

		// 10 (sócio) + 30 (bureau) + 60 (afiliados) = 100: aceita, e o plano da cobrança soma exatamente 100.
		expect(await setBureauDefaultPct(SA, t.bureau.id, "60")).toEqual({ ok: true });
		const { id, plan } = await reservePlan(t, "client");
		expect(plan.pixLines).toMatchObject([{ kind: "affiliate", pct: 60 }]);
		const sum = (await owner.query<{ s: string }>("select sum(pct) as s from charge_splits where pix_charge_id = $1", [id])).rows[0].s;
		expect(Number(sum)).toBe(100);

		// 61 passa de 100: o teto recusa e nenhum plano com essa % chega a existir.
		expect(await setBureauDefaultPct(SA, t.bureau.id, "61")).toEqual({ ok: false, reason: "split_over_100" });
		expect((await owner.query("select default_pct from bureau_affiliate_settings where bureau_id = $1", [t.bureau.id])).rows[0].default_pct).toBe("60.00");
	});

	it("chamar de novo devolve o mesmo plano sem duplicar, e mudar walletId depois não altera a cobrança", async () => {
		const t = await seedTenant(owner, "Split Frozen");
		await setBureauPct(t, 20);
		await setBureauWallet(t, WALLET(2));
		const identity = t.client;
		const first = await withUserTransaction(identity, async (c) => {
			const r = await reserveCharge(c, identity, {
				scope: { kind: "client", clientProfileId: t.client.userId },
				externalReference: randomUUID(),
				amount: "1000.00",
				billingType: "PIX",
				installments: 1,
				feeAmount: "0.00",
				totalCharged: null,
				payerKind: "owner",
				payerDocumentMasked: "***.982.***-**",
			});
			if (!r.ok) throw new Error(r.reason);
			return { id: r.id, a: await buildSplitPlan(c, r.id), b: await buildSplitPlan(c, r.id) };
		});
		expect(first.b).toEqual(first.a);
		expect(await splitRows(first.id)).toHaveLength(1);

		await setBureauWallet(t, WALLET(5));
		await owner.query("update pix_charges set asaas_payment_id = $2 where id = $1", [first.id, `pay_frozen_${randomUUID()}`]);
		const after = await withUserTransaction(identity, (c) => buildSplitPlan(c, first.id));
		expect(after.asaasSplit).toEqual([{ walletId: WALLET(2), percentualValue: 20 }]);
	});

	it("grants: app_runtime executa só as portas do plano; record_cash_in_commission é do webhook", async () => {
		const can = async (role: string, fn: string) =>
			(await owner.query<{ ok: boolean }>("select has_function_privilege($1, $2::regprocedure, 'execute') as ok", [role, fn])).rows[0].ok;
		expect(await can("app_runtime", "charge_split_plan(uuid)")).toBe(true);
		expect(await can("app_runtime", "payment_link_charge_split(uuid)")).toBe(true);
		for (const fn of ["charge_split_plan_internal(uuid)", "record_cash_in_commission(uuid)"]) {
			expect(await can("app_runtime", fn)).toBe(false);
		}
		expect(await can("app_webhook", "record_cash_in_commission(uuid)")).toBe(true);
		expect(await can("app_webhook", "charge_split_plan_internal(uuid)")).toBe(false);
	});

	it("só o autor da cobrança pendente do próprio bureau chama o plano", async () => {
		const a = await seedTenant(owner, "Split Auth A");
		const b = await seedTenant(owner, "Split Auth B");
		const { id } = await reservePlan(a, "client");

		await expect(withUserTransaction(b.client, (c) => buildSplitPlan(c, id))).rejects.toThrow(/not_allowed/);
		await expect(withUserTransaction(a.bureauAdmin, (c) => buildSplitPlan(c, id))).rejects.toThrow(/not_allowed/);
	});
});

describe("checkout leva o split ao Asaas e guarda o plano", () => {
	it("Pix do cliente: o fake recebe o split do plano e charge_splits fica pending", async () => {
		const t = await seedTenant(owner, "Split Checkout");
		await addPartner(10, WALLET(1));
		await setBureauPct(t, 20);
		await setBureauWallet(t, WALLET(2));

		const { res, asaasPaymentId } = await checkoutPix(t, "client");

		expect(res).toMatchObject({ error: null, method: "PIX" });
		expect(getFakeChargeSplit(asaasPaymentId)).toEqual([
			{ walletId: WALLET(2), percentualValue: 20 },
			{ walletId: WALLET(1), percentualValue: 10 },
		]);
		const id = (res as { id: string }).id;
		expect((await splitRows(id)).map((r) => [r.beneficiary_kind, r.status])).toEqual([["bureau", "pending"], ["partner", "pending"]]);
		const audit = await owner.query<{ metadata: { lines: { wallet: string | null }[] } }>(
			"select metadata from audit_logs where action = 'charge_split.planned' and record_id = $1",
			[id],
		);
		expect(audit.rows).toHaveLength(1);
		expect(JSON.stringify(audit.rows[0].metadata)).not.toContain(WALLET(1));
		expect(audit.rows[0].metadata.lines.map((l) => l.wallet)).toContain("***0001");
	});

	it("sem nenhuma camada o corpo não leva split; soma acima de 100% bloqueia a cobrança", async () => {
		const plain = await seedTenant(owner, "Split Plain");
		const { res, asaasPaymentId } = await checkoutPix(plain, "client");
		expect(res).toMatchObject({ error: null });
		expect(getFakeChargeSplit(asaasPaymentId)).toBeUndefined();

		const over = await seedTenant(owner, "Split Over Checkout");
		await addPartner(80, WALLET(1));
		await setBureauPct(over, 30);
		const blocked = await checkoutPix(over, "client");
		expect(blocked.res).toMatchObject({ error: expect.stringMatching(/indisponível/) });
		expect(getFakeChargeSplit(blocked.asaasPaymentId)).toBeUndefined();
		expect(Number((await owner.query("select count(*)::int as n from pix_charges where bureau_id = $1", [over.bureau.id])).rows[0].n)).toBe(0);
	});
});

describe("confirmação do pagamento", () => {
	it("afiliado em modo Pix e bureau sem walletId: lança uma vez; webhook repetido e reprocesso não duplicam", async () => {
		const t = await seedTenant(owner, "Cash In");
		await setBureauPct(t, 20);
		const affiliate = await withAffiliate(t, { pct: 10 });
		const { res } = await checkoutPix(t, "client");
		const id = (res as { id: string }).id;

		const first = await pay(id);
		const eventId = randomUUID();
		await pay(id, eventId);
		await pay(id, eventId);

		expect(first.status).toBe(200);
		const commissions = await owner.query<{ status: string; amount: string; pct: string; margin: string; release_at: Date }>(
			"select status, amount, pct, margin, release_at from affiliate_commissions where order_ref = $1",
			[id],
		);
		expect(commissions.rows).toMatchObject([{ status: "released", amount: "100.00", pct: "10.00", margin: "1000.00" }]);
		const wallet = await owner.query("select pending, available from affiliate_wallets where profile_id = $1", [affiliate.userId]);
		expect(wallet.rows[0]).toMatchObject({ pending: "0.00", available: "100.00" });
		const ledger = await owner.query("select kind, origin, amount from affiliate_ledger_entries where profile_id = $1 order by seq", [affiliate.userId]);
		expect(ledger.rows).toEqual([
			{ kind: "commission", origin: "cash_in", amount: "100.00" },
			{ kind: "commission_release", origin: "cash_in", amount: "100.00" },
		]);
		const accrual = await owner.query("select bureau_id, kind, amount from bureau_payable_entries where pix_charge_id = $1", [id]);
		expect(accrual.rows).toEqual([{ bureau_id: t.bureau.id, kind: "accrual", amount: "200.00" }]);
		expect((await splitRows(id)).map((r) => r.status)).toEqual(["done", "done"]);
		// O portal do afiliado mostra o valor da recarga (não há pedido), lido pela RLS dele.
		expect(await withUserTransaction(affiliate, getMyAffiliateSummary)).toMatchObject({
			referrals: [{ recharged: "1000.00" }],
			commissions: [{ amount: "100.00", baseValue: "1000.00", fromRecharge: true }],
		});

		expect(await recordCashInCommission({ pixChargeId: id })).toBe(0);
		expect(Number((await owner.query("select count(*)::int as n from affiliate_ledger_entries where profile_id = $1", [affiliate.userId])).rows[0].n)).toBe(2);
		const audits = await owner.query("select action from audit_logs where action in ('payable.cash_in_accrual', 'affiliate.commission') and metadata ->> 'pix_charge_id' = $1 order by action", [id]);
		expect(audits.rows.map((r) => r.action)).toEqual(["affiliate.commission", "payable.cash_in_accrual"]);
	});

	it("carência configurada deixa a comissão pendente até a data", async () => {
		const t = await seedTenant(owner, "Cash In Hold");
		const affiliate = await withAffiliate(t, { pct: 10 });
		await owner.query("update settings set value = '3'::jsonb where key = 'affiliate_cash_in_hold_days'");
		const { res } = await checkoutPix(t, "client");
		const id = (res as { id: string }).id;

		await pay(id);

		const c = await owner.query<{ status: string; hours: string }>(
			"select status, round(extract(epoch from (release_at - now())) / 3600)::text as hours from affiliate_commissions where order_ref = $1",
			[id],
		);
		expect(c.rows[0].status).toBe("pending");
		expect(Number(c.rows[0].hours)).toBeGreaterThanOrEqual(71);
		expect((await owner.query("select pending, available from affiliate_wallets where profile_id = $1", [affiliate.userId])).rows[0]).toMatchObject({ pending: "100.00", available: "0.00" });
	});

	it("recarga do próprio bureau paga: nenhum lançamento de comissão nem accrual", async () => {
		const t = await seedTenant(owner, "Cash In Topup");
		await addPartner(10, WALLET(1));
		await setBureauPct(t, 20);
		const { res } = await checkoutPix(t, "bureau");
		const id = (res as { id: string }).id;

		await pay(id);

		expect(Number((await owner.query("select count(*)::int as n from bureau_payable_entries where bureau_id = $1", [t.bureau.id])).rows[0].n)).toBe(0);
		expect((await owner.query("select status from pix_charges where id = $1", [id])).rows[0].status).toBe("paid");
		expect((await splitRows(id)).map((r) => [r.beneficiary_kind, r.status])).toEqual([["partner", "pending"]]);
	});

	it("crédito manual e pedido pago com saldo não geram split nem comissão", async () => {
		const t = await seedTenant(owner, "Cash In Manual");
		await setBureauPct(t, 20);
		await withAffiliate(t, { pct: 10 });
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "500.00", createdBy: t.bureauAdmin.userId });
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "500.00", createdBy: t.client.userId });

		for (const table of ["charge_splits", "affiliate_commissions"]) {
			expect(Number((await owner.query(`select count(*)::int as n from ${table} where bureau_id = $1`, [t.bureau.id])).rows[0].n)).toBe(0);
		}
		expect(Number((await owner.query("select count(*)::int as n from bureau_payable_entries where bureau_id = $1", [t.bureau.id])).rows[0].n)).toBe(0);
	});
});

describe("portal do afiliado em modo conta Asaas", () => {
	const summaryOf = (affiliate: Parameters<typeof withUserTransaction>[0]) => withUserTransaction(affiliate, getMyAffiliateSummary);
	const setSplit = (chargeId: string, status: string) =>
		owner.query("update charge_splits set status = $2 where pix_charge_id = $1 and beneficiary_kind = 'affiliate'", [chargeId, status]);
	async function recharge(t: SeededTenant) {
		const { res } = await checkoutPix(t, "client");
		return (res as { id: string }).id;
	}

	it("mostra a recarga paga pelo split: pendente até o Asaas confirmar e sem a cobrança não paga", async () => {
		const t = await seedTenant(owner, "Cash In Asaas Portal");
		// walletId novo: um bureau de outro teste não pode já o usar.
		const wallet = randomUUID();
		const affiliate = await withAffiliate(t, { pct: 10, asaasWallet: wallet });
		const id = await recharge(t);

		expect(await summaryOf(affiliate)).toMatchObject({ referrals: [{ recharged: "0.00" }], commissions: [] });

		await pay(id);
		expect(await summaryOf(affiliate)).toMatchObject({
			referrals: [{ recharged: "1000.00" }],
			commissions: [{ paidBy: "asaas", status: "pending", amount: "100.00", baseValue: "1000.00", fromRecharge: true }],
		});

		await setSplit(id, "done");
		const done = await summaryOf(affiliate);
		expect(done).toMatchObject({ referrals: [{ recharged: "1000.00" }], commissions: [{ paidBy: "asaas", status: "done" }] });
		expect(done?.commissions).toHaveLength(1);
		expect(JSON.stringify(done)).not.toContain(wallet);
	});

	it("recusado e estornado aparecem com o estado real e saem do total; estorno sem reversão não vira repassado", async () => {
		const t = await seedTenant(owner, "Cash In Asaas Status");
		const affiliate = await withAffiliate(t, { pct: 10, asaasWallet: randomUUID() });
		const id = await recharge(t);
		await pay(id);

		for (const status of ["refused", "refunded", "reversal_failed"]) {
			await setSplit(id, status);
			expect(await summaryOf(affiliate)).toMatchObject({ referrals: [{ recharged: "0.00" }], commissions: [{ status }] });
		}

		// Chargeback: a linha fica done até o Asaas reverter.
		await setSplit(id, "done");
		await owner.query("update pix_charges set status = 'refunded' where id = $1", [id]);
		expect(await summaryOf(affiliate)).toMatchObject({ referrals: [{ recharged: "0.00" }], commissions: [{ status: "reversal_failed" }] });
		await setSplit(id, "pending");
		expect(await summaryOf(affiliate)).toMatchObject({ commissions: [{ status: "refunded" }] });
	});

	it("afiliado que trocou de modo vê cada recarga uma vez", async () => {
		const t = await seedTenant(owner, "Cash In Asaas Switch");
		const affiliate = await withAffiliate(t, { pct: 10 });
		const first = await recharge(t);
		await pay(first);
		await owner.query("update affiliate_wallets set payout_method = 'asaas', asaas_wallet_id = $2 where profile_id = $1", [affiliate.userId, randomUUID()]);
		const second = await recharge(t);
		await pay(second);
		await setSplit(second, "done");

		const summary = await summaryOf(affiliate);

		expect(summary?.referrals).toMatchObject([{ recharged: "2000.00" }]);
		expect(summary?.commissions).toMatchObject([
			{ paidBy: "asaas", status: "done", baseValue: "1000.00" },
			{ paidBy: "wallet", status: "released", baseValue: "1000.00" },
		]);
		expect(summary?.commissions).toHaveLength(2);
	});
});

describe("link de pagamento", () => {
	async function linkedOrder(t: SeededTenant, price = 300) {
		const orderId = randomUUID();
		await seedOrderDossier(owner, { orderRef: orderId, bureauId: t.bureau.id, clientProfileId: null, members: 1 });
		await owner.query("insert into order_settlements (order_ref, bureau_id, mode, price, cost) values ($1, $2, 'counter', $3, $4)", [
			orderId,
			t.bureau.id,
			price,
			Math.min(120, price - 1),
		]);
		await owner.query("update dossier_orders set state = 'awaiting_payment' where dossier_id = $1", [orderId]);
		const link = await createPaymentLink(t.bureauAdmin, orderId);
		if (!link.ok) throw new Error("expected link");
		const resolved = await resolvePaymentLink(link.token);
		if (!resolved.ok) throw new Error("expected resolved link");
		return resolved.link;
	}

	it("a cobrança do link leva o split ao Asaas e o accrual do bureau sem walletId nasce uma vez na baixa", async () => {
		const t = await seedTenant(owner, "Link Split");
		await addPartner(10, WALLET(1));
		await setBureauPct(t, 20);
		const link = await linkedOrder(t);

		const created = await getOrCreateLinkPixCharge(link.id);
		expect(created.ok).toBe(true);
		const charge = (await owner.query<{ id: string; asaas_payment_id: string }>("select id, asaas_payment_id from pix_charges where payment_link_id = $1", [link.id])).rows[0];
		expect(getFakeChargeSplit(charge.asaas_payment_id)).toEqual([{ walletId: WALLET(1), percentualValue: 10 }]);
		expect((await splitRows(charge.id)).map((r) => [r.beneficiary_kind, r.payout_method, r.amount_cents])).toEqual([
			["bureau", "accrual", "6000"],
			["partner", "asaas", "3000"],
		]);

		await pay(charge.id);
		const eventId = randomUUID();
		await pay(charge.id, eventId);
		await pay(charge.id, eventId);
		await pay(charge.id);

		const accrual = await owner.query("select bureau_id, amount from bureau_payable_entries where pix_charge_id = $1", [charge.id]);
		expect(accrual.rows).toEqual([{ bureau_id: t.bureau.id, amount: "60.00" }]);
		expect((await splitRows(charge.id)).map((r) => [r.beneficiary_kind, r.status])).toEqual([["bureau", "done"], ["partner", "pending"]]);
	});

	it("payment_link_charge_split recusa cobrança de recarga", async () => {
		const t = await seedTenant(owner, "Link Split Guard");
		const { id } = await reservePlan(t, "client");
		await expect(pool.query("select * from payment_link_charge_split($1)", [id])).rejects.toThrow(/not_allowed/);
	});
});
