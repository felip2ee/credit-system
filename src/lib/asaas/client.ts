// Cliente HTTP do Asaas. Conferido em 2026-10-14 na documentação pública (docs.asaas.com), sem sandbox:
// POST /v3/payments (customer, billingType=PIX, value, dueDate, externalReference) com o header `access_token`;
// GET /v3/payments/{id}/pixQrCode -> { encodedImage, payload }; webhook com o header `asaas-access-token`
// (o authToken do webhook) e corpo { id, event, payment: { id, value } }.
// Não conferido: que a cobrança PIX sem customer próprio aceita um customer único da conta (ASAAS_CUSTOMER_ID).
// Prova real: item (post-deploy) da spec.
import { z } from "zod";

import type { AsaasClient, PixChargeInput, PixChargeResult } from "./types";

export const ASAAS_API_KEY_HEADER = "access_token";
export const ASAAS_WEBHOOK_TOKEN_HEADER = "asaas-access-token";
export const ASAAS_EVENT_PAYMENT_RECEIVED = "PAYMENT_RECEIVED";
export const ASAAS_EVENT_PAYMENT_CONFIRMED = "PAYMENT_CONFIRMED";
export const ASAAS_EVENT_PAYMENT_REFUNDED = "PAYMENT_REFUNDED";

const REQUEST_TIMEOUT_MS = 15_000;

export type AsaasClientSettings = { apiKey: string; baseUrl: string; customerId: string };

const paymentSchema = z.object({ id: z.string().min(1) });
const qrSchema = z.object({ encodedImage: z.string().min(1), payload: z.string().min(1) });

// Vencimento no fuso de Brasília (a data é local ao negócio, não UTC).
function todayInSaoPaulo(): string {
	return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo" }).format(new Date());
}

export function createAsaasClient(settings: AsaasClientSettings, fetchImpl: typeof fetch = fetch): AsaasClient {
	const base = settings.baseUrl.replace(/\/+$/, "");

	// Erros levam só método, caminho e status: nunca a chave nem o corpo da resposta.
	async function call<T>(
		method: "GET" | "POST",
		path: string,
		label: string,
		schema: z.ZodType<T>,
		body?: unknown,
	): Promise<T> {
		const response = await fetchImpl(`${base}${path}`, {
			method,
			headers: { [ASAAS_API_KEY_HEADER]: settings.apiKey, "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) throw new Error(`Asaas respondeu ${response.status} em ${label}`);
		const parsed = schema.safeParse(await response.json().catch(() => null));
		if (!parsed.success) throw new Error(`Resposta inválida do Asaas em ${label}`);
		return parsed.data;
	}

	return {
		async createPixCharge(input: PixChargeInput): Promise<PixChargeResult> {
			const payment = await call("POST", "/v3/payments", "POST /v3/payments", paymentSchema, {
				customer: settings.customerId,
				billingType: "PIX",
				// Serialização do valor já validado (2 casas); nenhuma conta em ponto flutuante.
				value: Number(input.amount),
				dueDate: todayInSaoPaulo(),
				externalReference: input.externalReference,
				description: input.description,
			});
			const qr = await call(
				"GET",
				`/v3/payments/${encodeURIComponent(payment.id)}/pixQrCode`,
				"GET /v3/payments/{id}/pixQrCode",
				qrSchema,
			);
			return { asaasPaymentId: payment.id, pixPayload: qr.payload, qrImageBase64: qr.encodedImage };
		},
	};
}
