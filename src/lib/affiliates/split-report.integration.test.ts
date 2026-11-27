// Painel de repasses e prejuízo por cliente (081) contra um Postgres real, sob RLS.
import { randomUUID } from "node:crypto";

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

vi.mock("next/headers", () => ({
	headers: () => {
		throw new Error("no request scope");
	},
}));

import { pool } from "@/lib/db/pool";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedClientProfile, seedPixCharge, seedSuperadmin, seedTenant, type SeedSuperadmin, type SeededTenant } from "@/test/seed";

import { getPartnerSplitTotal, listBureauSplits, listClientLosses, parseReportRange } from "./split-report";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });
const WALLET = "00000000-0000-4000-8000-0000000000a1";
const WIDE = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" };

let SA: SeedSuperadmin;
let A: SeededTenant;
let B: SeededTenant;
let clientA2: { userId: string };
let affiliateA: { userId: string };
let partnerId: string;
let refundedFailedCharge: string;

type ChargeKind = "paid" | "refund" | "chargeback" | "ghost_refund";

// 'ghost_refund': estorno antes do pagamento (a cobrança vira refunded, mas o evento fica 'ignored': nunca houve dinheiro).
async function charge(t: SeededTenant, clientId: string, kind: ChargeKind, amount = "100.00") {
	const c = await seedPixCharge(owner, {
		bureauId: t.bureau.id,
		requestedBy: clientId,
		amount,
		status: kind === "paid" ? "paid" : "refunded",
		clientProfileId: clientId,
	});
	if (kind !== "paid") {
		await owner.query(
			`insert into asaas_webhook_events (bureau_id, event_id, event_type, asaas_payment_id, payload, result)
			 values ($1, $2, $3, $4, '{}'::jsonb, $5)`,
			[
				t.bureau.id,
				randomUUID(),
				kind === "chargeback" ? "PAYMENT_CHARGEBACK_REQUESTED" : "PAYMENT_REFUNDED",
				c.asaasPaymentId,
				kind === "ghost_refund" ? "ignored" : "refunded",
			],
		);
	}
	return c.id;
}

async function split(
	t: SeededTenant,
	chargeId: string,
	o: { kind: "partner" | "bureau" | "bureau_referrer" | "affiliate"; id: string; method?: "asaas" | "pix" | "accrual"; cents: number; status?: string; wallet?: string },
) {
	const method = o.method ?? "asaas";
	await owner.query(
		`insert into charge_splits (pix_charge_id, bureau_id, beneficiary_kind, beneficiary_id, payout_method, asaas_wallet_id, pct, amount_cents, status)
		 values ($1, $2, $3, $4, $5, $6, 10, $7, $8)`,
		[chargeId, t.bureau.id, o.kind, o.id, method, method === "asaas" ? (o.wallet ?? WALLET) : null, o.cents, o.status ?? "done"],
	);
}

beforeAll(async () => {
	SA = await seedSuperadmin(owner);
	A = await seedTenant(owner, "Painel Split A");
	B = await seedTenant(owner, "Painel Split B");
	clientA2 = await seedClientProfile(owner, A.bureau.id);
	affiliateA = await seedClientProfile(owner, A.bureau.id);
	partnerId = randomUUID();

	// Cliente 1 do bureau A: paga 400 (2 pagas, 1 estorno, 1 chargeback); o estorno deixou um repasse que o Asaas não reverteu.
	const paid1 = await charge(A, A.client.userId, "paid");
	const paid2 = await charge(A, A.client.userId, "paid");
	refundedFailedCharge = await charge(A, A.client.userId, "refund");
	const cb = await charge(A, A.client.userId, "chargeback");
	await charge(A, A.client.userId, "ghost_refund", "50.00");
	await split(A, paid1, { kind: "bureau", id: A.bureau.id, cents: 1000 });
	await split(A, paid1, { kind: "partner", id: partnerId, cents: 500 });
	await split(A, paid2, { kind: "affiliate", id: affiliateA.userId, method: "pix", cents: 700, status: "pending" });
	await split(A, refundedFailedCharge, { kind: "bureau", id: A.bureau.id, cents: 2000, status: "reversal_failed" });
	await split(A, refundedFailedCharge, { kind: "partner", id: partnerId, cents: 400, status: "reversal_failed" });
	await split(A, cb, { kind: "affiliate", id: affiliateA.userId, wallet: WALLET, cents: 300, status: "refused" });

	// Saldo negativo do afiliado: comissão de R$ 50 liberada e já sacada, depois estornada na cobrança do chargeback.
	const com = await owner.query<{ id: string }>(
		`insert into affiliate_commissions (order_ref, bureau_id, affiliate_profile_id, referred_profile_id, pct, margin, amount, reversed_amount, status, release_at)
		 values ($1, $2, $3, $4, 10, 500, 50, 50, 'reversed', now()) returning id`,
		[cb, A.bureau.id, affiliateA.userId, A.client.userId],
	);
	const post = (kind: string, amount: number, key: string, ref: string) =>
		owner.query("select * from affiliate_wallet_post_entry($1, $2, $3, $4, $5, $1, 'cash_in')", [affiliateA.userId, kind, amount, key, ref]);
	await post("commission", 50, "t7:c", `commission:${com.rows[0].id}`);
	await post("commission_release", 50, "t7:r", `commission:${com.rows[0].id}`);
	await post("withdrawal_hold", 50, "t7:w", "t7");
	await post("commission_clawback", 50, "t7:k", `commission:${com.rows[0].id}`);

	// Cliente 2 do bureau A: só cobranças pagas. Bureau B: um cliente com estorno (não pode vazar para A).
	await charge(A, clientA2.userId, "paid", "200.00");
	const bRefund = await charge(B, B.client.userId, "refund");
	await split(B, bRefund, { kind: "bureau", id: B.bureau.id, cents: 999, status: "reversal_failed" });
});

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

