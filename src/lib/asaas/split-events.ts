import { z } from "zod";

import { getWebhookPool } from "@/lib/db/webhook-pool";

import {
	ASAAS_EVENT_PAYMENT_AWAITING_CHARGEBACK_REVERSAL,
	ASAAS_EVENT_PAYMENT_CHARGEBACK_DISPUTE,
	ASAAS_EVENT_PAYMENT_CHARGEBACK_REQUESTED,
	ASAAS_EVENT_PAYMENT_REFUNDED,
	ASAAS_EVENT_PAYMENT_SPLIT_CANCELLED,
	ASAAS_EVENT_PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED,
	ASAAS_EVENT_PAYMENT_SPLIT_DONE,
} from "./client";

// Eventos só de split: nada a mais para a cobrança. A recusa chega como item REFUSED ou CANCELLED (não há evento próprio).
export const SPLIT_ONLY_EVENTS: ReadonlySet<string> = new Set([
	ASAAS_EVENT_PAYMENT_SPLIT_DONE,
	ASAAS_EVENT_PAYMENT_SPLIT_CANCELLED,
	ASAAS_EVENT_PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED,
]);
// Estorno e chargeback devolvem o repasse (item REFUNDED). O evento segue para apply_asaas_payment (saldo e alertas).
export const SPLIT_REFUND_EVENTS: ReadonlySet<string> = new Set([
	ASAAS_EVENT_PAYMENT_REFUNDED,
	ASAAS_EVENT_PAYMENT_CHARGEBACK_REQUESTED,
	ASAAS_EVENT_PAYMENT_CHARGEBACK_DISPUTE,
	ASAAS_EVENT_PAYMENT_AWAITING_CHARGEBACK_REVERSAL,
]);

const splitItemsSchema = z.array(
	z.object({
		id: z.string().trim().min(1).max(200),
		walletId: z.string().trim().min(1).max(64).optional().catch(undefined),
		status: z.string().trim().max(50).optional().catch(undefined),
	}),
);

// unbound_charge: cobrança deste sistema que ainda não gravou o id do pagamento (083): o reenvio do Asaas a encontra.
export type ChargeSplitEventResult = "unknown_charge" | "unbound_charge" | "updated" | "unchanged";

// payment.split do corpo; null quando falta ou tem outro formato (o evento não derruba o webhook).
export function parseSplitItems(raw: unknown): z.infer<typeof splitItemsSchema> | null {
	const split = (raw as { payment?: { split?: unknown } } | null)?.payment?.split;
	const parsed = splitItemsSchema.safeParse(split);
	return parsed.success ? parsed.data : null;
}

// Webhook sem sessão (role app_webhook): a função SECURITY DEFINER é a única porta de escrita em charge_splits (072, 083).
export async function applyChargeSplitEvent(event: {
	eventId: string;
	eventType: string;
	asaasPaymentId: string;
	asaasInstallmentId?: string;
	externalReference?: string;
	splits: z.infer<typeof splitItemsSchema>;
}): Promise<ChargeSplitEventResult> {
	const { rows } = await getWebhookPool().query<{ result: ChargeSplitEventResult }>(
		"select public.apply_charge_split_event($1, $2, $3::jsonb, $4, $5, $6) as result",
		[
			event.eventId,
			event.asaasPaymentId,
			JSON.stringify(event.splits),
			event.eventType,
			event.asaasInstallmentId ?? null,
			event.externalReference ?? null,
		],
	);
	return rows[0].result;
}
