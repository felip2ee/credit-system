import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { ASAAS_INVOICE_EVENT_PREFIX, ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";
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
	payment: z.object({ id: z.string().trim().min(1).max(200) }),
});

// Hash dos dois lados iguala o tamanho; timingSafeEqual não vaza o prefixo comum.
function tokenMatches(received: string | null, expected: string): boolean {
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(received ?? ""), digest(expected));
}

// Eventos que creditam (iguais aos de apply_asaas_payment): o reenvio de um estorno não pede nota.
const PAYMENT_CREDIT_EVENTS = new Set(["PAYMENT_RECEIVED", "PAYMENT_CONFIRMED"]);

const respond = (status: number) => new Response(null, { status });

// Só nome e código: nada do payload. 500 faz o Asaas reenviar.
function logApplyFailure(error: unknown): void {
	console.error("[asaas-webhook] falha ao aplicar o evento", {
		name: error instanceof Error ? error.name : typeof error,
		code: error instanceof Error && "code" in error ? error.code : undefined,
	});
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

	let result: Awaited<ReturnType<typeof applyAsaasPayment>>;
	try {
		result = await applyAsaasPayment({
			// Sem id de evento no corpo, o par evento+cobrança o identifica: o reenvio do Asaas continua idempotente.
			eventId: parsed.data.id ?? `${parsed.data.event}:${parsed.data.payment.id}`,
			eventType: parsed.data.event,
			asaasPaymentId: parsed.data.payment.id,
			payload: raw,
		});
	} catch (error) {
		logApplyFailure(error);
		return respond(500);
	}

	// Depois do crédito e fora dele: a nota nunca desfaz o crédito nem muda o status da resposta.
	if (result === "credited") {
		await requestInvoiceForPayment(parsed.data.payment.id).catch(() => {});
	} else if (result === "duplicate" && PAYMENT_CREDIT_EVENTS.has(parsed.data.event)) {
		// Reenvio de um crédito já aplicado: repara a nota que ficou em not_requested. Nota já pedida não é agendada de novo.
		await repairInvoiceForPayment(parsed.data.payment.id).catch(() => {});
	}
	return respond(200);
}
