import { describe, expect, it } from "vitest";

import { toStatementLine, type StatementRow } from "./statement-total";

const at = new Date("2026-10-20T12:00:00Z");
const row = (source: StatementRow["source"], kind: string, amount: string, reason: string | null = null): StatementRow => ({
	id: "00000000-0000-4000-8000-000000000001",
	source,
	kind,
	amount,
	reason,
	at,
	cursorAt: "2026-10-20T12:00:00.000000Z",
});

describe("toStatementLine", () => {
	it("recarga entra no saldo pré-pago com sinal positivo", () => {
		expect(toStatementLine(row("prepaid", "topup", "50.00"))).toMatchObject({
			source: "prepaid",
			title: "Recarga no saldo pré-pago",
			amount: "50.00",
			tone: "in",
		});
	});

	it("venda no balcão: custo separado sai do saldo; pedido concluído não conta duas vezes", () => {
		expect(toStatementLine(row("prepaid", "reserve", "5.00"))).toMatchObject({
			title: "Custo saiu do saldo pré-pago",
			amount: "-5.00",
			tone: "out",
		});
		expect(toStatementLine(row("prepaid", "capture", "5.00"))).toMatchObject({ amount: "5.00", tone: "neutral" });
		expect(toStatementLine(row("prepaid", "release", "5.00"))).toMatchObject({ amount: "5.00", tone: "in" });
		expect(toStatementLine(row("prepaid", "reversal", "5.00"))).toMatchObject({ amount: "-5.00", tone: "out" });
	});

	it("ajuste da Rainha Cred segue o sinal do valor e mostra o motivo", () => {
		expect(toStatementLine(row("prepaid", "adjustment", "-3.00", "erro de lançamento"))).toMatchObject({
			amount: "-3.00",
			tone: "out",
			detail: expect.stringContaining("erro de lançamento"),
		});
		expect(toStatementLine(row("prepaid", "adjustment", "3.00"))).toMatchObject({ amount: "3.00", tone: "in" });
	});

	it("ajuste de conta explica de onde saiu e para onde foi", () => {
		const out = toStatementLine(row("prepaid", "client_adjustment_out", "100.00", "Correção de cobrança"));
		expect(out).toMatchObject({ title: "Crédito dado a cliente", amount: "-100.00", tone: "out" });
		expect(out.detail).toContain("Saiu do saldo do Bureau e entrou no saldo do cliente (ajuste de conta).");
		expect(out.detail).toContain("Correção de cobrança");
		const back = toStatementLine(row("prepaid", "client_adjustment_in", "30.00"));
		expect(back).toMatchObject({ title: "Crédito tirado de cliente", amount: "30.00", tone: "in" });
		expect(back.detail).toContain("Saiu do saldo do cliente e voltou para o saldo do Bureau");
	});

	it("A receber: venda online, estorno e repasse", () => {
		expect(toStatementLine(row("payable", "accrual", "20.00"))).toMatchObject({
			title: "Sua parte entrou em A receber",
			amount: "20.00",
			tone: "in",
		});
		expect(toStatementLine(row("payable", "reversal", "-20.00"))).toMatchObject({ amount: "-20.00", tone: "out" });
		expect(toStatementLine(row("payable", "payout", "-50.00"))).toMatchObject({ title: "Repasse recebido", amount: "-50.00", tone: "out" });
	});

	it("lançamento de cliente sem par no Bureau ainda aparece", () => {
		expect(toStatementLine(row("client", "adjustment_credit", "10.00", "motivo qualquer"))).toMatchObject({
			source: "client",
			title: "Crédito dado a cliente",
			amount: "10.00",
			tone: "in",
		});
		expect(toStatementLine(row("client", "adjustment_debit", "10.00"))).toMatchObject({ amount: "-10.00", tone: "out" });
	});

	it("nenhum texto leva nome técnico", () => {
		const kinds: Array<[StatementRow["source"], string]> = [
			["prepaid", "topup"], ["prepaid", "reserve"], ["prepaid", "capture"], ["prepaid", "release"], ["prepaid", "reversal"],
			["prepaid", "adjustment"], ["prepaid", "client_adjustment_out"], ["prepaid", "client_adjustment_in"],
			["payable", "accrual"], ["payable", "reversal"], ["payable", "payout"],
			["client", "adjustment_credit"], ["client", "adjustment_debit"],
		];
		for (const [s, k] of kinds) {
			const l = toStatementLine(row(s, k, "1.00", "motivo"));
			expect(`${l.title} ${l.detail}`).not.toMatch(/reserve|capture|notification|accrual|payout|reversal|_/);
		}
	});

	it("tipo desconhecido falha em vez de sumir", () => {
		expect(() => toStatementLine(row("prepaid", "novo_tipo", "1.00"))).toThrow();
	});
});
