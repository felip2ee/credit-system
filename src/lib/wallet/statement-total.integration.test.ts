// Extrato total contra um Postgres real, sob RLS. Cada teste usa Bureaus novos.

import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

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
import { withUserTransaction, type DbIdentity } from "@/lib/db/transaction";
import { TEST_DATABASE_OWNER_URL } from "@/test/db-env";
import { seedCashInAccrual, seedClientWalletTopup, seedPayableEntry, seedTenant, seedWalletTopup } from "@/test/seed";

import { adjustClientBalance } from "./client-adjustment";
import { listWalletStatement, type StatementLine } from "./statement-total";

const owner = new Pool({ connectionString: TEST_DATABASE_OWNER_URL, max: 4 });

afterAll(async () => {
	await Promise.all([owner.end(), pool.end()]);
});

const WIDE = { start: "2000-01-01T00:00:00Z", end: "2100-01-01T00:00:00Z" };

const read = (identity: DbIdentity, bureauId: string, args: Partial<Parameters<typeof listWalletStatement>[1]> = {}) =>
	withUserTransaction(identity, (c) => listWalletStatement(c, { bureauId, source: "all", includePayable: true, range: WIDE, ...args }));

const post = (bureauId: string, kind: string, amount: string, by: string) =>
	owner.query("select * from wallet_post_entry($1, $2, $3, $4, null, null, $5)", [bureauId, kind, amount, `t-${randomUUID()}`, by]);