describe("listClientLosses", () => {
	it("soma pago, estornos, chargebacks e percentual por cliente; ignora estorno sem dinheiro", async () => {
		const rows = await listClientLosses(A.bureauAdmin, WIDE);
		const c1 = rows.find((r) => r.clientId === A.client.userId);
		expect(c1).toMatchObject({
			totalPaidCents: 40000,
			refundCount: 1,
			refundCents: 10000,
			chargebackCount: 1,
			chargebackCents: 10000,
			refundPct: 50,
		});
	});

	it("comissão já paga sobre estornadas: repasse reversal_failed e saldo negativo do afiliado", async () => {
		const c1 = (await listClientLosses(A.bureauAdmin, WIDE)).find((r) => r.clientId === A.client.userId);
		expect(c1?.reversalFailedCents).toBe(2000);
		expect(c1?.negativeBalanceCents).toBe(5000);
	});

	it("cliente sem estorno aparece com zero", async () => {
		const c2 = (await listClientLosses(A.bureauAdmin, WIDE)).find((r) => r.clientId === clientA2.userId);
		expect(c2).toMatchObject({
			totalPaidCents: 20000,
			refundCount: 0,
			chargebackCount: 0,
			refundPct: 0,
			reversalFailedCents: 0,
			negativeBalanceCents: 0,
		});
	});

	it("bureau_admin só vê o próprio bureau (RLS) e a lista sai por maior percentual", async () => {
		const rowsA = await listClientLosses(A.bureauAdmin, WIDE);
		expect(rowsA.map((r) => r.clientId)).not.toContain(B.client.userId);
		expect(rowsA[0].clientId).toBe(A.client.userId);
		const rowsB = await listClientLosses(B.bureauAdmin, WIDE);
		expect(rowsB.map((r) => r.clientId)).toEqual([B.client.userId]);
	});

	it("o período limita as cobranças", async () => {
		const rows = await listClientLosses(A.bureauAdmin, { from: "2000-01-01T00:00:00Z", to: "2001-01-01T00:00:00Z" });
		expect(rows).toEqual([]);
	});
});

