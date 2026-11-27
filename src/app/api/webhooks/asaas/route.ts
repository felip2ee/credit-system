import { createHash, timingSafeEqual } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { ASAAS_INVOICE_EVENT_PREFIX, ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";
import { applyChargeSplitEvent, parseSplitItems, SPLIT_ONLY_EVENTS, SPLIT_REFUND_EVENTS } from "@/lib/asaas/split-events";
import { readAsaasConfig, readWebhookDatabaseUrl } from "@/lib/config";
import {
	applyInvoiceEvent,
	parseInvoiceEvent,
	repairInvoiceForPayment,
	requestInvoiceForPayment,
} from "@/lib/nfse/invoice";
import { applyAsaasPayment } from "@/lib/wallet/pix-charges";

// Rota pública (sem sessão): a autenticação é o token do header. O valor creditado nunca vem do corpo.
const MAX_BODY_CHARS = 65_536;

const eventSchema = z.object({
	id: z.string().trim().min(1).max(200).optional(),
	event: z.string().trim().min(1).max(100),
	payment: z.object({
		id: z.string().trim().min(1).max(200),
		// Parcelamento do cartão. Valor fora do formato não derruba o evento.
		installment: z.string().trim().min(1).max(200).optional().catch(undefined),
		externalReference: z.string().trim().min(1).max(200).optional().catch(undefined),
	}),
});

// Hash dos dois lados iguala o tamanho; timingSafeEqual não vaza o prefixo comum.
function tokenMatches(received: string | null, expected: string): boolean {
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(received ?? ""), digest(expected));
}

// Eventos que creditam (iguais aos de apply_asaas_payment): o reenvio de um estorno não pede nota.
const PAYMENT_CREDIT_EVENTS = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"]);

// O corpo é gravado em asaas_webhook_events: do cartão ficam só bandeira e 4 últimos dígitos. Nunca o token.
function stripCardSecrets(raw: unknown): unknown {
	const payment = (raw as { payment?: unknown }).payment;
	if (typeof payment !== "object" || payment === null || !("creditCard" in payment)) return raw;
	const { creditCard, ...rest } = payment as { creditCard?: unknown };
	const card = typeof creditCard === "object" && creditCard !== null ? (creditCard as Record<string, unknown>) : {};
	const kept: Record<string, unknown> = {};
	if (typeof card.creditCardBrand === "string") kept.creditCardBrand = card.creditCardBrand;
	if (typeof card.creditCardNumber === "string" && /^\d{4}$/.test(card.creditCardNumber)) {
		kept.creditCardNumber = card.creditCardNumber;
	}
	return { ...(raw as object), payment: { ...rest, creditCard: kept } };
}

const respond = (status: number) => new Response(null, { status });

// Só nome e código: nada do payload. 500 faz o Asaas reenviar.
function logApplyFailure(error: unknown): void {
	console.error("[asaas-webhook] falha ao aplicar o evento", {
		name: error instanceof Error ? error.name : typeof error,
		code: error instanceof Error && "code" in error ? error.code : undefined,
	});
}

// Trabalho depois da resposta (nota fiscal). Next 14.2 não tem after(); o servidor standalone segue vivo, então a
// promessa termina sozinha. Nunca fica sem catch: a falha só vai ao log (nome e código), nunca ao Asaas.
function runAfterAck(step: string, task: () => Promise<unknown>): void {
	void Promise.resolve()
		.then(task)
		.catch((error) =>
			console.error(`[asaas-webhook] ${step} falhou`, {
				name: error instanceof Error ? error.name : typeof error,
				code: error instanceof Error && "code" in error ? error.code : undefined,
			}),
		);
}

// O crédito do cliente muda o saldo da tela dele; o cache falhar não pode virar 500 (o crédito já está gravado).
function revalidateClientCredits(): void {
	try {
		revalidatePath("/portal/credits");
	} catch (error) {
		console.error("[asaas-webhook] revalidação falhou", { name: error instanceof Error ? error.name : typeof error });
	}
}

const isInvoiceEvent = (raw: unknown): boolean =>
	typeof raw === "object" &&
	raw !== null &&
	typeof (raw as { event?: unknown }).event === "string" &&
	(raw as { event: string }).event.startsWith(ASAAS_INVOICE_EVENT_PREFIX);

// Evento de nota: o corpo traz invoice.payment (não payment.id). Só atualiza o status da nota; nunca a carteira.
async function handleInvoiceEvent(raw: unknown): Promise<Response> {
	const parsed = parseInvoiceEvent(raw);
	if (!parsed.success) {
		console.warn("[asaas-webhook] evento de nota sem invoice.payment ignorado");
		return respond(200);
	}
	try {
		await applyInvoiceEvent(parsed.data);
		return respond(200);
	} catch (error) {
		logApplyFailure(error);
		return respond(500);
	}
}