describe("listWalletStatement", () => {
	it("mostra cada tipo de lançamento com o título e o sinal certos", async () => {
		const t = await seedTenant(owner, "Stmt");
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "100.00", createdBy: t.bureauAdmin.userId });
		await post(t.bureau.id, "reserve", "10.00", t.bureauAdmin.userId);
		await post(t.bureau.id, "capture", "10.00", t.bureauAdmin.userId);
		await post(t.bureau.id, "reserve", "4.00", t.bureauAdmin.userId);
		await post(t.bureau.id, "release", "4.00", t.bureauAdmin.userId);
		await seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "accrual", amount: "20.00" });
		await seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "reversal", amount: "-5.00" });

		const { lines } = await read(t.bureauAdmin, t.bureau.id);
		const by = (title: string) => lines.filter((l) => l.title === title);
		expect(by("Recarga no saldo pré-pago")[0]).toMatchObject({ amount: "100.00", tone: "in", source: "prepaid" });
		expect(by("Custo saiu do saldo pré-pago").map((l) => l.amount).sort()).toEqual(["-10.00", "-4.00"]);
		expect(by("Pedido de balcão concluído")[0]).toMatchObject({ amount: "10.00", tone: "neutral" });
		expect(by("Valor devolvido ao saldo pré-pago")[0]).toMatchObject({ amount: "4.00", tone: "in" });
		expect(by("Sua parte entrou em A receber")[0]).toMatchObject({ amount: "20.00", tone: "in", source: "payable" });
		expect(by("Parte estornada em A receber")[0]).toMatchObject({ amount: "-5.00", tone: "out" });
		expect(lines).toHaveLength(7);
	});

	it("cobertura de cupom em A receber (coupon_cost e coupon_refund) aparece no extrato sem erro", async () => {
		const t = await seedTenant(owner, "StmtCoupon");
		const orderRef = randomUUID();
		await owner.query(
			`insert into order_settlements (order_ref, bureau_id, mode, price, cost, status, closed_at)
			 values ($1, $2, 'counter', 1, 0, 'captured', now())`,
			[orderRef, t.bureau.id],
		);
		await owner.query(
			`insert into bureau_payable_entries (bureau_id, kind, amount, order_ref)
			 values ($1, 'coupon_cost', -3.00, $2), ($1, 'coupon_refund', 3.00, $2)`,
			[t.bureau.id, orderRef],
		);
		const { lines } = await read(t.bureauAdmin, t.bureau.id, { source: "payable" });
		expect(lines.map((l) => [l.title, l.amount, l.tone]).sort()).toEqual([
			["Cobertura de cupom", "-3.00", "out"],
			["Devolução de cobertura de cupom", "3.00", "in"],
		]);
	});

	it("o acréscimo da entrada de dinheiro (sem pedido, com cobrança) aparece no extrato, separado do acréscimo por pedido", async () => {
		const t = await seedTenant(owner, "StmtCashIn");
		await seedCashInAccrual(owner, {
			bureauId: t.bureau.id, requestedBy: t.client.userId, clientProfileId: t.client.userId, chargeAmount: "100.00", amount: "7.50",
		});
		const { lines } = await read(t.bureauAdmin, t.bureau.id, { source: "payable" });
		expect(lines.map((l) => [l.title, l.detail, l.amount, l.tone])).toEqual([
			["Sua parte entrou em A receber", "Pagamento recebido de um cliente. A Rainha Cred repassa essa parte a você.", "7.50", "in"],
		]);
	});

	it("um ajuste de conta vira uma linha só, de crédito e de débito", async () => {
		const t = await seedTenant(owner, "Stmt");
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "100.00", createdBy: t.bureauAdmin.userId });
		const credit = await adjustClientBalance(t.bureauAdmin, {
			holderId: t.holder.id, requestId: randomUUID(), direction: "credit", amount: "40.00", reason: "Correção de cobrança",
		});
		expect(credit.ok).toBe(true);
		const debit = await adjustClientBalance(t.bureauAdmin, {
			holderId: t.holder.id, requestId: randomUUID(), direction: "debit", amount: "15.00", reason: "Crédito dado por engano",
		});
		expect(debit.ok).toBe(true);

		const { lines } = await read(t.bureauAdmin, t.bureau.id);
		const adjustments = lines.filter((l) => /cliente$/.test(l.title));
		expect(adjustments).toHaveLength(2);
		const credito = adjustments.find((l) => l.title === "Crédito dado a cliente") as StatementLine;
		expect(credito).toMatchObject({ amount: "-40.00", tone: "out", source: "prepaid" });
		expect(credito.detail).toContain("Saiu do saldo do Bureau e entrou no saldo do cliente (ajuste de conta).");
		expect(credito.detail).toContain("Correção de cobrança");
		expect(adjustments.find((l) => l.title === "Crédito tirado de cliente")).toMatchObject({ amount: "15.00", tone: "in" });
		// recarga + 2 ajustes: o saldo do cliente não vira uma segunda linha.
		expect(lines).toHaveLength(3);
	});

	it("lançamento de ajuste do cliente sem par no Bureau ainda aparece, só em Tudo", async () => {
		const t = await seedTenant(owner, "Stmt");
		const id = randomUUID();
		await seedClientWalletTopup(owner, { clientProfileId: t.client.userId, amount: "1.00", createdBy: t.client.userId });
		await owner.query(
			"select * from client_wallet_post_entry($1, 'adjustment_credit', 7, $2, $3, 'motivo de teste', $1)",
			[t.client.userId, `adjustment:${id}:client`, `adjustment:${id}`],
		);
		const all = await read(t.bureauAdmin, t.bureau.id);
		expect(all.lines.filter((l) => l.source === "client")).toHaveLength(1);
		expect((await read(t.bureauAdmin, t.bureau.id, { source: "prepaid" })).lines).toHaveLength(0);
	});

	it("filtra por saldo pré-pago e por A receber", async () => {
		const t = await seedTenant(owner, "Stmt");
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "30.00", createdBy: t.bureauAdmin.userId });
		await seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "accrual", amount: "9.00" });
		const prepaid = await read(t.bureauAdmin, t.bureau.id, { source: "prepaid" });
		const payable = await read(t.bureauAdmin, t.bureau.id, { source: "payable" });
		expect(prepaid.lines.map((l) => l.source)).toEqual(["prepaid"]);
		expect(payable.lines.map((l) => l.source)).toEqual(["payable"]);
		expect((await read(t.bureauAdmin, t.bureau.id)).lines).toHaveLength(2);
	});

	it("sem includePayable (operador, sem payout:read) o A receber não sai do banco", async () => {
		const t = await seedTenant(owner, "Stmt");
		await seedWalletTopup(owner, { bureauId: t.bureau.id, amount: "30.00", createdBy: t.bureauAdmin.userId });
		await seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "accrual", amount: "9.00" });
		const asOperator = await read(t.operator, t.bureau.id, { includePayable: false });
		expect(asOperator.lines.map((l) => l.source)).toEqual(["prepaid"]);
		expect((await read(t.operator, t.bureau.id, { includePayable: false, source: "payable" })).lines).toEqual([]);
		expect((await read(t.bureauAdmin, t.bureau.id)).lines.map((l) => l.source).sort()).toEqual(["payable", "prepaid"]);
	});

	it("respeita o período: início incluído, fim excluído", async () => {
		const t = await seedTenant(owner, "Stmt");
		for (const d of ["2026-03-01T00:00:00Z", "2026-03-15T12:00:00Z", "2026-04-01T00:00:00Z"]) {
			await seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "accrual", amount: "1.00", createdAt: d });
		}
		const { lines } = await read(t.bureauAdmin, t.bureau.id, { range: { start: "2026-03-01T00:00:00Z", end: "2026-04-01T00:00:00Z" } });
		expect(lines.map((l) => l.at.toISOString())).toEqual(["2026-03-15T12:00:00.000Z", "2026-03-01T00:00:00.000Z"]);
	});

	it("pagina sem repetir nem perder linha, mesmo com a mesma data em todas", async () => {
		const t = await seedTenant(owner, "Stmt");
		const same = "2026-05-10T10:00:00.123456Z";
		const ids = new Set<string>();
		for (let i = 0; i < 5; i += 1) ids.add(await seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "accrual", amount: "1.00", createdAt: same }));
		await seedPayableEntry(owner, { bureauId: t.bureau.id, kind: "accrual", amount: "1.00", createdAt: "2026-05-09T10:00:00Z" });

		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const page: Awaited<ReturnType<typeof read>> = await read(t.bureauAdmin, t.bureau.id, { limit: 2, cursor });
			seen.push(...page.lines.map((l) => l.id));
			cursor = page.nextCursor;
			pages += 1;
		} while (cursor && pages < 10);
		expect(pages).toBe(3);
		expect(seen).toHaveLength(6);
		expect(new Set(seen).size).toBe(6);
		ids.forEach((id) => expect(seen).toContain(id));
	});

	it("o Bureau B não lê o extrato do Bureau A", async () => {
		const a = await seedTenant(owner, "StmtA");
		const b = await seedTenant(owner, "StmtB");
		await seedWalletTopup(owner, { bureauId: a.bureau.id, amount: "30.00", createdBy: a.bureauAdmin.userId });
		await seedPayableEntry(owner, { bureauId: a.bureau.id, kind: "accrual", amount: "9.00" });
		expect((await read(b.bureauAdmin, a.bureau.id)).lines).toHaveLength(0);
		expect((await read(a.bureauAdmin, a.bureau.id)).lines).toHaveLength(2);
	});

	it("Bureau sem lançamentos devolve lista vazia", async () => {
		const t = await seedTenant(owner, "Stmt");
		expect(await read(t.bureauAdmin, t.bureau.id)).toEqual({ lines: [], nextCursor: null });
	});

	it("recusa cursor e período inválidos", async () => {
		const t = await seedTenant(owner, "Stmt");
		await expect(read(t.bureauAdmin, t.bureau.id, { cursor: "x" })).rejects.toThrow(RangeError);
		const id = randomUUID();
		await expect(read(t.bureauAdmin, t.bureau.id, { cursor: `2026-13-01T00:00:00.000000Z|${id}` })).rejects.toThrow(RangeError);
		await expect(read(t.bureauAdmin, t.bureau.id, { cursor: `2026-01-01T00:00:00.000000Z|${"-".repeat(36)}` })).rejects.toThrow(RangeError);
		await expect(read(t.bureauAdmin, t.bureau.id, { range: { start: "nao-e-data", end: WIDE.end } })).rejects.toThrow(RangeError);
	});
});
