import { createHash, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { ASAAS_WEBHOOK_TOKEN_HEADER } from "@/lib/asaas/client";
import { readAsaasConfig } from "@/lib/config";
import { applyAsaasPayment } from "@/lib/wallet/pix-charges";

// Rota pública (sem sessão): a autenticação é o token do header. O valor creditado nunca vem do corpo.
const MAX_BODY_CHARS = 65_536;

const eventSchema = z.object({
	id: z.string().trim().min(1).max(200),
	event: z.string().trim().min(1).max(100),
	payment: z.object({ id: z.string().trim().min(1).max(200) }),
});

// Hash dos dois lados iguala o tamanho; timingSafeEqual não vaza o prefixo comum.
function tokenMatches(received: string | null, expected: string): boolean {
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(received ?? ""), digest(expected));
}

const respond = (status: number) => new Response(null, { status });

export async function POST(request: Request): Promise<Response> {
	let expectedToken: string;
	try {
		expectedToken = readAsaasConfig(process.env).webhookToken;
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
	const parsed = eventSchema.safeParse(raw);
	if (!parsed.success) {
		// Evento sem cobrança (ou sem id): não há o que gravar. 200 evita reenvios; o corpo não vai ao log.
		console.warn("[asaas-webhook] evento sem payment.id ignorado");
		return respond(200);
	}

	try {
		await applyAsaasPayment({
			eventId: parsed.data.id,
			eventType: parsed.data.event,
			asaasPaymentId: parsed.data.payment.id,
			payload: raw,
		});
		return respond(200);
	} catch (error) {
		// Só nome e código: nada do payload. 500 faz o Asaas reenviar.
		console.error("[asaas-webhook] falha ao aplicar o evento", {
			name: error instanceof Error ? error.name : typeof error,
			code: error instanceof Error && "code" in error ? error.code : undefined,
		});
		return respond(500);
	}
}