// Split (072, 083): evento de split, estorno ou chargeback com payment.split atualiza charge_splits. Retorna a resposta só
// quando o evento é apenas de split; estorno e chargeback seguem para apply_asaas_payment. 500 faz o Asaas reenviar.
async function handleSplitEvent(event: z.infer<typeof eventSchema>, raw: unknown): Promise<Response | null> {
	const splitOnly = SPLIT_ONLY_EVENTS.has(event.event);
	if (!splitOnly && !SPLIT_REFUND_EVENTS.has(event.event)) return null;
	const splits = parseSplitItems(raw);
	if (splits === null) return splitOnly ? respond(200) : null;
	try {
		const result = await applyChargeSplitEvent({
			eventId: event.id ?? `${event.event}:${event.payment.id}`,
			eventType: event.event,
			asaasPaymentId: event.payment.id,
			asaasInstallmentId: event.payment.installment,
			externalReference: event.payment.externalReference,
			splits,
		});
		if (result === "unknown_charge") console.warn("[asaas-webhook] split de cobrança desconhecida", { asaasPaymentId: event.payment.id });
		if (result === "unbound_charge") {
			console.warn("[asaas-webhook] split de cobrança ainda sem o id do pagamento", { asaasPaymentId: event.payment.id });
			// Só o evento de split se perde com um 200; estorno e chargeback seguem e apply_asaas_payment liga a cobrança.
			if (splitOnly) return respond(500);
		}
	} catch (error) {
		logApplyFailure(error);
		return respond(500);
	}
	return splitOnly ? respond(200) : null;
}

export async function POST(request: Request): Promise<Response> {
	let expectedToken: string;
	try {
		expectedToken = readAsaasConfig(process.env).webhookToken;
		readWebhookDatabaseUrl(process.env);
	} catch (error) {
		console.error("[asaas-webhook] configuração inválida", { name: error instanceof Error ? error.name : typeof error });
		return respond(500);
	}
	if (!tokenMatches(request.headers.get(ASAAS_WEBHOOK_TOKEN_HEADER), expectedToken)) return respond(401);

	const text = await request.text();
	if (text.length > MAX_BODY_CHARS) return respond(400);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return respond(400);
	}
	if (isInvoiceEvent(raw)) return handleInvoiceEvent(raw);
	const parsed = eventSchema.safeParse(raw);
	if (!parsed.success) {
		// Evento sem cobrança: não há o que gravar. 200 evita reenvios; o corpo não vai ao log.
		console.warn("[asaas-webhook] evento sem payment.id ignorado");
		return respond(200);
	}

	const splitResponse = await handleSplitEvent(parsed.data, raw);
	if (splitResponse) return splitResponse;

	let result: Awaited<ReturnType<typeof applyAsaasPayment>>;
	try {
		result = await applyAsaasPayment({
			// Sem id de evento no corpo, o par evento+cobrança o identifica: o reenvio do Asaas continua idempotente.
			eventId: parsed.data.id ?? `${parsed.data.event}:${parsed.data.payment.id}`,
			eventType: parsed.data.event,
			asaasPaymentId: parsed.data.payment.id,
			payload: stripCardSecrets(raw),
		});
	} catch (error) {
		logApplyFailure(error);
		return respond(500);
	}

	// O crédito já está gravado. A nota (chamada lenta ao Asaas) roda depois da resposta e nunca muda o status dela.
	const paymentId = parsed.data.payment.id;
	const installment = parsed.data.payment.installment;
	if (result === "credited") {
		runAfterAck("pedido da nota", () => requestInvoiceForPayment(paymentId, installment));
		revalidateClientCredits();
	} else if (result === "duplicate" && PAYMENT_CREDIT_EVENTS.has(parsed.data.event)) {
		// Reenvio de um crédito já aplicado: repara a nota que ficou em not_requested ou presa em pending (mais de 10 min).
		runAfterAck("reparo da nota", () => repairInvoiceForPayment(paymentId, installment));
	} else if (result === "unknown_charge" && PAYMENT_CREDIT_EVENTS.has(parsed.data.event)) {
		// Pagamento de uma cobrança que o banco não tem (por exemplo, a linha não foi salva depois de criar o PIX): ninguém foi creditado.
		console.error("[asaas-webhook] pagamento de cobrança desconhecida, sem crédito", { asaasPaymentId: paymentId });
	} else if (result === "partial_refund_ignored") {
		// Estorno parcial não mexe em saldo (M6): 200 evita o reenvio do Asaas; o evento fica registrado no banco.
		console.warn("[asaas-webhook] estorno parcial ignorado");
	} else if (result === "chargeback_ignored") {
		// Disputa sem tratamento automático: só evento e id da cobrança no log (o corpo fica no banco).
		console.error("[asaas-webhook] chargeback sem tratamento", { event: parsed.data.event, asaasPaymentId: paymentId });
	} else if (result === "link_order_not_payable") {
		// Pix de link pago, mas o pedido já não aceita pagamento (pago no balcão ou cancelado): sem pagamento de balcão. A operação confere.
		console.error("[asaas-webhook] pix de link sem pedido pagável", { asaasPaymentId: paymentId });
	} else if (result === "link_refund_ignored") {
		// Estorno ou chargeback de Pix de link: nada reverte sozinho (o pedido pode já ter avançado). Só ids no log.
		console.error("[asaas-webhook] estorno de pix de link sem tratamento", { event: parsed.data.event, asaasPaymentId: paymentId });
	} else if (result === "link_overpaid") {
		// Pix lançado, mas a soma passou o preço: a operação devolve a diferença no Asaas. Só id no log.
		console.error("[asaas-webhook] pix de link maior que o saldo da consulta", { asaasPaymentId: paymentId });
	} else if (result === "amount_mismatch") {
		// Pago a menos que o esperado: nada foi creditado. A operação confere no Asaas.
		console.error("[asaas-webhook] valor divergente", { asaasPaymentId: paymentId });
	}
	return respond(200);
}
