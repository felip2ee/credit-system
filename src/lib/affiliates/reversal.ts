// Estorno e chargeback da comissão sobre a entrada (migração 079): reverte os repasses que o split do Asaas não cobre.
// Afiliado em modo Pix: reversão no livro-razão (origin 'cash_in'); o saldo pode ficar negativo e é abatido das próximas
// comissões. Bureau sem walletId: lançamento 'reversal' ligado ao accrual. Linhas em modo asaas: só o status (refunded,
// ou reversal_failed quando o Asaas não reverteu o repasse).
// Onde roda: apply_asaas_payment chama reverse_cash_in_commission na MESMA transação que marca a cobrança como estornada
// (e no estorno de Pix de link). Um evento repetido cai em 'duplicate' antes disso e nada duplica; a função também é
// idempotente por si (só trata linha pending ou done e a marca refunded; chaves únicas são a segunda barreira).
// Esta função de TypeScript serve para reprocessar uma cobrança já estornada (reparo): mesmo efeito, sem duplicar.
// Sem sessão de usuário (role app_webhook), como cash-in.ts: não recebe contexto de transação.
import { getWebhookPool } from "@/lib/db/webhook-pool";

// Quantas linhas do plano foram tratadas agora. Cobrança que não está paga nem estornada devolve 0.
export async function reverseCashInCommission({
	pixChargeId,
	eventType = "PAYMENT_REFUNDED",
	payload = null,
}: {
	pixChargeId: string;
	eventType?: string;
	payload?: unknown;
}): Promise<number> {
	const { rows } = await getWebhookPool().query<{ done: number }>(
		"select public.reverse_cash_in_commission($1, $2, $3::jsonb) as done",
		[pixChargeId, eventType, payload === null ? null : JSON.stringify(payload)],
	);
	return rows[0].done;
}
