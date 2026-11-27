// Comissão sobre a entrada de dinheiro (migração 069): na confirmação do pagamento, grava o que o split do Asaas não cobre.
// Afiliado em modo Pix vira comissão com carência (affiliate_cash_in_hold_days, padrão 0) e lançamento cash_in; bureau
// (dono ou indicador) sem walletId vira accrual em bureau_payable_entries (C2).
// Onde roda: apply_asaas_payment (070) chama record_cash_in_commission na MESMA transação que marca a cobrança como
// paga. Um webhook repetido cai em 'duplicate' antes disso e nada duplica; a função também é idempotente por si
// (só trata linha de charge_splits em pending e a marca done; o livro-razão tem chave única por cobrança).
// Esta função de TypeScript serve para reprocessar uma cobrança já paga (reparo): mesmo efeito, sem duplicar.
import { getWebhookPool } from "@/lib/db/webhook-pool";

// Quantas linhas do plano foram lançadas agora. Cobrança que não está paga devolve 0.
export async function recordCashInCommission({ pixChargeId }: { pixChargeId: string }): Promise<number> {
	const { rows } = await getWebhookPool().query<{ done: number }>(
		"select public.record_cash_in_commission($1) as done",
		[pixChargeId],
	);
	return rows[0].done;
}