describe("listBureauSplits", () => {
	it("bureau_admin vê só as linhas do próprio bureau, sem sócios, com walletId mascarado", async () => {
		const rows = await listBureauSplits(A.bureauAdmin, WIDE);
		expect(rows.map((r) => r.beneficiaryKind)).not.toContain("partner");
		expect(rows.every((r) => r.bureauId === A.bureau.id)).toBe(true);
		const refused = rows.find((r) => r.status === "refused");
		expect(refused).toMatchObject({ amountCents: 300, walletMasked: "***00a1", beneficiaryKind: "affiliate" });
		expect(JSON.stringify(rows)).not.toContain(WALLET);
		const failed = rows.find((r) => r.status === "reversal_failed");
		expect(failed).toMatchObject({ pixChargeId: refundedFailedCharge, amountCents: 2000, beneficiaryKind: "bureau" });
	});

	it("filtra por status", async () => {
		const rows = await listBureauSplits(A.bureauAdmin, { ...WIDE, status: "refused" });
		expect(rows).toHaveLength(1);
	});

	it("superadmin vê todos os bureaus e os sócios; o total dos sócios exclui recusado e estornado", async () => {
		// Sócios são globais e mexem na soma das camadas dos outros testes: o cadastro vive só durante este teste.
		await owner.query("insert into platform_partners (id, name, asaas_wallet_id, pct) values ($1, 'Sócio Painel', $2, 10)", [partnerId, WALLET]);
		let rows;
		try {
			rows = await listBureauSplits(SA, WIDE);
		} finally {
			await owner.query("delete from platform_partners where id = $1", [partnerId]);
		}
		expect(rows.some((r) => r.beneficiaryKind === "partner" && r.beneficiaryName === "Sócio Painel")).toBe(true);
		expect(new Set(rows.filter((r) => r.bureauId === A.bureau.id || r.bureauId === B.bureau.id).map((r) => r.bureauId)).size).toBe(2);
		// 500 (done) + 400 (reversal_failed: o dinheiro saiu e não voltou)
		expect(await getPartnerSplitTotal(SA, WIDE)).toBeGreaterThanOrEqual(900);
	});

	it("bureau_admin não lê o total dos sócios (RLS)", async () => {
		expect(await getPartnerSplitTotal(A.bureauAdmin, WIDE)).toBe(0);
	});
});

describe("status da cobrança no painel (083)", () => {
	it("ignora repasse de cobrança que não foi paga e marca a estornada", async () => {
		const pending = await seedPixCharge(owner, { bureauId: A.bureau.id, requestedBy: clientA2.userId, status: "pending", clientProfileId: clientA2.userId });
		const expired = await seedPixCharge(owner, { bureauId: A.bureau.id, requestedBy: clientA2.userId, status: "expired", clientProfileId: clientA2.userId });
		const before = await getPartnerSplitTotal(SA, WIDE);
		for (const c of [pending, expired]) await split(A, c.id, { kind: "partner", id: partnerId, cents: 777, status: "pending" });
		await split(A, pending.id, { kind: "bureau", id: A.bureau.id, cents: 888, status: "pending" });

		expect(await getPartnerSplitTotal(SA, WIDE)).toBe(before);
		for (const identity of [SA, A.bureauAdmin]) {
			const ids = (await listBureauSplits(identity, WIDE)).map((r) => r.pixChargeId);
			expect(ids).not.toContain(pending.id);
			expect(ids).not.toContain(expired.id);
		}
		const rows = await listBureauSplits(A.bureauAdmin, WIDE);
		expect(rows.find((r) => r.pixChargeId === refundedFailedCharge)?.chargeRefunded).toBe(true);
		expect(rows.find((r) => r.status === "pending")?.chargeRefunded).toBe(false);
	});

	it("estorno citado em outra parcela casa pela cobrança parcelada (asaas_installment_id)", async () => {
		const t = await seedTenant(owner, "Painel Split Parcelas");
		const c = await seedPixCharge(owner, { bureauId: t.bureau.id, requestedBy: t.client.userId, amount: "90.00", status: "refunded", clientProfileId: t.client.userId });
		const installment = `ins_${randomUUID()}`;
		await owner.query("update pix_charges set billing_type = 'CREDIT_CARD', installments = 3, asaas_installment_id = $2, pix_payload = null where id = $1", [c.id, installment]);
		await owner.query(
			`insert into asaas_webhook_events (bureau_id, event_id, event_type, asaas_payment_id, payload, result)
			 values ($1, $2, 'PAYMENT_CHARGEBACK_REQUESTED', 'pay_parcela_2', $3::jsonb, 'refunded')`,
			[t.bureau.id, randomUUID(), JSON.stringify({ payment: { installment } })],
		);

		expect(await listClientLosses(t.bureauAdmin, WIDE)).toMatchObject([{ totalPaidCents: 9000, chargebackCount: 1, chargebackCents: 9000, refundCount: 0 }]);
	});
});

describe("parseReportRange", () => {
	it("usa o padrão de 30 dias e valida datas", () => {
		const now = new Date("2026-11-26T12:00:00-03:00");
		const d = parseReportRange({}, now);
		expect(d.fromDate).toBe("2026-10-27");
		expect(d.toDate).toBe("2026-11-26");
		expect(d.to).toBe("2026-11-27T00:00:00-03:00");
		expect(parseReportRange({ de: "lixo", ate: "2026-02-31" }, now).fromDate).toBe("2026-10-27");
		expect(parseReportRange({ de: "2026-11-01", ate: "2026-11-10" }, now)).toMatchObject({ fromDate: "2026-11-01", toDate: "2026-11-10" });
	});
});
