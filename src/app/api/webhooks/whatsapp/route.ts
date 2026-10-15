import { readWebhookDatabaseUrl, readWhatsappConfig } from "@/lib/config";
import { getWebhookPool } from "@/lib/db/webhook-pool";
import {
	WHATSAPP_MAX_BODY_BYTES,
	WHATSAPP_SIGNATURE_HEADER,
	applyWhatsappWebhook,
	parseWhatsappWebhook,
	signatureMatches,
	verifyTokenMatches,
} from "@/lib/notifications/whatsapp-webhook";

// Rota pública (sem sessão): GET se autentica pelo verify token; POST, pela assinatura HMAC do corpo bruto.
const MAX_CHALLENGE_DIGITS = 64;

const respond = (status: number) => new Response(null, { status });

// null = WhatsApp desligado (404); configuração inválida lança e a rota responde 500.
function readConfig(): { config: ReturnType<typeof readWhatsappConfig>; invalid: boolean } {
	try {
		return { config: readWhatsappConfig(process.env), invalid: false };
	} catch (error) {
		console.error("[whatsapp-webhook] configuração inválida", {
			name: error instanceof Error ? error.name : typeof error,
		});
		return { config: null, invalid: true };
	}
}

// Lê o corpo aos pedaços e aborta ao passar do limite: nunca guarda mais que WHATSAPP_MAX_BODY_BYTES.
async function readBodyWithin(request: Request, maxBytes: number): Promise<Buffer | null> {
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) return null;
	if (!request.body) return Buffer.alloc(0);

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > maxBytes) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}

// Só nome e código: nunca o corpo, o remetente, o texto nem o header de assinatura.
function logFailure(error: unknown): void {
	console.error("[whatsapp-webhook] falha ao aplicar o evento", {
		name: error instanceof Error ? error.name : typeof error,
		code: error instanceof Error && "code" in error ? error.code : undefined,
	});
}

export async function GET(request: Request): Promise<Response> {
	const { config, invalid } = readConfig();
	if (invalid) return respond(500);
	if (!config) return respond(404);

	const params = new URL(request.url).searchParams;
	const challenge = params.get("hub.challenge") ?? "";
	if (
		params.get("hub.mode") !== "subscribe" ||
		!verifyTokenMatches(params.get("hub.verify_token"), config.verifyToken) ||
		!new RegExp(`^\\d{1,${MAX_CHALLENGE_DIGITS}}$`).test(challenge)
	) {
		return respond(403);
	}
	return new Response(challenge, {
		status: 200,
		headers: { "content-type": "text/plain" },
	});
}

export async function POST(request: Request): Promise<Response> {
	const { config, invalid } = readConfig();
	if (invalid) return respond(500);
	if (!config) return respond(404);
	try {
		readWebhookDatabaseUrl(process.env);
	} catch (error) {
		console.error("[whatsapp-webhook] configuração inválida", {
			name: error instanceof Error ? error.name : typeof error,
		});
		return respond(500);
	}

	const rawBody = await readBodyWithin(request, WHATSAPP_MAX_BODY_BYTES);
	if (!rawBody) return respond(413);
	if (
		!signatureMatches(
			rawBody,
			request.headers.get(WHATSAPP_SIGNATURE_HEADER),
			config.appSecret,
		)
	) {
		return respond(401);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(rawBody.toString("utf8"));
	} catch {
		return respond(400);
	}

	try {
		const counts = await applyWhatsappWebhook(
			parseWhatsappWebhook(raw, config.phoneNumberId),
			getWebhookPool(),
		);
		console.info("[whatsapp-webhook] evento aplicado", counts);
		return respond(200);
	} catch (error) {
		logFailure(error);
		return respond(500);
	}
}
